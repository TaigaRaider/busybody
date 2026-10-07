import { useEffect, useRef, useState } from "react";
import { renderRuns } from "../../../lib/richtext";
import { IconClose, IconFit, IconPencil, IconUndo } from "./Icons";

const SIZES = ["small", "wide", "tall", "big"];

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * The one shared renderer for a thought's text: colour spans become chalk and
 * `@handle` tags become tappable mention chips, exactly as they do in the body
 * of a single-writer card.
 */
function ThoughtRuns({ text, color, mentions, onTag }) {
  return renderRuns(`{% ${color} %}${text}{% end %}`, mentions || {}).map((run, i) =>
    run.type === "mention" ? (
      <button
        key={i}
        type="button"
        className="mention"
        style={{ color: run.color }}
        title={run.userId ? `Notes mentioning @${run.handle}` : `@${run.handle} (no account)`}
        onClick={() => onTag(run.handle)}
      >
        {run.text}
      </button>
    ) : (
      <span key={i} style={{ color: run.color }}>
        {run.text}
      </span>
    ),
  );
}

/**
 * `canResize` is separate from the note permissions on purpose: the bento size
 * is a personal layout preference, so a reader who may not touch a single word
 * still gets it. It is also the one preference the server refuses a ghost,
 * which is why it cannot simply be inferred from `perm`.
 */
export default function NoteCard({
  note,
  onEdit,
  onDelete,
  onRollback,
  onResize,
  onAppend,
  onEditThought,
  onDeleteVote,
  onTag,
  onFocus,
  canResize = true,
}) {
  const perm = note.perm || {};
  const edited = note.updatedAt && note.updatedAt !== note.createdAt;

  // The consent poll to remove a shared card, when one is open. `null`/absent
  // means the card has no other writer to consult and deletes as it always
  // did. While pending, the × is disabled and the count below it is what the
  // author waits on; other contributors get the "vote to delete" button.
  const vote = note.deleteVote || null;
  const deletePending = vote && !vote.approved;

  // The card's attributed thoughts, opening first. Every stored note has at
  // least the author's opening (the migration backfills it), but a stale
  // cached note could lack the array, so fall back to an empty one.
  const thoughts = note.thoughts?.length ? note.thoughts : [];
  const multiThought = thoughts.length > 1;

  const [appending, setAppending] = useState(false);
  const [appendText, setAppendText] = useState("");
  const [editingThought, setEditingThought] = useState(null); // thought id + draft
  const [thoughtBusy, setThoughtBusy] = useState(false);

  // A card is "clipped" when its content outgrows the height cap. The cap stops
  // boxes from stretching into tall columns as the grid narrows — which is what
  // made text re-wrap awkwardly. Clipped cards fade out at the bottom and offer
  // a focus trigger instead of a scrollbar inside a fixed-height box. The two
  // observers keep the measure honest: ResizeObserver catches the box shrinking
  // (size cycle, narrower viewport), MutationObserver catches content changing
  // (a thought appended, an edit saved, the consent poll appearing).
  const chalkRef = useRef(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const el = chalkRef.current;
    if (!el || !onFocus) return undefined;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [onFocus]);

  const submitAppend = async () => {
    const text = appendText.trim();
    if (!text || !onAppend || appending) return;
    setAppending(true);
    try {
      await onAppend(note, text);
      setAppendText("");
    } catch {
      /* the toast already said why; keep the draft so nothing is lost */
    } finally {
      setAppending(false);
    }
  };

  const saveThought = async () => {
    if (!editingThought || thoughtBusy || !editingThought.draft.trim()) return;
    setThoughtBusy(true);
    try {
      await onEditThought(note, editingThought.id, editingThought.draft.trim());
      setEditingThought(null);
    } catch {
      /* keep the editor open with the draft, per the toast's explanation */
    } finally {
      setThoughtBusy(false);
    }
  };

  const runs =
    multiThought
      ? []
      : renderRuns(note.body, note.mentions || {});

  /** A thought's byline: chalk dot, handle, time, and an "edited" marker. */
  const thoughtByline = (thought) => (
    <p className="thought-byline">
      <span className="chalk-dot" style={{ backgroundColor: thought.color }} />
      {/* Same byline states as a note: live, departed (greyed), never had one. */}
      {thought.author ? (
        <span className={thought.author.gone ? "author-gone" : undefined}>
          @{thought.author.handle}
        </span>
      ) : (
        "archived"
      )}
      {" · "}
      {timeAgo(thought.createdAt)}
      {thought.updatedAt !== thought.createdAt
        ? ` · edited ${timeAgo(thought.updatedAt)}`
        : ""}
    </p>
  );

  return (
    <article className={`note-card ${note.size}`}>
      <div className="card-buttons-top-right">
        {canResize && (
          <button
            type="button"
            className="resize"
            title={`Change card size (${SIZES[(SIZES.indexOf(note.size) + 1) % SIZES.length]})`}
            aria-label="Change card size"
            onClick={() => onResize(note)}
          >
            <IconFit size={16} />
          </button>
        )}
        {perm.canEdit && (
          <button
            type="button"
            className="edit-button"
            title="Edit this note"
            aria-label="Edit this note"
            onClick={() => onEdit(note)}
          >
            <IconPencil size={16} />
          </button>
        )}
        {perm.canRollback && (
          <button
            type="button"
            className="rollback"
            title="Undo the last edit"
            aria-label="Undo the last edit"
            onClick={() => onRollback(note)}
          >
            <IconUndo size={16} />
          </button>
        )}
        {perm.canDelete && (
          <button
            type="button"
            className="remove"
            title={
              deletePending
                ? `Waiting for consent — ${vote.consents} of ${vote.contributors} contributors agree`
                : "Delete"
            }
            aria-label="Delete this note"
            disabled={deletePending}
            onClick={() => onDelete(note)}
          >
            <IconClose size={16} />
          </button>
        )}
      </div>

      <div
        ref={chalkRef}
        className={`note-chalk${clipped ? " clipped" : ""}`}
        style={{ borderLeftColor: note.authorColor || "var(--gray-600)" }}
      >
        {note.title && <h2>{note.title}</h2>}

        {multiThought ? (
          /* A card with appended thoughts renders each one as its own block:
             the author's opening first, then every append, each chalked and
             bylined with its writer. None of them is a runway for rewriting
             anyone else's — the pencil appears only on your own thought and
             only while the server's edit window is still open. */
          <div className="thought-stack">
            {thoughts.map((thought) => (
              <div key={thought.id} className="thought">
                <div className="body-colored">
                  <ThoughtRuns
                    text={thought.text}
                    color={thought.color}
                    mentions={note.mentions}
                    onTag={onTag}
                  />
                </div>
                {editingThought?.id === thought.id ? (
                  <div className="thought-edit">
                    <textarea
                      rows={3}
                      value={editingThought.draft}
                      autoFocus
                      onChange={(e) =>
                        setEditingThought({ id: thought.id, draft: e.target.value })
                      }
                    />
                    <div className="thought-edit-actions">
                      <button
                        type="button"
                        className="ghost"
                        disabled={thoughtBusy || !editingThought.draft.trim()}
                        onClick={saveThought}
                      >
                        {thoughtBusy ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setEditingThought(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="thought-foot">
                    {thoughtByline(thought)}
                    {thought.perm?.canEdit && (
                      <button
                        type="button"
                        className="thought-edit-button"
                        title="Edit your thought"
                        aria-label="Edit your thought"
                        onClick={() =>
                          setEditingThought({ id: thought.id, draft: thought.text })
                        }
                      >
                        <IconPencil size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          /* A single-writer card keeps exactly the rendering it always had. */
          <>
            <div className="body-colored">
              {runs.map((run, i) =>
                run.type === "mention" ? (
                  <button
                    key={i}
                    type="button"
                    className="mention"
                    style={{ color: run.color }}
                    title={run.userId ? `Notes mentioning @${run.handle}` : `@${run.handle} (no account)`}
                    onClick={() => onTag(run.handle)}
                  >
                    {run.text}
                  </button>
                ) : (
                  <span key={i} style={{ color: run.color }}>
                    {run.text}
                  </span>
                ),
              )}
            </div>
            <p className="note-timestamp">
              <span className="chalk-dot" style={{ backgroundColor: note.authorColor || "var(--gray-600)" }} />
              {/* Three bylines, told apart by `gone`: a live account, a departed one
                  (the server sends the snapshot handle with `gone: true`), or a note
                  that never had an author at all. Collapsing the middle case into
                  "archived" would claim it was anonymous, which it was not. */}
              {note.author ? (
                <span className={note.author.gone ? "author-gone" : undefined}>
                  @{note.author.handle}
                </span>
              ) : (
                "archived"
              )}
              {" · "}
              {timeAgo(note.createdAt)}
              {edited ? ` · edited ${timeAgo(note.updatedAt)}` : ""}
            </p>
          </>
        )}

        {perm.canAppend && (
          <div className="append-box">
            <textarea
              rows={2}
              placeholder="Add a thought of your own…"
              value={appendText}
              onChange={(e) => setAppendText(e.target.value)}
            />
            <div className="append-actions">
              <button
                type="button"
                disabled={appending || !appendText.trim()}
                onClick={submitAppend}
              >
                {appending ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
        )}

        {deletePending && (
          <div className="delete-consent">
            <p className="delete-consent-note">
              Removing this card needs the other writers to agree —{" "}
              {vote.consents} of {vote.contributors} have.
            </p>
            {vote.canVote && !perm.isMine && (
              <button
                type="button"
                className="ghost delete-consent-vote"
                onClick={() => onDeleteVote?.(note)}
              >
                Vote to delete
              </button>
            )}
          </div>
        )}

        {clipped && onFocus && (
          <button
            type="button"
            className="focus-trigger"
            aria-label="Read the full note"
            onClick={() => onFocus(note)}
          >
            Read the rest
          </button>
        )}
      </div>
    </article>
  );
}