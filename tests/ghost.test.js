import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, PALETTE, TEST_PASSWORD } from "./helpers.js";

/**
 * "Ghost In Time": the holder pauses their own account rather than deleting it.
 *
 * Two properties are asserted throughout, and they are the whole feature:
 *   1. nothing is lost - handle, password, token, memberships and every past
 *      note survive, and the account can still sign in;
 *   2. nothing new reaches them, and they can write nothing.
 */
describe("ghost in time", () => {
  let server;
  let ghost; // the account holder who ghosts themselves
  let friend;
  let space; // a private space the ghost owns
  let ghostSpaceNote; // written by the ghost, before ghosting
  let friendLobbyNote; // written by somebody else, before ghosting

  before(async () => {
    server = await boot();

    // Named by hand rather than via makeUsers, because `@ghost` has to be a real
    // handle for the mention test below to mean anything.
    const make = async (handle, color) => {
      const api = clientFor(server.base);
      const res = await api.register(handle, color, TEST_PASSWORD);
      assert.equal(res.status, 201, `could not register ${handle}`);
      return { handle, api, user: res.body.user, token: res.body.token, password: TEST_PASSWORD };
    };
    ghost = await make("ghost", PALETTE[0]);
    friend = await make("friend", PALETTE[1]);

    const created = await ghost.api.post("/spaces", {
      name: "Ghosts Guild",
      visibility: "private",
    });
    space = created.body;

    ghostSpaceNote = (await ghost.api.post(`/spaces/${space.id}/notes`, {
      title: "before",
      body: "written while alive",
    })).body;
    friendLobbyNote = (await friend.api.post("/notes", {
      title: "also before",
      body: "from somebody else",
    })).body;

    const res = await ghost.api.post("/auth/ghost");
    assert.equal(res.status, 200, `ghosting failed: ${JSON.stringify(res.body)}`);
  });

  after(async () => {
    await server.close();
  });

  /* ----------------------------- it keeps everything ----------------------------- */

  it("keeps the account and everything on it", async () => {
    const me = await ghost.api.get("/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.handle, "ghost");
    assert.ok(me.body.user.ghostedAt, "reports the ghosting timestamp");

    // Still an owner of the space, still a member, still signed in.
    const spaces = await ghost.api.get("/spaces");
    const mine = spaces.body.find((s) => s.id === space.id);
    assert.equal(mine.role, "owner");
    assert.equal(mine.ownerId, ghost.user.id);

    // The note they wrote before ghosting is untouched and still theirs.
    const notes = await ghost.api.get(`/spaces/${space.id}/notes`);
    assert.equal(notes.status, 200);
    assert.equal(notes.body.items.length, 1);
    assert.equal(notes.body.items[0].id, ghostSpaceNote.id);
    assert.equal(notes.body.items[0].perm.canEdit, false, "but they cannot edit it");
  });

  it("still lets them sign in, so they can get back", async () => {
    const fresh = clientFor(server.base);
    const res = await fresh.login("ghost", TEST_PASSWORD);
    assert.equal(res.status, 200);
    assert.ok(res.body.user.ghostedAt, "the ghost state survives a fresh login");

    // Signing in re-issues the account's only token, so the shared client has to
    // adopt it or every later test runs unauthenticated.
    ghost.api.token = res.body.token;
  });

  it("keeps the account's own credentials working", async () => {
    // Otherwise a ghost could be locked out of the one button that revives them.
    const profile = await ghost.api.patch("/auth/me", { displayName: "Still Here" });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.displayName, "Still Here");

    const rotated = await ghost.api.post("/auth/rotate-token");
    assert.equal(rotated.status, 200);
    assert.ok(rotated.body.token);

    // The old token dies...
    const stale = await clientFor(server.base, ghost.token).get("/auth/me");
    assert.equal(stale.status, 401);

    // ...and the replacement is still a ghost, so this is not a way out of it.
    ghost.api.token = rotated.body.token;
    const me = await ghost.api.get("/auth/me");
    assert.equal(me.status, 200);
    assert.ok(me.body.user.ghostedAt);
  });

  /* ------------------------------ it blocks writing ------------------------------ */

  it("reports only read capabilities, so the client closes its own buttons", async () => {
    // The whole UI hangs off this list: the composer, the roster controls and
    // the space settings all gate on a capability. Narrowing it here means no
    // component has to know ghosting exists.
    const spaces = await ghost.api.get("/spaces");
    const mine = spaces.body.find((s) => s.id === space.id);
    assert.deepEqual([...mine.caps], ["read_notes"]);

    // And the role is still reported, because ownership is metadata that
    // survived the ghosting rather than something revoked by it.
    assert.equal(mine.role, "owner");
  });

  it("refuses every kind of note writing with one honest code", async () => {
    const attempts = [
      ["post to the lobby", () => ghost.api.post("/notes", { title: "x", body: "y" })],
      ["post to their own space", () => ghost.api.post(`/spaces/${space.id}/notes`, { title: "x" })],
      ["edit an old note", () => ghost.api.put(`/notes/${ghostSpaceNote.id}`, { body: "changed" })],
      ["roll back", () => ghost.api.put(`/notes/${ghostSpaceNote.id}/rollback`, {})],
      ["delete an old note", () => ghost.api.del(`/notes/${ghostSpaceNote.id}`)],
      ["resize a card", () => ghost.api.put(`/notes/${ghostSpaceNote.id}/layout`, { size: "tall" })],
    ];

    for (const [label, run] of attempts) {
      const res = await run();
      assert.equal(res.status, 403, `${label} should be refused`);
      assert.equal(res.body.code, "GHOSTED", `${label} should say why`);
      assert.match(res.body.error, /ghost/i, `${label} should name the state`);
    }
  });

  it("refuses to manage the spaces it still owns", async () => {
    const attempts = [
      ["rename", () => ghost.api.patch(`/spaces/${space.id}`, { name: "Renamed" })],
      ["delete", () => ghost.api.del(`/spaces/${space.id}`)],
      ["add a member", () => ghost.api.post(`/spaces/${space.id}/members`, { handle: "friend" })],
      [
        "change a role",
        () => ghost.api.patch(`/spaces/${space.id}/members/${friend.user.id}`, { role: "moderator" }),
      ],
      ["remove a member", () => ghost.api.del(`/spaces/${space.id}/members/${friend.user.id}`)],
    ];

    for (const [label, run] of attempts) {
      const res = await run();
      assert.equal(res.status, 403, `${label} should be refused`);
      assert.equal(res.body.code, "GHOSTED");
    }
  });

  it("refuses to ask for access, having lost the ability to join anything", async () => {
    const other = await friend.api.post("/spaces", { name: "Elsewhere", visibility: "private" });
    const res = await ghost.api.post(`/spaces/${other.body.id}/requests`, { role: "viewer" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "GHOSTED");
  });

  it("still lets them walk out of a room", async () => {
    // Leaving is a right, not a privilege. Trapping somebody in a space they
    // can no longer manage would be the worse failure.
    const away = await friend.api.post("/spaces", { name: "Somewhere", visibility: "private" });
    const added = await friend.api.post(`/spaces/${away.body.id}/members`, {
      handle: "ghost",
      role: "participant",
    });
    assert.equal(added.status, 201);

    const left = await ghost.api.post(`/spaces/${away.body.id}/leave`);
    assert.equal(left.status, 204);

    const spaces = await ghost.api.get("/spaces");
    assert.ok(
      !spaces.body.some((s) => s.id === away.body.id && s.role),
      "no longer a member",
    );
  });

  /* ------------------------------- it stops time ------------------------------- */

  it("hides everything written after the ghosting", async () => {
    // The friend keeps living: a note in the shared space, one in the Lobby,
    // and a brand new space the ghost has never seen.
    await friend.api.post(`/spaces/${space.id}/notes`, { title: "after", body: "later" });
    const lobby = await friend.api.post("/notes", { title: "lobby after", body: "later" });
    const freshSpace = await friend.api.post("/spaces", { name: "Born Later", visibility: "public" });

    const spaceNotes = await ghost.api.get(`/spaces/${space.id}/notes`);
    assert.equal(spaceNotes.status, 200);
    assert.equal(
      spaceNotes.body.items.length,
      1,
      "only the note that existed at ghosting time",
    );
    assert.equal(spaceNotes.body.items[0].id, ghostSpaceNote.id);

    const lobbyNotes = await ghost.api.get("/notes");
    assert.deepEqual(
      lobbyNotes.body.items.map((n) => n.id),
      [friendLobbyNote.id],
    );

    const spaces = await ghost.api.get("/spaces");
    assert.ok(
      !spaces.body.some((s) => s.id === freshSpace.body.id),
      "a space created afterwards is new content too",
    );
  });

  it("will not even confirm a note it should not know exists", async () => {
    const after = await friend.api.post("/notes", { title: "unseen", body: "unseen" });
    const edit = await ghost.api.put(`/notes/${after.body.id}`, { body: "peeked" });
    assert.equal(edit.status, 403);
    assert.equal(edit.body.code, "GHOSTED");
  });

  it("hides mentions that arrived after the ghosting", async () => {
    const shout = await friend.api.post("/notes", {
      title: "calling",
      body: "@ghost are you there",
    });
    assert.equal(shout.status, 201);

    const feed = await ghost.api.get("/mentions");
    assert.equal(feed.status, 200);
    assert.deepEqual(
      feed.body.items.map((i) => i.note.id),
      [],
      "nobody new reaches a ghost",
    );
  });

  /* -------------------------------- it revives -------------------------------- */

  it("refuses to be ghosted twice or revived when not a ghost", async () => {
    const again = await ghost.api.post("/auth/ghost");
    assert.equal(again.status, 400);
    assert.equal(again.body.code, "ALREADY_GHOSTED");
  });

  it("comes back exactly as it was, with one click and no password", async () => {
    const back = await ghost.api.post("/auth/revive");
    assert.equal(back.status, 200);
    assert.equal(back.body.user.ghostedAt, null);

    // Writing works again, immediately, with the same token.
    const post = await ghost.api.post("/notes", { title: "back", body: "hello" });
    assert.equal(post.status, 201);

    // And the board is whole again: the notes written while ghosting are visible.
    const lobby = await ghost.api.get("/notes");
    assert.ok(
      lobby.body.items.some((n) => n.title === "unseen"),
      "new content is visible once revived",
    );

    // Membership survived untouched, so they manage the space again.
    const renamed = await ghost.api.patch(`/spaces/${space.id}`, { name: "Ghosts Guild" });
    assert.equal(renamed.status, 200);
  });

  it("will not revive an account that is not a ghost", async () => {
    const res = await friend.api.post("/auth/revive");
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "NOT_GHOSTED");
  });

  it("refuses the env admin token, so there is no lever but the holder's own", async () => {
    const admin = clientFor(server.base, "test-admin-token");
    const ghosted = await admin.post("/auth/ghost");
    assert.equal(ghosted.status, 400);
    assert.match(ghosted.body.error, /environment admin token/i);

    const revived = await admin.post("/auth/revive");
    assert.equal(revived.status, 400);
    assert.match(revived.body.error, /environment admin token/i);
  });
});