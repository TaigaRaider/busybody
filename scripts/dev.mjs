/**
 * One-shot dev launcher: migrate, then run the API and the Vite dev server
 * together. Avoids the two-terminal dance and guarantees the schema is current
 * before the first request lands.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
    child.on("error", reject);
  });

const children = [];
const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await run(process.execPath, ["server/scripts/migrate.mjs"]);

// Prefer running Vite's bin directly. Going through `npm` would need
// `shell: true` on Windows (npm is a .cmd), which Node warns about, and it
// costs an extra process for no benefit.
const viteBin = join(root, "client", "node_modules", "vite", "bin", "vite.js");

children.push(
  spawn(process.execPath, ["server/src/index.js"], { stdio: "inherit" }),
  // Vite resolves its config and index.html relative to cwd, so it has to run
  // from client/ (which is what `npm --prefix client` would have done).
  existsSync(viteBin)
    ? spawn(process.execPath, [viteBin], { stdio: "inherit", cwd: join(root, "client") })
    : spawn("npm", ["--prefix", "client", "run", "dev"], { stdio: "inherit" }),
);

console.log("\n  api    http://localhost:8080");
console.log("  client http://localhost:5173\n");
