import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Canonical schema for the whole app.
 *
 * Imported by the API, the local dev server and drizzle-kit. Previously this
 * file was duplicated (and drifted) between `server/src/db/schema.js` and
 * `api/index.js`.
 */

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Always stored lowercase; uniqueness is enforced by the DB.
  handle: text("handle").notNull().unique(),
  displayName: text("display_name"),
  // Always stored as lowercase #rrggbb; one chalk per user, enforced by the DB.
  color: text("color").notNull().unique(),
  // sha256 hex of the bearer token. The raw token is only ever returned once,
  // at registration / rotation time, and is never stored.
  tokenHash: text("token_hash").notNull().unique(),
  isAdmin: integer("is_admin").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const spaces = sqliteTable("spaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => users.id),
  // "private" => non-members see metadata only, must request access
  // "public"  => non-members may read notes without joining
  visibility: text("visibility").notNull().default("private"),
  createdAt: text("created_at").notNull(),
});

export const spaceMembers = sqliteTable(
  "space_members",
  {
    spaceId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // viewer | participant | moderator | owner
    role: text("role").notNull(),
    addedBy: integer("added_by").references(() => users.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    index("space_members_user_idx").on(t.userId),
  ],
);

export const spaceRequests = sqliteTable(
  "space_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    spaceId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // viewer | participant  (escalation to moderator/owner is never requestable)
    requestedRole: text("requested_role").notNull(),
    message: text("message"),
    // pending | approved | denied | cancelled
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolvedBy: integer("resolved_by").references(() => users.id),
  },
  (t) => [
    // One request row per (space, user); re-requesting updates it in place.
    uniqueIndex("space_requests_unique").on(t.spaceId, t.userId),
    index("space_requests_space_idx").on(t.spaceId, t.status),
    index("space_requests_user_idx").on(t.userId, t.status),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // null => the public "Lobby"
    spaceId: integer("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    title: text("title"),
    body: text("body"),
    authorId: integer("author_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Snapshot of the author's chalk at write time, so old notes keep their
    // colour even if the user later changes theirs.
    authorColor: text("author_color"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // JSON array of previous revisions, capped server-side.
    history: text("history").notNull().default("[]"),
  },
  (t) => [
    index("notes_space_idx").on(t.spaceId, t.createdAt),
    index("notes_author_idx").on(t.authorId),
  ],
);

/**
 * Durable record of `@handle` tags. The literal `@handle` text also stays in
 * the note body so tags survive edits and render inline; this table is the
 * queryable source of truth used for the mentions feed and for permission
 * filtered lookups.
 */
export const noteMentions = sqliteTable(
  "note_mentions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mentionedBy: integer("mentioned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Denormalised from the note so the mentions feed can filter by access
    // without joining notes.
    spaceId: integer("space_id").references(() => spaces.id, {
      onDelete: "cascade",
    }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("note_mentions_unique").on(t.noteId, t.userId),
    index("note_mentions_user_idx").on(t.userId),
    index("note_mentions_space_idx").on(t.spaceId),
  ],
);

/**
 * Per-user bento board layout. Resizing a card is a personal arrangement, so
 * the size lives against (note, user) rather than on the note itself — one
 * user's board reshuffle never disturbs anyone else's.
 */
export const noteLayouts = sqliteTable(
  "note_layouts",
  {
    noteId: integer("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    size: text("size").notNull().default("small"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.userId] }),
    index("note_layouts_user_idx").on(t.userId),
  ],
);

export const ROLE_VALUES = ["viewer", "participant", "moderator", "owner"];
export const REQUESTABLE_ROLES = ["viewer", "participant"];
export const VISIBILITIES = ["private", "public"];
export const SIZES = ["small", "wide", "tall", "big"];
export const DEFAULT_SIZE = "small";
