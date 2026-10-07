import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Canonical schema for the whole app.
 *
 * Imported by the API, the local dev server and drizzle-kit. Previously this
 * file was duplicated (and drifted) between `server/src/db/schema.js` and
 * `api/index.js`.
 */

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Always stored lowercase; uniqueness is enforced by the DB.
  handle: text("handle").notNull().unique(),
  displayName: text("display_name"),
  // Always stored as lowercase #rrggbb; one chalk per user, enforced by the DB.
  color: text("color").notNull().unique(),
  // sha256 hex of the bearer token. The raw token is only ever returned once,
  // at registration / login / rotation time, and is never stored.
  tokenHash: text("token_hash").notNull().unique(),
  // scrypt-encoded password. Nullable because the anon-* placeholders created
  // by the legacy migration carry authorship but have no credential and so can
  // never authenticate. Every account created through the API has one.
  passwordHash: text("password_hash"),
  isAdmin: integer("is_admin").notNull().default(0),
  // Set when the holder ghosts themselves; NULL for a live account. It is a
  // timestamp rather than a boolean because "the board as of the moment you
  // left" is exactly what a ghost can see - see `ghostCutoff` in lib/app.js.
  ghostedAt: text("ghosted_at"),
  createdAt: text("created_at").notNull(),
});

export const spaces = sqliteTable("spaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => users.id),
  // "private" => non-members see metadata only, must request access
  // "public"  => non-members may read notes without joining
  visibility: text("visibility").notNull().default("private"),
  createdAt: text("created_at").notNull(),
});

export const spaceMembers = sqliteTable(
  "space_members",
  {
    spaceId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // viewer | participant | moderator | owner
    role: text("role").notNull(),
    addedBy: integer("added_by").references(() => users.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index("space_members_user_idx").on(t.userId),
  ],
);

export const spaceRequests = sqliteTable(
  "space_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    spaceId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // viewer | participant  (escalation to moderator/owner is never requestable)
    requestedRole: text("requested_role").notNull(),
    message: text("message"),
    // pending | approved | denied | cancelled
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolvedBy: integer("resolved_by").references(() => users.id),
  },
  (t) => [
    // One request row per (space, user); re-requesting updates it in place.
    uniqueIndex("space_requests_unique").on(t.spaceId, t.userId),
    index("space_requests_space_idx").on(t.spaceId, t.status),
    index("space_requests_user_idx").on(t.userId, t.status),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // null => the public "Lobby"
    spaceId: integer("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    title: text("title"),
    body: text("body"),
    authorId: integer("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Snapshot of the author's chalk at write time, so old notes keep their
    // colour even if the user later changes theirs.
    authorColor: text("author_color"),
    // Snapshot of the author's handle for the same reason, and for a second one:
    // an account can be deleted, and the byline has to survive that as a
    // departed author rather than collapsing to "archived". Set alongside
    // authorColor on every insert, so `authorId === null && authorHandle` is
    // exactly "the author deleted their account", and both null means a note
    // that never had one (the legacy authorless rows).
    authorHandle: text("author_handle"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // JSON array of previous revisions, capped server-side.
    history: text("history").notNull().default("[]"),
  },
  (t) => [
    index("notes_space_idx").on(t.spaceId, t.createdAt),
    index("notes_author_idx").on(t.authorId),
  ],
);

/**
 * Durable record of `@handle` tags. The literal `@handle` text also stays in
 * the note body so tags survive edits and render inline; this table is the
 * queryable source of truth used for the mentions feed and for permission
 * filtered lookups.
 */
export const noteMentions = sqliteTable(
  "note_mentions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mentionedBy: integer("mentioned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Denormalised from the note so the mentions feed can filter by access
    // without joining notes.
    spaceId: integer("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("note_mentions_unique").on(t.noteId, t.userId),
    index("note_mentions_user_idx").on(t.userId),
    index("note_mentions_space_idx").on(t.spaceId),
  ],
);

/**
 * Attributed thoughts appended to a card.
 *
 * A card is not one person's canvas: anyone who may post in its room can
 * append their own thought to it, and that thought stays theirs. The first
 * row of a note is its "opening thought" (the author's, backfilled by the
 * migration); the rest are appends. Each row keeps a handle + chalk snapshot
 * so a thought's byline outlives its author, exactly like `notes.author_*`.
 * `notes.body` is the derived, colour-marked concatenation of these rows —
 * the server recomputes it on every write, so the cache cannot drift.
 */
export const noteThoughts = sqliteTable(
  "note_thoughts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    // NULL after the author deletes their account; the snapshot columns keep
    // the grey byline standing, as they do on `notes`.
    authorId: integer("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorHandle: text("author_handle").notNull(),
    color: text("color").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("note_thoughts_note_idx").on(t.noteId, t.id),
  ],
);

/**
 * Consent to delete a card that carries other people's thoughts.
 *
 * Deleting a card erases every thought on it, so it is not the author's alone
 * to decide once other contributors have written on it: each contributor may
 * record consent, and the card may be removed once at least half of the *other*
 * live contributors have agreed (the requester's own agreement is implicit and
 * never counted). Admins and space moderators bypass the poll entirely — see
 * the delete route. A row here means "this contributor consents"; rows cascade
 * away with the card and are deleted with a departing account's other records.
 */
export const noteDeletionVotes = sqliteTable(
  "note_deletion_votes",
  {
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.userId] }),
    index("note_deletion_votes_note_idx").on(t.noteId),
  ],
);

/**
 * Per-user bento board layout. Resizing a card is a personal arrangement, so
 * the size lives against (note, user) rather than on the note itself — one
 * user's board reshuffle never disturbs anyone else's.
 */
export const noteLayouts = sqliteTable(
  "note_layouts",
  {
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    size: text("size").notNull().default("small"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.userId] }),
    index("note_layouts_user_idx").on(t.userId),
  ],
);

/**
 * Handles belonging to accounts that have been deleted.
 *
 * This exists so a departed author's name cannot be impersonated. Their notes
 * keep the byline `@handle` in grey, and if registration were free to hand that
 * handle to somebody else, a new account would appear on those old notes as
 * though it had written them. The name is a historical fact about a note, so it
 * stays unclaimable.
 */
export const retiredHandles = sqliteTable("retired_handles", {
  handle: text("handle").primaryKey(),
  deletedAt: text("deleted_at").notNull(),
});

/**
 * DB-backed request throttles.
 *
 * The login limiter used to live in process memory, which on serverless only
 * covered whichever warm instance served the request — a speed bump, not a
 * guarantee. A shared counter in the database is the same speed bump applied
 * everywhere at once, and it extends to the write routes that previously had
 * no throttle at all. A row is `(key, window_start, count)` for a fixed
 * window; `key` encodes what is being throttled (`login|ip|handle`, `reg|ip`,
 * `notes|<user>`, ...) so one budget never drains another.
 */
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});

/**
 * Who did what, when.
 *
 * Only privileged mutations are recorded — the actions a board would need to
 * reconstruct if someone abused them: deleting or editing a card that is not
 * one's own, changing membership, resolving requests, deleting a space. The
 * env ADMIN_TOKEN has no user row, so `actor_id` is nullable when the act was
 * done by the operator key; `actor_role` is a human-readable label computed at
 * write time.
 */
export const adminActions = sqliteTable("admin_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorId: integer("actor_id"),
  actorRole: text("actor_role").notNull(),
  action: text("action").notNull(),
  details: text("details").notNull(),
  createdAt: text("created_at").notNull(),
});

export const ROLE_VALUES = ["viewer", "participant", "moderator", "owner"];
export const REQUESTABLE_ROLES = ["viewer", "participant"];
export const VISIBILITIES = ["private", "public"];
export const SIZES = ["small", "wide", "tall", "big"];
export const DEFAULT_SIZE = "small";
