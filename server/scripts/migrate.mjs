#!/usr/bin/env node
/**
 * Idempotent schema migration.
 *
 * Bootstraps an empty database and upgrades the legacy (pre-identity) schema in
 * one idempotent pass, so `npm run dev` and the test suite need no drizzle-kit
 * step. Safe to run repeatedly.
 *
 * Legacy -> current:
 *   - notes.author_id  TEXT uuid   -> INTEGER FK -> users.id
 *   - notes gains space_id          -> NULL means the public "Lobby"
 *   - notes drops the unused editor_color column
 *   - new: users, spaces, space_members, space_requests, note_mentions,
 *          note_layouts
 *   - users gains ghosted_at    -> NULL means a live account
 *   - notes gains author_handle  -> the byline a note keeps after its author
 *                                   deletes their account
 *   - new: retired_handles       -> deleted accounts' handles, unclaimable
 *   - new: note_thoughts         -> every card's attributed thoughts; the
 *                                   author's opening is backfilled from the
 *                                   note's own fields
 *   - new: note_deletion_votes   -> contributors' consent to delete a shared
 *                                   card, collected before the author may
 *                                   remove it
 *
 * Legacy notes keep an "archived author" placeholder user keyed off the old
 * uuid prefix. Because those users have no known credential, only an admin can
 * delete their notes afterwards — which is the honest outcome.
 */
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { stripMarkup } from "../../lib/richtext.js";

const BOOTSTRAP = [
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     handle TEXT NOT NULL UNIQUE,
     display_name TEXT,
     color TEXT NOT NULL UNIQUE,
     token_hash TEXT NOT NULL UNIQUE,
     password_hash TEXT,
     is_admin INTEGER NOT NULL DEFAULT 0,
     ghosted_at TEXT,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS spaces (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     slug TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     description TEXT,
     owner_id INTEGER NOT NULL REFERENCES users(id),
     visibility TEXT NOT NULL DEFAULT 'private',
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS space_members (
     space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL,
     added_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL,
     PRIMARY KEY (space_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS space_members_user_idx ON space_members(user_id)`,

  `CREATE TABLE IF NOT EXISTS space_requests (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     requested_role TEXT NOT NULL,
     message TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TEXT NOT NULL,
     resolved_at TEXT,
     resolved_by INTEGER REFERENCES users(id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS space_requests_unique ON space_requests(space_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS space_requests_space_idx ON space_requests(space_id, status)`,
  `CREATE INDEX IF NOT EXISTS space_requests_user_idx ON space_requests(user_id, status)`,

  `CREATE TABLE IF NOT EXISTS notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     space_id INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
     title TEXT,
     body TEXT,
     author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     author_color TEXT,
     author_handle TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     history TEXT NOT NULL DEFAULT '[]'
   )`,

  // Handles of deleted accounts, kept unclaimable so a grey byline cannot be
  // impersonated by whoever registers the name next.
  `CREATE TABLE IF NOT EXISTS retired_handles (
     handle TEXT PRIMARY KEY,
     deleted_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS note_mentions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     mentioned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     space_id INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS note_mentions_unique ON note_mentions(note_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS note_mentions_user_idx ON note_mentions(user_id)`,
  `CREATE INDEX IF NOT EXISTS note_mentions_space_idx ON note_mentions(space_id)`,

  `CREATE TABLE IF NOT EXISTS note_layouts (
     note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     size TEXT NOT NULL DEFAULT 'small',
     updated_at TEXT NOT NULL,
     PRIMARY KEY (note_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS note_layouts_user_idx ON note_layouts(user_id)`,

  // Every card's attributed thoughts: the author's opening plus appends by
  // others. The first row of each note is backfilled by `ensureThoughts`; the
  // note's body is the derived concatenation.
  `CREATE TABLE IF NOT EXISTS note_thoughts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     author_handle TEXT NOT NULL,
     color TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS note_thoughts_note_idx ON note_thoughts(note_id, id)`,

  // Contributor consent to delete a card that carries other people's thoughts.
  // A row means "this contributor agrees the card should go". At least half of
  // the other live contributors must consent before the author may remove it;
  // admins and space moderators bypass the poll (see the delete route).
  `CREATE TABLE IF NOT EXISTS note_deletion_votes (
     note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     PRIMARY KEY (note_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS note_deletion_votes_note_idx ON note_deletion_votes(note_id)`,

  // Shared throttles, so one serverless instance's budget is everyone's. A row
  // is (key, window_start, count) for a fixed window; see lib/schema.js.
  `CREATE TABLE IF NOT EXISTS rate_limits (
     key TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   )`,
  // Lightweight audit trail for privileged mutations; see lib/schema.js.
  `CREATE TABLE IF NOT EXISTS admin_actions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     actor_id INTEGER,
     actor_role TEXT NOT NULL,
     action TEXT NOT NULL,
     details TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

async function tableExists(client, name) {
  const r = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return r.rows.length > 0;
}

async function columnExists(client, table, column) {
  if (!(await tableExists(client, table))) return false;
  const r = await client.execute(
    `SELECT name FROM pragma_table_info(?) WHERE name = ?`,
    [table, column],
  );
  return r.rows.length > 0;
}

/**
 * Rebuilds `notes` into the current shape, mapping legacy uuid authors onto
 * placeholder users. No-ops unless the legacy `editor_color` column is present.
 */
async function upgradeNotes(client, log) {
  if (!(await columnExists(client, "notes", "editor_color"))) {
    log("notes already current");
    return;
  }

  log("detected legacy notes table — rebuilding");

  // Must run outside a transaction to take effect.
  await client.execute("PRAGMA foreign_keys = OFF");
  await client.execute("DROP TABLE IF EXISTS notes_legacy_migration_tmp");

  // Archived authors. INSERT OR IGNORE keeps this safe when two legacy uuids
  // share a colour (users.color is UNIQUE): the second author's notes simply
  // end up with a NULL author, admin-only.
  await client.execute(`
    INSERT OR IGNORE INTO users (handle, display_name, color, token_hash, is_admin, created_at)
    SELECT
      'anon-' || substr(n.author_id, 1, 12),
      'Archived author',
      COALESCE(NULLIF(n.author_color, ''), '#8899aa'),
      lower(hex(randomblob(24))),
      0,
      COALESCE(n.created_at, datetime('now'))
    FROM notes n
    WHERE n.author_id IS NOT NULL AND n.author_id <> ''
    GROUP BY substr(n.author_id, 1, 12)
  `);

  await client.execute(`
    CREATE TABLE notes_legacy_migration_tmp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
      title TEXT,
      body TEXT,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      history TEXT NOT NULL DEFAULT '[]'
    )
  `);

  // Rows whose author mapped to a placeholder user.
  await client.execute(`
    INSERT INTO notes_legacy_migration_tmp
      (id, title, body, author_id, author_color, created_at, updated_at, history)
    SELECT
      n.id, n.title, n.body,
      (SELECT u.id FROM users u
        WHERE u.handle = 'anon-' || substr(n.author_id, 1, 12)),
      n.author_color,
      COALESCE(n.created_at, datetime('now')),
      COALESCE(n.updated_at, n.created_at, datetime('now')),
      COALESCE(n.history, '[]')
    FROM notes n
    WHERE n.author_id IS NOT NULL AND n.author_id <> ''
  `);

  // Rows that were already anonymous.
  await client.execute(`
    INSERT INTO notes_legacy_migration_tmp
      (id, title, body, author_id, author_color, created_at, updated_at, history)
    SELECT
      n.id, n.title, n.body, NULL, n.author_color,
      COALESCE(n.created_at, datetime('now')),
      COALESCE(n.updated_at, n.created_at, datetime('now')),
      COALESCE(n.history, '[]')
    FROM notes n
    WHERE n.author_id IS NULL OR n.author_id = ''
  `);

  await client.execute("DROP TABLE notes");
  await client.execute(
    "ALTER TABLE notes_legacy_migration_tmp RENAME TO notes",
  );

  await client.execute(
    "DELETE FROM sqlite_sequence WHERE name IN ('notes', 'notes_legacy_migration_tmp')",
  );
  await client.execute(
    "INSERT INTO sqlite_sequence (name, seq) SELECT 'notes', COALESCE(MAX(id), 0) FROM notes",
  );

  await client.execute("PRAGMA foreign_keys = ON");
}

/**
 * Adds `users.password_hash` to a database created before passwords existed.
 *
 * Nullable on purpose: SQLite cannot add a NOT NULL column without a default,
 * and the anon-* placeholders genuinely have no credential. NULL is the
 * accurate representation of "this account cannot sign in".
 */
async function ensurePasswordColumn(client, log) {
  if (await columnExists(client, "users", "password_hash")) {
    log("users.password_hash already present");
    return;
  }
  log("adding users.password_hash");
  await client.execute("ALTER TABLE users ADD COLUMN password_hash TEXT");
}

/**
 * Adds `users.ghosted_at` for databases created before "Ghost In Time".
 *
 * Nullable with no default: an existing row has NULL, which is the live state,
 * so no backfill is needed and no account is accidentally frozen by an upgrade.
 */
async function ensureGhostColumn(client, log) {
  if (await columnExists(client, "users", "ghosted_at")) {
    log("users.ghosted_at already present");
    return;
  }
  log("adding users.ghosted_at");
  await client.execute("ALTER TABLE users ADD COLUMN ghosted_at TEXT");
}

/**
 * Adds `notes.author_handle` and backfills it from the author still on record.
 *
 * The column is the byline a note keeps after its author deletes their account,
 * so the backfill matters: without it every note already on the board would
 * collapse to "archived" the first time somebody left. Runs after
 * `upgradeNotes`, which is what creates the anon-* placeholder users the
 * backfill reads from.
 */
async function ensureAuthorHandleColumn(client, log) {
  if (await columnExists(client, "notes", "author_handle")) {
    log("notes.author_handle already present");
    return;
  }
  log("adding notes.author_handle");
  await client.execute("ALTER TABLE notes ADD COLUMN author_handle TEXT");
  // Only for rows that still have an author; the authorless legacy notes keep a
  // NULL handle, which is what distinguishes them from a departed author.
  await client.execute(`
    UPDATE notes SET author_handle = (
      SELECT u.handle FROM users u WHERE u.id = notes.author_id
    )
    WHERE author_id IS NOT NULL
  `);
}

/**
 * The `notes` indexes can only be created once the table is in its current
 * shape, so this runs after `upgradeNotes` rather than as part of the
 * bootstrap. Against a fresh database the table is already correct.
 */
async function ensureNoteIndexes(client) {
  await client.execute(
    "CREATE INDEX IF NOT EXISTS notes_space_idx ON notes(space_id, created_at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS notes_author_idx ON notes(author_id)",
  );
}

/**
 * Backfills the opening thought for every note that predates `note_thoughts`.
 *
 * Idempotent: notes that already have a thought row are left alone. The
 * opening thought is the note author's, so the row mirrors the note's own
 * snapshot fields, and its text is the body with colour markup stripped —
 * `notes.body` is the derived concatenation and stays as it was stored.
 */
async function ensureThoughts(client, log) {
  const withThought = await client.execute(
    "SELECT note_id FROM note_thoughts GROUP BY note_id",
  );
  const done = new Set(withThought.rows.map((r) => r.note_id));
  const rows = await client.execute(`
    SELECT id, author_id, author_handle, author_color, body, created_at, updated_at
    FROM notes
  `);

  let added = 0;
  for (const n of rows.rows) {
    if (done.has(n.id)) continue;
    await client.execute(
      `INSERT INTO note_thoughts
         (note_id, author_id, author_handle, color, text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        n.id,
        n.author_id,
        n.author_handle || "",
        n.author_color || "#8899aa",
        stripMarkup(n.body || ""),
        n.created_at,
        n.updated_at,
      ],
    );
    added += 1;
  }
  log(added ? `backfilled ${added} opening thoughts` : "opening thoughts already present");
}

export async function migrate({ log = () => {} } = {}) {
  const url = process.env.TURSO_DATABASE_URL || "file:local.db";
  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });

  try {
    log(`migrating ${url}`);
    for (const sql of BOOTSTRAP) await client.execute(sql);
    await upgradeNotes(client, log);
    await ensurePasswordColumn(client, log);
    await ensureGhostColumn(client, log);
    await ensureAuthorHandleColumn(client, log);
    await ensureNoteIndexes(client);
    await ensureThoughts(client, log);
    log("migration complete");
  } finally {
    client.close();
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  migrate({ log: (m) => console.log(`[migrate] ${m}`) }).catch((err) => {
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
}
