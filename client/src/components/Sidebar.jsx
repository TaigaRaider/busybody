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
        ) : space.visibility === "public" ? (
          // Public and not a member is readable, not locked. Saying otherwise
          // contradicted the "read without joining" hint right above it.
          <span className="chip subtle">open</span>
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
  onChangePassword,
  changingPassword,
  onGhost,
  onRevive,
  ghosting,
  onDeleteAccount,
  deleting,
  drawerOpen,
  onCloseDrawer,
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmGhost, setConfirmGhost] = useState(false);
  const [rekeying, setRekeying] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [rekeyError, setRekeyError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState(null);
  const [discoverQuery, setDiscoverQuery] = useState("");

  const closeRekey = () => {
    setRekeying(false);
    setCurrentPassword("");
    setNewPassword("");
    setRekeyError(null);
  };

  const submitRekey = async (event) => {
    event.preventDefault();
    if (!currentPassword || newPassword.length < 8 || changingPassword) return;
    setRekeyError(null);
    const result = await onChangePassword(currentPassword, newPassword);
    // Only clear the fields on success; on failure the user needs to retype
    // the current password, and wiping it would make the form look broken.
    if (result?.ok) closeRekey();
    else setRekeyError(result?.message || "Could not change the password.");
  };

  const closeDelete = () => {
    setConfirmDelete(false);
    setDeletePassword("");
    setDeleteError(null);
  };

  const submitDelete = async (event) => {
    event.preventDefault();
    if (!deletePassword || deleting) return;
    setDeleteError(null);
    const result = await onDeleteAccount(deletePassword);
    // Only on failure. On success the whole shell is replaced by the auth gate,
    // so there is nothing left to tidy - and on an OWNS_SPACES refusal the user
    // needs the password still in the box to go and deal with the spaces.
    if (result?.ok) closeDelete();
    else setDeleteError(result?.message || "Could not delete the account.");
  };

  // The one flag the whole feature turns on. The server is the authority - this
  // only decides which buttons are drawn.
  const ghosted = Boolean(user.ghostedAt);

  const needle = discoverQuery.trim().toLowerCase();
  const matches = (s) =>
    !needle ||
    s.name.toLowerCase().includes(needle) ||
    (s.description || "").toLowerCase().includes(needle);

  const mineAll = spaces.filter((s) => s.role);
  const lockedAll = spaces.filter(
    (s) => !s.role && s.visibility === "private",
  );
  const discoverAll = spaces.filter(
    (s) => !s.role && s.visibility === "public",
  );

  // The filter runs over every group. A box that greys out your own spaces while
  // you type their name would be worse than no box at all.
  const mine = mineAll.filter(matches);
  const lockedVisible = lockedAll.filter(matches);
  const discoverVisible = discoverAll.filter(matches);
  const activeId = selection.kind === "space" ? selection.id : null;
  const searching = needle.length > 0;
  const nothingFound =
    searching &&
    mine.length === 0 &&
    lockedVisible.length === 0 &&
    discoverVisible.length === 0;

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
    <aside className={`sidebar ${drawerOpen ? "drawer-open" : ""}`}>
      {/* On a phone this is the only permanently visible chrome: a sticky strip
          holding the masthead. Everything navigable moved into the drawer below,
          because the full sidebar used to stack above the notes and push the
          first one below the fold. On desktop the top bar is the masthead and the
          panel is the sidebar, which is how it always looked. */}
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <div>
            <strong>TABLOID</strong>
            <span className="brand-sub">anonymous blackboard</span>
          </div>
        </div>
        <button
          type="button"
          className="drawer-close"
          onClick={onCloseDrawer}
          aria-label="Close spaces"
        >
          &#10005;
        </button>
      </div>

      <div className="sidebar-panel">
        <button
          type="button"
          className={`lobby-row ${selection.kind === "lobby" ? "active" : ""}`}
          onClick={() => onSelect({ kind: "lobby" })}
        >
          Lobby
          <span className="chip subtle">open</span>
        </button>

        {/* Above the lists it filters, and only once the lists are long enough
            to need it. Five is roughly where the drawer starts scrolling on a
            phone; below that the box is a control with nothing to control. */}
        {mineAll.length + lockedAll.length + discoverAll.length > 4 && (
          <input
            className="discover-search"
            type="search"
            value={discoverQuery}
            placeholder="find a space"
            aria-label="Find a space"
            onChange={(e) => setDiscoverQuery(e.target.value)}
          />
        )}

        <nav className="space-groups">
          {/* Empty groups are not rendered at all. Both headings used to show
              regardless, which spent ~122px of a phone screen on "none yet" and
              "nothing to discover" for somebody with no spaces. */}
          {mine.length > 0 && (
            <div className="group">
              <h3>your spaces</h3>
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
          )}

          {lockedVisible.length > 0 && (
            <div className="group">
              <h3>locked</h3>
              <p className="group-hint">private — ask to get in</p>
              <ul>
                {lockedVisible.map((s) => (
                  <SpaceRow
                    key={s.id}
                    space={s}
                    active={activeId === s.id}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </div>
          )}

          {discoverVisible.length > 0 && (
            <div className="group">
              <h3>discover</h3>
              <p className="group-hint">public — read without joining</p>
              <ul>
                {discoverVisible.map((s) => (
                  <SpaceRow
                    key={s.id}
                    space={s}
                    active={activeId === s.id}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </div>
          )}

          {searching && nothingFound && (
            <p className="group-empty">nothing matches “{discoverQuery.trim()}”</p>
          )}
        </nav>

        {/* Creating a room is management, so a ghost does not get the button at
            all rather than getting one that 403s. */}
        {!ghosted &&
          (creating ? (
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
          ))}

        <div className="sidebar-foot">
          {/* Persistent, not a toast: a ghost must never be able to forget why
              the board has gone quiet, and this is also where the way back is. */}
          {ghosted && (
            <div className="ghost-state">
              <p>
                you are a ghost
                <span className="ghost-since">
                  {" "}
                  since {new Date(user.ghostedAt).toLocaleString()}
                </span>
              </p>
              <button type="button" onClick={onRevive} disabled={ghosting}>
                {ghosting ? "waking…" : "revive"}
              </button>
            </div>
          )}
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
            <button
              type="button"
              className="ghost"
              onClick={() => setRekeying((open) => !open)}
              title="Change your password"
            >
              🔑
            </button>
            {/* Ghosting looks like signing out, so it takes a deliberate second
                click rather than being one stray tap away. Reviving, by
                contrast, is one click in the banner above - it has to be easy,
                since the person most likely to want it is the one who has
                walked away. */}
            {!ghosted &&
              (confirmGhost ? (
                <span className="rotate-confirm">
                  <button
                    type="button"
                    disabled={ghosting}
                    onClick={() => {
                      setConfirmGhost(false);
                      onGhost();
                    }}
                  >
                    {ghosting ? "…" : "go"}
                  </button>
                  <button type="button" className="ghost" onClick={() => setConfirmGhost(false)}>
                    no
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setConfirmGhost(true)}
                  title="Pause your account — nothing is deleted, and you can come back"
                >
                  👻
                </button>
              ))}
            {/* Offered to ghosts too, and deliberately not behind the two-step
                confirm the ghost button uses. Deleting asks for the password in a
                form that spells out what survives, which is a different and much
                harder barrier than a second click; and the person who most wants
                the permanent exit is often the one already a ghost. */}
            <button
              type="button"
              className="ghost"
              onClick={() => setConfirmDelete((open) => !open)}
              title="Delete your account for good"
            >
              🗑
            </button>
            <button type="button" className="ghost" onClick={onSignOut} title="Sign out">
              ⏻
            </button>
          </div>

          {confirmDelete && (
            <form className="rekey depart" onSubmit={submitDelete}>
              <p className="rekey-title">delete @{user.handle} for good</p>
              <p className="rekey-note">
                This cannot be undone and there is no way back: your account, your
                spaces, your memberships and your mentions go. Every note you wrote
                stays exactly where it is, with your name on it in grey —{" "}
                <strong>@{user.handle} stays retired</strong>, so nobody else can take
                it. If you would rather step away and come back later, ghosting
                does that instead.
              </p>
              <input
                className="gate-input"
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="your password, to confirm"
                autoComplete="current-password"
                autoFocus
                spellCheck={false}
              />
              {deleteError && <p className="gate-error">{deleteError}</p>}
              <div className="rekey-actions">
                <button
                  type="submit"
                  className="danger"
                  disabled={!deletePassword || deleting}
                >
                  {deleting ? "deleting…" : "delete my account"}
                </button>
                <button type="button" className="ghost" onClick={closeDelete}>
                  cancel
                </button>
              </div>
            </form>
          )}

          {rekeying && (
            <form className="rekey" onSubmit={submitRekey}>
              <p className="rekey-title">change your password</p>
              <input
                className="gate-input"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="current password"
                autoComplete="current-password"
                autoFocus
                spellCheck={false}
              />
              <input
                className="gate-input"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="new password (8+ characters)"
                autoComplete="new-password"
                spellCheck={false}
              />
              <p className="rekey-note">
                Your current token is retired as part of this, so keep this window
                open — it re-signs-in with the new token automatically.
              </p>
              {rekeyError && <p className="gate-error">{rekeyError}</p>}
              <div className="rekey-actions">
                <button
                  type="submit"
                  disabled={!currentPassword || newPassword.length < 8 || changingPassword}
                >
                  {changingPassword ? "saving…" : "save"}
                </button>
                <button type="button" className="ghost" onClick={closeRekey}>
                  cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Dismissal by tapping outside. Decorative for assistive tech, which can
          already dismiss via the close button or Escape; rendered only while open,
          and App gates `drawerOpen` on the mobile breakpoint, so desktop is safe. */}
      {drawerOpen && <div className="drawer-scrim" onClick={onCloseDrawer} aria-hidden="true" />}
    </aside>
  );
}