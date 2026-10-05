import { useCallback, useEffect, useRef, useState } from "react";
import {
  addMember,
  approveRequest,
  denyRequest,
  fetchMembers,
  fetchRequests,
  removeMember,
  searchUsers,
  setMemberRole,
} from "../api";

const ROLE_LABEL = {
  owner: "owner",
  moderator: "mod",
  participant: "can post",
  viewer: "read only",
};

/** Roles this browser may offer. `manage_members` is owner-only server-side. */
const GRANTABLE = [
  { value: "viewer", label: "read only" },
  { value: "participant", label: "can post" },
  { value: "moderator", label: "moderator" },
  { value: "owner", label: "co-owner" },
];

/** A partially typed @tag immediately after the caret, as in the composer. */
const PARTIAL_TAG = /@([a-z0-9._-]*)$/i;

/**
 * Moderator inbox + member roster. Both are only reachable when the server
 * grants `manage_requests` / `read_notes`, so this is purely a rendering shell.
 */
export default function Moderation({ space, caps, onChanged, notify }) {
  const [tab, setTab] = useState("requests");
  const [requests, setRequests] = useState([]);
  const [members, setMembers] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const [draftHandle, setDraftHandle] = useState("");
  const [draftRole, setDraftRole] = useState("viewer");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);

  const canManageRequests = caps.includes("manage_requests");
  const canManageMembers = caps.includes("manage_members");
  const canRead = caps.includes("read_notes");

  const searchRef = useRef(null);
  const addInputRef = useRef(null);

  const loadRequests = useCallback(async () => {
    if (!canManageRequests) return;
    try {
      setRequests(await fetchRequests(space.id));
    } catch (err) {
      notify(err?.response?.data?.error || "Could not load requests", "error");
    }
  }, [space.id, canManageRequests, notify]);

  const loadMembers = useCallback(async () => {
    if (!canRead) return;
    try {
      setMembers(await fetchMembers(space.id));
    } catch (err) {
      notify(err?.response?.data?.error || "Could not load the roster", "error");
    }
  }, [space.id, canRead, notify]);

  // Initial fetch. `loadRequests`/`loadMembers` stay as-is because `refresh`
  // reuses them after a mutation; these two are guarded so a space switch can't
  // land a stale roster.
  useEffect(() => {
    if (!canManageRequests) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchRequests(space.id);
        if (!cancelled) setRequests(list);
      } catch (err) {
        if (!cancelled) notify(err?.response?.data?.error || "Could not load requests", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [space.id, canManageRequests, notify]);

  useEffect(() => {
    if (!canRead) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchMembers(space.id);
        if (!cancelled) setMembers(list);
      } catch (err) {
        if (!cancelled) notify(err?.response?.data?.error || "Could not load the roster", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [space.id, canRead, notify]);

  // The cleanup has to sit above the early return below, or a viewer without
  // either cap would unmount before ever subscribing to it.
  useEffect(() => () => clearTimeout(searchRef.current), []);

  const refresh = async () => {
    await Promise.all([loadRequests(), loadMembers()]);
    onChanged();
  };

  const act = async (id, action) => {
    setBusyId(id);
    try {
      await action();
      await refresh();
    } catch (err) {
      notify(err?.response?.data?.error || "That did not work", "error");
    } finally {
      setBusyId(null);
    }
  };

  /* --------------------------- add by handle --------------------------- */

  // Everyone already on the roster, so the picker can label them instead of
  // letting the owner invite them to a space they are already in. Derived rather
  // than stored, so it cannot drift from the roster it is describing.
  const rosterHandles = new Set(members.map((m) => m.handle.toLowerCase()));

  const suggest = (value, caret) => {
    const match = value.slice(0, caret).match(PARTIAL_TAG);
    if (!match) {
      setSuggestions([]);
      return;
    }
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(() => {
      searchUsers(match[1])
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 150);
  };

  const choose = (account) => {
    setDraftHandle(`@${account.handle} `);
    setSuggestions([]);
    addInputRef.current?.focus();
  };

  const submitAdd = async (event) => {
    event.preventDefault();
    const handle = draftHandle.trim().replace(/^@/, "").replace(/\s+/g, "");
    if (!handle || adding || !canManageMembers) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await addMember(space.id, { handle, role: draftRole });
      notify(`@${res.data.handle} added as ${ROLE_LABEL[res.data.role] || res.data.role}`);
      setDraftHandle("");
      setDraftRole("viewer");
      setSuggestions([]);
      await refresh();
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      // 409 is not a failure to report as a dead end: they are already here, so
      // offer the one action that actually moves things forward.
      if (status === 409 && body?.code === "ALREADY_MEMBER") {
        const promote = window.confirm(
          `@${handle} is already a member (${ROLE_LABEL[body.role] || body.role}). ` +
            `Change their role to ${ROLE_LABEL[draftRole] || draftRole}?`,
        );
        if (promote) {
          await act(body.userId, () =>
            setMemberRole(space.id, body.userId, draftRole),
          );
          setDraftHandle("");
          setDraftRole("viewer");
        }
      } else {
        setAddError(body?.error || "Could not add that person");
      }
    } finally {
      setAdding(false);
    }
  };

  const pending = requests.filter((r) => r.status === "pending");
  const settled = requests.filter((r) => r.status !== "pending");

  if (!canManageRequests && !canRead) return null;

  return (
    <section className="moderation">
      <div className="mod-tabs">
        {canManageRequests && (
          <button
            type="button"
            className={tab === "requests" ? "active" : ""}
            onClick={() => setTab("requests")}
          >
            requests{pending.length ? ` (${pending.length})` : ""}
          </button>
        )}
        {canRead && (
          <button
            type="button"
            className={tab === "roster" ? "active" : ""}
            onClick={() => setTab("roster")}
          >
            members ({members.length})
          </button>
        )}
      </div>

      {tab === "requests" && canManageRequests && (
        <div className="mod-body">
          {pending.length === 0 ? (
            <p className="empty-inline">
              No pending requests. To bring somebody in without waiting, use the
              members tab.
            </p>
          ) : null}
          {pending.map((r) => (
            <div key={r.id} className="request-row">
              <div className="request-who">
                <span className="chalk-dot" style={{ backgroundColor: r.color }} />
                <strong>@{r.handle}</strong>
                <span className="chip subtle">wants {r.requestedRole}</span>
              </div>
              {r.message && <p className="request-message">{r.message}</p>}
              <div className="request-actions">
                <button
                  type="button"
                  disabled={busyId === r.id}
                  onClick={() => act(r.id, () => approveRequest(r.id))}
                >
                  approve
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busyId === r.id}
                  onClick={() => act(r.id, () => denyRequest(r.id))}
                >
                  deny
                </button>
              </div>
            </div>
          ))}

          {settled.length > 0 && (
            <details className="settled">
              <summary>{settled.length} resolved</summary>
              {settled.map((r) => (
                <p key={r.id} className="settled-row">
                  <span className="chalk-dot" style={{ backgroundColor: r.color }} />@{r.handle}
                  <span className={`chip subtle ${r.status}`}>{r.status}</span>
                </p>
              ))}
            </details>
          )}
        </div>
      )}

      {tab === "roster" && canRead && (
        <div className="mod-body">
          {canManageMembers && (
            <form className="member-add" onSubmit={submitAdd}>
              <p className="member-add-title">add somebody directly</p>
              <div className="member-add-row">
                <div className="member-add-handle">
                  <input
                    ref={addInputRef}
                    type="text"
                    value={draftHandle}
                    placeholder="@handle"
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Handle to add"
                    onChange={(e) => {
                      setDraftHandle(e.target.value);
                      setAddError(null);
                      suggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
                    }}
                    onKeyDown={(event) => {
                      if (!suggestions.length) return;
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setSuggestions([]);
                      } else if (event.key === "Enter" && suggestions[0]) {
                        // Only hijack Enter when a suggestion is showing;
                        // otherwise it has to submit the form.
                        event.preventDefault();
                        choose(suggestions[0]);
                      }
                    }}
                    onBlur={() => setTimeout(() => setSuggestions([]), 120)}
                  />
                  {suggestions.length > 0 && (
                    <ul className="mention-menu">
                      {suggestions.map((account) => (
                        <li key={account.id}>
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              choose(account);
                            }}
                          >
                            <span
                              className="chalk-dot"
                              style={{ backgroundColor: account.color }}
                            />
                            @{account.handle}
                            {rosterHandles.has(account.handle.toLowerCase()) && (
                              <span className="chip subtle">already in</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <select
                  value={draftRole}
                  aria-label="Role to grant"
                  onChange={(e) => setDraftRole(e.target.value)}
                >
                  {GRANTABLE.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button type="submit" disabled={adding || !draftHandle.trim()}>
                  {adding ? "adding…" : "add"}
                </button>
              </div>
              {addError && <p className="gate-error">{addError}</p>}
              <p className="member-add-note">
                Skips the request queue — useful when you already know who should
                be in. They appear in the requests inbox as already settled.
              </p>
            </form>
          )}

          {members.map((m) => (
            <div key={m.userId} className="member-row">
              <span className="chalk-dot" style={{ backgroundColor: m.color }} />
              <strong>@{m.handle}</strong>
              {canManageMembers && m.userId !== space.ownerId ? (
                <select
                  value={m.role}
                  disabled={busyId === m.userId}
                  onChange={(e) =>
                    act(m.userId, () => setMemberRole(space.id, m.userId, e.target.value))
                  }
                >
                  <option value="viewer">read only</option>
                  <option value="participant">can post</option>
                  <option value="moderator">moderator</option>
                  <option value="owner">co-owner</option>
                </select>
              ) : (
                <span className="chip subtle">{ROLE_LABEL[m.role] || m.role}</span>
              )}
              {canManageMembers && m.userId !== space.ownerId && (
                <button
                  type="button"
                  className="ghost danger"
                  disabled={busyId === m.userId}
                  onClick={() => act(m.userId, () => removeMember(space.id, m.userId))}
                >
                  remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
