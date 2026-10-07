import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { boot, clientFor, PALETTE, TEST_PASSWORD } from "./helpers.js";

// Real limits, shared by every assertion in this file. The window is short so
// "the throttle resets once the window passes" can be tested without waiting a
// quarter of an hour. Everything here lives in this file's own process and
// database, so the tight budgets cannot disturb any other file. Registration
// is budgeted per caller address, so accounts are spread across two windows in
// `before()` and the throttling tests each use a distinct account.
process.env.RATE_LIMIT_WINDOW_MS = "1500";
process.env.RATE_LIMIT_LOGIN = "3";
process.env.RATE_LIMIT_REGISTER = "3";
process.env.RATE_LIMIT_NOTES = "3";
process.env.RATE_LIMIT_THOUGHTS = "3";
process.env.RATE_LIMIT_SPACES = "2";
process.env.RATE_LIMIT_COLOR = "2";

describe("DB-backed rate limiting", () => {
  let server;
  let noter; // note-creation budget
  let thinker; // thought-append budget (and the note host)
  let spacey; // space-creation budget
  let dye; // chalk budget
  let winker; // sign-in budget

  const make = async (handle, color) => {
    const api = clientFor(server.base);
    const res = await api.register(handle, color, TEST_PASSWORD);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return api;
  };

  before(async () => {
    server = await boot();
    // Window A: the three permitted registrations.
    winker = await make("winker", PALETTE[0]);
    noter = await make("noter", PALETTE[1]);
    await setTimeout(1700); // > RATE_LIMIT_WINDOW_MS, opening a fresh window
    // Window B: another three. This window is the one every throttle test runs
    // inside, so its budgets are the real budgets the assertions check.
    thinker = await make("thinker", PALETTE[2]);
    spacey = await make("spacey", PALETTE[3]);
    dye = await make("dye", PALETTE[4]);
  });

  after(async () => {
    await server.close();
  });

  it("throttles registration per caller address", async () => {
    const capped = await clientFor(server.base).register("round4", PALETTE[5], TEST_PASSWORD);
    assert.equal(capped.status, 429);
    assert.equal(capped.body.code, "RATE_LIMITED");
  });

  it("throttles note creation per user", async () => {
    await noter.post("/notes", { title: "one" });
    await noter.post("/notes", { title: "two" });
    await noter.post("/notes", { title: "three" });

    const capped = await noter.post("/notes", { title: "four" });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.code, "RATE_LIMITED");
  });

  it("throttles appended thoughts per user", async () => {
    const note = (await thinker.post("/notes", { title: "thought host" })).body;
    assert.ok(note.id);

    // A separate budget from note creation: one post did not touch this one.
    await thinker.post(`/notes/${note.id}/thoughts`, { text: "one" });
    await thinker.post(`/notes/${note.id}/thoughts`, { text: "two" });
    await thinker.post(`/notes/${note.id}/thoughts`, { text: "three" });

    const capped = await thinker.post(`/notes/${note.id}/thoughts`, { text: "four" });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.code, "RATE_LIMITED");
  });

  it("throttles space creation per user", async () => {
    await spacey.post("/spaces", { name: "pad one" });
    await spacey.post("/spaces", { name: "pad two" });
    const capped = await spacey.post("/spaces", { name: "pad three" });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.code, "RATE_LIMITED");
  });

  it("throttles chalk re-colouring per user", async () => {
    assert.equal((await dye.patch("/auth/me", { color: PALETTE[5] })).status, 200);
    assert.equal((await dye.patch("/auth/me", { color: PALETTE[6] })).status, 200);

    const capped = await dye.patch("/auth/me", { color: PALETTE[7] });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.code, "RATE_LIMITED");

    // Display-name edits are not chalk and do not share the colour budget.
    const renamed = await dye.patch("/auth/me", { displayName: "still me" });
    assert.equal(renamed.status, 200);
  });

  it("throttles sign-in attempts per handle, like before", async () => {
    const anon = clientFor(server.base);
    for (let i = 0; i < 3; i += 1) {
      const res = await anon.login("winker", `guess-${i}`);
      assert.equal(res.status, 401, `attempt ${i + 1} should be a plain rejection`);
    }
    const blocked = await anon.login("winker", TEST_PASSWORD);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, "RATE_LIMITED");
  });

  it("lets every budget recover once the window closes", async () => {
    await setTimeout(1700); // > RATE_LIMIT_WINDOW_MS of 1500

    // Same accounts, same endpoints: a fresh window hands each budget back.
    assert.equal((await noter.post("/notes", { title: "fresh one" })).status, 201);
    assert.equal((await spacey.post("/spaces", { name: "pad three" })).status, 201);
    assert.equal((await dye.patch("/auth/me", { color: PALETTE[7] })).status, 200);
    assert.equal((await clientFor(server.base).register("reborn", PALETTE[4], TEST_PASSWORD)).status, 201);
  });
});