import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";

/**
 * Single database connection for the whole app.
 *
 * Falls back to a local SQLite file when TURSO_DATABASE_URL is unset so that
 * `npm run dev` works with no remote configuration.
 */
const url = process.env.TURSO_DATABASE_URL || "file:local.db";

export const client = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

// drizzle 1.0 takes a config object rather than a client instance.
export const db = drizzle({ client, schema });

export { schema };
