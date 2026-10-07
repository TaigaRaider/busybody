import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, clientFor, PALETTE } from "./helpers.js";

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "even-better-battery-staple";

/** Asserts a response carries nothing that could be replayed as a credential. */
function assertNoSecrets(body) {
  const json = JSON.stringify(body);
  assert.ok(!json.includes("passwordHash"), `leaked passwordHash: ${json}`);
  assert.ok(!json.includes("password_hash"), `leaked password_hash: ${json}`);
  assert.ok(!json.includes(PASSWORD), `leaked the password: ${json}`);
}

describe("password auth", () => {
  let server;
  let alice;

  before(async () => {
    server = await boot({ adminHandle: "alice" });

    alice = clientFor(server.base);
    const created = await alice.register("alice", PALETTE[0], PASSWORD);
    assert.equal(created.status, 201);
    // Admin comes from an operator grant paired with the designated handle, not
    // from being first. `alice` is the ADMIN_HANDLE for this file's board.
    await server.grantAdmin("alice");
  });

  after(async () => {
    await server.close();
  });

  describe("registration", () => {
    it("refuses to create an account without a password", async () => {
      for (const body of [
        { handle: "nopass", color: PALETTE[1] },
        { handle: "nopass", color: PALETTE[1], password: "" },
        { handle: "nopass", color: PALETTE[1], password: null },
        { handle: "nopass", color: PALETTE[1], password: "short" },
      ]) {
        const res = await clientFor(server.base).post("/auth/register", body);
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        assert.equal(res.body.code, "INVALID_PASSWORD");
        assertNoSecrets(res.body);
      }

      // And the handle is still free, so nothing half-created it.
      const retry = await clientFor(server.base).register("nopass", PALETTE[1], PASSWORD);
      assert.equal(retry.status, 201);
    });

    it("never returns password material", async () => {
      const res = await clientFor(server.base).register("quiet", PALETTE[2], PASSWORD);
      assert.equal(res.status, 201);
      assert.equal(res.body.user.passwordHash, undefined);
      assertNoSecrets(res.body);
      assert.ok(res.body.token.length > 20);
    });
  });

  describe("sign in", () => {
    it("accepts a handle and password", async () => {
      const fresh = clientFor(server.base);
      const res = await fresh.login("alice", PASSWORD);
      assert.equal(res.status, 200);
      assert.equal(res.body.user.handle, "alice");
      assert.equal(res.body.user.isAdmin, true);
      assert.ok(res.body.token.length > 20);
      assertNoSecrets(res.body);

      // The issued token is a real credential, not just a formality.
      assert.equal((await fresh.get("/auth/me")).status, 200);
      assert.equal((await fresh.get("/auth/me")).body.user.handle, "alice");
    });

    it("issues a fresh token and retires the previous one", async () => {
      const first = clientFor(server.base);
      const a = await first.login("alice", PASSWORD);
      const stolen = a.body.token;

      const second = clientFor(server.base);
      const b = await second.login("alice", PASSWORD);

      assert.notEqual(b.body.token, stolen);
      // Signing in again must evict the older session, so a token copied out of
      // a shared browser stops working as soon as the owner signs in themselves.
      assert.equal((await clientFor(server.base, stolen).get("/auth/me")).status, 401);
      assert.equal((await second.get("/auth/me")).status, 200);
    });

    it("matches the handle case-insensitively, like registration", async () => {
      const res = await clientFor(server.base).login("ALICE", PASSWORD);
      assert.equal(res.status, 200);
      assert.equal(res.body.user.handle, "alice");
    });

    it("rejects a wrong password", async () => {
      const res = await clientFor(server.base).login("alice", "not-the-password");
      assert.equal(res.status, 401);
      assert.equal(res.body.code, "BAD_CREDENTIALS");
      assertNoSecrets(res.body);
    });

    it("answers identically for an unknown handle", async () => {
      const ghost = await clientFor(server.base).login("nobody-here", PASSWORD);
      const wrong = await clientFor(server.base).login("alice", "not-the-password");

      // Identical down to the code, so the endpoint cannot be used to discover
      // which handles exist.
      assert.equal(ghost.status, wrong.status);
      assert.deepEqual(ghost.body, wrong.body);
    });

    it("rejects empty or non-string credentials", async () => {
      for (const body of [
        { handle: "alice", password: "" },
        { handle: "alice" },
        { handle: "", password: PASSWORD },
        { handle: "alice", password: 12345 },
        {},
      ]) {
        const res = await clientFor(server.base).post("/auth/login", body);
        assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(body)}`);
        assert.equal(res.body.code, "BAD_CREDENTIALS");
      }
    });

    it("cannot be walked into with a token in the password field", async () => {
      // The token is still a valid bearer credential, but it must not double as
      // a password -- otherwise rotating the token would be pointless.
      const victim = clientFor(server.base);
      await victim.register("wall", PALETTE[3], PASSWORD);
      const res = await clientFor(server.base).login("wall", victim.token);
      assert.equal(res.status, 401);
    });

    it("refuses an account that has no password", async () => {
      // The anon-* placeholders created by the legacy migration carry
      // authorship but hold no credential. They must be permanently locked
      // rather than left with some accidental way in.
      const { db } = await import("../lib/db.js");
      const { users } = await import("../lib/schema.js");

      await db.insert(users).values({
        handle: "ghostauthor",
        displayName: "Archived author",
        color: "#0d1117",
        tokenHash: "placeholder-token-hash-0001",
        passwordHash: null,
        isAdmin: 0,
        createdAt: new Date().toISOString(),
      });

      const res = await clientFor(server.base).login("ghostauthor", "");
      assert.equal(res.status, 401);
      assert.equal(res.body.code, "BAD_CREDENTIALS");

      for (const guess of ["password", "12345678", "correct-horse-battery", "anon"]) {
        const attempt = await clientFor(server.base).login("ghostauthor", guess);
        assert.equal(attempt.status, 401, `placeholder accepted ${guess}`);
      }
    });

    it("throttles a run of failures against one handle", async () => {
      // A dedicated account, deliberately. The limiter keys on ip+handle with a
      // small budget, and alice has already spent hers in the tests above --
      // sharing a handle would make this test pass or fail for the wrong
      // reason.
      const sprayed = clientFor(server.base);
      await sprayed.register("sprayed", PALETTE[4], PASSWORD);

      const anon = clientFor(server.base);
      for (let i = 0; i < 10; i += 1) {
        const res = await anon.login("sprayed", `guess-${i}`);
        assert.equal(res.status, 401, `attempt ${i + 1} should still be a plain rejection`);
      }

      const blocked = await anon.login("sprayed", PASSWORD);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, "RATE_LIMITED");

      // Holding the correct password does not buy a way past the window.
      assert.equal((await anon.login("sprayed", PASSWORD)).status, 429);
    });
  });

  describe("change password", () => {
    let bob;

    before(async () => {
      // Its own account so the sign-in budget is not shared with alice.
      bob = clientFor(server.base);
      const created = await bob.register("bob", PALETTE[5], PASSWORD);
      assert.equal(created.status, 201);
    });

    it("requires authentication", async () => {
      const anon = clientFor(server.base);
      const res = await anon.post("/auth/change-password", {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      assert.equal(res.status, 401);
    });

    it("rejects a wrong current password and leaves the old one working", async () => {
      const changer = clientFor(server.base);
      await changer.login("bob", PASSWORD);

      const res = await changer.post("/auth/change-password", {
        currentPassword: "not-the-password",
        newPassword: NEW_PASSWORD,
      });
      // 400, not 401: the caller is authenticated, the supplied password is not
      // correct. A 401 here would make the client's interceptor sign them out.
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "BAD_CREDENTIALS");

      // The failed attempt must not have changed anything.
      assert.equal((await clientFor(server.base).login("bob", PASSWORD)).status, 200);
    });

    it("rejects a new password that fails the policy", async () => {
      const changer = clientFor(server.base);
      await changer.login("bob", PASSWORD);

      for (const newPassword of ["short", "", "x".repeat(201)]) {
        const res = await changer.post("/auth/change-password", {
          currentPassword: PASSWORD,
          newPassword,
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(newPassword)}`);
        assert.equal(res.body.code, "INVALID_PASSWORD");
      }
      assert.equal((await clientFor(server.base).login("bob", PASSWORD)).status, 200);
    });

    it("swaps the password, reissues the token, and retires the old one", async () => {
      const changer = clientFor(server.base);
      await changer.login("bob", PASSWORD);
      const oldToken = changer.token;

      const res = await changer.post("/auth/change-password", {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.token.length > 20);
      assert.notEqual(res.body.token, oldToken);
      assertNoSecrets(res.body);

      // The caller's own token is invalidated, so the browser has to adopt the
      // returned one. A leaked old token stops working immediately.
      assert.equal((await clientFor(server.base, oldToken).get("/auth/me")).status, 401);

      changer.token = res.body.token;
      assert.equal((await changer.get("/auth/me")).status, 200);

      // New password in, old password out.
      assert.equal((await clientFor(server.base).login("bob", PASSWORD)).status, 401);
      const fresh = clientFor(server.base);
      assert.equal((await fresh.login("bob", NEW_PASSWORD)).status, 200);
      assert.equal((await fresh.get("/auth/me")).status, 200);
    });

    it("is refused for the environment admin token", async () => {
      // ADMIN_TOKEN is a deployment secret, not an account. It has no password
      // row to update, so pretending otherwise would be a lie.
      const envAdmin = clientFor(server.base, "test-admin-token");
      const res = await envAdmin.post("/auth/change-password", {
        currentPassword: "anything",
        newPassword: NEW_PASSWORD,
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /no password/i);
    });

    it("never answers 401 for a bad input on an authenticated route", async () => {
      // The client clears its stored token on any 401 and drops to the auth
      // screen. So a 401 on these routes -- where the caller demonstrably *is*
      // signed in -- would mean a typo silently signs the user out.
      const changer = clientFor(server.base);
      await changer.login("bob", NEW_PASSWORD);
      const token = changer.token;

      const probes = await Promise.all([
        changer.post("/auth/change-password", { currentPassword: "nope", newPassword: "another-good-one" }),
        changer.post("/auth/change-password", { currentPassword: NEW_PASSWORD, newPassword: "short" }),
        changer.post("/auth/change-password", {}),
        changer.patch("/auth/me", { color: "rebeccapurple" }),
        changer.patch("/auth/me", { handle: "Bad Handle" }),
        changer.post("/spaces", { name: "" }),
      ]);

      for (const res of probes) {
        assert.notEqual(res.status, 401, `unexpected 401 from ${JSON.stringify(res.body)}`);
      }

      // And the session genuinely survived all of that.
      assert.equal((await clientFor(server.base, token).get("/auth/me")).status, 200);
    });
  });
});