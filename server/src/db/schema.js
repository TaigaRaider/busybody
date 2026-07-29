import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notesTable = sqliteTable("notes", {
  id: int('id').primaryKey({ autoIncrement: true }),
  title: text('title'),
  body: text('body'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});
