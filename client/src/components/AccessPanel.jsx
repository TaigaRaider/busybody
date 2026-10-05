import { useState } from "react";

/**
 * Shown when the signed-in user cannot read a space. "private" here means the
 * notes are gated — the space is still listed so people can ask for access.
 */
export default function AccessPanel({
  space,
  pendingRequest,
  busy,
  onRequest,
  onWithdraw,
  ghosted,
}) {
  const [role, setRole] = useState("participant");
  const [message, setMessage] = useState("");

  const submit = (event) => {
    event.preventDefault();
    onRequest(role, message.trim() || null);
  };

  return (
    <section className="access-panel">
      <span className={`chip ${space.visibility}`}>{space.visibility}</span>
      <h2>{space.name}</h2>
      {space.description && <p className="access-desc">{space.description}</p>}

      {/* A ghost cannot ask for anything, but they may still withdraw a request
          they made before ghosting - so that branch stays reachable and only
          the way to *start* one closes. */}
      {ghosted ? (
        <div className="access-pending">
          <p>
            You are a ghost. This space opens up again when you revive; nothing
            you asked for is lost in the meantime.
          </p>
          {pendingRequest && (
            <button type="button" className="ghost" onClick={onWithdraw} disabled={busy}>
              withdraw request
            </button>
          )}
        </div>
      ) : pendingRequest ? (
        <div className="access-pending">
          <p>
            Your request for <strong>{pendingRequest}</strong> access is waiting
            for a moderator.
          </p>
          <button type="button" className="ghost" onClick={onWithdraw} disabled={busy}>
            withdraw request
          </button>
        </div>
      ) : (
        <form className="access-form" onSubmit={submit}>
          <fieldset>
            <legend>What do you need?</legend>
            <label>
              <input
                type="radio"
                name="access-role"
                checked={role === "viewer"}
                onChange={() => setRole("viewer")}
              />
              <span>
                <strong>Read</strong> — see the notes, cannot post
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="access-role"
                checked={role === "participant"}
                onChange={() => setRole("participant")}
              />
              <span>
                <strong>Participate</strong> — read, post and edit my own notes
              </span>
            </label>
          </fieldset>
          <textarea
            placeholder="Why do you want in? (optional)"
            value={message}
            maxLength={500}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
          />
          <button type="submit" disabled={busy}>
            {busy ? "requesting…" : "request access"}
          </button>
          <p className="access-fine">
            A moderator or the owner approves requests. Tagging someone in a
            private space sends them an invite automatically.
          </p>
        </form>
      )}
    </section>
  );
}
