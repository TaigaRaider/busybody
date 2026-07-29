import axios from 'axios'

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8080' })

export const fetchNotes = () => api.get('/notes')
export const createNote = (data) => api.post('/notes', data)
export const updateNote = (data) => api.put('/notes', data)
export const deleteNote = (id, token) =>
  api.delete(`/notes/${id}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
