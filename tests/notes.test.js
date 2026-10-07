import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, makeUsers, PALETTE } from "./helpers.js";

describe("notes", () => {
  let server;
  let owner; // user0 — the file's designated admin handle, used for the admin-deletion case
  let ada;
  let bob;
  let admin;

  before(async () => {
    server = await boot({ adminHandle: "user0" });
    [owner, ada, bob] = await makeUsers(server.base, 3);
    await server.grantAdmin("user0");
    admin = clientFor(server.base, "test-admin-token");
  });
  after(async () => {
    await server.close();
  });

  const post = (api, body, title = "topic") =>
    api.post("/notes", { title, body });

  /** Reads the stored edit trail straight from the database. */
  const historyLen = async (noteId) => {
    const { db } = await import("../lib/db.js");
    const { notes } = await import("../lib/schema.js");
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select({ history: notes.history })
      .from(notes)
      .where(eq(notes.id, noteId))
      .limit(1);
    return JSON.parse(rows[0].history || "[]").length;
  };

  it("creates a note wrapped in the author's chalk", async () => {
    const res = await post(ada.api, "hello world");
    assert.equal(res.status, 201);
    assert.equal(res.body.title, "topic");
    assert.equal(res.body.authorId, ada.user.id);
    assert.equal(res.body.authorColor, ada.user.color);
    assert.equal(res.body.body, `{% ${ada.user.color} %}hello world{% end %}`);
    assert.equal(res.body.perm.isMine, true);
    assert.equal(res.body.perm.canDelete, true);
  });

  it("takes the chalk from the account, not the request", async () => {
    const res = await post(
      ada.api,
      "spoof attempt",
      "spoof",
    );
    assert.ok(!res.body.body.includes("#000000"));
    assert.equal(res.body.authorColor, ada.user.color);
  });

  it("rejects an empty note", async () => {
    const res = await post(ada.api, "   ", "   ");
    assert.equal(res.status, 400);
  });

  it("refuses to let the environment admin post", async () => {
    const res = await post(admin, "from the void");
    assert.equal(res.status, 400);
  });

  it("stamps the author identity onto every listed note", async () => {
    const created = await post(ada.api, "who wrote this");
    const res = await ada.api.get("/notes");
    const found = res.body.items.find((n) => n.id === created.body.id);
    assert.equal(found.author.handle, ada.handle);
    assert.equal(found.author.color, ada.user.color);
  });

  /* ------------------------- deletion authorization ------------------------ */

  it("lets the author delete their own note", async () => {
    const created = await post(ada.api, "delete me");
    const res = await ada.api.del(`/notes/${created.body.id}`);
    assert.equal(res.status, 204);
  });

  it("stops a stranger deleting someone else's note", async () => {
    const created = await post(ada.api, "mine, thanks");
    const res = await bob.api.del(`/notes/${created.body.id}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "NOT_PERMITTED");
    // still there
    const list = await ada.api.get("/notes");
    assert.ok(list.body.items.some((n) => n.id === created.body.id));
  });

  it("rejects a user id presented as a bearer token", async () => {
    // The old scheme used a client-side uuid *as* the credential. An id is not
    // a credential, so it is rejected before any authorization runs.
    const created = await post(ada.api, "still mine");
    const spoof = clientFor(server.base, String(ada.user.id));
    assert.equal((await spoof.del(`/notes/${created.body.id}`)).status, 401);
  });

  it("lets an admin delete anybody's note", async () => {
    const created = await post(ada.api, "moderated away");
    const res = await admin.del(`/notes/${created.body.id}`);
    assert.equal(res.status, 204);
  });

  it("does not expose a delete button to non-owners", async () => {
    const created = await post(ada.api, "read only for you");
    const asBob = await bob.api.get("/notes");
    const found = asBob.body.items.find((n) => n.id === created.body.id);
    assert.equal(found.perm.canDelete, false);
    assert.equal(found.perm.canEdit, false);
    assert.equal(found.perm.isMine, false);
  });

  it("404s deleting something that is not there", async () => {
    assert.equal((await ada.api.del("/notes/999999")).status, 404);
  });

  /* ------------------------------- editing ------------------------------- */

  it("stops a stranger editing", async () => {
    const created = await post(ada.api, "original");
    const res = await bob.api.put(`/notes/${created.body.id}`, {
      title: "hijacked",
      body: "hijacked",
    });
    assert.equal(res.status, 403);
  });

  it("lets the author edit and records a history entry", async () => {
    const created = await post(ada.api, "first");
    const res = await ada.api.put(`/notes/${created.body.id}`, {
      title: "second",
      body: "{% #ffffff %}second{% end %}",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "second");
    assert.notEqual(res.body.updatedAt, res.body.createdAt);
    // The edit trail is recorded, and it stays off the wire: `history` is the
    // private store that rollback reads from, not part of the published card.
    assert.equal(await historyLen(created.body.id), 1);
    assert.equal(res.body.history, undefined);
  });

  it("rolls back to the previous revision", async () => {
    const created = await post(ada.api, "v1", "v1");
    await ada.api.put(`/notes/${created.body.id}`, {
      title: "v2",
      body: "{% #ffffff %}v2{% end %}",
    });
    const rolled = await ada.api.put(`/notes/${created.body.id}/rollback`);
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.title, "v1");
    assert.ok(rolled.body.body.includes("v1"));
    assert.equal(await historyLen(created.body.id), 0);
  });

  it("refuses a rollback with no history", async () => {
    const created = await post(ada.api, "no history");
    const res = await ada.api.put(`/notes/${created.body.id}/rollback`);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "NO_HISTORY");
  });

  it("caps the stored history so notes cannot grow without bound", async () => {
    const created = await post(ada.api, "revision 0");
    for (let i = 1; i <= 25; i += 1) {
      await ada.api.put(`/notes/${created.body.id}`, {
        title: `revision ${i}`,
        body: `{% #ffffff %}revision ${i}{% end %}`,
      });
    }
    const list = await ada.api.get("/notes");
    const found = list.body.items.find((n) => n.id === created.body.id);
    // Still stored (the 20-revision ceiling lives in the store), still not
    // shipped to readers.
    assert.equal(await historyLen(created.body.id), 20);
    assert.equal(found.history, undefined);
  });

  it("stops a stranger rolling back", async () => {
    const created = await post(ada.api, "guarded");
    await ada.api.put(`/notes/${created.body.id}`, {
      title: "changed",
      body: "{% #ffffff %}changed{% end %}",
    });
    assert.equal((await bob.api.put(`/notes/${created.body.id}/rollback`)).status, 403);
  });

  /* ------------------------------ pagination ------------------------------ */

  it("pages through notes with a stable cursor", async () => {
    // Use a private space so the fixture is isolated from every other note in
    // the database.
    const scoped = clientFor(server.base);
    await scoped.register("paginator", PALETTE[4]);
    const space = await scoped.post("/spaces", { name: "pagination fixture" });
    assert.equal(space.status, 201);

    for (let i = 0; i < 7; i += 1) {
      const created = await scoped.post(
        `/spaces/${space.body.id}/notes`,
        { title: `p${i}`, body: `page ${i}` },
      );
      assert.equal(created.status, 201);
    }

    const first = await scoped.get(`/spaces/${space.body.id}/notes?limit=3`);
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 3);
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.nextCursor);

    const second = await scoped.get(
      `/spaces/${space.body.id}/notes?limit=3&cursor=${first.body.nextCursor}`,
    );
    assert.equal(second.body.items.length, 3);
    assert.equal(second.body.hasMore, true);

    const third = await scoped.get(
      `/spaces/${space.body.id}/notes?limit=3&cursor=${second.body.nextCursor}`,
    );
    assert.equal(third.body.items.length, 1);
    assert.equal(third.body.hasMore, false);
    assert.equal(third.body.nextCursor, null);

    // newest first, no duplicates, no gaps
    const seen = [...first.body.items, ...second.body.items, ...third.body.items];
    assert.equal(new Set(seen.map((n) => n.id)).size, 7);
    const ids = seen.map((n) => n.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  });

  it("clamps a silly limit instead of trusting it", async () => {
    const res = await ada.api.get("/notes?limit=100000");
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length <= 50);
  });

  it("ignores a junk cursor", async () => {
    const res = await ada.api.get("/notes?cursor=not-a-number");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  });

  /* --------------------------- persisted layout --------------------------- */

  it("defaults a card to small", async () => {
    const created = await post(ada.api, "layout default");
    assert.equal(created.body.size, "small");
  });

  it("persists a resized card for the resizing user only", async () => {
    const created = await post(ada.api, "layout me");

    const resized = await ada.api.put(`/notes/${created.body.id}/layout`, {
      size: "big",
    });
    assert.equal(resized.status, 200);
    assert.equal(resized.body.size, "big");

    // survives a refetch
    const mine = await ada.api.get("/notes");
    assert.equal(
      mine.body.items.find((n) => n.id === created.body.id).size,
      "big",
    );

    // but is somebody else's business
    const theirs = await bob.api.get("/notes");
    assert.equal(
      theirs.body.items.find((n) => n.id === created.body.id).size,
      "small",
    );
  });

  it("cycles through every size slot", async () => {
    const created = await post(ada.api, "cycle");
    for (const size of ["wide", "tall", "big", "small"]) {
      const res = await ada.api.put(`/notes/${created.body.id}/layout`, { size });
      assert.equal(res.body.size, size);
    }
  });

  it("rejects an unknown size", async () => {
    const created = await post(ada.api, "bad size");
    const res = await bob.api.put(`/notes/${created.body.id}/layout`, {
      size: "enormous",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_SIZE");
  });

  it("404s a layout change on a missing note", async () => {
    assert.equal((await ada.api.put("/notes/999999/layout", { size: "wide" })).status, 404);
  });
});
