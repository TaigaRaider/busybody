import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

/**
 * Boots the real API against a throwaway SQLite file on an ephemeral port.
 *
 * `node --test` runs each test file in its own process, so each file gets its
 * own module registry and therefore its own database — the env vars below are
 * read by `lib/db.js` and `server/scripts/migrate.mjs` on first import.
 */
export async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "tabloid-test-"));

  process.env.TURSO_DATABASE_URL = `file:${join(dir, "test.db")}`;
  process.env.TURSO_AUTH_TOKEN = "";
  process.env.ADMIN_TOKEN = "test-admin-token";
  process.env.CORS_ORIGIN = "*";

  const { migrate } = await import("../server/scripts/migrate.mjs");
  await migrate();

  const dbModule = await import("../lib/db.js");
  const { createApp } = await import("../lib/app.js");
  const server = createApp().listen(0);
  await once(server, "listening");

  const base = `http://127.0.0.1:${server.address().port}`;
  const removeDir = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS will reclaim the temp dir */
    }
  };
  process.on("exit", removeDir);

  return {
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      // Release the sqlite handle before deleting the file, otherwise Windows
      // refuses with EPERM.
      dbModule.client.close();
      removeDir();
    },
  };
}

/** Thin fetch wrapper that carries a bearer token and parses JSON. */
export function clientFor(base, token = null) {
  const state = { token };

  async function call(method, path, body) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    return { status: response.status, body: parsed };
  }

  return {
    get token() {
      return state.token;
    },
    set token(value) {
      state.token = value;
    },
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    patch: (path, body) => call("PATCH", path, body),
    del: (path) => call("DELETE", path),
    /** Registers and keeps the returned token for later calls. */
    async register(handle, color) {
      const res = await call("POST", "/auth/register", { handle, color });
      if (res.status === 201) state.token = res.body.token;
      return res;
    },
  };
}

export const PALETTE = [
  "#e06c75",
  "#98c379",
  "#61afef",
  "#e5c07b",
  "#c678dd",
  "#56b6c2",
  "#d19a66",
  "#abb2bf",
];

/** Registers `count` throwaway accounts and returns one client per handle. */
export async function makeUsers(base, count) {
  const clients = [];
  for (let i = 0; i < count; i += 1) {
    const handle = `user${i}`;
    const api = clientFor(base);
    const res = await api.register(handle, PALETTE[i % PALETTE.length]);
    if (res.status !== 201) {
      throw new Error(`could not register ${handle}: ${JSON.stringify(res.body)}`);
    }
    clients.push({ handle, api, user: res.body.user, token: res.body.token });
  }
  return clients;
}
