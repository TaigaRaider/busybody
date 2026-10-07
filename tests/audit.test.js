import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, makeUsers } from "./helpers.js";

/**
 * The audit trail: every privileged mutation leaves a line behind — who, what,
 * when — and nothing else does. Privileged is defined as "touching something
 * that is not your own": deleting or editing another's card, membership
 * changes, resolving access requests, and deleting a space.
 */
describe("audit trail", () => {
  let server;
  let envAdmin; // the operator key: acts with no user row behind it
  let owner; // the space owner (a plain member of the board)
  let writer; // writes cards in the space
  let member; // asks to join, gets denied, reapplies, joins, gets removed
  let roomId; // created by the fixture test below, used by the ones after

  before(async () => {
    server = await boot();
    [owner, writer, member] = await makeUsers(server.base, 3);
    envAdmin = clientFor(server.base, "test-admin-token");
  });
  after(async () => {
    await server.close();
  });

  const all = async () => {
    const { db } = await import("../lib/db.js");
    const { adminActions } = await import("../lib/schema.js");
    return db.select().from(adminActions).orderBy(adminActions.id);
  };
  /** Everything logged since the test started. */
  const since = async (start) => (await all()).slice(start);

  it("builds the fixture and stays silent about it", async () => {
    // Nothing above is an audit event: registering, reading, posting an
    // ordinary note, creating a space — none of it touches others' things.
    assert.deepEqual(await all(), []);
  });

  it("records a membership grant, a denied then approved request, and a role change", async () => {
    const start = (await all()).length;

    const room = (await owner.api.post("/spaces", { name: "The Audit Room", visibility: "private" })).body;
    roomId = room.id;
    assert.equal(
      (await owner.api.post(`/spaces/${room.id}/members`, { handle: writer.handle, role: "participant" })).status,
      201,
    );

    const requested = (await member.api.post(`/spaces/${room.id}/requests`, { role: "participant" })).body;
    assert.equal(requested.approved, false);

    const denied = (await owner.api.post(`/requests/${requested.request.id}/deny`)).status;
    assert.equal(denied, 200);

    const requestedAgain = (await member.api.post(`/spaces/${room.id}/requests`, { role: "participant" })).body;
    const approved = (await owner.api.post(`/requests/${requestedAgain.request.id}/approve`, { role: "participant" })).status;
    assert.equal(approved, 200);

    const roleChange = await owner.api.patch(`/spaces/${room.id}/members/${member.user.id}`, { role: "viewer" });
    assert.equal(roleChange.status, 200);

    const lines = await since(start);
    assert.deepEqual(
      lines.map((l) => l.action),
      ["members.add", "request.deny", "request.approve", "members.role"],
    );

    const [add, deny, approve, role] = lines;
    assert.equal(add.actorRole, "user");
    assert.deepEqual(JSON.parse(add.details), {
      handle: owner.handle,
      spaceId: room.id,
      spaceName: "The Audit Room",
      targetId: writer.user.id,
      targetHandle: writer.handle,
      role: "participant",
    });
    assert.equal(deny.actorRole, "user");
    assert.equal(JSON.parse(deny.details).requesterId, member.user.id);
    assert.equal(JSON.parse(approve.details).role, "participant");
    assert.equal(JSON.parse(role.details).to, "viewer");
    assert.equal(JSON.parse(role.details).from, "participant");
    assert.ok(lines.every((l) => /^\d{4}-\d{2}-\d{2}T/.test(l.createdAt)));
  });

  it("logs nothing for a refused action", async () => {
    const before = (await all()).length;
    // member is only a viewer now, and not the owner: removing writer is 403.
    const refused = await member.api.del(`/spaces/${roomId}/members/${writer.user.id}`);
    assert.equal(refused.status, 403);
    assert.equal((await all()).length, before, "a denied attempt writes nothing");
  });

  it("records a non-author edit, a non-author rollback, and a removal", async () => {
    const start = (await all()).length;

    const created = (await writer.api.post("/notes", { title: "shared card", body: "opening" })).body;
    // writer edits their own card: the author's own act, not an audit event.
    assert.equal((await writer.api.put(`/notes/${created.id}`, { title: "v2", body: "opening v2" })).status, 200);
    assert.equal((await all()).length, start);

    // The env admin rewrites it, then rolls it back once.
    const edited = await envAdmin.put(`/notes/${created.id}`, { title: "v3", body: "opening v3" });
    assert.equal(edited.status, 200);
    const rolled = await envAdmin.put(`/notes/${created.id}/rollback`);
    assert.equal(rolled.status, 200);
    // And removes the member.
    assert.equal((await owner.api.del(`/spaces/${roomId}/members/${member.user.id}`)).status, 204);

    const lines = await since(start);
    assert.deepEqual(
      lines.map((l) => l.action),
      ["note.edit", "note.rollback", "members.remove"],
    );
    assert.ok(lines.every((l) => l.actorRole === "env-admin" || l.actorRole === "user"));
    const [edit, rollback, removal] = lines;
    assert.equal(edit.actorRole, "env-admin");
    assert.deepEqual(JSON.parse(edit.details), {
      handle: "admin",
      noteId: created.id,
      authorId: created.authorId,
      role: null,
    });
    assert.equal(rollback.actorRole, "env-admin");
    assert.equal(JSON.parse(rollback.details).noteId, created.id);
    assert.equal(removal.actorRole, "user");
    assert.equal(JSON.parse(removal.details).targetId, member.user.id);
  });

  it("records an env-admin deleting somebody else's card", async () => {
    const created = (await writer.api.post("/notes", { title: "doomed", body: "text" })).body;
    assert.equal((await envAdmin.del(`/notes/${created.id}`)).status, 204);

    const [line] = (await all()).slice(-1);
    assert.equal(line.action, "note.delete");
    assert.equal(line.actorRole, "env-admin");
    assert.equal(JSON.parse(line.details).noteId, created.id);
    assert.equal(JSON.parse(line.details).authorId, created.authorId);
  });

  it("records deleting the space", async () => {
    const start = (await all()).length;
    const room = (await owner.api.post("/spaces", { name: "Doomed Room", visibility: "private" })).body;
    assert.equal((await owner.api.del(`/spaces/${room.id}`)).status, 204);

    const lines = await since(start);
    assert.deepEqual(lines.map((l) => l.action), ["space.delete"]);
    assert.deepEqual(JSON.parse(lines[0].details), {
      handle: owner.handle,
      spaceId: room.id,
      name: "Doomed Room",
      role: "owner",
    });
  });
});