import { TOKEN_KEY } from "./api";

const USER_KEY = "tabloid.user";

/**
 * The bearer token is the only credential. It is issued once at registration
 * and can be rotated from the profile menu; the server stores just its hash.
 */
export function loadSession() {
  const token = localStorage.getItem(TOKEN_KEY);
  const raw = localStorage.getItem(USER_KEY);
  if (!token || !raw) return null;
  try {
    return { token, user: JSON.parse(raw) };
  } catch {
    clearSession();
    return null;
  }
}

export function saveSession(user, token) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return { user, token };
}

export function updateStoredUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
