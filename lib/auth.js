import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { users } from "./schema.js";

/**
 * Bearer-token identity.
 *
 * Registration mints a 256-bit random token; only its SHA-256 hash is stored.
 * Presenting the token looks the user up by hash, so a user id can never be
 * forged the way the old scheme (client-side UUID used *as* the credential)
 * allowed. `ADMIN_TOKEN` remains supported as an env-based superuser for
 * operational access.
 */

export const ADMIN_SENTINEL = {
  id: -1,
  handle: "admin",
  displayName: "Administrator",
  color: "#e5c07b",
  isAdmin: 1,
  viaEnvToken: true,
};

export function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function readBearer(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/** @returns {Promise<object|null>} the caller, or null when unauthenticated */
export async function resolveUser(req) {
  const token = readBearer(req);
  if (!token) return null;

  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && token === adminToken) return ADMIN_SENTINEL;

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.tokenHash, hashToken(token)))
    .limit(1);
  return rows[0] || null;
}

/** Attaches `req.user` when a valid token is present, but never rejects. */
export async function attachUser(req, _res, next) {
  try {
    req.user = await resolveUser(req);
    next();
  } catch (err) {
    next(err);
  }
}

/** Rejects with 401 unless a valid token was supplied. */
export function requireAuth(req, res, next) {
  if (!req.user)
    return res.status(401).json({ error: "Sign in required", code: "UNAUTHENTICATED" });
  next();
}
