import { useState } from "react";
import { register } from "../api";
import { saveSession } from "../session";

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;

/**
 * Registration is the only way in: a handle plus a unique chalk colour. The
 * server returns a bearer token that it stores only as a hash.
 */
export default function AuthGate({ onRegistered }) {
  const [handle, setHandle] = useState("");
  const [color, setColor] = useState("#e06c75");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const cleanHandle = handle.trim().toLowerCase();
  const handleValid = HANDLE_RE.test(cleanHandle);

  const submit = async (event) => {
    event.preventDefault();
    if (!handleValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await register({ handle: cleanHandle, color });
      onRegistered(saveSession(result.user, result.token));
    } catch (err) {
      const payload = err?.response?.data;
      setError({
        message: payload?.error || "Could not create that account",
        field: payload?.field || null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1>TABLOID</h1>
        <p className="gate-sub">The anonymous blackboard</p>

        <label className="gate-label" htmlFor="handle">
          your handle
        </label>
        <input
          id="handle"
          className={`gate-input ${error?.field === "handle" ? "invalid" : ""}`}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="ada"
          autoComplete="off"
          autoFocus
          spellCheck={false}
        />
        {error?.field === "handle" && <p className="gate-error">{error.message}</p>}

        <label className="gate-label" htmlFor="chalk">
          your chalk
        </label>
        <div className="gate-chalk">
          <input
            id="chalk"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
          <span className="gate-hex">{color}</span>
        </div>
        {error?.field === "color" && <p className="gate-error">{error.message}</p>}

        {error && !error.field && <p className="gate-error">{error.message}</p>}

        <button className="gate-submit" type="submit" disabled={!handleValid || busy}>
          {busy ? "joining…" : "join the board"}
        </button>
        <p className="gate-fine">
          Your colour is claimed to your handle, so nobody else can take it.
        </p>
      </form>
    </div>
  );
}
