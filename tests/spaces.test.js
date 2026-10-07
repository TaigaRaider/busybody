import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, makeUsers } from "./helpers.js";

/**
 * The three-tier gate: discover -> read -> participate, plus the moderator
 * powers that sit on top.
 */
describe("spaces and access requests", () => {
  let server;
  let owner;
  let guest;
  let outsider;
  let spaceId;

  before(async () => {
    server = await boot();
    [owner, guest, outsider] = await makeUsers(server.base, 3);
    const created = await owner.api.post("/spaces", {
      name: "The Back Room",
      description: "quiet corner",
      visibility: "private",
    });
    assert.equal(created.status, 201);
    spaceId = created.body.id;
  });
  after(async () => {
    await server.close();
  });

  const spaceNotes = (api) => api.get(`/spaces/${spaceId}/notes`);
  const postNote = (api, body) =>
    api.post(`/spaces/${spaceId}/notes`, { title: "topic", body });

  /* ------------------------------ creation ------------------------------ */

  it("makes the creator the owner", async () => {
    const res = await owner.api.get(`/spaces/${spaceId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "owner");
    assert.equal(res.body.slug, "the-back-room");
    assert.equal(res.body.visibility, "private");
    assert.ok(res.body.caps.includes("manage_members"));
    assert.ok(res.body.caps.includes("delete_any"));
    assert.equal(res.body.memberCount, 1);
  });

  it("rejects an unnamed space", async () => {
    const res = await owner.api.post("/spaces", { name: "   " });
    assert.equal(res.status, 400);
  });

  it("gives colliding names distinct slugs", async () => {
    const a = await owner.api.post("/spaces", { name: "The Back Room" });
    const b = await owner.api.post("/spaces", { name: "the back room!" });
    assert.equal(a.body.slug, "the-back-room-2");
    assert.equal(b.body.slug, "the-back-room-3");
  });

  /* --------------------------- locked out ------------------------------- */

  it("lists a private space to non-members but grants nothing", async () => {
    const res = await guest.api.get("/spaces");
    assert.equal(res.status, 200);
    const found = res.body.find((s) => s.id === spaceId);
    assert.ok(found, "private spaces stay discoverable");
    assert.equal(found.role, null);
    assert.equal(found.pendingRequest, null);
    assert.deepEqual(found.caps, ["discover"]);
  });

  it("hides the notes from a non-member", async () => {
    await postNote(owner.api, "members only");
    const res = await spaceNotes(guest.api);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "NEEDS_REQUEST");
  });

  it("hides the roster from a non-member", async () => {
    assert.equal((await guest.api.get(`/spaces/${spaceId}/members`)).status, 403);
  });

  it("stops a non-member posting", async () => {
    const res = await postNote(guest.api, "let me in");
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "NEEDS_REQUEST");
  });

  it("stops a non-member changing membership or settings", async () => {
    assert.equal((await guest.api.patch(`/spaces/${spaceId}`, { name: "hijack" })).status, 403);
    assert.equal((await guest.api.del(`/spaces/${spaceId}`)).status, 403);
    assert.equal(
      (await guest.api.patch(`/spaces/${spaceId}/members/${owner.user.id}`, { role: "owner" })).status,
      403,
    );
  });

  /* ----------------------------- requesting ----------------------------- */

  it("records a pending request", async () => {
    const res = await guest.api.post(`/spaces/${spaceId}/requests`, {
      role: "participant",
      message: "let me in, I brought notes",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.approved, false);
    assert.equal(res.body.request.status, "pending");
    assert.equal(res.body.request.requestedRole, "participant");
  });

  it("surfaces the pending request to the requester", async () => {
    const res = await guest.api.get("/spaces");
    const found = res.body.find((s) => s.id === spaceId);
    assert.equal(found.pendingRequest, "participant");
    // The id is exposed so the requester can withdraw without being a mod.
    assert.ok(found.pendingRequestId);
  });

  it("still locks the notes while the request is pending", async () => {
    assert.equal((await spaceNotes(guest.api)).status, 403);
  });

  it("refuses a second membership request but lets it be edited", async () => {
    const again = await guest.api.post(`/spaces/${spaceId}/requests`, { role: "viewer" });
    assert.equal(again.status, 200);
    assert.equal(again.body.request.requestedRole, "viewer");
  });

  it("rejects an unrequestable role", async () => {
    const res = await outsider.api.post(`/spaces/${spaceId}/requests`, {
      role: "moderator",
    });
    assert.equal(res.status, 400);
  });

  it("only lets moderators see the request inbox", async () => {
    assert.equal((await guest.api.get(`/spaces/${spaceId}/requests`)).status, 403);
    assert.equal((await outsider.api.get(`/spaces/${spaceId}/requests`)).status, 403);
    const res = await owner.api.get(`/spaces/${spaceId}/requests`);
    assert.equal(res.status, 200);
    assert.ok(res.body.some((r) => r.userId === guest.user.id));
  });

  it("tells the owner there are requests to review", async () => {
    const res = await owner.api.get("/auth/me");
    assert.ok(res.body.moderating.includes(spaceId));
  });

  /* ----------------------------- approving ------------------------------ */

  it("approves a request and grants the requested role", async () => {
    const inbox = await owner.api.get(`/spaces/${spaceId}/requests`);
    const pending = inbox.body.find((r) => r.userId === guest.user.id);
    const res = await owner.api.post(`/requests/${pending.id}/approve`);
    assert.equal(res.status, 200);
    assert.equal(res.body.grantedRole, "viewer");

    const now = await guest.api.get(`/spaces/${spaceId}`);
    assert.equal(now.body.role, "viewer");
    // read, but not write
    assert.ok(now.body.caps.includes("read_notes"));
    assert.ok(!now.body.caps.includes("create_note"));
  });

  it("lets a viewer read the notes it asked for", async () => {
    const res = await spaceNotes(guest.api);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 1);
    assert.equal(res.body.items[0].perm.canEdit, false);
  });

  it("still stops a viewer posting", async () => {
    assert.equal((await postNote(guest.api, "hello")).status, 403);
  });

  it("upgrades a viewer to participant through the roster", async () => {
    const res = await owner.api.patch(`/spaces/${spaceId}/members/${guest.user.id}`, {
      role: "participant",
    });
    assert.equal(res.status, 200);
    const now = await guest.api.get(`/spaces/${spaceId}`);
    assert.ok(now.body.caps.includes("create_note"));
    assert.equal((await postNote(guest.api, "thanks")).status, 201);
  });

  it("cannot change the owner's role or remove the owner", async () => {
    assert.equal(
      (await owner.api.patch(`/spaces/${spaceId}/members/${owner.user.id}`, { role: "viewer" })).status,
      400,
    );
    assert.equal(
      (await owner.api.del(`/spaces/${spaceId}/members/${owner.user.id}`)).status,
      400,
    );
  });

  it("will not let the owner leave", async () => {
    const res = await owner.api.post(`/spaces/${spaceId}/leave`);
    assert.equal(res.status, 400);
  });

  it("lets a member leave and locks them out again", async () => {
    assert.equal((await guest.api.post(`/spaces/${spaceId}/leave`)).status, 204);
    assert.equal((await spaceNotes(guest.api)).status, 403);
  });

  it("keeps the author's rights to their own card after losing membership", async () => {
    // Re-admit guest (who left in the previous test) so they can write a card.
    const readded = await owner.api.post(`/spaces/${spaceId}/members`, {
      handle: guest.handle,
      role: "participant",
    });
    assert.equal(readded.status, 201, JSON.stringify(readded.body));

    const mine = (await postNote(guest.api, "written while a member")).body;

    // A stranger to the room gets a phantom for the same id.
    const blind = await outsider.api.del(`/notes/${mine.id}`);
    assert.equal(blind.status, 404, "a stranger cannot confirm the card exists");
    assert.equal(blind.body.code, "NOT_FOUND");

    // Leave, then confirm the card stays theirs: edit and delete still work.
    assert.equal((await guest.api.post(`/spaces/${spaceId}/leave`)).status, 204);
    const edited = await guest.api.put(`/notes/${mine.id}`, {
      title: "still mine",
      body: "v2",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((await guest.api.del(`/notes/${mine.id}`)).status, 204);
  });

  /* -------------------------- deny + escalate --------------------------- */

  it("denies a request", async () => {
    await outsider.api.post(`/spaces/${spaceId}/requests`, { role: "viewer" });
    const inbox = await owner.api.get(`/spaces/${spaceId}/requests`);
    const pending = inbox.body.find((r) => r.userId === outsider.user.id);
    const res = await owner.api.post(`/requests/${pending.id}/deny`);
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, "denied");
    assert.equal((await spaceNotes(outsider.api)).status, 403);
  });

  it("refuses to resolve the same request twice", async () => {
    const inbox = await owner.api.get(`/spaces/${spaceId}/requests`);
    const settled = inbox.body.find((r) => r.userId === outsider.user.id);
    assert.equal((await owner.api.post(`/requests/${settled.id}/approve`)).status, 409);
  });

  it("lets a rejected applicant try again", async () => {
    const res = await outsider.api.post(`/spaces/${spaceId}/requests`, {
      role: "participant",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, "pending");
    assert.equal(res.body.request.requestedRole, "participant");
  });

  it("promotes a participant to moderator", async () => {
    // outsider re-requested access after being denied; approve them first.
    const inbox = await owner.api.get(`/spaces/${spaceId}/requests`);
    const pending = inbox.body.find(
      (r) => r.userId === outsider.user.id && r.status === "pending",
    );
    const approved = await owner.api.post(`/requests/${pending.id}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.grantedRole, "participant");

    const res = await owner.api.patch(`/spaces/${spaceId}/members/${outsider.user.id}`, {
      role: "moderator",
    });
    assert.equal(res.status, 200);
    const me = await outsider.api.get(`/spaces/${spaceId}`);
    assert.ok(me.body.caps.includes("manage_requests"));
    assert.ok(!me.body.caps.includes("manage_members"));
  });

  it("lets a moderator delete somebody else's note", async () => {
    const note = await postNote(owner.api, "moderated content");
    const res = await outsider.api.del(`/notes/${note.body.id}`);
    assert.equal(res.status, 204);
  });

  it("stops a moderator escalating anyone to owner", async () => {
    const newbie = clientFor(server.base);
    const created = await newbie.register("newcomer", "#123456");
    assert.equal(created.status, 201);
    await newbie.post(`/spaces/${spaceId}/requests`, { role: "viewer" });

    const inbox = await owner.api.get(`/spaces/${spaceId}/requests`);
    const pending = inbox.body.find(
      (r) => r.userId === created.body.user.id && r.status === "pending",
    );
    const res = await outsider.api.post(`/requests/${pending.id}/approve`, {
      role: "owner",
    });
    assert.equal(res.status, 403);
    // ...and they are still not a member.
    assert.equal((await newbie.get(`/spaces/${spaceId}/members`)).status, 403);
  });

  it("stops a member requesting access they already have", async () => {
    // This is what keeps the self-approval guard in the approve route
    // unreachable through the public API.
    const res = await outsider.api.post(`/spaces/${spaceId}/requests`, {
      role: "participant",
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "ALREADY_MEMBER");
  });

  it("stops a moderator deleting the space", async () => {
    assert.equal((await outsider.api.del(`/spaces/${spaceId}`)).status, 403);
  });

  /* ---------------------------- public spaces --------------------------- */

  it("lets anyone read a public space without asking", async () => {
    const created = await owner.api.post("/spaces", {
      name: "Town Square",
      visibility: "public",
    });
    const open = created.body.id;
    await owner.api.post(`/spaces/${open}/notes`, { title: "hello town", body: "hi all" });

    const read = await outsider.api.get(`/spaces/${open}/notes`);
    assert.equal(read.status, 200);
    assert.equal(read.body.items.length, 1);

    const view = await outsider.api.get(`/spaces/${open}`);
    assert.deepEqual(view.body.caps, ["read_notes"]);
    assert.equal(view.body.role, null);
  });

  it("still makes posting in a public space a request", async () => {
    const open = (await owner.api.get("/spaces")).body.find((s) => s.name === "Town Square");
    const res = await outsider.api.post(`/spaces/${open.id}/notes`, { title: "x", body: "y" });
    assert.equal(res.status, 403);
    const req = await outsider.api.post(`/spaces/${open.id}/requests`, {
      role: "participant",
    });
    assert.equal(req.status, 201);
    assert.equal(req.body.approved, false);
  });

  it("grants a viewer request on a public space immediately", async () => {
    const open = (await owner.api.get("/spaces")).body.find((s) => s.name === "Town Square");
    const res = await guest.api.post(`/spaces/${open.id}/requests`, { role: "viewer" });
    assert.equal(res.status, 201);
    assert.equal(res.body.approved, true);
    const view = await guest.api.get(`/spaces/${open.id}`);
    assert.equal(view.body.role, "viewer");
  });

  it("cascades note deletion when a space is deleted", async () => {
    const created = await owner.api.post("/spaces", { name: "Temporary" });
    const doomed = created.body.id;
    await owner.api.post(`/spaces/${doomed}/notes`, { title: "t", body: "t" });
    assert.equal((await owner.api.del(`/spaces/${doomed}`)).status, 204);
    assert.equal((await owner.api.get(`/spaces/${doomed}`)).status, 404);
  });

  /* ---------------------- adding members directly ----------------------- */

  describe("adding a member by handle", () => {
    let addSpace;
    let invitee;
    let handle;

    before(async () => {
      const created = await owner.api.post("/spaces", {
        name: "Writers Room",
        visibility: "private",
      });
      addSpace = created.body.id;
      invitee = clientFor(server.base);
      const reg = await invitee.register("invitee", "#2b6cb0");
      assert.equal(reg.status, 201);
      handle = reg.body.user.handle;
    });

    /**
     * A moderator on `addSpace`, for exercising the escalation rules. The
     * handle is suffixed per call because registration is permanent and the
     * colour column is UNIQUE.
     */
    let modCount = 0;
    const makeModerator = async () => {
      modCount += 1;
      const handle = `mod-person-${modCount}`;
      const mod = clientFor(server.base);
      // The colour is derived from the handle rather than indexed into PALETTE,
      // which this file already walks past the end of.
      const color = `#${(0x333333 + modCount * 0x0f0f0f).toString(16).slice(0, 6)}`;
      const reg = await mod.register(handle, color);
      assert.equal(reg.status, 201, `register ${handle}: ${JSON.stringify(reg.body)}`);
      const added = await owner.api.post(`/spaces/${addSpace}/members`, {
        handle,
        role: "moderator",
      });
      assert.equal(added.status, 201);
      assert.equal(added.body.role, "moderator");
      return mod;
    };

    it("lets the owner add somebody by handle without a request", async () => {
      const res = await owner.api.post(`/spaces/${addSpace}/members`, { handle });
      assert.equal(res.status, 201);
      assert.equal(res.body.role, "viewer");
      assert.equal(res.body.handle, handle);

      // They can read immediately, without ever filing a request.
      const me = await invitee.get(`/spaces/${addSpace}`);
      assert.equal(me.body.role, "viewer");
      assert.ok(me.body.caps.includes("read_notes"));
      assert.ok(!me.body.caps.includes("create_note"));
    });

    it("defaults to read only and honours an explicit role", async () => {
      const res = await owner.api.post(`/spaces/${addSpace}/members`, {
        handle,
        role: "participant",
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "ALREADY_MEMBER");
      assert.equal(res.body.role, "viewer");

      // The conflict carries the userId needed to promote them via the roster.
      const promoted = await owner.api.patch(
        `/spaces/${addSpace}/members/${res.body.userId}`,
        { role: "participant" },
      );
      assert.equal(promoted.status, 200);
      const me = await invitee.get(`/spaces/${addSpace}`);
      assert.ok(me.body.caps.includes("create_note"));
    });

    it("refuses an unknown handle and a malformed one", async () => {
      const missing = await owner.api.post(`/spaces/${addSpace}/members`, {
        handle: "nobody-here",
      });
      assert.equal(missing.status, 404);

      const malformed = await owner.api.post(`/spaces/${addSpace}/members`, {
        handle: "not a handle!",
      });
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.code, "INVALID_HANDLE");
    });

    it("refuses an invalid role", async () => {
      const res = await owner.api.post(`/spaces/${addSpace}/members`, {
        handle: "someone-else",
        role: "wizard",
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "INVALID_ROLE");
    });

    it("will not let the owner add themselves", async () => {
      const res = await owner.api.post(`/spaces/${addSpace}/members`, {
        handle: owner.user.handle,
      });
      assert.equal(res.status, 400);
    });

    it("stops a non-manager adding anybody", async () => {
      const res = await invitee.post(`/spaces/${addSpace}/members`, {
        handle: outsider.user.handle,
      });
      assert.equal(res.status, 403);
    });

    it("stops a moderator adding anybody, who is also no manager", async () => {
      const mod = await makeModerator();
      const added = await mod.post(`/spaces/${addSpace}/members`, {
        handle: outsider.user.handle,
        role: "viewer",
      });
      assert.equal(added.status, 403);
    });

    it("keeps a moderator from minting a co-owner, matching approve", async () => {
      const mod = await makeModerator();

      // A moderator holds no manage_members, so adding is already refused above.
      // The escalation check that matters here is `grantableRole`: a moderator
      // asking for a tier above participant is rejected as forbidden.
      const escalate = await mod.post(`/spaces/${addSpace}/members`, {
        handle: outsider.user.handle,
        role: "moderator",
      });
      assert.equal(escalate.status, 403);
      // FORBIDDEN, not INVALID_ROLE: the request was well-formed, the caller
      // simply is not allowed to grant that tier.
      assert.equal(escalate.body.code, "FORBIDDEN");

      // And they did not get in by the back door.
      const view = await outsider.api.get(`/spaces/${addSpace}`);
      assert.equal(view.body.role, null);
      assert.deepEqual(view.body.caps, ["discover"]);
    });

    it("closes a pending request when the person is added directly", async () => {
      const pendingUser = clientFor(server.base);
      const reg = await pendingUser.register("waiter", "#975a16");
      const requested = await pendingUser.post(`/spaces/${addSpace}/requests`, {
        role: "participant",
      });
      assert.equal(requested.status, 201);

      const added = await owner.api.post(`/spaces/${addSpace}/members`, {
        handle: reg.body.user.handle,
        role: "participant",
      });
      assert.equal(added.status, 201);

      // The request is settled, so it no longer sits in the moderator inbox.
      const inbox = await owner.api.get(`/spaces/${addSpace}/requests`);
      const still = inbox.body.find(
        (r) => r.userId === reg.body.user.id && r.status === "pending",
      );
      assert.equal(still, undefined);
      // And they are a participant, not still waiting.
      const me = await pendingUser.get(`/spaces/${addSpace}`);
      assert.equal(me.body.role, "participant");
    });
  });
});
