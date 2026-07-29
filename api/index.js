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
  authorId: text("author_id"),
  editorColor: text("editor_color"),
  history: text("history"),
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
    const { title, body, color, authorId } = req.body;
    const tagged = color ? `{% ${color} %}${body}{% end %}` : body;
    const now = new Date().toISOString();
    const result = await db.insert(notes).values({ title, body: tagged, authorColor: color, authorId, history: "[]", createdAt: now, updatedAt: now }).returning();
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/notes", async (req, res) => {
  try {
    const { id, title, body } = req.body;
    const existing = await db.select({ body: notes.body, title: notes.title, history: notes.history }).from(notes).where(eq(notes.id, id)).limit(1);
    if (!existing.length) return res.status(404).json({ error: "Not found" });
    const history = JSON.parse(existing[0].history || "[]");
    history.push({ body: existing[0].body, title: existing[0].title, updatedAt: existing[0].updatedAt || new Date().toISOString() });
    const now = new Date().toISOString();
    const result = await db
      .update(notes)
      .set({ title, body, history: JSON.stringify(history), updatedAt: now })
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
    const noteId = Number(req.params.id);
    if (token === process.env.ADMIN_TOKEN) {
      await db.delete(notes).where(eq(notes.id, noteId));
      return res.status(204).end();
    }
    const note = await db.select({ authorId: notes.authorId }).from(notes).where(eq(notes.id, noteId)).limit(1);
    if (note.length && note[0].authorId && token === note[0].authorId) {
      await db.delete(notes).where(eq(notes.id, noteId));
      return res.status(204).end();
    }
    res.status(401).json({ error: "Unauthorized" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/notes/:id/rollback", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const noteId = Number(req.params.id);
    const note = await db.select().from(notes).where(eq(notes.id, noteId)).limit(1);
    if (!note.length) return res.status(404).json({ error: "Not found" });
    const isSuper = token === process.env.ADMIN_TOKEN;
    const isAuthor = note[0].authorId && token === note[0].authorId;
    if (!isSuper && !isAuthor) return res.status(401).json({ error: "Unauthorized" });
    const history = JSON.parse(note[0].history || "[]");
    if (!history.length) return res.status(400).json({ error: "No history to rollback to" });
    const prev = history.pop();
    const now = new Date().toISOString();
    const result = await db
      .update(notes)
      .set({ title: prev.title, body: prev.body, history: JSON.stringify(history), updatedAt: now })
      .where(eq(notes.id, noteId))
      .returning();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 3) });
});

export default app;
