import { useState, useEffect } from 'react'
import { fetchNotes, createNote, deleteNote } from './api'
import './App.css'

function App() {
  const [notes, setNotes] = useState([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  useEffect(() => {
    fetchNotes()
      .then(res => {
        const withSizes = res.data.map(n => ({ ...n, size: 'small' }))
        setNotes(withSizes)
      })
      .catch(err => console.error('Failed to load notes:', err))
  }, [])

  const addNote = async (e) => {
    e.preventDefault()
    if (!title.trim() && !body.trim()) return
    try {
      const res = await createNote({ title: title.trim(), body: body.trim() })
      const saved = { ...res.data[0], size: 'small' }
      console.log(saved.title);
      setNotes(prev => [...prev, saved])
      setTitle('')
      setBody('')
    } catch (err) {
      console.error('Failed to create note:', err)
    }
  }

  const removeNote = async (id) => {
    try {
      await deleteNote(id)
      setNotes(prev => prev.filter(n => n.id !== id))
    } catch (err) {
      console.error('Failed to delete note:', err)
    }
  }

  const cycleSize = (id) => {
    const sizes = ['small', 'wide', 'tall', 'big']
    setNotes(prev =>
      prev.map(n => {
        if (n.id !== id) return n
        const idx = sizes.indexOf(n.size)
        return { ...n, size: sizes[(idx + 1) % sizes.length] }
      })
    )
  }

  return (
    <div className="notes-app">
      <header className="header">
        <span className="crown">👑</span>
        <h1>Notes</h1>
        <p className="subtitle">Your royal collection</p>
      </header>
      <form className="note-form" onSubmit={addNote}>
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          placeholder="Write something..."
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="submit">Add Note</button>
      </form>
      <div className="notes-grid">
        {notes.length === 0 && (
          <p className="empty">No notes yet — start your collection</p>
        )}
        {notes.map((note) => (
          <div key={note.id} className={`note-card ${note.size}`}>
            <button
              className="resize"
              onClick={() => cycleSize(note.id)}
              title="Resize"
            >
              ◇
            </button>
            <button
              className="remove"
              onClick={() => removeNote(note.id)}
              title="Delete"
            >
              ×
            </button>
            {note.title && <h2>{note.title}</h2>}
            <p>{note.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
