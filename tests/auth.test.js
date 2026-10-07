import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, PALETTE, TEST_PASSWORD } from "./helpers.js";

describe("auth", () => {
  let server;
  let api;

  before(async () => {
    server = await boot({ adminHandle: "ada" });
    api = clientFor(server.base);
  });
  after(async () => {
    await server.close();
  });

  it("registers an account and returns a bearer token", async () => {
    const res = await api.register("ada", PALETTE[0]);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.handle, "ada");
    assert.equal(res.body.user.color, PALETTE[0]);
    assert.ok(res.body.token.length > 20);
    // The raw token must never be echoed back inside the user record.
    assert.equal(res.body.user.tokenHash, undefined);
    // Registration never bootstraps an admin: the role belongs to the
    // designated ADMIN_HANDLE (ada, for this file's board) once an operator
    // grants it, so a brand-new account is always ordinary.
    assert.equal(res.body.user.isAdmin, false);
  });

  it("does not make later accounts admins", async () => {
    const res = await clientFor(server.base).register("zoe", PALETTE[1]);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.isAdmin, false);
  });

  it("only the designated handle can act as admin, and only with an operator grant", async () => {
    // `api` holds ada's token, and ada is the ADMIN_HANDLE for this file's
    // board — yet without the operator's is_admin=1 grant, ada is ordinary.
    const before = await api.get("/auth/me");
    assert.equal(before.body.user.isAdmin, false, "a fresh account is never promoted");

    await server.grantAdmin("ada");
    const promoted = await api.get("/auth/me");
    assert.equal(
      promoted.body.user.isAdmin,
      true,
      "designated handle + operator grant = the admin",
    );

    // A granted row under a different handle has no authority at all.
    await server.grantAdmin("zoe");
    const zoe = await clientFor(server.base).login("zoe", TEST_PASSWORD);
    assert.equal(zoe.status, 200);
    assert.equal(zoe.body.user.isAdmin, false, "wrong handle, no authority");
  });

  it("lowercases the handle and colour", async () => {
    const res = await clientFor(server.base).register("MiXeD", PALETTE[3].toUpperCase());
    assert.equal(res.status, 201);
    assert.equal(res.body.user.handle, "mixed");
    assert.equal(res.body.user.color, PALETTE[3]);
  });

  it("rejects a duplicate handle", async () => {
    const res = await clientFor(server.base).register("ada", PALETTE[4]);
    assert.equal(res.status, 409);
    assert.equal(res.body.field, "handle");
  });

  it("rejects a colour another handle already claimed", async () => {
    const res = await clientFor(server.base).register("grace", PALETTE[0]);
    assert.equal(res.status, 409);
    assert.equal(res.body.field, "color");
  });

  it("rejects malformed handles", async () => {
    for (const handle of ["a", "Has Upper", "has space", ""]) {
      const res = await clientFor(server.base).register(handle, PALETTE[5]);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(handle)}`);
    }
  });

  it("rejects malformed colours", async () => {
    const res = await clientFor(server.base).register("nocolour", "rebeccapurple");
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_COLOR");
  });

  it("refuses unauthenticated access", async () => {
    const anon = clientFor(server.base);
    for (const [method, path] of [
      ["get", "/auth/me"],
      ["get", "/notes"],
      ["get", "/spaces"],
      ["get", "/mentions"],
    ]) {
      const res = await anon[method](path);
      assert.equal(res.status, 401, `${path} should require auth`);
    }
  });

  it("returns the profile for a valid token", async () => {
    const me = await api.get("/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.handle, "ada");
    assert.deepEqual(me.body.memberships, []);
    assert.equal(me.body.adminTokenConfigured, true);
  });

  it("rejects a bogus token", async () => {
    const fake = clientFor(server.base, "not-a-real-token");
    assert.equal((await fake.get("/auth/me")).status, 401);
  });

  it("accepts the environment admin token", async () => {
    const admin = clientFor(server.base, "test-admin-token");
    const res = await admin.get("/auth/me");
    assert.equal(res.status, 200);
    assert.equal(res.body.user.handle, "admin");
  });

  it("rotates the token and invalidates the old one", async () => {
    const victim = clientFor(server.base);
    await victim.register("rotator", PALETTE[6]);
    const oldToken = victim.token;

    const rotated = await victim.post("/auth/rotate-token");
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.token, oldToken);

    victim.token = rotated.body.token;
    assert.equal((await victim.get("/auth/me")).status, 200);

    const stale = clientFor(server.base, oldToken);
    assert.equal((await stale.get("/auth/me")).status, 401);
  });

  it("changes the chalk colour but enforces uniqueness", async () => {
    const changer = clientFor(server.base);
    await changer.register("painter", PALETTE[7]);

    const ok = await changer.patch("/auth/me", { color: "#123456" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.color, "#123456");

    const clash = await changer.patch("/auth/me", { color: PALETTE[0] });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.field, "color");
  });

  it("searches handles for autocomplete", async () => {
    const res = await api.get("/users?q=ad");
    assert.equal(res.status, 200);
    assert.ok(res.body.some((u) => u.handle === "ada"));
    assert.ok(res.body.every((u) => !("tokenHash" in u)));
  });

  it("lists claimed colours without leaking token hashes", async () => {
    const res = await api.get("/colors");
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    assert.ok(res.body.every((row) => row.color && !("tokenHash" in row)));
  });

  it("answers the health check without auth", async () => {
    const res = await clientFor(server.base).get("/ping");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it("404s unknown endpoints", async () => {
    const res = await api.get("/nope");
    assert.equal(res.status, 404);
  });
});
