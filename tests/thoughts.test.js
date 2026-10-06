import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, makeUsers, PALETTE, TEST_PASSWORD } from "./helpers.js";

/*
 * The append-and-settle model for shared cards.
 *
 * A card is not one person's canvas: anybody who may post in the room can add
 * their own thought to it. What they cannot do is rewrite what is already
 * there. Every thought is chalked and bylined with its writer, editable only
 * by that writer, and only until the edit window closes — after which the card
 * is the settled public record.
 */
describe("attributed thoughts", () => {
  let server;
  let owner; // first account, so the admin
  let ada; // writes the opening thought
  let bob; // appends to ada's cards
  let carol; // appends too
  let admin; // env-token admin

  before(async () => {
    server = await boot();
    [owner, ada, bob, carol] = await makeUsers(server.base, 4);
    admin = clientFor(server.base, "test-admin-token");
  });
  after(async () => {
    await server.close();
  });

  const post = (api, body, title = "topic") =>
    api.post("/notes", { title, body });

  // Named throwaway accounts for the permission and deletion tests. The four
  // `makeUsers` accounts above already hold PALETTE[0..3], so these take the
  // remaining four chalk colours.
  const extra = [];
  const make = async (handle) => {
    const api = clientFor(server.base);
    const res = await api.register(
      handle,
      PALETTE[4 + (extra.length % 4)],
      TEST_PASSWORD,
    );
    assert.equal(
      res.status,
      201,
      `could not register ${handle}: ${JSON.stringify(res.body)}`,
    );
    extra.push(handle);
    return { handle, api, user: res.body.user, password: TEST_PASSWORD };
  };

  /* ------------------------------ the opening ------------------------------ */

  it("starts every card with the author's opening thought", async () => {
    const created = await post(ada.api, "one writer");
    assert.equal(created.status, 201);
    assert.equal(created.body.thoughts.length, 1);
    const opening = created.body.thoughts[0];
    assert.equal(opening.text, "one writer");
    assert.equal(opening.authorHandle, ada.handle);
    assert.equal(opening.color, ada.user.color);
    assert.equal(opening.perm.isMine, true);
    // The opening is the author's own card, so the window-gated pencil does
    // not apply to it; the whole-note route is the author's editor instead.
    assert.equal(opening.perm.canEdit, false);
    assert.equal(created.body.perm.canAppend, true);
  });

  /* ------------------------------ appending ------------------------------ */

  it("lets another user append an attributed thought", async () => {
    const created = await post(ada.api, "the opening");
    const res = await bob.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "bob's take",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.thoughts.length, 2);
    const appended = res.body.thoughts[1];
    assert.equal(appended.text, "bob's take");
    assert.equal(appended.authorHandle, bob.handle);
    assert.equal(appended.color, bob.user.color);
    assert.equal(appended.perm.isMine, true);
    assert.equal(appended.perm.canEdit, true, "the author is inside their own window");
    // bob cannot touch the opening with his own pencil or his own words
    assert.equal(res.body.thoughts[0].perm.canEdit, false);
    // the body is the derived concatenation, each span in its writer's chalk
    assert.ok(res.body.body.includes(`{% ${ada.user.color} %}the opening{% end %}`));
    assert.ok(res.body.body.includes(`{% ${bob.user.color} %}bob's take{% end %}`));
    // a new thought moves the card's clock, so the board order stays fresh
    assert.notEqual(res.body.updatedAt, res.body.createdAt);
  });

  it("rejects an empty thought", async () => {
    const created = await post(ada.api, "blank invitation");
    const res = await bob.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "   ",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "BAD_REQUEST");
  });

  it("404s an append to a note that is not there", async () => {
    const res = await bob.api.post("/notes/999999/thoughts", { text: "?" });
    assert.equal(res.status, 404);
  });

  it("refuses the env admin an append", async () => {
    const created = await post(ada.api, "env watchdog");
    const res = await admin.post(`/notes/${created.body.id}/thoughts`, {
      text: "?",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Pick a registered account first");
  });

  it("keeps each appended thought with its writer, in order", async () => {
    const created = await post(ada.api, "shared card");
    await bob.api.post(`/notes/${created.body.id}/thoughts`, { text: "b" });
    const res = await carol.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "c",
    });
    assert.equal(res.body.thoughts.length, 3);
    assert.deepEqual(
      res.body.thoughts.map((t) => t.authorHandle),
      [ada.handle, bob.handle, carol.handle],
    );
    assert.deepEqual(res.body.thoughts[1].author, {
      handle: bob.handle,
      color: bob.user.color,
    });
  });

  /* ------------------------------ the window ------------------------------ */

  it("lets the author correct their own thought inside the window", async () => {
    const created = await post(ada.api, "correctable");
    const before = await bob.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "first draft",
    });
    const thought = before.body.thoughts[1];
    const res = await bob.api.put(
      `/notes/${created.body.id}/thoughts/${thought.id}`,
      { text: "second draft" },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.thoughts[1].text, "second draft");
    assert.notEqual(res.body.thoughts[1].updatedAt, thought.createdAt);
    assert.ok(res.body.body.includes("second draft"));
    assert.ok(!res.body.body.includes("first draft"));
  });

  it("stops anyone but the writer editing a thought", async () => {
    const created = await post(ada.api, "mine only");
    const before = await bob.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "bob wrote this",
    });
    const thought = before.body.thoughts[1];
    // Ada and Carol are other users: they get a plain 403. The env admin gets
    // 400, because the very idea of "me" does not exist for a scripted token.
    for (const intruder of [ada.api, carol.api]) {
      const res = await intruder.put(
        `/notes/${created.body.id}/thoughts/${thought.id}`,
        { text: "rewritten" },
      );
      assert.equal(res.status, 403, "nobody else may rewrite a thought");
    }
    assert.equal(
      (
        await admin.put(`/notes/${created.body.id}/thoughts/${thought.id}`, {
          text: "rewritten",
        })
      ).status,
      400,
      "the env admin must pick a registered account first",
    );
    // the text survived every attempt
    const list = await bob.api.get("/notes");
    const found = list.body.items.find((n) => n.id === created.body.id);
    assert.equal(found.thoughts[1].text, "bob wrote this");
  });

  it("closes the window, and the server is the one checking the clock", async () => {
    const created = await post(ada.api, "frozen");
    const before = await bob.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "will settle",
    });
    const thought = before.body.thoughts[1];

    process.env.EDIT_WINDOW_MS = "0";
    try {
      const res = await bob.api.put(
        `/notes/${created.body.id}/thoughts/${thought.id}`,
        { text: "too late" },
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "FROZEN");
      // the client's mirror agrees: the pencil is gone
      const list = await bob.api.get("/notes");
      const found = list.body.items.find((n) => n.id === created.body.id);
      assert.equal(found.thoughts[1].perm.canEdit, false);
    } finally {
      delete process.env.EDIT_WINDOW_MS;
    }
  });

  it("404s an edit of a thought that belongs to another note", async () => {
    const first = await post(ada.api, "first card");
    const added = await bob.api.post(`/notes/${first.body.id}/thoughts`, {
      text: "on the first card",
    });
    const second = await post(ada.api, "second card");
    const res = await bob.api.put(
      `/notes/${second.body.id}/thoughts/${added.body.thoughts[1].id}`,
      { text: "wrong card" },
    );
    assert.equal(res.status, 404);
  });

  /* ------------------------ the opening stays whole ------------------------ */

  it("lets the author edit the opening without touching appends", async () => {
    const created = await post(ada.api, "the opening");
    await bob.api.post(`/notes/${created.body.id}/thoughts`, { text: "bob's take" });

    const res = await ada.api.put(`/notes/${created.body.id}`, {
      title: "retitled by the author",
      body: "the opening v2",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "retitled by the author");
    assert.equal(res.body.thoughts.length, 2, "appends must survive an opening edit");
    assert.equal(res.body.thoughts[0].text, "the opening v2");
    assert.equal(res.body.thoughts[1].text, "bob's take");
    assert.ok(res.body.body.includes("bob's take"));
    assert.equal(JSON.parse(res.body.history).length, 1);
  });

  it("refuses to roll a card back once others have appended", async () => {
    const created = await post(ada.api, "v1 opening");
    await ada.api.put(`/notes/${created.body.id}`, { title: "v2", body: "v2 opening" });
    await bob.api.post(`/notes/${created.body.id}/thoughts`, { text: "bob's take" });

    const res = await ada.api.put(`/notes/${created.body.id}/rollback`);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "HAS_THOUGHTS");
    // nothing was rolled back
    const list = await ada.api.get("/notes");
    const found = list.body.items.find((n) => n.id === created.body.id);
    assert.equal(found.thoughts.length, 2);
  });

  it("still rolls a single-writer card back, keeping the opening row in step", async () => {
    const created = await post(ada.api, "v1", "v1");
    await ada.api.put(`/notes/${created.body.id}`, { title: "v2", body: "v2" });
    const rolled = await ada.api.put(`/notes/${created.body.id}/rollback`);
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.title, "v1");
    assert.equal(rolled.body.thoughts[0].text, "v1");
    assert.ok(rolled.body.body.includes("{% "));
  });

  /* ---------------------- mentions follow the thoughts ---------------------- */

  it("re-indexes mentions across every appended thought", async () => {
    const created = await post(ada.api, "tags stay live");
    await bob.api.post(`/notes/${created.body.id}/thoughts`, {
      text: `@${carol.handle} take a look`,
    });
    const feed = await carol.api.get("/mentions");
    assert.equal(feed.status, 200);
    assert.ok(
      feed.body.items.some(({ note }) => note.id === created.body.id),
      "@carol should appear in her mention feed from an appended thought",
    );
  });

  /* ------------------------------ permissions ------------------------------ */

  it("hides the append affordance from a quarantined account", async () => {
    const ghost = await make("spectre");
    const created = await post(ada.api, "still visible to a ghost");

    assert.equal((await ghost.api.post("/auth/ghost")).status, 200);

    // The note predates the ghosting, so it stays readable — but the append
    // box must not, and the server must refuse the write on its own authority.
    const list = await ghost.api.get("/notes");
    const found = list.body.items.find((n) => n.id === created.body.id);
    assert.equal(found.perm.canAppend, false);
    const res = await ghost.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "from beyond",
    });
    assert.equal(res.status, 403);
  });

  it("gives participants the append, and only them", async () => {
    // owner builds a room: ada participates, carol is a viewer-only guest
    const room = (await owner.api.post("/spaces", { name: "Think Tank", visibility: "private" })).body;
    assert.equal(
      (await owner.api.post(`/spaces/${room.id}/members`, { handle: ada.handle, role: "participant" })).status,
      201,
    );
    assert.equal(
      (await owner.api.post(`/spaces/${room.id}/members`, { handle: carol.handle, role: "viewer" })).status,
      201,
    );

    const note = (await ada.api.post(`/spaces/${room.id}/notes`, { title: "in the tank", body: "opening" })).body;

    // a participant may append…
    const ok = await ada.api.post(`/notes/${note.id}/thoughts`, { text: "more of mine" });
    assert.equal(ok.status, 201);

    // …a viewer may read the card but never add to it…
    const refused = await carol.api.post(`/notes/${note.id}/thoughts`, { text: "peek" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "NEEDS_REQUEST");

    // …and an outsider to the private room cannot even resolve the card.
    const outsider = await make("outsider");
    const blind = await outsider.api.post(`/notes/${note.id}/thoughts`, { text: "?" });
    assert.equal(blind.status, 403);
    assert.equal(blind.body.code, "NEEDS_REQUEST");
  });

  it("keeps public-space non-members read-only", async () => {
    const room = (await owner.api.post("/spaces", { name: "Open Plaza", visibility: "public" })).body;
    assert.equal(
      (await owner.api.post(`/spaces/${room.id}/members`, { handle: ada.handle, role: "participant" })).status,
      201,
    );
    const note = (await ada.api.post(`/spaces/${room.id}/notes`, { title: "plaza", body: "opening" })).body;

    const outsider = await make("bystander");
    // readable by any signed-in account…
    const list = await outsider.api.get(`/spaces/${room.id}/notes`);
    assert.equal(list.status, 200);
    // …but appending is a participant's act, and a non-member is not one.
    const res = await outsider.api.post(`/notes/${note.id}/thoughts`, { text: "?" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "NEEDS_REQUEST");
  });

  /* ---------------------------- departed authors ---------------------------- */

  it("greys out the thoughts of an author who deletes their account", async () => {
    const departed = await make("departed");
    const created = await post(ada.api, "outliving departed");
    const before = await departed.api.post(`/notes/${created.body.id}/thoughts`, {
      text: "this stays",
    });
    const thought = before.body.thoughts[1];

    assert.equal(
      (await departed.api.del("/auth/me", { password: TEST_PASSWORD })).status,
      204,
    );

    // The thought and its byline survive, with the account link greyed out —
    // the same deal as notes, so nobody can adopt or rewrite it afterwards.
    const list = await ada.api.get("/notes");
    const found = list.body.items.find((n) => n.id === created.body.id);
    assert.equal(found.thoughts.length, 2);
    assert.equal(found.thoughts[1].text, "this stays");
    assert.equal(found.thoughts[1].authorId, null);
    assert.deepEqual(found.thoughts[1].author, {
      handle: departed.handle,
      color: departed.user.color,
      gone: true,
    });
    assert.equal(found.thoughts[1].perm.canEdit, false);
    assert.equal(found.thoughts[1].perm.isMine, false);

    // nobody — not even the admin — may edit a departed person's thought
    const res = await owner.api.put(
      `/notes/${created.body.id}/thoughts/${thought.id}`,
      { text: "rewritten" },
    );
    assert.equal(res.status, 403);
  });
});