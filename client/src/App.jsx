import { useState, useEffect } from "react";
import { fetchNotes, createNote, deleteNote, updateNote, rollbackNote, fetchColors } from "./api";
import "./App.css";

function getColor() {
  let c = localStorage.getItem("userColor");
  if (!c) { c = "#e06c75"; localStorage.setItem("userColor", c) }
  return c;
}

function getAuthorId() {
  let id = localStorage.getItem("authorId");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("authorId", id) }
  return id;
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

function parseColorTags(body) {
  if (!body) return [];
  const parts = [];
  const re = /\{%\s*([^%]+?)\s*%\}([\s\S]*?)\{%\s*end\s*%\}/g;
  let last = 0, m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push({ text: body.slice(last, m.index), color: "var(--gray-400)" });
    parts.push({ text: m[2], color: m[1].trim() });
    last = re.lastIndex;
  }
  if (last < body.length) parts.push({ text: body.slice(last), color: "var(--gray-400)" });
  return parts;
}

function rebuildBody(edited, segments, userColor) {
  const out = [];
  let pos = 0;
  let si = 0;
  while (pos < edited.length) {
    const seg = segments[si];
    if (seg && edited.slice(pos, pos + seg.text.length) === seg.text) {
      out.push(`{% ${seg.color} %}${seg.text}{% end %}`);
      pos += seg.text.length;
      si++;
    } else if (seg && seg.text.length > 0) {
      const idx = edited.indexOf(seg.text, pos);
      if (idx > pos) {
        out.push(`{% ${userColor} %}${edited.slice(pos, idx)}{% end %}`);
        pos = idx;
      } else if (idx === pos) {
        out.push(`{% ${seg.color} %}${seg.text}{% end %}`);
        pos += seg.text.length;
        si++;
      } else {
        si++;
      }
    } else {
      out.push(`{% ${userColor} %}${edited.slice(pos)}{% end %}`);
      pos = edited.length;
    }
  }
  return out.join("");
}

function App() {
  const [notes, setNotes] = useState([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [showPicker, setShowPicker] = useState(!localStorage.getItem("userColor"));

  const [bodySegments, setBodySegments] = useState([]);
  const [pickedColor, setPickedColor] = useState("#e06c75");
  const [takenColors, setTakenColors] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");

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
    const userColor = getColor();
    try {
      if (editingId) {
        const wrapped = rebuildBody(body, bodySegments, userColor);
        const res = await updateNote({ id: editingId, title: title.trim(), body: wrapped });
        setNotes((prev) => prev.map((n) => (n.id === editingId ? { ...n, ...res.data[0] } : n)));
        setEditingId(null);
      } else {
        if (!title.trim() && !body.trim()) return;
        const res = await createNote({ title: title.trim(), body: body.trim(), color: userColor, authorId: getAuthorId() });
        const saved = { ...res.data[0], size: "small" };
        setNotes((prev) => [...prev, saved]);
      }
      setBody("");
      setBodySegments([]);
      setTitle("");
    } catch (err) {
      console.error("Failed to save note:", err);
    }
  };

  const removeNote = async (id, token) => {
    try {
      await deleteNote(id, token);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  };

  const handleRollback = async (id, token) => {
    try {
      const res = await rollbackNote(id, token);
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...res.data[0] } : n)));
    } catch (err) {
      console.error("Failed to rollback:", err);
    }
  };

  const myId = getAuthorId();

  const filteredNotes = notes.filter(n => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const plainBody = n.body?.replace(/\{%\s*[^%]+?\s*%\}/g, "").replace(/\{%\s*end\s*%\}/g, "").trim();
    return (n.title || "").toLowerCase().includes(q) || plainBody?.toLowerCase().includes(q);
  });

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

  const startEdit = (note) => {
    const segs = parseColorTags(note.body);
    setEditingId(note.id);
    setTitle(note.title);
    setBody(segs.map(s => s.text).join(""));
    setBodySegments(segs);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    if (showPicker) fetchColors(getAuthorId()).then(setTakenColors).catch(() => {});
  }, [showPicker]);

  const isColorTaken = takenColors.includes(pickedColor);
  const confirmPick = () => {
    if (isColorTaken) return;
    localStorage.setItem("userColor", pickedColor);
    setShowPicker(false);
  };

  const myColor = getColor();

  if (showPicker) {
    return (
      <div className="notes-app">
        <div className="color-picker-modal">
          <h2>pick your chalk</h2>
          <div className="color-wheel-area">
            <label className="color-wheel-label">
              <input type="color" value={pickedColor} onChange={(e) => setPickedColor(e.target.value)} />
            </label>
          </div>
          <div className="picked-preview" style={{ backgroundColor: pickedColor }} />
          <div className="color-hex">{pickedColor}</div>
          {isColorTaken ? (
            <p className="color-taken-msg">✗ already claimed</p>
          ) : (
            <button className="color-confirm" onClick={confirmPick}>Use this chalk</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="notes-app">
      <header className="header">
        <div className="header-row">
          <h1>TABLOID</h1>
          <span className="my-color-dot" style={{ backgroundColor: myColor }} title="your chalk — click to change" onClick={() => { setShowPicker(true); setPickedColor(myColor) }} />
        </div>
        <p className="subtitle">Your Chalk on The Anonymous BlackBoard</p>
        <div className="search-bar">
          <input
            className="search-input"
            type="text"
            placeholder="search…"
            value={searchQuery}
            onChange={(e) => {
              const val = e.target.value;
              const m = val.match(/^!\{([^}]+)\}$/);
              if (m) {
                setAdminToken(m[1]);
                localStorage.setItem("adminToken", m[1]);
                setSearchQuery("");
              } else {
                setSearchQuery(val);
              }
            }}
          />
          {adminToken && (
            <span className="admin-badge" onClick={() => { setAdminToken(""); localStorage.removeItem("adminToken") }}>
              admin ✕
            </span>
          )}
        </div>
      </header>
      <form className="note-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Topic"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          placeholder="Write something..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onInput={(e) => { e.target.style.height = ""; e.target.style.height = e.target.scrollHeight + "px" }}
        />
        <button type="submit">{editingId ? "Update" : "Post"}</button>
        {editingId && (
          <button type="button" onClick={() => { setEditingId(null); setBody(""); setBodySegments([]); setTitle(""); }}>
            Cancel
          </button>
        )}
      </form>
      <div className="notes-grid">
        {notes.length === 0 && (
          <p className="empty">No notes yet — start your collection</p>
        )}
        {notes.length > 0 && filteredNotes.length === 0 && (
          <p className="empty">no matches for "{searchQuery}"</p>
        )}
        {filteredNotes.map((note) => {
          const segments = parseColorTags(note.body);
          return (
            <div key={note.id} className={`note-card ${note.size}`}>
              <div className="card-buttons-top-right">
                <button className="resize" onClick={() => cycleSize(note.id)} title="Resize">◇</button>
                <button className="edit-button" onClick={() => startEdit(note)} title="Edit">∆</button>
                {(note.authorId === myId) && (
                  <button className="remove" onClick={() => removeNote(note.id, myId)} title="Delete">×</button>
                )}
                {adminToken && note.authorId !== myId && (
                  <button className="remove" onClick={() => removeNote(note.id, adminToken)} title="Delete">×</button>
                )}
                {(note.authorId === myId || adminToken) && (
                  <button className="rollback" onClick={() => handleRollback(note.id, note.authorId === myId ? myId : adminToken)} title="Rollback">↩</button>
                )}
              </div>
              <div className="note-chalk" style={{ borderLeftColor: note.authorColor || "var(--gray-600)" }}>
                {note.title && <h2>{note.title}</h2>}
                <div className="body-colored">
                  {segments.map((p, i) => (
                    <span key={i} style={{ color: p.color }}>{p.text}</span>
                  ))}
                </div>
                <p className="note-timestamp">
                  <span className="chalk-dot" style={{ backgroundColor: note.authorColor || "var(--gray-600)" }} />
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