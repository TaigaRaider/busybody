import { stripMarkup } from "../../../lib/richtext";
import Composer from "./Composer";
import NoteCard from "./NoteCard";

/**
 * The bento board. Notes arrive a page at a time; "load more" walks the
 * cursor. Polling refreshes only the newest page and merges, so older pages the
 * reader already loaded stay put.
 */
export default function Board({
  space,
  notes,
  search,
  onSearch,
  editing,
  onEdit,
  onCancelEdit,
  onSubmit,
  onDelete,
  onRollback,
  onResize,
  onTag,
  hasMore,
  loadingMore,
  onLoadMore,
  busy,
  emptyMessage,
}) {
  const canPost = space ? space.caps.includes("create_note") : true;

  const query = search.trim().toLowerCase();
  const visible = query
    ? notes.filter((n) => {
        const plain = stripMarkup(n.body).toLowerCase();
        return (
          (n.title || "").toLowerCase().includes(query) || plain.includes(query)
        );
      })
    : notes;

  return (
    <div className="board">
      {canPost ? (
        <Composer
          key={editing ? `edit-${editing.id}` : "new"}
          editing={editing}
          busy={busy}
          onSubmit={onSubmit}
          onCancel={onCancelEdit}
        />
      ) : (
        <p className="board-readonly">
          You have read access to this space. Request to participate to post.
        </p>
      )}

      <div className="search-bar">
        <input
          className="search-input"
          type="search"
          placeholder="search loaded notes, or @handle…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {query && (
          <span className="search-count">
            {visible.length} of {notes.length} loaded
          </span>
        )}
      </div>

      <div className="notes-grid">
        {notes.length === 0 && <p className="empty">{emptyMessage}</p>}
        {notes.length > 0 && visible.length === 0 && (
          <p className="empty">no matches for “{search}” in the notes you have loaded</p>
        )}

        {visible.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            onEdit={onEdit}
            onDelete={onDelete}
            onRollback={onRollback}
            onResize={onResize}
            onTag={onTag}
          />
        ))}
      </div>

      {hasMore && (
        <div className="load-more-wrap">
          <button
            type="button"
            className="load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "loading…" : `load more (${notes.length} shown)`}
          </button>
        </div>
      )}
    </div>
  );
}
