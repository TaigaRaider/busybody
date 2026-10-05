import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hashPassword,
  isAcceptablePassword,
  PASSWORD_MAX,
  PASSWORD_MIN,
  verifyPassword,
} from "../lib/auth.js";
import {
  extractHandles,
  isValidHandle,
  normalizeColor,
  normalizeHandle,
  toPlainText,
} from "../lib/mentions.js";
import {
  parseColorSegments,
  rebuildColorBody,
  renderRuns,
  stripMarkup,
} from "../lib/richtext.js";
import { allow, capsFor, grantableRole, isGhosted, rank } from "../lib/permissions.js";

const privateSpace = { id: 1, visibility: "private" };
const publicSpace = { id: 2, visibility: "public" };

describe("mentions", () => {
  it("extracts handles in order without duplicates", () => {
    assert.deepEqual(
      extractHandles("hey @ada, @bob_1 and @ada again"),
      ["ada", "bob_1"],
    );
  });

  it("matches a handle at the very start", () => {
    assert.deepEqual(extractHandles("@ada hi"), ["ada"]);
  });

  it("does not treat email addresses as tags", () => {
    assert.deepEqual(extractHandles("write to foo@bar.com"), []);
  });

  it("ignores an empty or tagless body", () => {
    assert.deepEqual(extractHandles(""), []);
    assert.deepEqual(extractHandles(null), []);
    assert.deepEqual(extractHandles("nothing here"), []);
  });

  it("finds tags inside colour spans", () => {
    assert.deepEqual(extractHandles("{% #e06c75 %}ping @ada{% end %}"), ["ada"]);
  });

  it("normalises and validates handles", () => {
    assert.equal(normalizeHandle("  Ada  "), "ada");
    assert.ok(isValidHandle("ada"));
    assert.ok(isValidHandle("a.b_c-9"));
    assert.ok(!isValidHandle("a"));
    assert.ok(!isValidHandle("Ada"));
    assert.ok(!isValidHandle("has space"));
    assert.ok(!isValidHandle(""));
  });

  it("normalises colours and rejects malformed ones", () => {
    assert.equal(normalizeColor("#E06C75"), "#e06c75");
    assert.equal(normalizeColor("red"), null);
    assert.equal(normalizeColor("#fff"), null);
  });

  it("strips markup for plain-text matching", () => {
    assert.equal(toPlainText("{% #fff %}hi @ada{% end %}"), "hi @ada");
  });
});

describe("richtext", () => {
  it("splits colour spans and keeps the untagged tail", () => {
    assert.deepEqual(parseColorSegments("{% #fff %}hi{% end %} there"), [
      { text: "hi", color: "#fff" },
      { text: " there", color: "var(--gray-400)" },
    ]);
  });

  it("returns an empty list for an empty body", () => {
    assert.deepEqual(parseColorSegments(""), []);
  });

  it("keeps untagged text before the first span", () => {
    const segments = parseColorSegments("pre {% #fff %}hi{% end %}");
    assert.equal(segments[0].text, "pre ");
    assert.equal(segments[0].color, "var(--gray-400)");
    assert.equal(segments[1].text, "hi");
  });

  it("renders tags as their own runs using the resolved mention colour", () => {
    const runs = renderRuns("{% #fff %}hi @ada{% end %}", {
      ada: { id: 7, handle: "ada", color: "#0f0" },
    });
    assert.deepEqual(runs, [
      { type: "text", text: "hi ", color: "#fff" },
      { type: "mention", text: "@ada", color: "#0f0", handle: "ada", userId: 7 },
    ]);
  });

  it("still renders an unresolved tag as a mention run", () => {
    const runs = renderRuns("ping @ghost");
    assert.equal(runs.length, 2);
    assert.equal(runs[1].type, "mention");
    assert.equal(runs[1].userId, undefined);
  });

  it("does not merge adjacent tags", () => {
    const runs = renderRuns("@ada @bob");
    assert.equal(runs.filter((r) => r.type === "mention").length, 2);
  });

  it("rebuilds colour markup for an unchanged edit", () => {
    const segments = parseColorSegments("{% #fff %}hello{% end %}");
    assert.equal(rebuildColorBody("hello", segments, "#000"), "{% #fff %}hello{% end %}");
  });

  it("chalk newly typed text in the editor's own colour", () => {
    const segments = parseColorSegments("{% #fff %}hello{% end %}");
    assert.equal(
      rebuildColorBody("hello world", segments, "#000"),
      "{% #fff %}hello{% end %}{% #000 %} world{% end %}",
    );
  });

  it("survives tags passing through an edit", () => {
    const segments = parseColorSegments("{% #fff %}ping @ada{% end %}");
    assert.equal(
      rebuildColorBody("ping @ada!", segments, "#000"),
      "{% #fff %}ping @ada{% end %}{% #000 %}!{% end %}",
    );
  });

  it("strips markup but keeps tags", () => {
    assert.equal(stripMarkup("{% #fff %}a{% end %}b"), "ab");
  });
});

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.ok(await verifyPassword("correct horse battery staple", stored));
    assert.ok(!(await verifyPassword("correct horse battery stapl", stored)));
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    assert.notEqual(a, b);
    // ...but both still verify, which is the point of salting.
    assert.ok(await verifyPassword("same password", a));
    assert.ok(await verifyPassword("same password", b));
  });

  it("records its own parameters and never the password", async () => {
    const stored = await hashPassword("hunter2");
    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[\w+/=]+\$[\w+/=]+$/);
    assert.ok(!stored.includes("hunter2"));
  });

  it("refuses an account that has no password set", async () => {
    // This is the anon-* placeholder case from the legacy migration: a null
    // credential must fail closed, never throw or return true.
    assert.equal(await verifyPassword("anything", null), false);
    assert.equal(await verifyPassword("anything", undefined), false);
    assert.equal(await verifyPassword("anything", ""), false);
  });

  it("refuses malformed or tampered stored hashes", async () => {
    const stored = await hashPassword("hunter2");
    const parts = stored.split("$");

    const tampered = [...parts];
    // Flip the final hash byte.
    const raw = Buffer.from(parts[5], "base64");
    raw[0] ^= 0xff;
    tampered[5] = raw.toString("base64");
    assert.equal(await verifyPassword("hunter2", tampered.join("$")), false);

    // A different salt must not verify.
    assert.equal(await verifyPassword("hunter2", [parts[0], parts[1], parts[2], parts[3], Buffer.alloc(16).toString("base64"), parts[5]].join("$")), false);

    for (const bad of [
      "not-a-hash",
      "scrypt$1$8$1$onlyfour",
      "bcrypt$32768$8$1$c2FsdA==$aGFzaA==",
      "scrypt$0$8$1$c2FsdA==$aGFzaA==",
      // N this large would try to allocate ~8 GB; it must be refused, not run.
      `scrypt$${1 << 25}$8$1$c2FsdA==$aGFzaA==`,
      "scrypt$abc$8$1$c2FsdA==$aGFzaA==",
      `scrypt$32768$8$1$c2FsdA==`,
      `scrypt$32768$8$1$c2FsdA==$aGFzaA==$extra`,
      `scrypt$32768$8$1$$aGFzaA==`,
    ]) {
      assert.equal(await verifyPassword("hunter2", bad), false, `should reject ${bad}`);
    }
  });

  it("enforces the length policy at the boundaries", async () => {
    assert.ok(!isAcceptablePassword(null));
    assert.ok(!isAcceptablePassword(undefined));
    assert.ok(!isAcceptablePassword(12345678));
    assert.ok(!isAcceptablePassword("x".repeat(PASSWORD_MIN - 1)));
    assert.ok(isAcceptablePassword("x".repeat(PASSWORD_MIN)));
    assert.ok(isAcceptablePassword("x".repeat(PASSWORD_MAX)));
    assert.ok(!isAcceptablePassword("x".repeat(PASSWORD_MAX + 1)));
  });
});

describe("permissions", () => {
  it("ranks roles in order", () => {
    assert.ok(rank("viewer") < rank("participant"));
    assert.ok(rank("participant") < rank("moderator"));
    assert.ok(rank("moderator") < rank("owner"));
    assert.equal(rank("nonsense"), 0);
  });

  it("gives the lobby no moderator powers", () => {
    const caps = capsFor(null, null);
    assert.ok(caps.has("read_notes"));
    assert.ok(caps.has("create_note"));
    assert.ok(!caps.has("delete_any"));
    assert.ok(!caps.has("manage_requests"));
  });

  it("locks non-members out of private spaces", () => {
    const caps = capsFor(privateSpace, null);
    assert.deepEqual([...caps], ["discover"]);
  });

  it("lets non-members read public spaces but not post", () => {
    const caps = capsFor(publicSpace, null);
    assert.ok(caps.has("read_notes"));
    assert.ok(!caps.has("create_note"));
  });

  it("escalates member capabilities with the role", () => {
    assert.ok(!capsFor(privateSpace, "viewer").has("create_note"));
    assert.ok(capsFor(privateSpace, "participant").has("create_note"));
    assert.ok(capsFor(privateSpace, "moderator").has("delete_any"));
    assert.ok(capsFor(privateSpace, "moderator").has("manage_requests"));
    assert.ok(!capsFor(privateSpace, "moderator").has("manage_members"));
    assert.ok(capsFor(privateSpace, "owner").has("manage_members"));
    assert.ok(capsFor(privateSpace, "owner").has("delete_space"));
  });

  it("lets admins bypass every check", () => {
    const admin = { id: 1, isAdmin: 1 };
    assert.ok(allow(admin, privateSpace, null, "read_notes"));
    assert.ok(allow(admin, null, null, "manage_members"));
  });

  it("only lets owners mint moderators", () => {
    const owner = { id: 1, isAdmin: 0 };
    const moderator = { id: 2, isAdmin: 0 };

    assert.equal(grantableRole(owner, privateSpace, "owner", "moderator"), "moderator");
    assert.equal(grantableRole(owner, privateSpace, "owner", "participant"), "participant");

    // A space moderator can approve requests but cannot escalate anyone.
    assert.equal(grantableRole(moderator, privateSpace, "moderator", "moderator"), null);
    assert.equal(grantableRole(moderator, privateSpace, "moderator", "viewer"), "viewer");

    // Admins are not bound by space roles.
    assert.equal(grantableRole({ id: 3, isAdmin: 1 }, privateSpace, null, "owner"), "owner");
  });

  it("stops a ghost writing, whatever their role", () => {
    const ghostOwner = { id: 1, isAdmin: 0, ghostedAt: "2026-01-01T00:00:00.000Z" };

    // Reading survives, at every rank.
    assert.ok(allow(ghostOwner, privateSpace, "owner", "read_notes"));
    assert.ok(allow(ghostOwner, null, null, "read_notes"));

    // Every write does not.
    for (const action of [
      "create_note",
      "edit_own",
      "delete_own",
      "edit_any",
      "delete_any",
      "manage_requests",
      "manage_members",
      "delete_space",
    ]) {
      assert.equal(
        allow(ghostOwner, privateSpace, "owner", action),
        false,
        `${action} should be refused to a ghost`,
      );
    }

    // Including a non-member discovering a private space by name.
    assert.ok(allow(ghostOwner, privateSpace, null, "discover"));
  });

  it("refuses a ghost's own escalation even when they moderate", () => {
    const ghostMod = { id: 2, isAdmin: 0, ghostedAt: "2026-01-01T00:00:00.000Z" };
    assert.equal(grantableRole(ghostMod, privateSpace, "moderator", "viewer"), null);
  });

  it("does not let the admin flag outlive a ghosting", () => {
    // A ghost is read-only in full. Otherwise an admin could not step away,
    // and "read only" would quietly mean "read only except for the powerful".
    const ghostAdmin = { id: 3, isAdmin: 1, ghostedAt: "2026-01-01T00:00:00.000Z" };
    // Reading the Lobby still works...
    assert.ok(allow(ghostAdmin, null, null, "read_notes"));
    // ...but the admin flag no longer opens anything the role did not.
    assert.equal(allow(ghostAdmin, null, null, "delete_any"), false);
    assert.equal(allow(ghostAdmin, null, null, "manage_members"), false);
    assert.equal(allow(ghostAdmin, privateSpace, null, "read_notes"), false);
  });

  it("reports a live account as unghosted", () => {
    assert.equal(isGhosted({ id: 1, ghostedAt: null }), false);
    assert.equal(isGhosted({ id: 1 }), false);
    assert.equal(isGhosted({ id: 1, ghostedAt: "2026-01-01T00:00:00.000Z" }), true);
  });
});
