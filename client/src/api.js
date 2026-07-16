import axios from 'axios'

const api = axios.create({ baseURL: 'http://localhost:8080' })

export const fetchNotes = () => api.get('/notes')
export const createNote = (data) => api.post('/notes', data)
export const updateNote = (data) => api.put('/notes', data)
export const deleteNote = (id) => api.delete(`/notes/${id}`)
