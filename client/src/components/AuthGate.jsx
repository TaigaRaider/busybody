import { useState } from "react";
import { register, verifyToken } from "../api";
import { saveSession } from "../session";

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;

/**
 * Two ways in: registration mints a handle plus a chalk colour, and "sign in"
 * re-adopts an existing token. The token is the only credential the server
 * knows, so it is also the only way back into an account whose session was
 * lost — there is no password to reset.
 */
export default function AuthGate({ onAuthenticated }) {
  const [mode, setMode] = useState("join");
  const [handle, setHandle] = useState("");
  const [color, setColor] = useState("#e06c75");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const cleanHandle = handle.trim().toLowerCase();
  const handleValid = HANDLE_RE.test(cleanHandle);
  const cleanToken = token.trim();

  const switchMode = (next) => {
    setMode(next);
    setError(null);
  };

  const join = async (event) => {
    event.preventDefault();
    if (!handleValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await register({ handle: cleanHandle, color });
      onAuthenticated(saveSession(result.user, result.token));
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

  const signIn = async (event) => {
    event.preventDefault();
    if (!cleanToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await verifyToken(cleanToken);
      onAuthenticated(saveSession(me.user, cleanToken));
    } catch {
      setError({ message: "That token was not accepted", field: "token" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>TABLOID</h1>
        <p className="gate-sub">The anonymous blackboard</p>

        <div className="gate-tabs">
          <button
            type="button"
            className={mode === "join" ? "active" : ""}
            onClick={() => switchMode("join")}
          >
            join
          </button>
          <button
            type="button"
            className={mode === "signin" ? "active" : ""}
            onClick={() => switchMode("signin")}
          >
            sign in
          </button>
        </div>

        {mode === "join" ? (
          <form onSubmit={join}>
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
        ) : (
          <form onSubmit={signIn}>
            <label className="gate-label" htmlFor="token">
              your token
            </label>
            <textarea
              id="token"
              className={`gate-input gate-token ${error?.field === "token" ? "invalid" : ""}`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste the token you registered with"
              rows={3}
              autoComplete="off"
              autoFocus
              spellCheck={false}
            />
            {error && <p className="gate-error">{error.message}</p>}

            <button className="gate-submit" type="submit" disabled={!cleanToken || busy}>
              {busy ? "checking…" : "sign in"}
            </button>
            <p className="gate-fine">
              The token is the only credential. Registration shows it once and
              the server keeps just a hash, so paste the original to get back in.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}