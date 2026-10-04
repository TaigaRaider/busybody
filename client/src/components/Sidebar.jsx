import { useState } from "react";

const ROLE_HINT = {
  owner: "owner",
  moderator: "mod",
  participant: "post",
  viewer: "read",
};

function SpaceRow({ space, active, onSelect }) {
  return (
    <li>
      <button
        type="button"
        className={`space-row ${active ? "active" : ""}`}
        onClick={() => onSelect(space)}
      >
        <span className={`dot ${space.visibility}`} />
        <span className="space-name">{space.name}</span>
        {space.role ? (
          <span className={`chip subtle ${space.role}`}>{ROLE_HINT[space.role]}</span>
        ) : space.pendingRequest ? (
          <span className="chip subtle pending">asked</span>
        ) : (
          <span className="chip subtle">locked</span>
        )}
      </button>
    </li>
  );
}

export default function Sidebar({
  user,
  spaces,
  selection,
  onSelect,
  onCreateSpace,
  onOpenMentions,
  mentionCount,
  onSignOut,
  onRotateToken,
  rotating,
  rotatedToken,
  onDismissToken,
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [confirmRotate, setConfirmRotate] = useState(false);

  const mine = spaces.filter((s) => s.role);
  const discover = spaces.filter((s) => !s.role);
  const activeId = selection.kind === "space" ? selection.id : null;

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    const created = await onCreateSpace({ name: name.trim(), description, visibility });
    if (created) {
      setName("");
      setDescription("");
      setCreating(false);
    }
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">T</span>
        <div>
          <strong>TABLOID</strong>
          <span className="brand-sub">anonymous blackboard</span>
        </div>
      </div>

      <button
        type="button"
        className={`lobby-row ${selection.kind === "lobby" ? "active" : ""}`}
        onClick={() => onSelect({ kind: "lobby" })}
      >
        Lobby
        <span className="chip subtle">open</span>
      </button>

      <nav className="space-groups">
        <div className="group">
          <h3>your spaces</h3>
          {mine.length === 0 && <p className="group-empty">none yet</p>}
          <ul>
            {mine.map((s) => (
              <SpaceRow
                key={s.id}
                space={s}
                active={activeId === s.id}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>

        <div className="group">
          <h3>discover</h3>
          <p className="group-hint">visible, but locked until you ask</p>
          {discover.length === 0 && <p className="group-empty">nothing to discover</p>}
          <ul>
            {discover.map((s) => (
              <SpaceRow
                key={s.id}
                space={s}
                active={activeId === s.id}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>
      </nav>

      {creating ? (
        <form className="space-create" onSubmit={submit}>
          <input
            autoFocus
            placeholder="space name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="what is it for? (optional)"
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
          />
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="private">private — request to read or post</option>
            <option value="public">public — anyone can read</option>
          </select>
          <div className="row">
            <button type="submit">create</button>
            <button type="button" className="ghost" onClick={() => setCreating(false)}>
              cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="space-new" onClick={() => setCreating(true)}>
          + new space
        </button>
      )}

      <div className="sidebar-foot">
        {rotatedToken && (
          <div className="token-reveal">
            <p>your new token — copy it now, it is shown only once:</p>
            <code>{rotatedToken}</code>
            <button type="button" className="ghost" onClick={onDismissToken}>
              dismiss
            </button>
          </div>
        )}
        <button type="button" className="mentions-link" onClick={onOpenMentions}>
          mentions{mentionCount ? ` (${mentionCount})` : ""}
        </button>
        <div className="me">
          <span className="chalk-dot" style={{ backgroundColor: user.color }} />
          <span className="me-handle">@{user.handle}</span>
          {/* Rotation is irreversible and kills the old token immediately, so it
              is never one stray click away. */}
          {confirmRotate ? (
            <span className="rotate-confirm">
              <button
                type="button"
                disabled={rotating}
                onClick={() => {
                  setConfirmRotate(false);
                  onRotateToken();
                }}
              >
                {rotating ? "…" : "rotate"}
              </button>
              <button type="button" className="ghost" onClick={() => setConfirmRotate(false)}>
                no
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ghost"
              onClick={() => setConfirmRotate(true)}
              title="Rotate token — the current one stops working immediately"
            >
              ⟳
            </button>
          )}
          <button type="button" className="ghost" onClick={onSignOut} title="Sign out">
            ⏻
          </button>
        </div>
      </div>
    </aside>
  );
}
