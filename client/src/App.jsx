import { useState, useEffect, useRef } from "react";
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

function parseColorTags(body) {
  if (!body) return [];
  const parts = [];
  const re = /\{%\s*([^%]+)\s*\}(.*?)\{%\s*end\s*%\}/gs;
  let last = 0, m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push({ text: body.slice(last, m.index), color: null });
    parts.push({ text: m[2], color: m[1].trim() });
    last = re.lastIndex;
  }
  if (last < body.length) parts.push({ text: body.slice(last), color: null });
  return parts;
}

function segmentsToPlain(segments) {
  return segments.map(s => s.text).join("");
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
  const segmentsMap = useRef(new Map());

  useEffect(() => {
    const load = () =>
      fetchNotes()
        .then((res) => {
          const newMap = new Map();
          res.data.forEach((n) => newMap.set(n.id, parseColorTags(n.body)));
          segmentsMap.current = newMap;
          setNotes((prev) => {
            const prevMap = new Map(prev.map((n) => [n.id, n]));
            return res.data.map((n) => ({ ...prevMap.get(n.id), ...n, size: prevMap.get(n.id)?.size ?? "small" }));
          });
        })
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
        const stored = segmentsMap.current.get(editingId) || [];
        const wrapped = rebuildBody(body, stored, userColor);
        const res = await updateNote({ id: editingId, title: title.trim(), body: wrapped });
        segmentsMap.current.set(editingId, parseColorTags(wrapped));
        setNotes((prev) => prev.map((n) => (n.id === editingId ? { ...n, ...res.data[0] } : n)));
        setEditingId(null);
      } else {
        if (!title.trim() && !body.trim()) return;
        const res = await createNote({ title: title.trim(), body: body.trim(), color: userColor });
        const saved = { ...res.data[0], size: "small" };
        segmentsMap.current.set(saved.id, parseColorTags(res.data[0].body));
        setNotes((prev) => [...prev, saved]);
      }
      setBody("");
      setTitle("");
    } catch (err) {
      console.error("Failed to save note:", err);
    }
  };

  const removeNote = async (id) => {
    try {
      await deleteNote(id, adminToken);
      segmentsMap.current.delete(id);
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

  const startEdit = (note) => {
    setEditingId(note.id);
    setTitle(note.title);
    const segs = segmentsMap.current.get(note.id) || [];
    setBody(segmentsToPlain(segs));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const pick = (c) => {
    localStorage.setItem("userColor", c);
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
          <button type="button" onClick={() => { setEditingId(null); setBody(""); setTitle(""); }}>
            Cancel
          </button>
        )}
      </form>
      <div className="notes-grid">
        {notes.length === 0 && (
          <p className="empty">No notes yet — start your collection</p>
        )}
        {notes.map((note) => {
          const parts = segmentsMap.current.get(note.id) || [];
          return (
            <div key={note.id} className={`note-card ${note.size}`}>
              <div className="card-buttons-top-right">
                <button className="resize" onClick={() => cycleSize(note.id)} title="Resize">◇</button>
                <button className="edit-button" onClick={() => startEdit(note)} title="Edit">∆</button>
                {adminToken && (
                  <button className="remove" onClick={() => removeNote(note.id)} title="Delete">×</button>
                )}
              </div>
              <div className="note-chalk" style={{ borderLeftColor: note.authorColor || "var(--gray-600)" }}>
                {note.title && <h2>{note.title}</h2>}
                <div className="body-colored">
                  {parts.map((p, i) => (
                    <span key={i} style={{ color: p.color || "var(--gray-400)" }}>{p.text}</span>
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