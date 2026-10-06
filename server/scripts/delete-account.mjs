/**
 * Deletes an account directly in the database, bypassing the API.
 *
 * This is the counterpart to `set-password.mjs`, and it exists for the same
 * reason: one situation the app deliberately offers no way out of.
 *
 * `DELETE /auth/me` demands the account's password. That is the right rule for
 * a browser, where the password is the difference between "the holder asked" and
 * "somebody walked up to an unlocked machine". But it means an account whose
 * password was never recorded, or was set by a test and then forgotten, can
 * never be removed by anyone at all. Test accounts accumulate exactly this way,
 * and they are not harmless: each one permanently burns a chalk colour
 * (`users.color` is UNIQUE) and sits in the mention autocomplete as a handle
 * nobody can claim or clear.
 *
 * There is no admin endpoint for this on purpose. The app has no moderation
 * lever over accounts — the same principle that made the ghost feature refuse
 * its `isAdmin` bypass — and this script is not that lever, because it needs
 * database credentials, which already mean total control of the deployment. It
 * is a way to not accumulate junk, not a way to remove people.
 *
 * The teardown itself is NOT reimplemented here. Both this script and the route
 * call `lib/account-deletion.js`, so the two cannot drift: a recovery path that
 * quietly stopped matching what the product promises would be worse than no
 * recovery path. The `OWNS_SPACES` and `LAST_ADMIN` guards therefore apply here
 * too, and neither can be overridden with a flag.
 *
 *   node server/scripts/delete-account.mjs <handle> [--dry-run] [--env <file>]
 *
 * `--dry-run` reports exactly what would be destroyed and stops.
 *
 * Notes the account wrote are kept, with its name greyed on them, exactly as
 * they would be through the UI. Its handle is retired and stays unclaimable.
 */
import { readFileSync } from "node:fs";
import { count as countRows, eq } from "drizzle-orm";

/** Loads a KEY=VALUE env file, for callers who keep secrets out of the shell. */
function loadEnvFile(path) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

/**
 * Argument parsing.
 *
 * Flags are filtered out rather than assumed to sit before the handle: the
 * usage line promises `--env <file>` and `--dry-run` in any order, and a
 * positional index that shifted depending on where the flag was written would
 * make `--env` silently mean something else.
 */
const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes("--dry-run");

let envFile = null;
let sawEnv = false;
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--env") {
    sawEnv = true;
    envFile = rawArgs[++i] ?? null;
  } else if (rawArgs[i] !== "--dry-run") {
    positional.push(rawArgs[i]);
  }
}

if (sawEnv && !envFile) {
  console.error("--env needs a file path");
  process.exit(1);
}
if (envFile) loadEnvFile(envFile);

const handle = String(positional[0] || "").trim().toLowerCase();

if (!handle || !/^[a-z0-9][a-z0-9._-]{1,30}$/.test(handle)) {
  console.error(
    "usage: node server/scripts/delete-account.mjs <handle> [--dry-run] [--env <file>]",
  );
  process.exit(1);
}

// Set before importing, because `lib/db.js` reads the URL at import time.
process.env.TURSO_DATABASE_URL =
  process.env.TURSO_DATABASE_URL || "file:local.db";

const { db, client } = await import("../../lib/db.js");
const { deleteAccountData } = await import("../../lib/account-deletion.js");
const { notes, noteThoughts, spaceMembers, spaceRequests, users, retiredHandles } =
  await import("../../lib/schema.js");

/**
 * Counts a user's rows in a table.
 *
 * A `count()` aggregate rather than selecting the rows: this only ever runs
 * against one account, but the shape of the answer should not depend on how many
 * rows it throws away.
 */
const count = async (table, column, value) => {
  const rows = await db
    .select({ n: countRows() })
    .from(table)
    .where(eq(column, value));
  return rows[0]?.n ?? 0;
};

try {
  // Checked before the account itself, and for a good reason: a handle that is
  // already in `retired_handles` means this account was deleted, so there is no
  // row left to find. Reporting that as "no account with handle" would be true
  // but useless — the operator would be left wondering whether the account ever
  // existed. The insert below would also fail on the primary key and roll the
  // whole transaction back, so this is caught here with the actual history
  // rather than left to a constraint violation.
  const prior = await db
    .select()
    .from(retiredHandles)
    .where(eq(retiredHandles.handle, handle))
    .limit(1);
  if (prior[0]) {
    console.error(
      `refusing: @${handle} was already deleted at ${prior[0].deletedAt} - the handle is retired and unclaimable`,
    );
    process.exit(1);
  }

  const found = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
  const user = found[0];
  if (!user) {
    console.error(`no account with handle ${JSON.stringify(handle)}`);
    process.exit(1);
  }

  // Reported before anything is removed, so the operator can see the shape of
  // what they are about to lose without having to remember it afterwards.
  const summary = {
    notesKept: await count(notes, notes.authorId, user.id),
    thoughtsKept: await count(noteThoughts, noteThoughts.authorId, user.id),
    memberships: await count(spaceMembers, spaceMembers.userId, user.id),
    requests: await count(spaceRequests, spaceRequests.userId, user.id),
  };

  console.log(`@${user.handle} (id ${user.id})`);
  console.log(`  notes kept, byline greyed: ${summary.notesKept}`);
  console.log(`  thoughts kept, greyed:     ${summary.thoughtsKept}`);
  console.log(`  memberships removed:       ${summary.memberships}`);
  console.log(`  requests removed:          ${summary.requests}`);

  if (dryRun) {
    console.log("\ndry run - nothing was changed");
    process.exit(0);
  }

  // Same transaction the route uses, so a partial teardown is impossible here
  // too.
  const result = await db.transaction((tx) => deleteAccountData(tx, user));
  if (!result.ok) {
    console.error(`\nrefused: ${result.error} (${result.code})`);
    process.exit(1);
  }

  console.log(`\ndeleted @${user.handle}`);
  console.log(`  their token is dead immediately and the password is gone`);
  console.log(`  @${user.handle} is retired and can never be registered again`);
} finally {
  client.close();
}
