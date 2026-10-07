import { useEffect, useState } from "react";
import { stripMarkup } from "../../../lib/richtext";
import Composer from "./Composer";
import NoteCard from "./NoteCard";
import { IconSearch } from "./Icons";

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
  onAppend,
  onEditThought,
  onDeleteVote,
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
  user,
}) {
  // The Lobby has no space and therefore no capability list to narrow, so the
  // ghost check has to be here too - otherwise the one board everybody can post
  // to is the one board a ghost can still post to.
  const canPost = !ghosted && (space ? space.caps.includes("create_note") : true);

  const query = search.trim().toLowerCase();

  /**
   * `whoami?` in the search box answers with your own name instead of filtering.
   *
   * Exact match on the trimmed, lowercased query, with the question mark
   * optional — punctuation that carries no intent should not decide whether a
   * question gets answered, but anything looser would hijack a genuine search
   * for the word. Checked before the filter so it never reads as "0 of 12
   * loaded", which would look like a failed search rather than an answer.
   */
  const askingWhoAmI = query === "whoami" || query === "whoami?";

  // The focused (full-view) note. Kept as an id so the reader always shows the
  // freshest copy of the note — after an append or an edit it re-resolves from
  // the loaded pages — and closes on its own if the note disappears (deleted or
  // dropped off the paged set). While an edit is active it resolves to nothing,
  // so the reader closes and the composer opens front and centre instead of
  // hiding behind the overlay.
  const [focusedId, setFocusedId] = useState(null);
  const focused =
    focusedId && !editing ? notes.find((n) => n.id === focusedId) : null;

  useEffect(() => {
    if (!focusedId) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") setFocusedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [focusedId]);

  const visible = askingWhoAmI
    ? []
    : query
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
                  {requestingJoin ? "Requesting…" : "Request to participate"}
                </button>
              )}
              {/* Withdrawing from here for the same reason: the request was made from
                  here, and AccessPanel is not on screen to undo it. */}
              {onWithdrawJoin && (
                <button type="button" className="ghost" onClick={onWithdrawJoin}>
                  Withdraw request
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="search-bar">
        <span className="search-icon" aria-hidden="true">
          <IconSearch size={17} />
        </span>
        <input
          className="search-input"
          type="search"
          placeholder="Search these notes…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {/* Hidden while asking: "0 of 12 loaded" beside an answer reads as a
            failed search. */}
        {query && !askingWhoAmI && (
          <span className="search-count">
            {visible.length} of {notes.length} loaded
          </span>
        )}
      </div>

      {/* The board is anonymous to everyone else, so this is the one place a
          reader can confirm who they are — and the only place their display name
          is ever shown back to them, since it is hidden everywhere else. */}
      {askingWhoAmI && user && (
        <div className="whoami">
          <p className="chalk-dot big" style={{ backgroundColor: user.color }} />
          {/* The handle is the headline, because it is the only part of your
              identity the board shows anybody. A display name, if you have set
              one, is the smaller line — it is a note to yourself here, not a
              name you are known by. */}
          <p className="whoami-name">@{user.handle}</p>
          {user.displayName && (
            <p className="whoami-handle">{user.displayName}</p>
          )}
          <p className="whoami-note">
            On here since {new Date(user.createdAt).toLocaleDateString()}. Nobody
            else on the board can see this — your notes carry only your handle
            and chalk.
          </p>
        </div>
      )}

      <div className="notes-grid">
        {/* First run: the board is blank, so instead of a bare "no notes yet"
            this teaches the one thing the board does. It only appears now — once
            there is a single note, the board speaks for itself. */}
        {notes.length === 0 && !query && !askingWhoAmI && (
          <div className="board-empty">
            <h2 className="board-empty-title">No notes yet</h2>
            <p className="board-empty-message">{emptyMessage}</p>
            <ol>
              <li data-step="1">
                Post a note with the composer above — a title, a thought, or both.
              </li>
              <li data-step="2">
                Anyone can add their own thought to any note; it is credited to them.
              </li>
              <li data-step="3">
                Type @handle anywhere to tag someone — they will find it under
                Mentions.
              </li>
            </ol>
          </div>
        )}
        {notes.length === 0 && query && !askingWhoAmI && (
          <p className="empty">nothing matches “{search}” in the notes you have loaded</p>
        )}
        {notes.length > 0 && visible.length === 0 && !askingWhoAmI && (
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
            onAppend={onAppend}
            onEditThought={onEditThought}
            onDeleteVote={onDeleteVote}
            onTag={onTag}
            onFocus={(note) => setFocusedId(note.id)}
            canResize={!ghosted}
          />
        ))}
      </div>

      {/* The full-note reader. A clipped card ("Read the rest") opens here at
          full height with every action the board offers; the width is fixed so
          the text keeps its line breaks instead of re-wrapping to whatever the
          grid shrank to. Closes on Close / Escape / tapping the scrim, and by
          itself when the note it shows is deleted. */}
      {focused && (
        <div
          className="focus-scrim"
          role="dialog"
          aria-modal="true"
          aria-label="Full note"
          onClick={() => setFocusedId(null)}
        >
          <div className="focus-modal" onClick={(e) => e.stopPropagation()}>
            <div className="focus-bar">
              <span>Full view of this note</span>
              <button
                type="button"
                className="focus-close"
                autoFocus
                onClick={() => setFocusedId(null)}
              >
                Close
              </button>
            </div>
            <NoteCard
              note={focused}
              onEdit={onEdit}
              onDelete={onDelete}
              onRollback={onRollback}
              onAppend={onAppend}
              onEditThought={onEditThought}
              onDeleteVote={onDeleteVote}
              onTag={onTag}
              canResize={false}
            />
          </div>
        </div>
      )}

      {/* Suppressed while asking: paging the board you just asked to be told
          where you are would answer a different question. */}
      {hasMore && !askingWhoAmI && (
        <div className="load-more-wrap">
          <button
            type="button"
            className="load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : `Load more (${notes.length} shown)`}
          </button>
        </div>
      )}
    </div>
  );
}
