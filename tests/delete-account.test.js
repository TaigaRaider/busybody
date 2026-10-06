import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, PALETTE, TEST_PASSWORD } from "./helpers.js";

// Imported for the one test that has to fabricate a legacy authorless row. The
// module registry is per-test-file, so this resolves to the same throwaway
// database `boot()` set up, as long as it is a dynamic import after `boot()`.
let leaverDb;
let notes;

/**
 * Deleting an account is the one irreversible thing the app does, so these
 * tests are mostly about what must *survive* it.
 *
 * The contract, in one line: everything that is only about the departing
 * person is destroyed, and everything they contributed to a shared space is
 * still there with their name on it in grey.
 */
describe("deleting an account", () => {
  let server;
  let founder; // the first account, so the admin — never leaves until the end
  let leaver; // deletes their own account
  let stayer; // proves the board keeps working
  let room; // a space the leaver is a member of, not the owner of
  let theirNote; // in the Lobby, before leaving
  let theirRoomNote; // in the shared space, before leaving
  let theirColor;

  before(async () => {
    server = await boot();
    ({ db: leaverDb } = await import("../lib/db.js"));
    ({ notes } = await import("../lib/schema.js"));

    const make = async (handle, color) => {
      const api = clientFor(server.base);
      const res = await api.register(handle, color, TEST_PASSWORD);
      assert.equal(res.status, 201, `could not register ${handle}: ${JSON.stringify(res.body)}`);
      return { handle, api, user: res.body.user, password: TEST_PASSWORD };
    };

    // Registered first, so it bootstraps as the admin. Every other account here
    // is ordinary, which is what lets `leaver` go without stranding the board.
    founder = await make("founder", PALETTE[4]);
    leaver = await make("leaver", PALETTE[0]);
    stayer = await make("stayer", PALETTE[1]);
    theirColor = leaver.user.color;

    room = (await stayer.api.post("/spaces", { name: "Reading Room", visibility: "public" })).body;
    const joined = await stayer.api.post(`/spaces/${room.id}/members`, {
      handle: "leaver",
      role: "participant",
    });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));

    theirNote = (await leaver.api.post("/notes", { title: "mine, in the lobby", body: "still here" })).body;
    theirRoomNote = (await leaver.api.post(`/spaces/${room.id}/notes`, {
      title: "mine, in the room",
      body: "still here too",
    })).body;
  });

  after(async () => {
    await server.close();
  });

  const ok = async (client, body = { password: TEST_PASSWORD }) => {
    const res = await client.api.del("/auth/me", body);
    assert.equal(res.status, 204, JSON.stringify(res.body));
  };

  /* ------------------------------ the guards ------------------------------ */

  it("insists on the password, and refuses a wrong one", async () => {
    // requireAuth only proves a token. Without this a walk-up at an unlocked
    // browser could end the account.
    const missing = await leaver.api.del("/auth/me");
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "BAD_CREDENTIALS");

    const wrong = await leaver.api.del("/auth/me", { password: "not-the-password" });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, "BAD_CREDENTIALS");

    // Still very much here.
    const still = await leaver.api.get("/auth/me");
    assert.equal(still.status, 200);
  });

  it("answers 400 rather than 401 on a bad password, so it cannot sign you out", async () => {
    // The client's interceptor drops the session on any 401, so mistyping your
    // own password must not look like a dead token.
    const res = await leaver.api.del("/auth/me", { password: "nope-nope-nope" });
    assert.notEqual(res.status, 401);
  });

  it("refuses while they still own a space", async () => {
    const owned = (await leaver.api.post("/spaces", { name: "Mine To Keep", visibility: "private" })).body;
    const res = await leaver.api.del("/auth/me", { password: TEST_PASSWORD });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "OWNS_SPACES");
    // It says which, so the fix is obvious instead of a scavenger hunt.
    assert.deepEqual(res.body.spaces.map((s) => s.name), [owned.name]);

    await leaver.api.del(`/spaces/${owned.id}`);
  });

  it("refuses the environment admin token, which has no account", async () => {
    const admin = clientFor(server.base, "test-admin-token");
    const res = await admin.del("/auth/me", { password: "whatever" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /environment admin token/i);
  });

  /* ------------------------------ what it takes ----------------------------- */

  it("takes the account and everything that was only about them", async () => {
    // A pending request, so the requests table has a row of theirs to cascade.
    const privateRoom = (await stayer.api.post("/spaces", { name: "Locked Room", visibility: "private" })).body;
    const asked = await leaver.api.post(`/spaces/${privateRoom.id}/requests`, { role: "viewer" });
    assert.equal(asked.status, 201);

    // They mentioned the stayer, so there is a mention row pointing at them.
    await leaver.api.post("/notes", { title: "ping", body: "@stayer hello" });

    await ok(leaver);

    // The token is dead immediately — not merely unlinked.
    const after = await leaver.api.get("/auth/me");
    assert.equal(after.status, 401);

    // And they cannot sign in again.
    const relogin = clientFor(server.base);
    const back = await relogin.login("leaver", TEST_PASSWORD);
    assert.equal(back.status, 401);

    // The membership, the request and the mention are all gone.
    const spaces = await stayer.api.get("/spaces");
    const shared = spaces.body.find((s) => s.id === room.id);
    assert.equal(shared.caps.includes("manage_members"), true, "the room itself is intact");
    const roster = await stayer.api.get(`/spaces/${room.id}/members`);
    assert.ok(
      !roster.body.some((m) => m.handle === "leaver"),
      "their membership went with them",
    );
    const stayerMentions = await stayer.api.get("/mentions");
    assert.equal(
      stayerMentions.body.items.filter((i) => i.note.title === "ping").length,
      1,
      "the note stays, and so does the mention of the stayer in it",
    );
  });

  it("keeps every note they wrote, with the name still on it", async () => {
    const lobby = await stayer.api.get("/notes");
    const kept = lobby.body.items.find((n) => n.id === theirNote.id);
    assert.ok(kept, "the note survived the account");
    assert.equal(kept.title, "mine, in the lobby");
    assert.match(kept.body, /still here/);
    assert.equal(kept.authorId, null, "no longer attributed to a live account");
  });

  it("greys the byline instead of pretending the note was always anonymous", async () => {
    const lobby = await stayer.api.get("/notes");
    const kept = lobby.body.items.find((n) => n.id === theirNote.id);
    // `gone` is what the client greys out. Without it the reader could not tell
    // a departed author from a note that never had one.
    assert.deepEqual(kept.author, {
      handle: "leaver",
      color: theirColor,
      gone: true,
    });

    const roomNotes = await stayer.api.get(`/spaces/${room.id}/notes`);
    const inRoom = roomNotes.body.items.find((n) => n.id === theirRoomNote.id);
    assert.equal(inRoom.author.gone, true);
  });

  it("still reads as never-having-an-author for the genuinely authorless notes", async () => {
    // The three states have to stay distinguishable, or "archived" would come
    // back for the legacy rows the moment a deleted author's note is on screen.
    // A fresh database has no authorless rows of its own, so make one the way the
    // legacy data looks: written before anybody could be tracked to it.
    const orphan = (await leaverDb
      .insert(notes)
      .values({
        spaceId: null,
        title: "written by nobody in particular",
        body: "no author column",
        authorId: null,
        authorColor: null,
        authorHandle: null,
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        history: "[]",
      })
      .returning())[0];

    const lobby = await stayer.api.get("/notes");
    const found = lobby.body.items.find((n) => n.id === orphan.id);
    assert.equal(found.author, null, "never had an author, so author: null");
    assert.equal(found.authorHandle, null);
  });

  it("lets the community edit but not delete what a departed author wrote", async () => {
    // Rewriting follows the Lobby's open-editing rule, so a live account may
    // correct the note and the grey byline stays. Deletion was the power that
    // died with the account: the rule that only the author can take a post
    // down has nobody left to satisfy, and nobody else may claim it.
    const stayerEdit = await stayer.api.put(`/notes/${theirNote.id}`, { body: "edited" });
    assert.equal(stayerEdit.status, 200);
    const stayerDelete = await stayer.api.del(`/notes/${theirNote.id}`);
    assert.equal(stayerDelete.status, 403);
  });

  it("retires the handle, so the grey byline cannot be impersonated", async () => {
    const res = await clientFor(server.base).register("leaver", PALETTE[2]);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "HANDLE_RETIRED");
    assert.match(res.body.error, /retired/i);
  });

  it("frees the chalk colour, because nothing of theirs is left to colour", async () => {
    // The colour lived on the users row, and that row is gone. Nothing on the
    // board depends on the account for it — each note carries its own snapshot.
    const res = await clientFor(server.base).register("fresh-chalk", theirColor);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.color, theirColor);
  });

  /* ------------------------------ ghosted too ------------------------------ */

  it("lets a ghost leave for good, since ghosting is only the reversible exit", async () => {
    const tmp = clientFor(server.base);
    const made = await tmp.register("parting-ghost", PALETTE[3]);
    assert.equal(made.status, 201);
    const token = made.body.token;
    assert.equal((await tmp.post("/auth/ghost")).status, 200);

    const res = await tmp.del("/auth/me", { password: TEST_PASSWORD });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await clientFor(server.base, token).get("/auth/me")).status, 401);
  });

  /* ---------------------------- the unrecoverable ---------------------------- */

  it("refuses the last admin, because there is no way to appoint another", async () => {
    // Last, because it only holds at the end: every other admin-capable account
    // in this database has by now deleted itself. There is no endpoint that
    // grants admin, so a board with none can never be given one again — this is
    // the one guard that is about the site's survival rather than the person's.
    assert.equal(founder.user.isAdmin, true, "the founder bootstrapped as admin");

    const res = await founder.api.del("/auth/me", { password: TEST_PASSWORD });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "LAST_ADMIN");

    // Still admin, and still perfectly deletable once a second admin exists.
    assert.equal((await founder.api.get("/auth/me")).status, 200);
  });

  it("lets the last admin go once a second one exists", async () => {
    // The guard is about being alone, not about being an admin: it must not
    // quietly become a rule that admins may never leave.
    const heir = await clientFor(server.base).register("heir", PALETTE[5]);
    assert.equal(heir.status, 201);
    assert.equal(heir.body.user.isAdmin, false, "nobody can just appoint a second admin");

    // Promote out of band, which is exactly the lever the app does not expose.
    const { users } = await import("../lib/schema.js");
    const { eq } = await import("drizzle-orm");
    await leaverDb
      .update(users)
      .set({ isAdmin: 1 })
      .where(eq(users.handle, "heir"));

    const res = await founder.api.del("/auth/me", { password: TEST_PASSWORD });
    assert.equal(res.status, 204, JSON.stringify(res.body));
  });
});
