/**
 * Local development entry point. Production runs `api/index.js` on Vercel.
 */
import { createApp } from "../../lib/app.js";

const app = createApp();

// Vercel supplies its own listener, so only bind a port outside Vercel.
if (process.env.VERCEL !== "1") {
  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`TABLOID api listening on http://localhost:${port}`);
  });
}

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

export default app;
