import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { createClient } from "@libsql/client";

import { clientFor } from "./helpers.js";

/**
 * The legacy (pre-identity) upgrade path: a `notes` table with a text
 * `author_id` uuid and an unused `editor_color` column, which has to be
 * rebuilt in place without losing rows.
 */
const LEGACY_SCHEMA = `
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    body TEXT,
    created_at TEXT,
    updated_at TEXT,
    author_color TEXT,
    author_id TEXT,
    editor_color TEXT,
    history TEXT
  );
`;

async function seedLegacy(dbPath) {
  const db = createClient({ url: `file:${dbPath}` });
  await db.execute(LEGACY_SCHEMA);
  await db.execute(
    `INSERT INTO notes (id, title, body, created_at, updated_at, author_color, author_id, editor_color, history)
     VALUES (1, 'old one', '{% #e06c75 %}first note{% end %}', '2024-01-01T00:00:00.000Z',
             '2024-01-01T00:00:00.000Z', '#e06c75', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '#61afef', '[]')`,
  );
  await db.execute(
    `INSERT INTO notes (id, title, body, created_at, updated_at, author_color, author_id, editor_color, history)
     VALUES (2, 'old two', '{% #98c379 %}second note{% end %}', '2024-02-01T00:00:00.000Z',
             '2024-02-02T00:00:00.000Z', '#98c379', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '#61afef', '[]')`,
  );
  await db.execute(
    `INSERT INTO notes (id, title, body, created_at, updated_at, author_color, author_id, editor_color, history)
     VALUES (7, 'anonymous', 'no author at all', NULL, NULL, '#c678dd', NULL, '#61afef', '[]')`,
  );
  db.close();
}

describe("legacy migration", () => {
  let dir;
  let dbPath;
  let db;
  let server;
  let admin;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "tabloid-migrate-"));
    dbPath = join(dir, "legacy.db");
    await seedLegacy(dbPath);

    process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
    process.env.TURSO_AUTH_TOKEN = "";
    process.env.ADMIN_TOKEN = "test-admin-token";
    process.env.CORS_ORIGIN = "*";

    const { migrate } = await import("../server/scripts/migrate.mjs");
    await migrate();

    db = createClient({ url: `file:${dbPath}` });

    const dbModule = await import("../lib/db.js");
    const { createApp } = await import("../lib/app.js");
    server = createApp().listen(0);
    await once(server, "listening");
    admin = clientFor(`http://127.0.0.1:${server.address().port}`, "test-admin-token");

    globalThis.__testDb = dbModule;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    globalThis.__testDb?.client?.close();
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS reclaims the temp dir */
    }
  });

  const columns = async (table) => {
    const rows = await db.execute(`SELECT name FROM pragma_table_info(?)`, [table]);
    return rows.rows.map((r) => r.name);
  };

  it("creates every table the app needs", async () => {
    const tables = await db.execute(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    );
    const names = tables.rows.map((r) => r.name);
    for (const expected of [
      "users",
      "spaces",
      "space_members",
      "space_requests",
      "notes",
      "note_mentions",
      "note_layouts",
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
  });

  it("drops the legacy columns and adds space_id", async () => {
    const cols = await columns("notes");
    assert.ok(!cols.includes("editor_color"), "editor_color should be gone");
    assert.ok(cols.includes("space_id"));
    assert.ok(cols.includes("author_id"));
  });

  it("keeps every legacy note with its id and body", async () => {
    const rows = await db.execute(
      `SELECT id, title, body, space_id, author_color FROM notes ORDER BY id`,
    );
    assert.equal(rows.rows.length, 3);
    assert.equal(rows.rows[0].id, 1);
    assert.equal(rows.rows[0].title, "old one");
    assert.ok(rows.rows[0].body.includes("first note"));
    // legacy notes belong to no space, i.e. the Lobby
    assert.equal(rows.rows[0].space_id, null);
    // ids, including a gap, are preserved
    assert.equal(rows.rows[2].id, 7);
  });

  it("maps a legacy uuid author onto a single placeholder account", async () => {
    const rows = await db.execute(
      `SELECT n.id, n.author_id, u.handle, u.display_name
       FROM notes n LEFT JOIN users u ON u.id = n.author_id
       WHERE n.id IN (1, 2) ORDER BY n.id`,
    );
    assert.equal(rows.rows[0].handle, rows.rows[1].handle, "one account, not two");
    // 12-character prefix of the legacy uuid
    assert.equal(rows.rows[0].handle, "anon-aaaaaaaa-bbb");
    assert.equal(rows.rows[0].display_name, "Archived author");
  });

  it("leaves notes that never had an author as admin-only", async () => {
    const rows = await db.execute(`SELECT author_id FROM notes WHERE id = 7`);
    assert.equal(rows.rows[0].author_id, null);
  });

  it("substitutes a timestamp when the legacy row had none", async () => {
    const rows = await db.execute(`SELECT created_at, updated_at FROM notes WHERE id = 7`);
    assert.ok(rows.rows[0].created_at, "created_at must not be null");
    assert.ok(rows.rows[0].updated_at);
  });

  it("fixes the autoincrement sequence past the highest id", async () => {
    const created = await admin.post("/notes", { title: "new", body: "after migration" });
    assert.equal(created.status, 400, "the env admin may not post");
    const row = await db.execute(`SELECT seq FROM sqlite_sequence WHERE name='notes'`);
    assert.ok(Number(row.rows[0].seq) >= 7, `seq was ${row.rows[0].seq}`);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const { migrate } = await import("../server/scripts/migrate.mjs");
    await migrate();
    const rows = await db.execute(`SELECT COUNT(*) AS n FROM notes`);
    assert.equal(rows.rows[0].n, 3);
    const users = await db.execute(`SELECT COUNT(*) AS n FROM users`);
    assert.equal(users.rows[0].n, 1, "must not duplicate placeholder users");
  });

  it("serves the migrated notes over the API", async () => {
    const res = await admin.get("/notes");
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 3);
    assert.equal(res.body.items.find((n) => n.id === 7).author, null);
  });

  it("locks archived notes against ordinary accounts", async () => {
    // Placeholder users have no credential, so only a superuser can remove the
    // notes they are credited with.
    const reader = clientFor(`http://127.0.0.1:${server.address().port}`);
    const created = await reader.register("newcomer", "#61afef");
    assert.equal(created.status, 201);

    const list = await reader.get("/notes");
    const archived = list.body.items.find((n) => n.id === 1);
    const authorless = list.body.items.find((n) => n.id === 7);
    assert.equal(archived.perm.canDelete, false);
    assert.equal(archived.perm.canEdit, false);
    assert.equal(authorless.perm.canDelete, false);
    assert.equal((await reader.del("/notes/1")).status, 403);
    assert.equal((await reader.del("/notes/7")).status, 403);
  });

  it("lets the env admin delete an archived note", async () => {
    assert.equal((await admin.del("/notes/7")).status, 204);
  });
});