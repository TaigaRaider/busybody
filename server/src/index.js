import express from "express";
import cors from "cors";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { notesTable } from "./db/schema.js";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

app.get("/ping", (req, res) => res.json({ ok: true, url: req.url }));

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const db = drizzle(client);

app.get("/", async (req, res) => {
  const notes = await db.select().from(notesTable).all();
  res.json(notes);
});

app.get("/notes", async (req, res) => {
  try {
    const notes = await db.select().from(notesTable);
    res.json(notes);
  } catch (e) {
    console.error("GET /notes error:", e.cause ?? e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/notes", async (req, res) => {
  try {
    const { title, body, color } = req.body;
    const tagged = color ? `{% ${color} %}${body}{% end %}` : body;
    const now = new Date().toISOString();
    const note = await db.insert(notesTable).values({ title, body: tagged, authorColor: color, createdAt: now, updatedAt: now }).returning();
    res.status(201).json(note);
  } catch (e) {
    console.error("POST /notes error:", e.cause ?? e);
    res.status(500).json({ error: e.message });
  }
});

app.put("/notes", async (req, res) => {
  try {
    const { id, title, body } = req.body;
    const now = new Date().toISOString();
    const note = await db
      .update(notesTable)
      .set({ title, body, updatedAt: now })
      .where(eq(notesTable.id, id))
      .returning();
    res.json(note);
  } catch (e) {
    console.error("PUT /notes error:", e.cause ?? e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/notes/:id", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const id = Number(req.params.id);
    await db.delete(notesTable).where(eq(notesTable.id, id));
    res.status(204).end();
  } catch (e) {
    console.error("DELETE /notes/:id error:", e.cause ?? e);
    res.status(500).json({ error: e.message });
  }
});

const isVercel = process.env.VERCEL === "1";
if (!isVercel) {
  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`App started at http://localhost:${port}`);
  });
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 3).join("\n") });
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

export default app;
