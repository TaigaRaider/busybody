import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { createClient } from "@libsql/client";

import { boot, clientFor, PALETTE, TEST_PASSWORD } from "./helpers.js";

const SCRIPT = "server/scripts/delete-account.mjs";

/**
 * The operator script, exercised against the same database the test API uses.
 *
 * It exists for accounts the API cannot reach — one whose password was never
 * recorded or has since been forgotten — so what matters is that it does exactly
 * what the route does and refuses exactly what the route refuses. A recovery
 * path that quietly diverged would be worse than no recovery path.
 */
describe("the delete-account operator script", () => {
  let server;
  let db;
  let room; // owned by `rich`, which the script must refuse to remove

  // Accounts the script is pointed at, and the ones it must not touch.
  let rich; // owns a space and wrote notes: the interesting teardown
  let bystander; // ordinary account, must survive untouched

  before(async () => {
    server = await boot();
    // `boot()` points TURSO_DATABASE_URL at a throwaway file and leaves the env
    // var set, so the script can be pointed at exactly the same database. Its
    // own connection is separate, as a separate process would be.
    db = createClient({ url: process.env.TURSO_DATABASE_URL });

    const founder = clientFor(server.base);
    assert.equal(
      (await founder.register("op-founder", PALETTE[4], TEST_PASSWORD)).status,
      201,
    );
    bystander = clientFor(server.base);
    assert.equal(
      (await bystander.register("op-bystander", PALETTE[5], TEST_PASSWORD)).status,
      201,
    );
    rich = clientFor(server.base);
    assert.equal((await rich.register("op-rich", PALETTE[6], TEST_PASSWORD)).status, 201);

    // A space for `rich` to own, plus a membership and notes, so the teardown
    // has something real to do.
    room = (await rich.post("/spaces", { name: "Op Room", visibility: "public" })).body;
    await rich.post(`/spaces/${room.id}/members`, {
      handle: "op-bystander",
      role: "participant",
    });
    await rich.post(`/spaces/${room.id}/notes`, { title: "op note", body: "in a room" });
    await rich.post("/notes", { title: "lobby note", body: "@op-bystander hi" });

    // A private space owned by somebody else, so `rich` also has a pending
    // request row of its own to cascade.
    const bystanderRoom = (
      await bystander.post("/spaces", { name: "Bystander Room", visibility: "private" })
    ).body;
    await rich.post(`/spaces/${bystanderRoom.id}/requests`, { role: "viewer" });

    // `op-stranded` exists but has no password hash at all — the exact shape the
    // script is for. Written directly, because registration always sets one.
    const stranger = clientFor(server.base);
    assert.equal(
      (await stranger.register("op-stranded", PALETTE[7], TEST_PASSWORD)).status,
      201,
    );
    await db.execute("UPDATE users SET password_hash = NULL WHERE handle = 'op-stranded'");

    // Confirm the API really cannot serve this account before relying on that.
    const viaApi = await clientFor(server.base).login("op-stranded", "");
    assert.equal(viaApi.status, 401, "no password means no way in");
  });

  after(async () => {
    // `boot()` returns `close()` as an async method that takes no arguments, so
    // wrapping it in `new Promise((resolve) => close(resolve))` would never
    // settle — the callback is ignored and the executor returns immediately
    // without ever resolving. Await the method itself.
    await server.close();
    db.close();
  });

  /** Runs the script against the test database, resolving its stdout. */
  const script = (handle, ...flags) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [SCRIPT, handle, ...flags],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
            TURSO_AUTH_TOKEN: "",
            ADMIN_TOKEN: "test-admin-token",
          },
        },
        (err, stdout, stderr) =>
          err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
      );
    });

  const usersNamed = async (handles) => {
    const placeholders = handles.map(() => "?").join(",");
    const rows = await db.execute(
      `SELECT handle FROM users WHERE handle IN (${placeholders}) ORDER BY handle`,
      handles,
    );
    return rows.rows.map((r) => r.handle);
  };

  /* ------------------------------ refusals ------------------------------ */

  it("fails cleanly on an account that does not exist", async () => {
    await assert.rejects(() => script("op-nobody"), /no account with handle/);
  });

  it("refuses a last admin, exactly as the route does", async () => {
    // `op-founder` is the first account in this database, so it bootstrapped as
    // the admin. The script must not become a way to lose the board's only
    // admin, which is why this is guarded rather than sitting behind a flag.
    await assert.rejects(() => script("op-founder"), /refused:.*only admin.*\(LAST_ADMIN\)/s);

    const me = await clientFor(server.base).login("op-founder", TEST_PASSWORD);
    assert.equal(me.status, 200, "the admin is still here");
  });

  it("refuses an account that owns a space, naming the space", async () => {
    await assert.rejects(
      () => script("op-rich"),
      /refused:.*own a space: Op Room.*\(OWNS_SPACES\)/s,
    );

    const still = await rich.get("/spaces");
    assert.ok(
      still.body.some((s) => s.name === "Op Room"),
      "the space did not go with the refused deletion",
    );
  });

  /* ------------------------------ the dry run ---------------------------- */

  it("reports a dry run and changes nothing", async () => {
    const stdout = await script("op-rich", "--dry-run");
    assert.match(stdout, /notes kept, byline greyed: 2/);
    assert.match(stdout, /memberships removed:\s+1/);
    assert.match(stdout, /requests removed:\s+1/);
    assert.match(stdout, /dry run - nothing was changed/);

    assert.deepEqual(await usersNamed(["op-rich"]), ["op-rich"]);
    const lobby = await bystander.get("/notes");
    assert.ok(lobby.body.items.some((n) => n.title === "lobby note"));
  });

  /* ------------------------------ the teardown --------------------------- */

  it("removes an account the API could never reach", async () => {
    const stdout = await script("op-stranded");
    assert.match(stdout, /deleted @op-stranded/);
    assert.match(stdout, /can never be registered again/);

    assert.deepEqual(await usersNamed(["op-stranded"]), []);
  });

  it("removes an account with content, once it no longer owns a space", async () => {
    // The space has to go first, which is the app's own rule about owners rather
    // than something the script relaxes. Its note goes with it — a room's notes
    // belong to the room, and nobody signed up to inherit an orphaned space —
    // so the count that matters is the one left standing on the Lobby.
    assert.equal((await rich.del(`/spaces/${room.id}`)).status, 204);

    const stdout = await script("op-rich");
    assert.match(stdout, /notes kept, byline greyed: 1/);
    assert.match(stdout, /memberships removed:\s+0/, "the membership went with the space");
    assert.match(stdout, /deleted @op-rich/);
    assert.deepEqual(await usersNamed(["op-rich"]), []);
  });

  it("keeps its notes, with the byline greyed rather than dropped", async () => {
    // The same contract as the route, which is the whole reason the teardown is
    // shared code rather than a second implementation.
    const lobby = await bystander.get("/notes");
    const note = lobby.body.items.find((n) => n.title === "lobby note");
    assert.ok(note, "the lobby note survived");
    assert.equal(note.authorId, null);
    assert.deepEqual(note.author, {
      handle: "op-rich",
      color: PALETTE[6],
      gone: true,
    });
  });

  it("leaves the note community-editable but impossible to delete", async () => {
    // Rewriting follows the Lobby's open-editing rule; deletion was the power
    // that died with the account, and nobody else may claim it.
    const lobby = await bystander.get("/notes");
    const note = lobby.body.items.find((n) => n.title === "lobby note");
    assert.equal(note.perm.canEdit, true);
    assert.equal(note.perm.canDelete, false, "deletion power died with the account");
    assert.equal((await bystander.del(`/notes/${note.id}`)).status, 403);
    const edited = await bystander.put(`/notes/${note.id}`, { body: "community edit" });
    assert.equal(edited.status, 200);
  });

  it("retires the handle, so the grey byline cannot be impersonated", async () => {
    // The route, not the script, is what a newcomer meets.
    const res = await clientFor(server.base).register("op-rich", PALETTE[7]);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "HANDLE_RETIRED");
  });

  it("frees the chalk colour, which was the real cost of leaving them there", async () => {
    const res = await clientFor(server.base).register("op-fresh-chalk", PALETTE[6]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.color, PALETTE[6]);
  });

  it("refuses to delete the same account twice", async () => {
    // The second attempt would fail on the retired_handles primary key and roll
    // the whole transaction back. Caught up front instead, so the operator is
    // told what actually happened — the account was already deleted — rather
    // than being left with "no account with handle", which is true but useless.
    await assert.rejects(() => script("op-stranded"), /already deleted at .*retired and unclaimable/);
  });

  it("leaves every other account completely alone", async () => {
    assert.deepEqual(
      await usersNamed(["op-founder", "op-bystander"]),
      ["op-bystander", "op-founder"],
    );
    const rooms = await bystander.get("/spaces");
    assert.ok(rooms.body.some((s) => s.name === "Bystander Room"));
    const lobby = await bystander.get("/notes");
    assert.equal(lobby.body.items.some((n) => n.title === "lobby note"), true);
  });
});
