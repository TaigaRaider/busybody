import axios from "axios";

const TOKEN_KEY = "tabloid.token";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:8080",
});

// The bearer token is attached centrally so no call site has to remember it.
// A 401 means the stored token is dead — drop it so the shell falls back to
// the auth gate instead of looping on failed requests.
api.interceptors.request.use((config) => {
  // A caller-supplied Authorization header wins, so a request can test a
  // credential explicitly instead of being masked by whatever is in storage.
  if (config.headers.Authorization) return config;
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401 && localStorage.getItem(TOKEN_KEY)) {
      localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new CustomEvent("tabloid:signed-out"));
    }
    return Promise.reject(error);
  },
);

export { TOKEN_KEY };

const data = (promise) => promise.then((r) => r.data);

/* ------------------------------- auth ------------------------------- */

export const register = (payload) => data(api.post("/auth/register", payload));
export const fetchMe = () => data(api.get("/auth/me"));
/**
 * Signs in with a handle and password. The server answers with a freshly issued
 * bearer token, which is the only thing kept in storage from here on — the
 * password is never persisted and never leaves the sign-in form again.
 */
export const login = (handle, password) =>
  data(api.post("/auth/login", { handle, password }));
export const updateMe = (patch) => data(api.patch("/auth/me", patch));
/**
 * Changes the password and adopts the reissued token that comes back, since the
 * server invalidates the old one on every successful change.
 */
export const changePassword = (currentPassword, newPassword) =>
  data(api.post("/auth/change-password", { currentPassword, newPassword })).then((res) => {
    if (res.token) localStorage.setItem(TOKEN_KEY, res.token);
    return res;
  });
export const rotateToken = () => data(api.post("/auth/rotate-token"));

/**
 * "Ghost In Time": pause your own account without deleting it. Nothing is
 * revoked and nothing is lost - the server just stamps `ghostedAt` and starts
 * hiding everything written after that moment, and refuses every write.
 */
export const ghostAccount = () => data(api.post("/auth/ghost"));

/** Undoes `ghostAccount`. No cooldown, no password: the holder owns it. */
export const reviveAccount = () => data(api.post("/auth/revive"));

/**
 * Deletes the signed-in account for good. The password has to be retyped,
 * because `requireAuth` only proves a token and a token is sitting in local
 * storage on whatever machine last used the board.
 *
 * Returns the raw axios response rather than unwrapped data: this one succeeds
 * with 204 and no body, so there is nothing to unwrap and a truthy value would
 * be a lie. Errors are left to reject so the caller can read `response.data` for
 * `OWNS_SPACES` / `LAST_ADMIN` and say something useful about them.
 */
export const deleteAccount = (password) => api.delete("/auth/me", { data: { password } });

export const searchUsers = (q) => data(api.get("/users", { params: { q } }));
export const fetchColors = () => data(api.get("/colors"));

/* ------------------------------ spaces ------------------------------ */

export const fetchSpaces = () => data(api.get("/spaces"));
export const createSpace = (payload) => data(api.post("/spaces", payload));
export const fetchSpace = (id) => data(api.get(`/spaces/${id}`));
export const updateSpace = (id, patch) =>
  data(api.patch(`/spaces/${id}`, patch));
export const deleteSpace = (id) => api.delete(`/spaces/${id}`);
export const fetchMembers = (id) => data(api.get(`/spaces/${id}/members`));
/**
 * Add somebody by handle. The server answers 409 with `ALREADY_MEMBER` and the
 * existing role when they are already on the roster, so the caller can offer to
 * change their role instead of retyping the invite.
 */
export const addMember = (id, payload) =>
  api.post(`/spaces/${id}/members`, payload);
export const setMemberRole = (id, userId, role) =>
  data(api.patch(`/spaces/${id}/members/${userId}`, { role }));
export const removeMember = (id, userId) =>
  api.delete(`/spaces/${id}/members/${userId}`);
export const leaveSpace = (id) => api.post(`/spaces/${id}/leave`);

/* ----------------------------- requests ----------------------------- */

export const requestAccess = (id, payload) =>
  data(api.post(`/spaces/${id}/requests`, payload));
export const fetchRequests = (id) => data(api.get(`/spaces/${id}/requests`));
export const approveRequest = (requestId, role) =>
  data(api.post(`/requests/${requestId}/approve`, { role }));
export const denyRequest = (requestId) => data(api.post(`/requests/${requestId}/deny`));
export const cancelRequest = (requestId) => api.delete(`/requests/${requestId}`);

/* ------------------------------- notes ------------------------------ */

const notesPath = (spaceId) => (spaceId ? `/spaces/${spaceId}/notes` : "/notes");

export const fetchNotes = ({ spaceId, cursor, limit } = {}) =>
  data(api.get(notesPath(spaceId), { params: { cursor, limit } }));

export const createNote = (payload, spaceId) =>
  data(api.post(notesPath(spaceId), payload));

export const updateNote = (id, payload) => data(api.put(`/notes/${id}`, payload));
export const deleteNote = (id) => api.delete(`/notes/${id}`);
export const rollbackNote = (id) => data(api.put(`/notes/${id}/rollback`));

/** Persists this user's bento size for a card. */
export const setNoteSize = (id, size) => data(api.put(`/notes/${id}/layout`, { size }));

export const fetchMentions = ({ cursor, limit } = {}) =>
  data(api.get("/mentions", { params: { cursor, limit } }));

export default api;
