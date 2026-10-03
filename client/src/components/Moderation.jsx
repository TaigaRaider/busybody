import { useCallback, useEffect, useState } from "react";
import {
  approveRequest,
  denyRequest,
  fetchMembers,
  fetchRequests,
  removeMember,
  setMemberRole,
} from "../api";

const ROLE_LABEL = {
  owner: "owner",
  moderator: "mod",
  participant: "can post",
  viewer: "read only",
};

/**
 * Moderator inbox + member roster. Both are only reachable when the server
 * grants `manage_requests` / `read_notes`, so this is purely a rendering shell.
 */
export default function Moderation({ space, caps, onChanged, notify }) {
  const [tab, setTab] = useState("requests");
  const [requests, setRequests] = useState([]);
  const [members, setMembers] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const canManageRequests = caps.includes("manage_requests");
  const canManageMembers = caps.includes("manage_members");
  const canRead = caps.includes("read_notes");

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

  if (!canManageRequests && !canRead) return null;

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

  const pending = requests.filter((r) => r.status === "pending");
  const settled = requests.filter((r) => r.status !== "pending");

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
          {pending.length === 0 && <p className="empty-inline">No pending requests.</p>}
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
