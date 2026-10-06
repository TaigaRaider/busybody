import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
  lte,
  lt,
} from "drizzle-orm";

import { db } from "./db.js";
import {
  DEFAULT_SIZE,
  REQUESTABLE_ROLES,
  ROLE_VALUES,
  SIZES,
  VISIBILITIES,
  noteLayouts,
  noteMentions,
  notes,
  retiredHandles,
  spaceMembers,
  spaceRequests,
  spaces,
  users,
} from "./schema.js";
import {
  attachUser,
  generateToken,
  hashPassword,
  hashToken,
  isAcceptablePassword,
  PASSWORD_MAX,
  PASSWORD_MIN,
  requireAuth,
  verifyPassword,
} from "./auth.js";
import { allow, capsFor, ghostAllows, grantableRole, isGhosted } from "./permissions.js";
import { deleteAccountData } from "./account-deletion.js";
import { extractHandles, isValidHandle, normalizeColor, normalizeHandle } from "./mentions.js";

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_MESSAGE = 500;
const MAX_HISTORY = 20;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

const bad = (res, error, code = "BAD_REQUEST") =>
  res.status(400).json({ error, code });

/**
 * 401 is reserved for "this request carried no valid session".
 *
 * The client's axios interceptor reacts to any 401 by clearing the stored token
 * and dropping to the auth screen, so returning 401 for a bad *input* on an
 * otherwise-authenticated endpoint signs the user out for making a typo. Use
 * `bad` for a wrong password on an authenticated route.
 */
const unauthorized = (res, error, code = "UNAUTHENTICATED") =>
  res.status(401).json({ error, code });

const forbidden = (res, error, code = "FORBIDDEN") =>
  res.status(403).json({ error, code });

const notFound = (res, error = "Not found") =>
  res.status(404).json({ error, code: "NOT_FOUND" });

/**
 * Surface which UNIQUE column collided so the client can say something useful.
 * Drizzle wraps driver errors in `DrizzleQueryError`, so walk the `cause` chain.
 */
function uniqueViolationColumn(err) {
  for (let current = err, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    const m = String(current.message || "").match(
      /UNIQUE constraint failed:\s*\w+\.(\w+)/i,
    );
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function conflict(res, err, { handle, color } = {}) {
  const column = uniqueViolationColumn(err);
  if (!column) return false;
  const error =
    column === "handle"
      ? `The handle "${handle}" is taken`
      : column === "color"
        ? `The chalk colour ${color} is already claimed`
        : "Already exists";
  res.status(409).json({ error, code: "CONFLICT", field: column });
  return true;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    handle: u.handle,
    displayName: u.displayName || null,
    color: u.color,
    isAdmin: !!u.isAdmin,
    // The client renders the ghost banner and hides every write affordance from
    // this one flag; the server still refuses each write independently.
    ghostedAt: u.ghostedAt || null,
    createdAt: u.createdAt,
  };
}

/**
 * A throwaway scrypt hash used when the account is unknown or has no password.
 *
 * Computing this once and reusing it is what keeps the response time of a
 * missing account indistinguishable from a wrong password. The alternative â€”
 * skipping verification for unknown handles â€” turns /auth/login into an oracle
 * that tells an attacker which handles exist.
 */
let decoy;
function decoyHash() {
  decoy ??= hashPassword(crypto.randomBytes(32).toString("base64url"));
  return decoy;
}

/**
 * Best-effort brute-force brake on /auth/login.
 *
 * This is in-memory, so on serverless it only covers the warm instances that
 * happen to serve the request â€” it is a speed bump, not a guarantee. Real
 * enforcement wants a shared counter in the database. The key mixes the IP and
 * the handle so that neither spraying one account nor one password across many
 * accounts gets a free run.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_MAX_KEYS = 5000; // bound the map; it dies with the instance anyway
const loginHits = new Map();

function loginGuard(req, res, next) {
  const now = Date.now();
  const key = `${req.ip}|${normalizeHandle(req.body?.handle)}`;

  let times = (loginHits.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);

  if (times.length >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({
      error: "Too many sign-in attempts. Wait a few minutes and try again.",
      code: "RATE_LIMITED",
    });
  }

  times.push(now);
  if (loginHits.size > LOGIN_MAX_KEYS) loginHits.clear();
  loginHits.set(key, times);
  next();
}

/**
 * "Ghost In Time": the holder pauses their own account instead of deleting it.
 *
 * The account, its handle and every note it ever wrote stay exactly where they
 * are. What changes is that the holder can no longer write anything, and no
 * longer sees anything written after they left - so the board reads as it did
 * at the moment they ghosted. `ghostedAt` is that moment, and every read path
 * filters on it. It is deliberately self-service and self-reversing: there is
 * no admin override, because the only person who can end a ghosting is the
 * person who started it.
 */
const GHOST_MESSAGE =
  "You are a ghost. Revive from your profile to post, manage spaces or see anything new.";

/**
 * `requireAuth` plus the ghost check, for every route that writes.
 *
 * `allow()` already refuses a ghost, and that stays as the backstop, but plenty
 * of write routes never reach it: creating or withdrawing an access request,
 * leaving a space, rotating a token. Rather than trust each one to remember,
 * the write routes carry this instead of `requireAuth`, so a ghost gets one
 * consistent 403 and one honest message instead of a misleading
 * "request to participate in X".
 *
 * Deliberately left open, because locking somebody out of their own account is
 * a worse failure than letting them tidy up:
 *   - `POST /auth/revive`, `change-password`, `rotate-token`, `PATCH /auth/me`
 *   - `POST /spaces/:id/leave` - you can always walk out of a room
 *   - `DELETE /requests/:id` - withdrawing a request you can no longer make
 *   - `POST /auth/login` - a ghost has to be able to come back to revive
 */
function requireAwake(req, res, next) {
  // It *replaces* requireAuth on the write routes, so the sign-in check has to
  // run first or the handler would be reached with no `req.user` at all.
  requireAuth(req, res, () => {
    if (isGhosted(req.user)) return forbidden(res, GHOST_MESSAGE, "GHOSTED");
    next();
  });
}

function slugify(value) {
  const base = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "space";
}

async function uniqueSlug(desired) {
  const base = slugify(desired);
  let candidate = base;
  let n = 2;
  /* eslint-disable no-await-in-loop */
  while (true) {
    const clash = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.slug, candidate))
      .limit(1);
    if (!clash.length) return candidate;
    candidate = `${base.slice(0, 44)}-${n}`;
    n += 1;
  }
  /* eslint-enable no-await-in-loop */
}

/* ------------------------------------------------------------------ *
 * lookups
 * ------------------------------------------------------------------ */

async function findSpace(param) {
  const raw = String(param ?? "");
  const asId = Number(raw);
  const rows =
    Number.isInteger(asId) && String(asId) === raw
      ? await db.select().from(spaces).where(eq(spaces.id, asId)).limit(1)
      : await db
          .select()
          .from(spaces)
          .where(eq(spaces.slug, raw.toLowerCase()))
          .limit(1);
  return rows[0] || null;
}

async function findNote(id) {
  const asId = Number(id);
  if (!Number.isInteger(asId)) return null;
  const rows = await db.select().from(notes).where(eq(notes.id, asId)).limit(1);
  return rows[0] || null;
}

/** @returns {Promise<string|null>} the caller's role in `spaceId`, if any */
async function roleIn(spaceId, userId) {
  if (!spaceId || !userId || userId < 0) return null;
  const rows = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(
      and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)),
    )
    .limit(1);
  return rows[0]?.role || null;
}

async function membershipMap(userId) {
  if (!userId || userId < 0) return new Map();
  const rows = await db
    .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, userId));
  return new Map(rows.map((r) => [r.spaceId, r.role]));
}

/* ------------------------------------------------------------------ *
 * serialisation
 * ------------------------------------------------------------------ */

function serializeSpace(space, role, extra = {}, user = null) {
  const caps = capsFor(space, role);
  return {
    id: space.id,
    slug: space.slug,
    name: space.name,
    description: space.description || null,
    visibility: space.visibility,
    ownerId: space.ownerId,
    createdAt: space.createdAt,
    // The role is metadata and stays put: a ghost still owns the room they left.
    role: role || null,
    // Server-authoritative capability list; the client uses it only to decide
    // which affordances to draw. Narrowed to the ghost's read-only set so every
    // component that already gates on a capability - the composer, the roster,
    // the space settings - closes itself without knowing about ghosting at all.
    caps: isGhosted(user) ? [...caps].filter((c) => ghostAllows(c)) : [...caps],
    ...extra,
  };
}

/**
 * Note permissions, computed once per request from the space role so the client
 * never has to re-derive them.
 */
function notePerms(note, { user, space, role }) {
  const isMine = !!user && note.authorId != null && note.authorId === user.id;
  // `isMine` short-circuits `allow`, so it would wave a ghost's own notes
  // through. Authoring is a write like any other, so check the flag here too.
  const canEdit =
    !!user && (!isGhosted(user) || ghostAllows("edit_own")) && (isMine || allow(user, space, role, "edit_any"));
  return {
    isMine,
    canEdit,
    canDelete: canEdit,
    canRollback: canEdit,
  };
}

/** Attach layout size, resolved mentions, author identity and permissions. */
async function decorate(rows, ctx) {
  const { user } = ctx;
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const authorIds = [...new Set(rows.map((r) => r.authorId).filter((v) => v != null))];

  const [layoutRows, mentionRows, authorRows] = await Promise.all([
    user && user.id >= 0
      ? db
          .select()
          .from(noteLayouts)
          .where(
            and(
              inArray(noteLayouts.noteId, ids),
              eq(noteLayouts.userId, user.id),
            ),
          )
      : Promise.resolve([]),
    db
      .select({
        noteId: noteMentions.noteId,
        id: users.id,
        handle: users.handle,
        color: users.color,
      })
      .from(noteMentions)
      .innerJoin(users, eq(noteMentions.userId, users.id))
      .where(inArray(noteMentions.noteId, ids)),
    authorIds.length
      ? db
          .select({ id: users.id, handle: users.handle, color: users.color })
          .from(users)
          .where(inArray(users.id, authorIds))
      : Promise.resolve([]),
  ]);

  const layouts = new Map(layoutRows.map((r) => [r.noteId, r.size]));
  const authors = new Map(authorRows.map((r) => [r.id, r]));

  /** noteId -> { [handle]: {id, handle, color} } */
  const mentions = new Map();
  for (const m of mentionRows) {
    if (!mentions.has(m.noteId)) mentions.set(m.noteId, {});
    mentions.get(m.noteId)[m.handle] = {
      id: m.id,
      handle: m.handle,
      color: m.color,
    };
  }

  return rows.map((note) => ({
    ...note,
    size: layouts.get(note.id) || DEFAULT_SIZE,
    // Three states, told apart by which of the two columns is set:
    //   authorId set              -> a live account, looked up as usual
    //   authorId null, handle set -> the author deleted their account; the
    //                               snapshot byline stands in, greyed out
    //   both null                 -> never had an author (legacy rows)
    author:
      note.authorId != null
        ? (authors.get(note.authorId) || null)
        : note.authorHandle
          ? { handle: note.authorHandle, color: note.authorColor, gone: true }
          : null,
    mentions: mentions.get(note.id) || {},
    perm: notePerms(note, ctx),
  }));
}

function readPage(req) {
  const requested = Number(req.query.limit);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : DEFAULT_PAGE, 1),
    MAX_PAGE,
  );
  const rawCursor = Number(req.query.cursor);
  const cursor =
    Number.isInteger(rawCursor) && rawCursor > 0 ? rawCursor : null;
  return { limit, cursor };
}

/** Turn an over-fetched row list into `{ items, nextCursor, hasMore }`. */
async function paginate(rows, limit, ctx) {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const items = await decorate(slice, ctx);
  return {
    items,
    nextCursor: hasMore && slice.length ? slice[slice.length - 1].id : null,
    hasMore,
  };
}

/* ------------------------------------------------------------------ *
 * mentions
 * ------------------------------------------------------------------ */

/**
 * Re-index `@handle` tags for a note. The literal tag text stays in the body;
 * this table is the queryable source of truth.
 */
async function syncMentions({ noteId, spaceId, authorId, body }) {
  await db.delete(noteMentions).where(eq(noteMentions.noteId, noteId));

  const handles = extractHandles(body);
  if (!handles.length) return [];

  const targets = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(inArray(users.handle, handles));
  if (!targets.length) return [];

  const at = now();
  await db
    .insert(noteMentions)
    .values(
      targets.map((u) => ({
        noteId,
        userId: u.id,
        mentionedBy: authorId ?? null,
        spaceId: spaceId ?? null,
        createdAt: at,
      })),
    );
  return targets;
}

/**
 * Being `@tagged` inside a private space doubles as an invitation: the tagged
 * user gets a pending viewer request so they can act on it.
 */
async function autoInvite(space, targets) {
  if (!space || space.visibility !== "private" || !targets.length) return;

  const at = now();
  for (const u of targets) {
    if (u.id === space.ownerId) continue;
    /* eslint-disable no-await-in-loop */
    if (await roleIn(space.id, u.id)) continue;
    const message = `You were tagged in ${space.name}.`;
    const existing = await db
      .select({ id: spaceRequests.id })
      .from(spaceRequests)
      .where(
        and(
          eq(spaceRequests.spaceId, space.id),
          eq(spaceRequests.userId, u.id),
        ),
      )
      .limit(1);
    if (existing.length) {
      await db
        .update(spaceRequests)
        .set({
          status: "pending",
          requestedRole: "viewer",
          message,
          createdAt: at,
          resolvedAt: null,
          resolvedBy: null,
        })
        .where(eq(spaceRequests.id, existing[0].id));
    } else {
      await db.insert(spaceRequests).values({
        spaceId: space.id,
        userId: u.id,
        requestedRole: "viewer",
        message,
        status: "pending",
        createdAt: at,
      });
    }
    /* eslint-enable no-await-in-loop */
  }
}

/* ------------------------------------------------------------------ *
 * app
 * ------------------------------------------------------------------ */

export function createApp() {
  const app = express();

  // Vercel terminates TLS and rewrites X-Forwarded-For, so without this every
  // request would look like it came from the same proxy and the login limiter
  // would key on a single address for the whole internet.
  app.set("trust proxy", true);

  app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
  app.use(express.json({ limit: "256kb" }));
  app.use(attachUser);

  app.get("/ping", (_req, res) => res.json({ ok: true }));

  /* ---------------------------- auth ---------------------------- */

  app.post("/auth/register", async (req, res) => {
    const handle = normalizeHandle(req.body?.handle);
    if (!isValidHandle(handle))
      return bad(
        res,
        "Handle must be 2-31 characters using a-z, 0-9, dot, dash or underscore",
        "INVALID_HANDLE",
      );

    const color = normalizeColor(req.body?.color);
    if (!color)
      return bad(res, "Colour must be a hex value like #e06c75", "INVALID_COLOR");

    const password = req.body?.password;
    if (!isAcceptablePassword(password))
      return bad(
        res,
        `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
        "INVALID_PASSWORD",
      );

    const displayName = req.body?.displayName
      ? String(req.body.displayName).trim().slice(0, 60) || null
      : null;

    // Checked before the insert so the caller gets the reason rather than a bare
    // UNIQUE violation. The name is still on the board in grey, so letting
    // somebody else take it would put their handle on somebody else's notes.
    const retired = await db
      .select({ handle: retiredHandles.handle })
      .from(retiredHandles)
      .where(eq(retiredHandles.handle, handle))
      .limit(1);
    if (retired.length)
      return bad(
        res,
        `@${handle} belonged to an account that was deleted, and its name stays retired`,
        "HANDLE_RETIRED",
      );

    // First account bootstraps the admin so a fresh install is manageable.
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    const token = generateToken();

    try {
      const inserted = await db
        .insert(users)
        .values({
          handle,
          displayName,
          color,
          tokenHash: hashToken(token),
          passwordHash: await hashPassword(password),
          isAdmin: existing.length ? 0 : 1,
          createdAt: now(),
        })
        .returning();
      res.status(201).json({ user: publicUser(inserted[0]), token });
    } catch (err) {
      if (!conflict(res, err, { handle, color })) throw err;
    }
  });

  /**
   * Password sign-in. The handle is not a secret, so the response is identical
   * whether the account is missing, has no password (an anon-* placeholder),
   * or the password is simply wrong â€” otherwise this becomes a handle oracle.
   */
  app.post("/auth/login", loginGuard, async (req, res) => {
    const handle = normalizeHandle(req.body?.handle);
    const password = req.body?.password;

    if (!handle || typeof password !== "string" || !password) {
      return unauthorized(res, "Handle or password is incorrect", "BAD_CREDENTIALS");
    }

    const rows = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
    const user = rows[0] || null;

    // Always pay the scrypt cost, even for an unknown handle, so response time
    // does not leak whether the account exists.
    const ok = await verifyPassword(password, user?.passwordHash || (await decoyHash()));

    if (!user || !user.passwordHash || !ok) {
      return unauthorized(res, "Handle or password is incorrect", "BAD_CREDENTIALS");
    }

    // A fresh token per sign-in: one leaked session token cannot be replayed
    // after the owner signs in again.
    const token = generateToken();
    await db
      .update(users)
      .set({ tokenHash: hashToken(token) })
      .where(eq(users.id, user.id));

    res.json({ user: publicUser(user), token });
  });

  /**
   * Changing a password also reissues the token. The old one is invalidated
   * whether or not the caller intended that, so a leaked token stops working
   * the moment the owner reacts to the leak.
   */
  app.post("/auth/change-password", requireAuth, async (req, res) => {
    if (req.user.viaEnvToken)
      return bad(res, "The environment admin token has no password to change");

    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    if (!isAcceptablePassword(newPassword))
      return bad(
        res,
        `New password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
        "INVALID_PASSWORD",
      );

    const rows = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
    const user = rows[0];
    if (!user) return bad(res, "Account not found", "NOT_FOUND");

    const ok = await verifyPassword(
      typeof currentPassword === "string" ? currentPassword : "",
      user.passwordHash,
    );
    // Deliberately 400, not 401. The caller *is* authenticated -- it is the
    // current password they supplied that is wrong. A 401 here would tell the
    // client's interceptor the session is dead, and mistyping your own
    // password would sign you out.
    if (!ok) return bad(res, "Current password is incorrect", "BAD_CREDENTIALS");

    const token = generateToken();
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(newPassword),
        tokenHash: hashToken(token),
      })
      .where(eq(users.id, user.id));

    res.json({ token });
  });

  app.get("/auth/me", requireAuth, async (req, res) => {
    const user = req.user;
    const [memberships, pending, incoming] = await Promise.all([
      membershipMap(user.id).then((m) =>
        [...m.entries()].map(([spaceId, role]) => ({ spaceId, role })),
      ),
      user.id >= 0
        ? db
            .select({
              spaceId: spaceRequests.spaceId,
              requestedRole: spaceRequests.requestedRole,
              createdAt: spaceRequests.createdAt,
            })
            .from(spaceRequests)
            .where(
              and(
                eq(spaceRequests.userId, user.id),
                eq(spaceRequests.status, "pending"),
              ),
            )
        : Promise.resolve([]),
      user.id >= 0
        ? db
            .select({ spaceId: spaceRequests.spaceId })
            .from(spaceRequests)
            .innerJoin(
              spaceMembers,
              eq(spaceMembers.spaceId, spaceRequests.spaceId),
            )
            .where(
              and(
                eq(spaceRequests.status, "pending"),
                eq(spaceMembers.userId, user.id),
                inArray(spaceMembers.role, ["moderator", "owner"]),
              ),
            )
        : Promise.resolve([]),
    ]);

    res.json({
      user: publicUser(user),
      memberships,
      pendingRequests: pending,
      // spaces where I moderate and therefore have a request inbox
      moderating: [...new Set(incoming.map((r) => r.spaceId))],
      adminTokenConfigured: !!process.env.ADMIN_TOKEN,
    });
  });

  app.patch("/auth/me", requireAuth, async (req, res) => {
    if (req.user.viaEnvToken)
      return bad(res, "The environment admin token cannot edit a profile");

    const patch = {};
    if (req.body?.color != null) {
      const color = normalizeColor(req.body.color);
      if (!color)
        return bad(res, "Colour must be a hex value like #e06c75", "INVALID_COLOR");
      patch.color = color;
    }
    if (req.body?.displayName !== undefined)
      patch.displayName = String(req.body.displayName).trim().slice(0, 60) || null;
    if (!Object.keys(patch).length) return bad(res, "Nothing to update");

    try {
      const updated = await db
        .update(users)
        .set(patch)
        .where(eq(users.id, req.user.id))
        .returning();
      res.json({ user: publicUser(updated[0]) });
    } catch (err) {
      if (!conflict(res, err, { color: patch.color })) throw err;
    }
  });

  /**
   * Delete the caller's own account, permanently.
   *
   * The one destructive route in the app, so it is the one that asks for the
   * password: `requireAuth` only proves a token, and a token is sitting in local
   * storage on whatever machine last used the board. This is the difference
   * between "the holder asked" and "somebody walked up to an unlocked browser".
   *
   * Open to ghosts, unlike every other write route. Ghosting is the reversible
   * exit; this is the permanent one, and refusing it to a ghost would mean the
   * way out depended on a state the holder might have entered by accident.
   *
   * What goes and what stays is the whole design:
   *   gone    the account, its token and password, every membership, request,
   *           mention of it and card layout — all of which are only ever about
   *           this person
   *   stays   every note it wrote, body intact, with the byline greyed out
   *
   * A note in a shared space is not the author's alone to destroy: deleting a
   * membership should not silently gut a roomful of other people's reading. The
   * snapshot handle is what makes that honest, and `retiredHandles` keeps the
   * name unclaimable so the grey byline cannot be impersonated later.
   */
  app.delete("/auth/me", requireAuth, async (req, res) => {
    if (req.user.viaEnvToken)
      return bad(res, "The environment admin token has no account to delete");

    const rows = await db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
    const user = rows[0];
    if (!user) return bad(res, "Account not found", "NOT_FOUND");

    const password = req.body?.password;
    const ok = await verifyPassword(
      typeof password === "string" ? password : "",
      user.passwordHash,
    );
    // 400, not 401, for the same reason change-password does it: the caller is
    // authenticated and it is the password they supplied that is wrong. A 401
    // would trip the client's interceptor and sign them out.
    if (!ok) return bad(res, "Password is incorrect", "BAD_CREDENTIALS");

    // The guards and the teardown live in `account-deletion.js`, shared with the
    // operator script. Both 409 cases are genuine conflicts, not bad requests.
    const result = await db.transaction((tx) => deleteAccountData(tx, user, now()));
    if (!result.ok)
      return res.status(409).json({
        error: result.error,
        code: result.code,
        ...(result.spaces ? { spaces: result.spaces } : {}),
      });

    res.status(204).end();
  });

  /**
   * Ghost In Time: the holder pauses their own account.
   *
   * Nothing is deleted and nothing is revoked - the token keeps working, the
   * handle stays claimed, every past note stays attributed. `ghostedAt` is
   * stamped rather than cleared, because that timestamp is the cutoff every
   * read path filters on: a ghost sees the board as it was when they left.
   *
   * Credential routes stay open while ghosted (change-password, rotate-token,
   * PATCH /auth/me) so nobody can be locked out of the account they are still
   * holding - including out of the one button that brings them back.
   */
  app.post("/auth/ghost", requireAuth, async (req, res) => {
    if (req.user.viaEnvToken)
      return bad(res, "The environment admin token cannot ghost an account");
    if (isGhosted(req.user))
      return bad(res, "This account is already a ghost", "ALREADY_GHOSTED");

    const updated = await db
      .update(users)
      .set({ ghostedAt: now() })
      .where(eq(users.id, req.user.id))
      .returning();
    res.json({ user: publicUser(updated[0]) });
  });

  /** Undoes `/auth/ghost`. No cooldown and no password: the holder owns it. */
  app.post("/auth/revive", requireAuth, async (req, res) => {
    if (req.user.viaEnvToken)
      return bad(res, "The environment admin token cannot revive an account");

    if (!isGhosted(req.user))
      return bad(res, "This account is not a ghost", "NOT_GHOSTED");

    const updated = await db
      .update(users)
      .set({ ghostedAt: null })
      .where(eq(users.id, req.user.id))
      .returning();
    res.json({ user: publicUser(updated[0]) });
  });

  app.post("/auth/rotate-token", requireAuth, async (req, res) => {
    if (req.user.viaEnvToken)
      return bad(res, "The environment admin token cannot be rotated");
    const token = generateToken();
    await db
      .update(users)
      .set({ tokenHash: hashToken(token) })
      .where(eq(users.id, req.user.id));
    res.json({ token });
  });

  /** Handle lookup for `@mention` autocomplete. */
  app.get("/users", requireAuth, async (req, res) => {
    const q = normalizeHandle(req.query.q).replace(/[^a-z0-9._-]/g, "");
    const rows = q
      ? await db
          .select({ id: users.id, handle: users.handle, color: users.color })
          .from(users)
          .where(like(users.handle, `${q}%`))
          .orderBy(asc(users.handle))
          .limit(10)
      : await db
          .select({ id: users.id, handle: users.handle, color: users.color })
          .from(users)
          .orderBy(asc(users.handle))
          .limit(10);
    res.json(rows);
  });

  /** Colours already claimed, for the chalk picker. */
  app.get("/colors", requireAuth, async (req, res) => {
    const rows = await db
      .select({ color: users.color, id: users.id, handle: users.handle })
      .from(users);
    res.json(rows);
  });

  /* ---------------------------- spaces -------------------------- */

  app.get("/spaces", requireAuth, async (req, res) => {
    // Spaces created after the ghosting are new content too, so they drop off
    // the list. The ones that existed at the time stay, ownership included.
    const all = isGhosted(req.user)
      ? await db
          .select()
          .from(spaces)
          .where(lte(spaces.createdAt, req.user.ghostedAt))
          .orderBy(asc(spaces.name))
      : await db.select().from(spaces).orderBy(asc(spaces.name));
    const roles = await membershipMap(req.user.id);

    const pending = req.user.id >= 0
      ? await db
          .select({
            id: spaceRequests.id,
            spaceId: spaceRequests.spaceId,
            requestedRole: spaceRequests.requestedRole,
          })
          .from(spaceRequests)
          .where(
            and(
              eq(spaceRequests.userId, req.user.id),
              eq(spaceRequests.status, "pending"),
            ),
          )
      : [];
    const pendingBySpace = new Map(
      pending.map((p) => [p.spaceId, p]),
    );

    res.json(
      all.map((s) => {
        const mine = pendingBySpace.get(s.id);
        return serializeSpace(
          s,
          roles.get(s.id) || null,
          {
            pendingRequest: mine?.requestedRole || null,
            // Lets the requester withdraw their own request without needing the
            // moderator-only request listing.
            pendingRequestId: mine?.id || null,
          },
          req.user,
        );
      }),
    );
  });

  app.post("/spaces", requireAwake, async (req, res) => {
    if (req.user.viaEnvToken) return bad(res, "Pick a registered account first");
    const name = String(req.body?.name || "").trim().slice(0, 80);
    if (!name) return bad(res, "Space needs a name", "INVALID_NAME");
    const visibility = VISIBILITIES.includes(req.body?.visibility)
      ? req.body.visibility
      : "private";
    const description = req.body?.description
      ? String(req.body.description).trim().slice(0, 300) || null
      : null;

    const slug = await uniqueSlug(req.body?.slug || name);
    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(spaces)
        .values({
          slug,
          name,
          description,
          ownerId: req.user.id,
          visibility,
          createdAt: now(),
        })
        .returning();
      await tx.insert(spaceMembers).values({
        spaceId: inserted[0].id,
        userId: req.user.id,
        role: "owner",
        addedBy: req.user.id,
        createdAt: now(),
      });
      return inserted[0];
    });

    res.status(201).json(serializeSpace(created, "owner"));
  });

  app.get("/spaces/:id", requireAuth, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);

    const extra = {};
    if (req.user.id >= 0) {
      const mine = await db
        .select({ id: spaceRequests.id, requestedRole: spaceRequests.requestedRole })
        .from(spaceRequests)
        .where(
          and(
            eq(spaceRequests.spaceId, space.id),
            eq(spaceRequests.userId, req.user.id),
            eq(spaceRequests.status, "pending"),
          ),
        )
        .limit(1);
      if (mine.length) {
        extra.pendingRequest = mine[0].requestedRole;
        extra.pendingRequestId = mine[0].id;
      }
    }
    if (allow(req.user, space, role, "read_notes")) {
      const roster = await db
        .select({ userId: spaceMembers.userId })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, space.id));
      extra.memberCount = roster.length;
    }
    res.json(serializeSpace(space, role, extra, req.user));
  });

  app.patch("/spaces/:id", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "manage_members"))
      return forbidden(res, "Only the space owner can edit it");

    const patch = {};
    if (req.body?.name != null) {
      const name = String(req.body.name).trim().slice(0, 80);
      if (!name) return bad(res, "Space needs a name", "INVALID_NAME");
      patch.name = name;
    }
    if (req.body?.description !== undefined)
      patch.description = String(req.body.description).trim().slice(0, 300) || null;
    if (req.body?.visibility != null) {
      if (!VISIBILITIES.includes(req.body.visibility))
        return bad(res, "Visibility must be private or public", "INVALID_VISIBILITY");
      patch.visibility = req.body.visibility;
    }
    if (!Object.keys(patch).length) return bad(res, "Nothing to update");

    const updated = await db
      .update(spaces)
      .set(patch)
      .where(eq(spaces.id, space.id))
      .returning();
    res.json(serializeSpace(updated[0], role));
  });

  app.delete("/spaces/:id", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "delete_space"))
      return forbidden(res, "Only the space owner can delete it");
    await db.delete(spaces).where(eq(spaces.id, space.id));
    res.status(204).end();
  });

  app.get("/spaces/:id/members", requireAuth, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "read_notes"))
      return forbidden(res, "Request access to see the roster", "NEEDS_REQUEST");

    const rows = await db
      .select({
        userId: users.id,
        handle: users.handle,
        color: users.color,
        role: spaceMembers.role,
        createdAt: spaceMembers.createdAt,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(spaceMembers.userId, users.id))
      .where(eq(spaceMembers.spaceId, space.id))
      .orderBy(asc(users.handle));

    res.json(rows);
  });

  /** Add somebody to a space directly, by handle, skipping the request queue. */
  app.post("/spaces/:id/members", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "manage_members"))
      return forbidden(res, "Only the space owner can add members");

    const handle = normalizeHandle(String(req.body?.handle || ""));
    if (!isValidHandle(handle))
      return bad(res, "That does not look like a handle", "INVALID_HANDLE");

    const requested = String(req.body?.role || "viewer");
    if (!ROLE_VALUES.includes(requested))
      return bad(res, `Role must be one of ${ROLE_VALUES.join(", ")}`, "INVALID_ROLE");

    // Same escalation rule as approving a request: moderators may hand out the
    // requestable tiers only, and minting a moderator or co-owner is owner-only.
    const granted = grantableRole(req.user, space, role, requested);
    if (!granted)
      return forbidden(res, "Only the owner can add a moderator or co-owner");

    const target = await db
      .select({ id: users.id, handle: users.handle })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    if (!target.length)
      return notFound(res, `Nobody here is called @${handle}`);
    if (target[0].id === req.user.id)
      return bad(res, "You are already in this space");

    const already = await db
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, space.id),
          eq(spaceMembers.userId, target[0].id),
        ),
      )
      .limit(1);
    if (already.length) {
      // Already a member. Say so with their current role rather than 409, so the
      // caller can offer "change their role instead" without a second lookup.
      return res.status(409).json({
        error: `@${handle} is already a member`,
        code: "ALREADY_MEMBER",
        userId: target[0].id,
        role: already[0].role,
      });
    }

    // A pending request becomes moot the moment they are added directly.
    await db.transaction(async (tx) => {
      await tx
        .insert(spaceMembers)
        .values({
          spaceId: space.id,
          userId: target[0].id,
          role: granted,
          addedBy: req.user.id,
          createdAt: now(),
        })
        .onConflictDoNothing();
      await tx
        .update(spaceRequests)
        .set({ status: "approved", resolvedAt: now(), resolvedBy: req.user.id })
        .where(
          and(
            eq(spaceRequests.spaceId, space.id),
            eq(spaceRequests.userId, target[0].id),
            eq(spaceRequests.status, "pending"),
          ),
        );
    });

    res.status(201).json({ userId: target[0].id, handle, role: granted });
  });

  app.patch("/spaces/:id/members/:userId", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "manage_members"))
      return forbidden(res, "Only the space owner can change roles");

    const targetId = Number(req.params.userId);
    const nextRole = String(req.body?.role || "");
    if (!ROLE_VALUES.includes(nextRole))
      return bad(res, `Role must be one of ${ROLE_VALUES.join(", ")}`, "INVALID_ROLE");
    if (targetId === space.ownerId)
      return bad(res, "The owner's role cannot be changed");

    const existing = await db
      .select()
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, space.id),
          eq(spaceMembers.userId, targetId),
        ),
      )
      .limit(1);
    if (!existing.length) return notFound(res, "That person is not a member");

    await db
      .update(spaceMembers)
      .set({ role: nextRole })
      .where(
        and(
          eq(spaceMembers.spaceId, space.id),
          eq(spaceMembers.userId, targetId),
        ),
      );
    res.json({ userId: targetId, role: nextRole });
  });

  app.delete("/spaces/:id/members/:userId", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "manage_members"))
      return forbidden(res, "Only the space owner can remove members");

    const targetId = Number(req.params.userId);
    if (targetId === space.ownerId) return bad(res, "The owner cannot be removed");
    await db
      .delete(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, space.id),
          eq(spaceMembers.userId, targetId),
        ),
      );
    res.status(204).end();
  });

  app.post("/spaces/:id/leave", requireAuth, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!role) return bad(res, "You are not a member of this space");
    if (role === "owner")
      return bad(res, "Transfer or delete the space instead of leaving it");
    await db
      .delete(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, space.id),
          eq(spaceMembers.userId, req.user.id),
        ),
      );
    res.status(204).end();
  });

  /* --------------------------- requests ------------------------- */

  app.post("/spaces/:id/requests", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    if (req.user.viaEnvToken) return bad(res, "Pick a registered account first");

    const requestedRole = String(req.body?.role || "viewer");
    if (!REQUESTABLE_ROLES.includes(requestedRole))
      return bad(
        res,
        `You can request ${REQUESTABLE_ROLES.join(" or ")} access`,
        "INVALID_ROLE",
      );

    const existingRole = await roleIn(space.id, req.user.id);
    if (existingRole) return res.status(409).json({ error: "Already a member", code: "ALREADY_MEMBER" });

    const message = req.body?.message
      ? String(req.body.message).trim().slice(0, MAX_MESSAGE) || null
      : null;

    // A public space already grants read access, so a viewer request is a
    // formality â€” grant it immediately instead of queueing it.
    if (space.visibility === "public" && requestedRole === "viewer") {
      await db
        .insert(spaceMembers)
        .values({
          spaceId: space.id,
          userId: req.user.id,
          role: "viewer",
          addedBy: null,
          createdAt: now(),
        })
        .onConflictDoUpdate({
          target: [spaceMembers.spaceId, spaceMembers.userId],
          set: { role: "viewer" },
        });
      return res.status(201).json({ approved: true, role: "viewer" });
    }

    const existing = await db
      .select({ id: spaceRequests.id })
      .from(spaceRequests)
      .where(
        and(
          eq(spaceRequests.spaceId, space.id),
          eq(spaceRequests.userId, req.user.id),
        ),
      )
      .limit(1);

    const values = {
      spaceId: space.id,
      userId: req.user.id,
      requestedRole,
      message,
      status: "pending",
      createdAt: now(),
      resolvedAt: null,
      resolvedBy: null,
    };

    if (existing.length) {
      const updated = await db
        .update(spaceRequests)
        .set(values)
        .where(eq(spaceRequests.id, existing[0].id))
        .returning();
      return res.json({ approved: false, request: updated[0] });
    }
    const inserted = await db.insert(spaceRequests).values(values).returning();
    res.status(201).json({ approved: false, request: inserted[0] });
  });

  app.get("/spaces/:id/requests", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "manage_requests"))
      return forbidden(res, "Only moderators can review access requests");

    const rows = await db
      .select({
        id: spaceRequests.id,
        requestedRole: spaceRequests.requestedRole,
        message: spaceRequests.message,
        status: spaceRequests.status,
        createdAt: spaceRequests.createdAt,
        resolvedAt: spaceRequests.resolvedAt,
        userId: users.id,
        handle: users.handle,
        color: users.color,
      })
      .from(spaceRequests)
      .innerJoin(users, eq(spaceRequests.userId, users.id))
      .where(eq(spaceRequests.spaceId, space.id))
      .orderBy(asc(spaceRequests.createdAt));

    const sorted = [...rows].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (b.status === "pending" && a.status !== "pending") return 1;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
    res.json(sorted);
  });

  /** Shared guard + load for the approve/deny endpoints. */
  async function loadRequestForModerator(req, res) {
    const rows = await db
      .select()
      .from(spaceRequests)
      .where(eq(spaceRequests.id, Number(req.params.id)))
      .limit(1);
    const request = rows[0];
    if (!request) {
      notFound(res, "Request not found");
      return null;
    }
    const space = await findSpace(request.spaceId);
    const role = await roleIn(request.spaceId, req.user.id);
    if (!allow(req.user, space, role, "manage_requests")) {
      forbidden(res, "Only moderators can review access requests");
      return null;
    }
    return { request, space, role };
  }

  app.post("/requests/:id/approve", requireAwake, async (req, res) => {
    const ctx = await loadRequestForModerator(req, res);
    if (!ctx) return;
    const { request, space, role } = ctx;

    if (request.status !== "pending")
      return res.status(409).json({ error: "Request already resolved", code: "RESOLVED" });
    if (request.userId === req.user.id)
      return bad(res, "You cannot approve your own request");

    const wanted = req.body?.role ? String(req.body.role) : request.requestedRole;
    if (!ROLE_VALUES.includes(wanted))
      return bad(res, `Role must be one of ${ROLE_VALUES.join(", ")}`, "INVALID_ROLE");

    // Moderators may only grant the requestable tiers; minting another
    // moderator or co-owner is owner-only.
    const granted = grantableRole(req.user, space, role, wanted);
    if (!granted)
      return forbidden(res, "Only the owner can grant moderator or owner");

    await db.transaction(async (tx) => {
      await tx
        .insert(spaceMembers)
        .values({
          spaceId: request.spaceId,
          userId: request.userId,
          role: granted,
          addedBy: req.user.id,
          createdAt: now(),
        })
        .onConflictDoUpdate({
          target: [spaceMembers.spaceId, spaceMembers.userId],
          set: { role: granted },
        });
      await tx
        .update(spaceRequests)
        .set({ status: "approved", resolvedAt: now(), resolvedBy: req.user.id })
        .where(eq(spaceRequests.id, request.id));
    });

    res.json({ request: { ...request, status: "approved" }, grantedRole: granted });
  });

  app.post("/requests/:id/deny", requireAwake, async (req, res) => {
    const ctx = await loadRequestForModerator(req, res);
    if (!ctx) return;
    const { request } = ctx;
    if (request.status !== "pending")
      return res.status(409).json({ error: "Request already resolved", code: "RESOLVED" });
    if (request.userId === req.user.id)
      return bad(res, "You cannot deny your own request");

    const updated = await db
      .update(spaceRequests)
      .set({ status: "denied", resolvedAt: now(), resolvedBy: req.user.id })
      .where(eq(spaceRequests.id, request.id))
      .returning();
    res.json({ request: updated[0] });
  });

  app.delete("/requests/:id", requireAuth, async (req, res) => {
    const rows = await db
      .select()
      .from(spaceRequests)
      .where(eq(spaceRequests.id, Number(req.params.id)))
      .limit(1);
    const request = rows[0];
    if (!request) return notFound(res, "Request not found");
    if (request.userId !== req.user.id)
      return forbidden(res, "You can only withdraw your own request");
    if (request.status !== "pending")
      return res.status(409).json({ error: "Request already resolved", code: "RESOLVED" });

    await db
      .update(spaceRequests)
      .set({ status: "cancelled", resolvedAt: now() })
      .where(eq(spaceRequests.id, request.id));
    res.status(204).end();
  });

  /* ---------------------------- notes --------------------------- */

  /** Shared access check for a note, resolving its space context. */
  async function noteContext(req, res) {
    const note = await findNote(req.params.id);
    if (!note) {
      notFound(res, "Note not found");
      return null;
    }
    // Refuse even to resolve a note a ghost should not be able to see. The
    // write checks below already refuse them; this keeps a guessed id from
    // confirming that a post exists after they left.
    if (isGhosted(req.user) && note.createdAt > req.user.ghostedAt) {
      forbidden(res, GHOST_MESSAGE, "GHOSTED");
      return null;
    }
    const space = note.spaceId ? await findSpace(note.spaceId) : null;
    const role = await roleIn(note.spaceId, req.user.id);
    return { note, space, role };
  }

  async function listNotes(res, { spaceId, req, limit, cursor }) {
    const where = and(
      spaceId == null ? isNull(notes.spaceId) : eq(notes.spaceId, spaceId),
      cursor ? lt(notes.id, cursor) : undefined,
      // A ghost sees nothing written after they ghosted.
      isGhosted(req.user) ? lte(notes.createdAt, req.user.ghostedAt) : undefined,
    );
    const rows = await db
      .select()
      .from(notes)
      .where(where)
      .orderBy(desc(notes.id))
      .limit(limit + 1);
    res.json(
      await paginate(rows, limit, {
        user: req.user,
        space: spaceId == null ? null : await findSpace(spaceId),
        role: await roleIn(spaceId, req.user.id),
      }),
    );
  }

  app.get("/notes", requireAuth, async (req, res) => {
    const { limit, cursor } = readPage(req);
    await listNotes(res, { spaceId: null, req, limit, cursor });
  });

  app.post("/notes", requireAwake, async (req, res) => {
    if (req.user.viaEnvToken) return bad(res, "Pick a registered account first");
    const title = String(req.body?.title || "").trim().slice(0, MAX_TITLE);
    const rawBody = String(req.body?.body || "").trim();
    if (!title && !rawBody) return bad(res, "A note needs a title or a body");

    const color = req.user.color;
    const body = rawBody ? `{% ${color} %}${rawBody}{% end %}` : "";
    const at = now();

    const inserted = await db
      .insert(notes)
      .values({
        spaceId: null,
        title,
        body,
        authorId: req.user.id,
        authorColor: color,
        authorHandle: req.user.handle,
        createdAt: at,
        updatedAt: at,
        history: "[]",
      })
      .returning();

    const tagged = await syncMentions({
      noteId: inserted[0].id,
      spaceId: null,
      authorId: req.user.id,
      body,
    });
    await autoInvite(null, tagged);

    const [decorated] = await decorate(inserted, {
      user: req.user,
      space: null,
      role: null,
    });
    res.status(201).json(decorated);
  });

  app.get("/spaces/:id/notes", requireAuth, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "read_notes"))
      return forbidden(res, `Request access to read ${space.name}`, "NEEDS_REQUEST");

    const { limit, cursor } = readPage(req);
    await listNotes(res, { spaceId: space.id, req, limit, cursor });
  });

  app.post("/spaces/:id/notes", requireAwake, async (req, res) => {
    const space = await findSpace(req.params.id);
    if (!space) return notFound(res, "Space not found");
    const role = await roleIn(space.id, req.user.id);
    if (!allow(req.user, space, role, "create_note"))
      return forbidden(res, `Request to participate in ${space.name}`, "NEEDS_REQUEST");
    if (req.user.viaEnvToken) return bad(res, "Pick a registered account first");

    const title = String(req.body?.title || "").trim().slice(0, MAX_TITLE);
    const rawBody = String(req.body?.body || "").trim();
    if (!title && !rawBody) return bad(res, "A note needs a title or a body");

    const body = rawBody ? `{% ${req.user.color} %}${rawBody}{% end %}` : "";
    const at = now();
    const inserted = await db
      .insert(notes)
      .values({
        spaceId: space.id,
        title,
        body,
        authorId: req.user.id,
        authorColor: req.user.color,
        authorHandle: req.user.handle,
        createdAt: at,
        updatedAt: at,
        history: "[]",
      })
      .returning();

    const tagged = await syncMentions({
      noteId: inserted[0].id,
      spaceId: space.id,
      authorId: req.user.id,
      body,
    });
    await autoInvite(space, tagged);

    const [decorated] = await decorate(inserted, {
      user: req.user,
      space,
      role,
    });
    res.status(201).json(decorated);
  });

  app.put("/notes/:id", requireAwake, async (req, res) => {
    const ctx = await noteContext(req, res);
    if (!ctx) return;
    const { note, space, role } = ctx;

    if (!notePerms(note, { user: req.user, space, role }).canEdit)
      return forbidden(
        res,
        note.authorId === req.user.id
          ? "You cannot edit this note"
          : "Only the author or a space moderator can edit this note",
      );

    const title = String(req.body?.title ?? note.title ?? "").trim().slice(0, MAX_TITLE);
    const body = String(req.body?.body ?? note.body ?? "").slice(0, MAX_BODY);

    const history = JSON.parse(note.history || "[]");
    history.push({
      title: note.title,
      body: note.body,
      updatedAt: note.updatedAt,
    });
    const trimmed = history.slice(-MAX_HISTORY);

    const updated = await db
      .update(notes)
      .set({
        title,
        body,
        history: JSON.stringify(trimmed),
        updatedAt: now(),
      })
      .where(eq(notes.id, note.id))
      .returning();

    const tagged = await syncMentions({
      noteId: note.id,
      spaceId: note.spaceId,
      authorId: note.authorId,
      body,
    });
    await autoInvite(space, tagged);

    const [decorated] = await decorate(updated, {
      user: req.user,
      space,
      role,
    });
    res.json(decorated);
  });

  app.put("/notes/:id/rollback", requireAwake, async (req, res) => {
    const ctx = await noteContext(req, res);
    if (!ctx) return;
    const { note, space, role } = ctx;

    if (!notePerms(note, { user: req.user, space, role }).canRollback)
      return forbidden(
        res,
        "Only the author or a space moderator can roll this note back",
      );

    const history = JSON.parse(note.history || "[]");
    if (!history.length)
      return bad(res, "No earlier revision to roll back to", "NO_HISTORY");

    const previous = history.pop();
    const updated = await db
      .update(notes)
      .set({
        title: previous.title ?? "",
        body: previous.body ?? "",
        history: JSON.stringify(history),
        updatedAt: now(),
      })
      .where(eq(notes.id, note.id))
      .returning();

    const tagged = await syncMentions({
      noteId: note.id,
      spaceId: note.spaceId,
      authorId: note.authorId,
      body: previous.body ?? "",
    });
    await autoInvite(space, tagged);

    const [decorated] = await decorate(updated, {
      user: req.user,
      space,
      role,
    });
    res.json(decorated);
  });

  /**
   * Note deletion authorisation.
   *
   * Allowed for: the author, a space moderator/owner, or an admin. A caller
   * that fails any of those gets 403 â€” the client merely hides the button.
   */
  app.delete("/notes/:id", requireAwake, async (req, res) => {
    const ctx = await noteContext(req, res);
    if (!ctx) return;
    const { note, space, role } = ctx;

    if (!notePerms(note, { user: req.user, space, role }).canDelete) {
      return forbidden(
        res,
        note.authorId == null
          ? "This note has no owner left; only an admin can delete it"
          : "Only the author or a space moderator can delete this note",
        "NOT_PERMITTED",
      );
    }

    await db.delete(notes).where(eq(notes.id, note.id));
    res.status(204).end();
  });

  /** Persist this user's bento size for one card. */
  app.put("/notes/:id/layout", requireAwake, async (req, res) => {
    const note = await findNote(req.params.id);
    if (!note) return notFound(res, "Note not found");

    const size = String(req.body?.size || "");
    if (!SIZES.includes(size))
      return bad(res, `Size must be one of ${SIZES.join(", ")}`, "INVALID_SIZE");

    const space = note.spaceId ? await findSpace(note.spaceId) : null;
    const role = await roleIn(note.spaceId, req.user.id);
    if (!allow(req.user, space, role, "read_notes"))
      return forbidden(res, "You cannot see this note", "NEEDS_REQUEST");
    if (req.user.viaEnvToken) return bad(res, "Pick a registered account first");

    const at = now();
    await db
      .insert(noteLayouts)
      .values({ noteId: note.id, userId: req.user.id, size, updatedAt: at })
      .onConflictDoUpdate({
        target: [noteLayouts.noteId, noteLayouts.userId],
        set: { size, updatedAt: at },
      });
    res.json({ noteId: note.id, size });
  });

  /* --------------------------- mentions ------------------------- */

  app.get("/mentions", requireAuth, async (req, res) => {
    const { limit, cursor } = readPage(req);
    const candidates = await db
      .select()
      .from(noteMentions)
      .where(
        and(
          eq(noteMentions.userId, req.user.id),
          cursor ? lt(noteMentions.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(noteMentions.id))
      .limit(limit + 1);

    if (!candidates.length)
      return res.json({ items: [], nextCursor: null, hasMore: false });

    const noteRows = await db
      .select()
      .from(notes)
      .where(inArray(notes.id, candidates.map((c) => c.noteId)));
    const noteMap = new Map(noteRows.map((n) => [n.id, n]));

    const spaceIds = [
      ...new Set(noteRows.map((n) => n.spaceId).filter((v) => v != null)),
    ];
    const spaceMap = new Map(
      spaceIds.length
        ? (await db.select().from(spaces).where(inArray(spaces.id, spaceIds))).map(
            (s) => [s.id, s],
          )
        : [],
    );
    const roles = await membershipMap(req.user.id);

    // Hide mentions the caller is not cleared to read (e.g. they later lost
    // access to a private space), and anything written since they ghosted.
    const readable = candidates.filter((c) => {
      const note = noteMap.get(c.noteId);
      if (!note) return false;
      if (note.authorId === req.user.id) return false;
      if (isGhosted(req.user) && note.createdAt > req.user.ghostedAt) return false;
      if (note.spaceId == null) return true;
      const space = spaceMap.get(note.spaceId);
      return allow(req.user, space, roles.get(note.spaceId) || null, "read_notes");
    });

    const hasMore = candidates.length > limit || readable.length > limit;
    const slice = hasMore ? readable.slice(0, limit) : readable;
    const decorated = await decorate(
      slice.map((c) => noteMap.get(c.noteId)).filter(Boolean),
      { user: req.user, space: null, role: null },
    );

    res.json({
      items: decorated.map((note) => ({
        note,
        mentionedAt: slice.find((c) => c.noteId === note.id)?.createdAt || null,
      })),
      nextCursor: hasMore && slice.length ? slice[slice.length - 1].id : null,
      hasMore,
    });
  });

  /* --------------------------- fallbacks ------------------------ */

  app.use((_req, res) => notFound(res, "No such endpoint"));

  app.use((err, _req, res, _next) => {
    console.error("[api]", err);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res
      .status(status)
      .json({ error: status === 500 ? "Internal server error" : err.message });
  });

  return app;
}

export default createApp;
