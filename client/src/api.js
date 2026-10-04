import axios from "axios";

const TOKEN_KEY = "tabloid.token";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:8080",
});

// The bearer token is attached centrally so no call site has to remember it.
// A 401 means the stored token is dead — drop it so the shell falls back to
// the auth gate instead of looping on failed requests.
api.interceptors.request.use((config) => {
  // A caller-supplied Authorization header wins, so `verifyToken` can test a
  // pasted token instead of being masked by whatever is already in storage.
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

export const register = data_ => data(api.post("/auth/register", data_));
export const fetchMe = () => data(api.get("/auth/me"));
/**
 * Checks a pasted token and resolves to the profile it belongs to, so a
 * returning user can get back in — registration is the only other way in.
 */
export const verifyToken = (token) =>
  data(api.get("/auth/me", { headers: { Authorization: `Bearer ${token}` } }));
export const updateMe = (patch) => data(api.patch("/auth/me", patch));
export const rotateToken = () => data(api.post("/auth/rotate-token"));
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
