/**
 * Vercel serverless entry point.
 *
 * The app itself lives in `lib/` so this file, the local dev server and the
 * test suite all exercise exactly the same code. Previously this was a
 * hand-copied duplicate of `server/src/index.js` that had already drifted.
 */
import { createApp } from "../lib/app.js";

export default createApp();
