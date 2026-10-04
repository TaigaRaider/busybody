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

/* ----------------------------- passwords ----------------------------- */

/**
 * Password hashing via scrypt from node:crypto.
 *
 * Deliberately NOT the SHA-256 used for tokens. A token is 256 bits of CSPRNG
 * output, so there is nothing to enumerate; a password is low-entropy, and a
 * fast digest would let anyone holding a stolen database test billions of
 * guesses per second. scrypt is memory-hard and already built into Node, so it
 * costs no dependency and no native build step on Vercel.
 */

const SCRYPT_N = 32768; // 2^15 — ~32 MB of memory per hash
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt needs about 128 * N * r bytes; Node's default maxmem is too tight.
const MAXMEM = 256 * SCRYPT_N * SCRYPT_R;
// Refuse absurd parameters from a tampered row rather than trying to honour
// them and hanging the function on a memory bomb.
const MAX_N = 1 << 20;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** @returns {Promise<string>} `scrypt$N$r$p$salt$hash`, all base64 where binary */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * Constant-time check. A null `stored` means the account has no password
 * credential — the anon-* placeholders from the legacy migration — and can
 * never sign in, which is the honest outcome for an unattributable author.
 */
export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 1 || N > MAX_N || r <= 0 || p <= 0) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, so guard before comparing.
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function isAcceptablePassword(password) {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN &&
    password.length <= PASSWORD_MAX
  );
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
