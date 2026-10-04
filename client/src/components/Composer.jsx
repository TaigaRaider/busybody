import { useEffect, useRef, useState } from "react";
import { searchUsers } from "../api";

/** Matches a partially typed tag immediately before the caret. */
const PARTIAL_TAG = /@([a-z0-9._-]*)$/i;

/**
 * Note composer with `@handle` autocomplete. Tags are stored as literal text in
 * the body; the API re-indexes them into `note_mentions` on save.
 */
export default function Composer({
  editing,
  onSubmit,
  onCancel,
  busy,
  collapsed = false,
  onExpand,
  onCollapse,
}) {
  // Seeded from props rather than synced in an effect: the parent remounts this
  // component with a new `key` whenever the note being edited changes, so the
  // form always starts from the right values.
  const [title, setTitle] = useState(editing?.title || "");
  const [body, setBody] = useState(editing?.plainBody || "");
  const [suggestions, setSuggestions] = useState([]);
  const [highlight, setHighlight] = useState(0);

  const areaRef = useRef(null);
  const titleRef = useRef(null);
  const debounceRef = useRef(null);
  const wasCollapsed = useRef(collapsed);

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  // Tapping "Post something" in the bottom bar should land the caret in the
  // form, not merely reveal it. Gated on the collapsed -> expanded edge so a
  // desktop mount never steals focus from the page.
  useEffect(() => {
    const justExpanded = wasCollapsed.current && !collapsed;
    wasCollapsed.current = collapsed;
    if (justExpanded) titleRef.current?.focus();
  }, [collapsed]);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const closeSuggestions = () => {
    clearTimeout(debounceRef.current);
    setSuggestions([]);
    setHighlight(0);
  };

  const handleChange = (event) => {
    const value = event.target.value;
    const caret = event.target.selectionStart;
    setBody(value);

    event.target.style.height = "";
    event.target.style.height = `${event.target.scrollHeight}px`;

    clearTimeout(debounceRef.current);
    const match = value.slice(0, caret).match(PARTIAL_TAG);
    if (!match) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      searchUsers(match[1])
        .then((found) => {
          setSuggestions(found);
          setHighlight(0);
        })
        .catch(() => setSuggestions([]));
    }, 150);
  };

  const accept = (account) => {
    const area = areaRef.current;
    if (!area) return;
    const caret = area.selectionStart;
    const match = body.slice(0, caret).match(PARTIAL_TAG);
    if (!match) return;

    const start = caret - match[1].length - 1;
    const insert = `@${account.handle} `;
    setBody(`${body.slice(0, start)}${insert}${body.slice(caret)}`);
    closeSuggestions();

    const nextCaret = start + insert.length;
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleKeyDown = (event) => {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(suggestions[highlight]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSuggestions();
    }
  };

  const submit = (event) => {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() && !body.trim()) return;
    onSubmit({ title: title.trim(), body: body.trim() });
  };

  // On a phone this form used to sit permanently expanded above the notes,
  // costing 170px of the first screen whether or not you wanted to write.
  // Collapsed it is one button; `editing` never collapses, because an edit form
  // you cannot see is a note you cannot edit.
  if (collapsed && !editing) {
    return (
      <button type="button" className="composer-collapsed" onClick={onExpand}>
        <span className="composer-collapsed-mark" aria-hidden="true">
          +
        </span>
        Post something
      </button>
    );
  }

  return (
    <form className="note-form" onSubmit={submit}>
      <input
        ref={titleRef}
        type="text"
        placeholder="Topic"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="composer-body">
        <textarea
          ref={areaRef}
          placeholder="Write something… use @handle to tag someone"
          value={body}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(closeSuggestions, 120)}
          rows={3}
        />
        {suggestions.length > 0 && (
          <ul className="mention-menu">
            {suggestions.map((account, i) => (
              <li key={account.id}>
                <button
                  type="button"
                  className={i === highlight ? "active" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(account);
                  }}
                >
                  <span className="chalk-dot" style={{ backgroundColor: account.color }} />
                  @{account.handle}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="composer-actions">
        <button type="submit" disabled={busy}>
          {editing ? "Update" : "Post"}
        </button>
        {/* Cancel means two different things: abandoning an edit, and putting an
            expanded mobile composer back away. Without the second, tapping Post
            leaves a full form on screen with no way to undo it. */}
        {(editing || onCollapse) && (
          <button
            type="button"
            className="ghost"
            onClick={editing ? onCancel : onCollapse}
          >
            Cancel
          </button>
        )}
        <span className="composer-hint">@mention tags notify people</span>
      </div>
    </form>
  );
}
