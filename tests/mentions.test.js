import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, makeUsers } from "./helpers.js";

describe("mentions", () => {
  let server;
  let ada;
  let bob;
  let carol;
  let admin;

  before(async () => {
    server = await boot();
    [ada, bob, carol] = await makeUsers(server.base, 3);
    admin = ada; // first registered account is an admin
  });
  after(async () => {
    await server.close();
  });

  it("records a tag and surfaces it in the tagged user's feed", async () => {
    const res = await ada.api.post("/notes", {
      title: "hello",
      body: `ping @${bob.handle} about the thing`,
    });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body.mentions), [bob.handle]);

    const feed = await bob.api.get("/mentions");
    assert.equal(feed.status, 200);
    assert.equal(feed.body.items.length, 1);
    assert.equal(feed.body.items[0].note.id, res.body.id);
    assert.equal(feed.body.items[0].note.title, "hello");
  });

  it("resolves the tag to the account's chalk colour", async () => {
    const feed = await bob.api.get("/mentions");
    const note = feed.body.items[0].note;
    assert.equal(note.mentions[bob.handle].color, bob.user.color);
    assert.equal(note.mentions[bob.handle].id, bob.user.id);
  });

  it("ignores a tag with no matching account", async () => {
    const res = await ada.api.post("/notes", {
      title: "ghost",
      body: "ping @nobodyhere",
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.mentions, {});
  });

  it("does not treat an email address as a tag", async () => {
    const res = await ada.api.post("/notes", {
      title: "email",
      body: "write to foo@bar.com please",
    });
    assert.deepEqual(res.body.mentions, {});
  });

  it("tags several people at once and de-duplicates", async () => {
    const res = await ada.api.post("/notes", {
      title: "many",
      body: `@${bob.handle} @${carol.handle} and @${bob.handle} again`,
    });
    assert.deepEqual(Object.keys(res.body.mentions).sort(), [bob.handle, carol.handle].sort());
    const feed = await carol.api.get("/mentions");
    assert.equal(feed.body.items[0].note.id, res.body.id);
  });

  it("re-indexes tags when a note is edited", async () => {
    const created = await ada.api.post("/notes", {
      title: "editable",
      body: `hi @${bob.handle}`,
    });
    const updated = await ada.api.put(`/notes/${created.body.id}`, {
      title: "editable",
      body: `{% ${ada.user.color} %}hi @${carol.handle}{% end %}`,
    });
    assert.deepEqual(Object.keys(updated.body.mentions), [carol.handle]);

    // bob no longer has it
    const bobFeed = await bob.api.get("/mentions");
    assert.ok(!bobFeed.body.items.some((i) => i.note.id === created.body.id));
    // carol does
    const carolFeed = await carol.api.get("/mentions");
    assert.ok(carolFeed.body.items.some((i) => i.note.id === created.body.id));
  });

  it("drops every tag when the body is cleared of them", async () => {
    const created = await ada.api.post("/notes", {
      title: "untag",
      body: `@${bob.handle} hello`,
    });
    const updated = await ada.api.put(`/notes/${created.body.id}`, {
      title: "untag",
      body: `{% ${ada.user.color} %}hello{% end %}`,
    });
    assert.deepEqual(updated.body.mentions, {});
  });

  it("rebuilds tags on rollback", async () => {
    const created = await ada.api.post("/notes", {
      title: "rollback",
      body: `{% ${ada.user.color} %}original @${bob.handle}{% end %}`,
    });
    await ada.api.put(`/notes/${created.body.id}`, {
      title: "rollback",
      body: `{% ${ada.user.color} %}replaced{% end %}`,
    });
    const rolled = await ada.api.put(`/notes/${created.body.id}/rollback`);
    assert.deepEqual(Object.keys(rolled.body.mentions), [bob.handle]);
  });

  it("never lists a note in its own author's feed", async () => {
    const res = await ada.api.post("/notes", { title: "self", body: `@${ada.handle} me` });
    assert.equal(res.status, 201);
    const feed = await ada.api.get("/mentions");
    assert.ok(!feed.body.items.some((i) => i.note.id === res.body.id));
  });

  it("drops the feed entry when the note is deleted", async () => {
    const created = await ada.api.post("/notes", {
      title: "temporary",
      body: `@${bob.handle} soon gone`,
    });
    assert.equal((await bob.api.get("/mentions")).body.items.length >= 1, true);
    await ada.api.del(`/notes/${created.body.id}`);
    const feed = await bob.api.get("/mentions");
    assert.ok(!feed.body.items.some((i) => i.note.id === created.body.id));
  });

  /* -------------------- mentions inside private spaces ------------------- */

  it("does not invite anyone for a tag in the open Lobby", async () => {
    await ada.api.post("/notes", { title: "lobby", body: `@${carol.handle} hi` });
    const spaces = await carol.api.get("/spaces");
    assert.ok(spaces.body.every((s) => !s.pendingRequest));
  });

  it("turns a tag inside a private space into an access request", async () => {
    const space = await ada.api.post("/spaces", {
      name: "Tag Invite",
      visibility: "private",
    });
    const created = await ada.api.post(`/spaces/${space.body.id}/notes`, {
      title: "come in",
      body: `@${carol.handle} you should see this`,
    });
    assert.equal(created.status, 201);

    const spaces = await carol.api.get("/spaces");
    const found = spaces.body.find((s) => s.id === space.body.id);
    assert.equal(found.pendingRequest, "viewer", "a tag doubles as an invite");
    assert.ok(found.pendingRequestId);
    // but the notes stay unreadable until it is approved
    assert.equal((await carol.api.get(`/spaces/${space.body.id}/notes`)).status, 403);
  });

  it("hides mentions from spaces the reader cannot access", async () => {
    const space = await ada.api.post("/spaces", {
      name: "Hidden Room",
      visibility: "private",
    });
    const created = await ada.api.post(`/spaces/${space.body.id}/notes`, {
      title: "secret",
      body: `@${bob.handle} psst`,
    });
    // the tag created bob an invite, but he has not been approved
    const feed = await bob.api.get("/mentions");
    assert.ok(
      !feed.body.items.some((i) => i.note.id === created.body.id),
      "an unapproved invite must not leak the note",
    );

    // once approved, it appears
    const spaces = await bob.api.get("/spaces");
    const pending = spaces.body.find((s) => s.id === space.body.id);
    await ada.api.post(`/requests/${pending.pendingRequestId}/approve`);

    const after = await bob.api.get("/mentions");
    assert.ok(after.body.items.some((i) => i.note.id === created.body.id));
  });

  it("re-invites on re-tag when a previous request was denied", async () => {
    const space = await ada.api.post("/spaces", {
      name: "Sour Room",
      visibility: "private",
    });
    await ada.api.post(`/spaces/${space.body.id}/notes`, {
      title: "one",
      body: `@${bob.handle} please`,
    });

    const before = await bob.api.get("/spaces");
    const pending = before.body.find((s) => s.id === space.body.id);
    await ada.api.post(`/requests/${pending.pendingRequestId}/deny`);

    let state = await bob.api.get("/spaces");
    assert.equal(state.body.find((s) => s.id === space.body.id).pendingRequest, null);

    await ada.api.post(`/spaces/${space.body.id}/notes`, {
      title: "two",
      body: `@${bob.handle} again please`,
    });

    state = await bob.api.get("/spaces");
    assert.equal(
      state.body.find((s) => s.id === space.body.id).pendingRequest,
      "viewer",
      "a fresh tag should reopen the request",
    );
  });

  it("pages the mentions feed", async () => {
    const me = clientFor(server.base);
    const created = await me.register("feedreader", "#0d1117");
    assert.equal(created.status, 201);
    const handle = created.body.user.handle;
    for (let i = 0; i < 5; i += 1) {
      await ada.api.post("/notes", { title: `feed ${i}`, body: `@${handle} item ${i}` });
    }
    const first = await me.get("/mentions?limit=2");
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.hasMore, true);

    const second = await me.get(`/mentions?limit=2&cursor=${first.body.nextCursor}`);
    assert.equal(second.body.items.length, 2);

    const third = await me.get(`/mentions?limit=2&cursor=${second.body.nextCursor}`);
    assert.equal(third.body.items.length, 1);
    assert.equal(third.body.hasMore, false);

    const seen = [...first.body.items, ...second.body.items, ...third.body.items];
    assert.equal(new Set(seen.map((i) => i.note.id)).size, 5);
  });

  it("keeps the admin's own access intact", () => {
    assert.ok(admin.user.isAdmin);
  });
});
