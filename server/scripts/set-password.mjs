/**
 * Sets an account's password directly in the database, bypassing the API.
 *
 * This is the recovery path for the one situation the app offers no way out of:
 * an account whose password has been forgotten. There is no email, no reset
 * token and no second factor, so if the only admin forgets their password the
 * account is otherwise gone for good.
 *
 * It requires database credentials, which already means total control of the
 * deployment, so this is not a way to escalate — it is a way to not lose data.
 *
 *   TABLOID_NEW_PASSWORD='...' node server/scripts/set-password.mjs tatati
 *
 * The password is read from the environment rather than an argument so it does
 * not end up in shell history.
 *
 * Admin is not auto-bootstrapped anymore: only the ADMIN_HANDLE handle
 * (default `tatati`) may act as admin, and only while its row says is_admin=1.
 * Grant or revoke that marker here:
 *
 *   TABLOID_NEW_PASSWORD='...' node server/scripts/set-password.mjs tatati --grant-admin
 *   node server/scripts/set-password.mjs tatati --revoke-admin
 *
 * With --grant-admin the token is NOT rotated (no password is being set), so a
 * holder who is already signed in keeps their session.
 *
 * The account's token is rotated at the same time as a password change and
 * deliberately NOT printed. Anyone using this script is doing so because they
 * cannot sign in, which very often means the session is in a state they do not
 * trust — leaving the old token alive would defeat the point. The new token is
 * discarded; the account signs in with the password and gets a fresh one.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

import { generateToken, hashPassword, hashToken, isAcceptablePassword, PASSWORD_MAX, PASSWORD_MIN } from "../../lib/auth.js";

/** Loads a KEY=VALUE env file, for callers who keep secrets out of the shell. */
function loadEnvFile(path) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const argv = process.argv.slice(2);
const envFileIndex = argv.indexOf("--env");
if (envFileIndex !== -1) {
  loadEnvFile(argv[envFileIndex + 1]);
  argv.splice(envFileIndex, 2);
}

const handle = String(argv[0] || "").trim().toLowerCase();
const password = process.env.TABLOID_NEW_PASSWORD;
const grantAdmin = argv.includes("--grant-admin");
const revokeAdmin = argv.includes("--revoke-admin");
const changingPassword = !grantAdmin && !revokeAdmin;

if (!handle || !/^[a-z0-9][a-z0-9._-]{1,30}$/.test(handle)) {
  console.error(
    "usage: TABLOID_NEW_PASSWORD='...' node server/scripts/set-password.mjs <handle> [--env <file>] [--grant-admin | --revoke-admin]",
  );
  process.exit(1);
}

if (grantAdmin && revokeAdmin) {
  console.error("--grant-admin and --revoke-admin are mutually exclusive");
  process.exit(1);
}

if (changingPassword && !isAcceptablePassword(password)) {
  // Never echo the value, only the requirement.
  console.error(
    `TABLOID_NEW_PASSWORD must be a string of ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
  );
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:local.db",
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

try {
  const found = await db.execute({
    sql: "select id, handle, is_admin from users where handle = ?",
    args: [handle],
  });

  if (found.rows.length === 0) {
    console.error(`no account with handle ${JSON.stringify(handle)}`);
    process.exit(1);
  }

  const user = found.rows[0];

if (grantAdmin || revokeAdmin) {
  const granting = grantAdmin ? 1 : 0;
  await db.execute({
    sql: "update users set is_admin = ? where id = ?",
    args: [granting, user.id],
  });
  console.log(
    `${grantAdmin ? "granted" : "revoked"} admin on @${user.handle}` +
      (grantAdmin
        ? " — make sure ADMIN_HANDLE (default: tatati) names this account, or the role stays dormant."
        : ""),
  );
} else {
  // The token is thrown away on purpose. See the note at the top of the file.
  const replacement = generateToken();

  await db.execute({
    sql: "update users set password_hash = ?, token_hash = ? where id = ?",
    args: [await hashPassword(password), hashToken(replacement), user.id],
  });

  console.log(`password set for @${user.handle} (admin: ${user.is_admin ? "yes" : "no"})`);
  console.log("their existing token has been revoked and discarded - sign in with the password");
}
} finally {
  db.close();
}