import { useState, useEffect } from "react";
import { fetchNotes, createNote, deleteNote, updateNote } from "./api";
import "./App.css";

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function App() {
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem("adminToken") || "");

  useEffect(() => {
    const load = () =>
      fetchNotes()
        .then((res) => setNotes((prev) => {
          const prevMap = new Map(prev.map((n) => [n.id, n]));
          return res.data.map((n) => ({ ...prevMap.get(n.id), ...n, size: prevMap.get(n.id)?.size ?? "small" }));
        }))
        .catch((err) => console.error("Failed to load notes:", err));
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() && !body.trim()) return;
    try {
      if (editingId) {
        const res = await updateNote({ id: editingId, title: title.trim(), body: body.trim() });
        setNotes((prev) => prev.map((n) => (n.id === editingId ? { ...n, ...res.data[0] } : n)));
      } else {
        const res = await createNote({ title: title.trim(), body: body.trim() });
        const saved = { ...res.data[0], size: "small" };
        setNotes((prev) => [...prev, saved]);
      }
      setTitle("");
      setBody("");
      setEditingId(null);
    } catch (err) {
      console.error("Failed to save note:", err);
    }
  };

  const removeNote = async (id) => {
    try {
      await deleteNote(id, adminToken);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  };

  const cycleSize = (id) => {
    const sizes = ["small", "wide", "tall", "big"];
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id !== id) return n;
        const idx = sizes.indexOf(n.size);
        return { ...n, size: sizes[(idx + 1) % sizes.length] };
      }),
    );
  };

  return (
    <div className="notes-app">
      <header className="header">
        <h1>TABLOID</h1>
        <p className="subtitle">Your Chalk on The Anonymous BlackBoard</p>
        <div className="admin-bar">
          {adminToken ? (
            <button className="admin-logout" onClick={() => { setAdminToken(""); localStorage.removeItem("adminToken") }}>admin</button>
          ) : (
            <form className="admin-login" onSubmit={(e) => { e.preventDefault(); const t = e.target.token.value; setAdminToken(t); localStorage.setItem("adminToken", t) }}>
              <input name="token" type="password" placeholder="admin key" />
            </form>
          )}
        </div>
      </header>
      {editingId && <p className="editing-status">editing...</p>}
      <form className="note-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          placeholder="Write something..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onInput={(e) => { e.target.style.height = ""; e.target.style.height = e.target.scrollHeight + "px" }}
        />
        <button type="submit">{editingId ? "Update Note" : "Add Note"}</button>
        {editingId && (
          <button type="button" onClick={() => { setEditingId(null); setTitle(""); setBody(""); }}>
            Cancel
          </button>
        )}
      </form>
      <div className="notes-grid">
        {notes.length === 0 && (
          <p className="empty">No notes yet — start your collection</p>
        )}
        {notes.map((note) => (
          <div key={note.id} className={`note-card ${note.size}`}>
            <div className="card-buttons-top-right">
              <button
              className="resize"
              onClick={() => cycleSize(note.id)}
              title="Resize"
            >
              ◇
            </button>
            <button
              className="edit-button"
              onClick={() => {
                setEditingId(note.id);
                setTitle(note.title);
                setBody(note.body);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              title="Edit"
            >
              ∆
            </button>
            {adminToken && (
              <button
                className="remove"
                onClick={() => removeNote(note.id)}
                title="Delete"
              >
                ×
              </button>
            )}
            </div>
            {note.title && <h2>{note.title}</h2>}
            <p>{note.body}</p>
            <p className="note-timestamp">
              {timeAgo(note.createdAt)}{
                note.updatedAt && note.createdAt !== note.updatedAt
                  ? ` · edited ${timeAgo(note.updatedAt)}`
                  : ""
              }
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
