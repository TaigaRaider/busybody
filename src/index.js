import { config } from "dotenv";
import express from "express";
import cors from "cors";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { notesTable } from "./db/schema.js";
const corsOptions = {
  "origin": "http://localhost:5173",
}

config();
const app = express();

app.use(cors(corsOptions));
app.use(express.json());

const db = drizzle(process.env.DB_FILE_NAME);

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
    const { title, body } = req.body;
    const note = await db.insert(notesTable).values({ title, body }).returning();
    res.status(201).json(note);
  } catch (e) {
    console.error("POST /notes error:", e.cause ?? e);
    res.status(500).json({ error: e.message });
  }
});

app.put("/notes", async (req, res) => {
  try {
    const { id, title, body } = req.body;
    const note = await db
      .update(notesTable)
      .set({ title, body })
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
    const id = Number(req.params.id);
    await db.delete(notesTable).where(eq(notesTable.id, id));
    res.status(204).end();
  } catch (e) {
    console.error("DELETE /notes/:id error:", e.cause ?? e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`App started at http://localhost:${process.env.PORT}`);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
