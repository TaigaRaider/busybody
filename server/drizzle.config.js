import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.js',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_FILE_NAME,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
