import express from "express";
import cors from "cors";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const db = drizzle(client);

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title"),
  body: text("body"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
  authorColor: text("author_color"),
  editorColor: text("editor_color"),
});

app.get("/ping", (req, res) => res.json({ ok: true }));

app.get("/notes", async (req, res) => {
  try {
    const result = await db.select().from(notes);
    return res.json(result);
  } catch (e) {
    return res.json({ error: String(e), message: e?.message, stack: e?.stack?.split("\n").slice(0, 5) });
  }
});

app.post("/notes", async (req, res) => {
  try {
    const { title, text, color } = req.body;
    const body = JSON.stringify([{ text, color }]);
    const now = new Date().toISOString();
    const result = await db.insert(notes).values({ title, body, authorColor: color, createdAt: now, updatedAt: now }).returning();
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/notes", async (req, res) => {
  try {
    const { id, text, color } = req.body;
    const existing = await db.select({ body: notes.body }).from(notes).where(eq(notes.id, id)).limit(1);
    if (!existing.length) return res.status(404).json({ error: "Not found" });
    const contributions = JSON.parse(existing[0].body || "[]");
    contributions.push({ text, color });
    const now = new Date().toISOString();
    const result = await db
      .update(notes)
      .set({ body: JSON.stringify(contributions), editorColor: color, updatedAt: now })
      .where(eq(notes.id, id))
      .returning();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/notes/:id", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await db.delete(notes).where(eq(notes.id, Number(req.params.id)));
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 3) });
});

export default app;
