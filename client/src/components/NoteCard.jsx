import { renderRuns } from "../../../lib/richtext";

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
  onTag,
  canResize = true,
}) {
  const runs = renderRuns(note.body, note.mentions || {});
  const perm = note.perm || {};
  const edited = note.updatedAt && note.updatedAt !== note.createdAt;

  return (
    <article className={`note-card ${note.size}`}>
      <div className="card-buttons-top-right">
        {canResize && (
          <button
            type="button"
            className="resize"
            title={`Resize (${SIZES[(SIZES.indexOf(note.size) + 1) % SIZES.length]})`}
            onClick={() => onResize(note)}
          >
            ◇
          </button>
        )}
        {perm.canEdit && (
          <button type="button" className="edit-button" title="Edit" onClick={() => onEdit(note)}>
            ∆
          </button>
        )}
        {perm.canRollback && (
          <button type="button" className="rollback" title="Roll back one edit" onClick={() => onRollback(note)}>
            ↩
          </button>
        )}
        {perm.canDelete && (
          <button type="button" className="remove" title="Delete" onClick={() => onDelete(note)}>
            ×
          </button>
        )}
      </div>

      <div className="note-chalk" style={{ borderLeftColor: note.authorColor || "var(--gray-600)" }}>
        {note.title && <h2>{note.title}</h2>}
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
          {note.author ? `@${note.author.handle}` : "archived"}
          {" · "}
          {timeAgo(note.createdAt)}
          {edited ? ` · edited ${timeAgo(note.updatedAt)}` : ""}
        </p>
      </div>
    </article>
  );
}
