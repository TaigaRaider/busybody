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
  composerCollapsed,
  onExpandComposer,
  onCollapseComposer,
  onRequestJoin,
  onWithdrawJoin,
  requestingJoin,
  ghosted,
}) {
  // The Lobby has no space and therefore no capability list to narrow, so the
  // ghost check has to be here too - otherwise the one board everybody can post
  // to is the one board a ghost can still post to.
  const canPost = !ghosted && (space ? space.caps.includes("create_note") : true);

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
          collapsed={composerCollapsed}
          onExpand={onExpandComposer}
          onCollapse={onCollapseComposer}
        />
      ) : (
        /* A public space grants read to non-members, so this panel is the only
           route from browsing to posting — `AccessPanel` never renders for a
           space you can already read. Without the button the notice below it
           was advice with no way to act on it.

           A ghost gets the same panel with different words: the caps are
           narrowed server-side so the composer closed on its own, but "request
           to participate" would be advice they cannot take and the server would
           refuse. */
        <div className="board-readonly">
          {ghosted ? (
            <p>
              You are reading this as a ghost. You can see everything here as it
              was when you left, but posting and access requests are closed until
              you revive.
            </p>
          ) : (
            <>
              <p>
                {onWithdrawJoin
                  ? `Your request for ${space.pendingRequest} access is waiting for a moderator.`
                  : "You have read access to this space. Request to participate to post."}
              </p>
              {onRequestJoin && (
                <button
                  type="button"
                  className="ghost"
                  disabled={requestingJoin}
                  onClick={onRequestJoin}
                >
                  {requestingJoin ? "requesting…" : "request to participate"}
                </button>
              )}
              {/* Withdrawing from here for the same reason: the request was made from
                  here, and AccessPanel is not on screen to undo it. */}
              {onWithdrawJoin && (
                <button type="button" className="ghost" onClick={onWithdrawJoin}>
                  withdraw request
                </button>
              )}
            </>
          )}
        </div>
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
            canResize={!ghosted}
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
