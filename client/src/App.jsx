import { useState, useEffect } from "react";
import { fetchNotes, createNote, deleteNote, updateNote } from "./api";
import "./App.css";

const COLORS = ["#e06c75","#61afef","#98c379","#d19a66","#c678dd","#56b6c2","#e5c07b","#be5046","#7ec8e3","#abb2bf","#b9826b","#83a598"];

function getColor() {
  let c = localStorage.getItem("userColor");
  if (!c) { c = COLORS[Math.floor(Math.random() * COLORS.length)]; localStorage.setItem("userColor", c) }
  return c;
}

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

function parseContributions(body) {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [{ text: body, color: null }];
  } catch {
    return [{ text: body, color: null }];
  }
}

function App() {
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [showPicker, setShowPicker] = useState(!localStorage.getItem("userColor"));
  const [pickColor, setPickColor] = useState("");

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
    if (!text.trim()) return;
    try {
      if (editingId) {
        const res = await updateNote({ id: editingId, text: text.trim(), color: getColor() });
        setNotes((prev) => prev.map((n) => (n.id === editingId ? { ...n, ...res.data[0] } : n)));
        setEditingId(null);
      } else {
        if (!title.trim()) return;
        const res = await createNote({ title: title.trim(), text: text.trim(), color: getColor() });
        const saved = { ...res.data[0], size: "small" };
        setNotes((prev) => [...prev, saved]);
        setTitle("");
      }
      setText("");
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

  const pick = (c) => {
    localStorage.setItem("userColor", c);
    setPickColor(c);
    setShowPicker(false);
  };

  const myColor = getColor();

  if (showPicker) {
    return (
      <div className="notes-app">
        <div className="color-picker-modal">
          <h2>pick your chalk</h2>
          <div className="color-picker-grid">
            {COLORS.map((c) => (
              <button key={c} className="color-swatch" style={{ backgroundColor: c }} onClick={() => pick(c)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="notes-app">
      <header className="header">
        <div className="header-row">
          <h1>TABLOID</h1>
          <span className="my-color-dot" style={{ backgroundColor: myColor }} title="your chalk" />
        </div>
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
      <form className="note-form" onSubmit={handleSubmit}>
        {!editingId && (
          <input
            type="text"
            placeholder="Topic"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
        <textarea
          placeholder={editingId ? "Add to this thread..." : "Write something..."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onInput={(e) => { e.target.style.height = ""; e.target.style.height = e.target.scrollHeight + "px" }}
        />
        <button type="submit">{editingId ? "Add to Thread" : "Start Thread"}</button>
        {editingId && (
          <button type="button" onClick={() => { setEditingId(null); setText(""); setTitle(""); }}>
            Cancel
          </button>
        )}
      </form>
      <div className="notes-grid">
        {notes.length === 0 && (
          <p className="empty">No notes yet — start your collection</p>
        )}
        {notes.map((note) => {
          const contributions = parseContributions(note.body);
          return (
            <div key={note.id} className={`note-card ${note.size}`}>
              <div className="card-buttons-top-right">
                <button className="resize" onClick={() => cycleSize(note.id)} title="Resize">◇</button>
                <button
                  className="edit-button"
                  onClick={() => {
                    setEditingId(note.id);
                    setTitle(note.title);
                    setText("");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  title="Add to thread"
                >
                  +
                </button>
                {adminToken && (
                  <button className="remove" onClick={() => removeNote(note.id)} title="Delete">×</button>
                )}
              </div>
              <div className="note-chalk" style={{ borderLeftColor: note.authorColor || "var(--gray-600)" }}>
                {note.title && <h2>{note.title}</h2>}
                <div className="contributions">
                  {contributions.map((c, i) => (
                    <p key={i} className="contribution" style={{ color: c.color || "var(--gray-400)" }}>
                      <span className="chalk-dot" style={{ backgroundColor: c.color || "var(--gray-600)" }} />
                      {c.text}
                    </p>
                  ))}
                </div>
                <p className="note-timestamp">
                  {timeAgo(note.createdAt)}{
                    note.updatedAt && note.createdAt !== note.updatedAt
                      ? ` · updated ${timeAgo(note.updatedAt)}`
                      : ""
                  }
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default App;