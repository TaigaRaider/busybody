import { defineConfig } from "drizzle-kit";

/**
 * Optional: `drizzle-kit` is only needed for schema *pushes* against a fresh
 * database. Ongoing schema changes are applied with `npm run migrate`, which
 * also carries the legacy-data upgrade that a push cannot express.
 */
export default defineConfig({
  out: "./drizzle",
  schema: "../lib/schema.js",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL || "file:local.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
