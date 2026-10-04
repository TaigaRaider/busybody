import { useState } from "react";
import { login, register } from "../api";
import { saveSession } from "../session";

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
// Mirrors PASSWORD_MIN on the server. The server is the authority; this only
// exists so the button is disabled before a pointless round trip.
const PASSWORD_MIN = 8;

/**
 * The way in: join claims a handle and a chalk colour behind a password, sign in
 * exchanges a handle and password for a bearer token.
 *
 * The password is what a human remembers; the token it trades for is what
 * actually rides on requests and what this app keeps in localStorage. The
 * password is never stored in the browser and is sent exactly once.
 */
export default function AuthGate({ onAuthenticated }) {
  const [mode, setMode] = useState("join");
  const [handle, setHandle] = useState("");
  const [color, setColor] = useState("#e06c75");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const cleanHandle = handle.trim().toLowerCase();
  const handleValid = HANDLE_RE.test(cleanHandle);
  const passwordOk = password.length >= PASSWORD_MIN;

  const switchMode = (next) => {
    setMode(next);
    setError(null);
  };

  /** Reads the server's own wording; it knows better than any guess made here. */
  const reportError = (err, fallbackField) => {
    const payload = err?.response?.data;
    setError({
      message: payload?.error || fallbackMessage(err, payload),
      field: payload?.field || fallbackField,
    });
  };

  const join = async (event) => {
    event.preventDefault();
    if (!handleValid || !passwordOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await register({
        handle: cleanHandle,
        color,
        password,
      });
      onAuthenticated(saveSession(result.user, result.token));
    } catch (err) {
      reportError(err, "password");
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (event) => {
    event.preventDefault();
    if (!handleValid || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await login(cleanHandle, password);
      onAuthenticated(saveSession(result.user, result.token));
    } catch (err) {
      // The server deliberately does not say whether it was the handle or the
      // password, so neither does this.
      reportError(err, null);
    } finally {
      setBusy(false);
    }
  };

  const sharedFields = (
    <>
      <label className="gate-label" htmlFor="handle">
        your handle
      </label>
      <input
        id="handle"
        className={`gate-input ${error?.field === "handle" ? "invalid" : ""}`}
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        placeholder="ada"
        autoComplete="username"
        autoFocus
        spellCheck={false}
      />
      {error?.field === "handle" && <p className="gate-error">{error.message}</p>}

      <label className="gate-label" htmlFor="password">
        your password
      </label>
      <input
        id="password"
        type="password"
        className={`gate-input ${error?.field === "password" ? "invalid" : ""}`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={mode === "join" ? "new-password" : "current-password"}
        spellCheck={false}
      />
      {error?.field === "password" && <p className="gate-error">{error.message}</p>}
    </>
  );

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
            {sharedFields}

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

            <button
              className="gate-submit"
              type="submit"
              disabled={!handleValid || !passwordOk || busy}
            >
              {busy ? "joining…" : "join the board"}
            </button>
            <p className="gate-fine">
              Your colour is claimed to your handle, so nobody else can take it.
              {passwordOk ? "" : ` Password needs at least ${PASSWORD_MIN} characters.`}
            </p>
          </form>
        ) : (
          <form onSubmit={signIn}>
            {sharedFields}

            {error && !error.field && <p className="gate-error">{error.message}</p>}

            <button
              className="gate-submit"
              type="submit"
              disabled={!handleValid || !password || busy}
            >
              {busy ? "checking…" : "sign in"}
            </button>
            <p className="gate-fine">
              Your password is exchanged for a token kept in this browser only.
              Forgot it? There is no reset — the server keeps a one-way hash and
              nothing else can recover it.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

/** Distinguishes being rate-limited from being offline, which read very differently. */
function fallbackMessage(err, payload) {
  if (err?.response?.status === 429) return payload?.error || "Too many attempts. Wait a few minutes.";
  if (!err?.response) return "Could not reach the board. Check your connection.";
  return "Something went wrong. Try again.";
}