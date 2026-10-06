import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendThought,
  cancelRequest,
  changePassword,
  createNote,
  createSpace,
  deleteAccount,
  deleteNote,
  editThought,
  fetchMe,
  fetchMentions,
  fetchNotes,
  fetchSpaces,
  ghostAccount,
  requestAccess,
  rollbackNote,
  rotateToken,
  reviveAccount,
  setNoteSize,
  updateNote,
  voteToDelete,
} from "./api";
import { clearSession, loadSession, saveSession, updateStoredUser } from "./session";
import { stripMarkup } from "../../lib/richtext";
import AuthGate from "./components/AuthGate";
import Sidebar from "./components/Sidebar";
import Board from "./components/Board";
import Moderation from "./components/Moderation";
import SpaceSettings from "./components/SpaceSettings";
import AccessPanel from "./components/AccessPanel";
import NoteCard from "./components/NoteCard";
import TabBar from "./components/TabBar";
import Toast from "./components/Toast";
import useMediaQuery from "./hooks/useMediaQuery";
import { MOBILE_QUERY } from "./layout";
import "./App.css";

const PAGE = 12;
const POLL_MS = 5000;
const SIZES = ["small", "wide", "tall", "big"];

const emptyFeed = { items: [], nextCursor: null, hasMore: false };

export default function App() {
  const [session, setSession] = useState(() => loadSession());
  const [me, setMe] = useState(null);
  const [spaces, setSpaces] = useState([]);
  const [selection, setSelection] = useState({ kind: "lobby" });
  const [view, setView] = useState("board");
  const [accessVersion, setAccessVersion] = useState(0);

  const [notes, setNotes] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [feed, setFeed] = useState(emptyFeed);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotatedToken, setRotatedToken] = useState(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [ghosting, setGhosting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState(null);

  /* --------------------------- mobile chrome -------------------------- */

  // Drives the bottom bar, the nav drawer and the collapsible composer. The
  // value is pinned to the same breakpoint the CSS uses — see layout.js for why
  // there is only one of them.
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  // Derived, not stored. An effect that force-closed the drawer on widening would
  // leave a frame where a fixed overlay is stranded over a desktop sidebar that
  // has no way to dismiss it. Gating the value instead means `true` can only ever
  // describe a drawer that is actually on screen.
  const drawerVisible = isMobile && drawerOpen;

  // Escape closes the drawer. Phones have no Escape key, but tablets with
  // keyboards make this worth wiring.
  useEffect(() => {
    if (!drawerVisible) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerVisible]);

  // Hold the page still behind the drawer, and stop iOS from scrolling the
  // board underneath a touch that was meant for the scrim.
  useEffect(() => {
    if (!drawerVisible) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerVisible]);

  const notify = useCallback((message, kind = "info") => {
    setToast({ message, kind });
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  /* ------------------------------ session ----------------------------- */

  useEffect(() => {
    const onSignedOut = () => {
      clearSession();
      setSession(null);
      setMe(null);
    };
    window.addEventListener("tabloid:signed-out", onSignedOut);
    return () => window.removeEventListener("tabloid:signed-out", onSignedOut);
  }, []);

  const refreshSpaces = useCallback(async () => {
    const list = await fetchSpaces();
    setSpaces(list);
    setAccessVersion((v) => v + 1);
    return list;
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const [profile, list] = await Promise.all([fetchMe(), fetchSpaces()]);
        if (cancelled) return;
        setMe(profile);
        setSpaces(list);
        setAccessVersion((v) => v + 1);
      } catch (err) {
        if (!cancelled) notify(err?.response?.data?.error || "Could not sign you in", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, notify]);

  /* --------------------------- space selection ------------------------ */

  const spaceId = selection.kind === "space" ? selection.id : null;
  const space = useMemo(
    () => (spaceId == null ? null : (spaces.find((s) => s.id === spaceId) || null)),
    [spaces, spaceId],
  );
  const canRead = space ? space.caps.includes("read_notes") : true;
  // Mirrors Board's own check so the bottom bar can omit Post for a reader
  // rather than offering a button that only reveals a "you cannot post here".
  // The server already drops `create_note` from a ghost's caps, so this line is
  // belt-and-braces for the Lobby, where there is no space to carry caps.
  const canPost =
    (space ? space.caps.includes("create_note") : true) &&
    !(me?.user || session?.user)?.ghostedAt;

  const selectSpace = (target) => {
    setView("board");
    setSelection(target.kind === "lobby" ? { kind: "lobby" } : { kind: "space", id: target.id });
    setSearch("");
    setEditing(null);
    // Choosing a space is the end of the mobile navigation gesture; leaving the
    // drawer hanging open over the board it just navigated to would be a bug.
    setDrawerOpen(false);
  };

  /* ------------------------------- notes ------------------------------ */

  // `accessVersion` is in the deps as a signal: bumping it re-runs this after a
  // membership change, so an approved request reveals the notes without a
  // reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Losing read access (a removed membership, a downgrade) empties the
      // board rather than leaving notes from a space you can no longer see.
      if (spaceId != null && !canRead) {
        if (cancelled) return;
        setNotes([]);
        setCursor(null);
        setHasMore(false);
        return;
      }
      try {
        const page = await fetchNotes({ spaceId, limit: PAGE });
        if (cancelled) return;
        setNotes(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch (err) {
        if (!cancelled) notify(err?.response?.data?.error || "Could not load notes", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spaceId, canRead, accessVersion, notify]);

  // Poll the newest page only. Older pages already on screen are preserved, and
  // anything inside the polled window that disappeared (deleted) is dropped.
  useEffect(() => {
    if (!session || view !== "board") return undefined;
    const timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const page = await fetchNotes({ spaceId, limit: PAGE });
        const floor = page.items.length ? page.items[page.items.length - 1].id : Infinity;
        const incoming = new Map(page.items.map((n) => [n.id, n]));
        setNotes((prev) => {
          if (!prev.length) return page.items;
          return [...page.items, ...prev.filter((n) => !incoming.has(n.id) && n.id < floor)];
        });
      } catch {
        /* transient — the next tick retries */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [session, view, spaceId]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchNotes({ spaceId, cursor, limit: PAGE });
      setNotes((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...page.items.filter((n) => !seen.has(n.id))];
      });
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      notify(err?.response?.data?.error || "Could not load more", "error");
    } finally {
      setLoadingMore(false);
    }
  };

  /* ------------------------------ mentions ---------------------------- */

  // Only for the "load more" button; the first page is fetched by the effect
  // below so that it can cancel cleanly on unmount.
  const loadMoreFeed = useCallback(async () => {
    try {
      const page = await fetchMentions({ cursor: feed.nextCursor, limit: PAGE });
      setFeed((prev) => ({
        items: [...prev.items, ...page.items],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      }));
    } catch (err) {
      notify(err?.response?.data?.error || "Could not load mentions", "error");
    }
  }, [feed.nextCursor, notify]);

  useEffect(() => {
    if (view !== "mentions") return undefined;
    let cancelled = false;
    (async () => {
      try {
        const page = await fetchMentions({ limit: PAGE });
        if (!cancelled) setFeed(page);
      } catch (err) {
        if (!cancelled) notify(err?.response?.data?.error || "Could not load mentions", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, notify]);

  /* ------------------------------ mutations --------------------------- */

  const handleSubmit = async ({ title, body }) => {
    setBusy(true);
    try {
      if (editing) {
        // Editing a card means editing its opening thought: title plus the
        // author's own text, sent plain. The server recomposes the card body
        // from every thought, so other people's appends stay exactly as they
        // are - never re-chalked, never overwritten.
        const saved = await updateNote(editing.id, { title, body });
        setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
        setEditing(null);
      } else {
        const created = await createNote({ title, body }, spaceId);
        setNotes((prev) => [created, ...prev]);
      }
      notify(editing ? "Note updated" : "Posted");
      // The note is now the top of the board, so put the form away and hand the
      // screen back to the content instead of leaving an empty editor there.
      setComposerOpen(false);
    } catch (err) {
      notify(err?.response?.data?.error || "Could not save the note", "error");
    } finally {
      setBusy(false);
    }
  };

  /**
   * The edit form works on the opening thought only: its title and the
   * author's own text. Other thoughts are other people's, so they are never
   * prefilled into an editor that could swallow them.
   */
  const startEdit = (note) => {
    const opening = note.thoughts?.[0];
    setEditing({
      id: note.id,
      title: note.title,
      body: opening ? opening.text : stripMarkup(note.body),
      plainBody: opening ? opening.text : stripMarkup(note.body),
    });
  };

  /** Append a thought of your own to a card - its content stays yours. */
  const handleAppend = async (note, text) => {
    try {
      const saved = await appendThought(note.id, text);
      setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
      notify("Thought added");
    } catch (err) {
      notify(err?.response?.data?.error || "Could not add the thought", "error");
      throw err;
    }
  };

  /** Correct your own appended thought, while its window is still open. */
  const handleEditThought = async (note, thoughtId, text) => {
    try {
      const saved = await editThought(note.id, thoughtId, text);
      setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
      notify("Thought updated");
    } catch (err) {
      notify(
        err?.response?.data?.error || "Could not save the thought",
        "error",
      );
      throw err;
    }
  };

  const handleDelete = async (note) => {
    try {
      await deleteNote(note.id);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      setEditing((current) => (current?.id === note.id ? null : current));
      notify("Note deleted");
    } catch (err) {
      notify(err?.response?.data?.error || "Could not delete the note", "error");
    }
  };

  /**
   * Record your consent to removing a card. Only people who wrote on the card
   * get a vote; once enough of them agree, the author's delete goes through.
   */
  const handleDeleteVote = async (note) => {
    try {
      const saved = await voteToDelete(note.id);
      setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
      const agreed = saved.deleteVote?.consents ?? 0;
      const total = saved.deleteVote?.contributors ?? 0;
      notify(`Consent recorded — ${agreed} of ${total} contributors agree`);
    } catch (err) {
      notify(err?.response?.data?.error || "Could not record the vote", "error");
    }
  };

  const handleRollback = async (note) => {
    try {
      const saved = await rollbackNote(note.id);
      setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
      notify("Rolled back one edit");
    } catch (err) {
      notify(err?.response?.data?.error || "Could not roll back", "error");
    }
  };

  /** Optimistic resize, persisted per-user so it survives reloads and devices. */
  const handleResize = async (note) => {
    const next = SIZES[(SIZES.indexOf(note.size) + 1) % SIZES.length];
    setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, size: next } : n)));
    try {
      await setNoteSize(note.id, next);
    } catch (err) {
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, size: note.size } : n)));
      notify(err?.response?.data?.error || "Could not save that layout", "error");
    }
  };

  const handleCreateSpace = async (payload) => {
    try {
      const created = await createSpace(payload);
      await refreshSpaces();
      setSelection({ kind: "space", id: created.id });
      notify(`${created.name} created`);
      return created;
    } catch (err) {
      notify(err?.response?.data?.error || "Could not create the space", "error");
      return null;
    }
  };

  const handleRequestAccess = async (role, message) => {
    setBusy(true);
    try {
      const result = await requestAccess(space.id, { role, message });
      await refreshSpaces();
      notify(result.approved ? "You have read access now" : "Request sent to the moderators");
    } catch (err) {
      notify(err?.response?.data?.error || "Could not send the request", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleWithdrawRequest = async () => {
    if (!space?.pendingRequestId) return;
    setBusy(true);
    try {
      await cancelRequest(space.pendingRequestId);
      await refreshSpaces();
      notify("Request withdrawn");
    } catch (err) {
      notify(err?.response?.data?.error || "Could not withdraw the request", "error");
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    clearSession();
    setSession(null);
    setMe(null);
    setSpaces([]);
    setNotes([]);
    setFeed(emptyFeed);
    setRotatedToken(null);
    setSelection({ kind: "lobby" });
    setView("board");
  };

  /**
   * Issues a fresh token and swaps it into both storage and state. Without the
   * state update the in-memory copy would keep sending the dead token and the
   * next request would 401 the user straight back out to the auth gate.
   *
   * The new token is revealed because rotation kills the old one immediately
   * and nothing else in the system can show it again — rotate blind and a lost
   * session is an unrecoverable account.
   */
  const handleRotateToken = useCallback(async () => {
    setRotating(true);
    try {
      const { token } = await rotateToken();
      const current = me?.user || session?.user;
      if (current) saveSession(current, token);
      setSession((prev) => (prev ? { ...prev, token } : prev));
      setRotatedToken(token);
      notify("Token rotated — the previous one no longer works");
    } catch (err) {
      notify(err?.response?.data?.error || "Could not rotate the token", "error");
    } finally {
      setRotating(false);
    }
  }, [me, session, notify]);

  /**
   * Changing the password also retires the current token, so the replacement is
   * adopted the same way rotation does — `changePassword` writes it to storage
   * before this runs, and if it ever stopped doing so the very next request
   * would 401 the user straight back out to the auth gate.
   *
   * Returns `{ ok, message }` so the sidebar can keep the form open and explain
   * what went wrong, rather than showing a generic failure.
   */
  const handleChangePassword = useCallback(
    async (currentPassword, newPassword) => {
      setChangingPassword(true);
      try {
        const { token } = await changePassword(currentPassword, newPassword);
        const current = me?.user || session?.user;
        if (current && token) saveSession(current, token);
        setSession((prev) => (prev && token ? { ...prev, token } : prev));
        notify("Password changed — your old token is no longer valid");
        return { ok: true };
      } catch (err) {
        const message =
          err?.response?.data?.error || "Could not change the password";
        notify(message, "error");
        return { ok: false, message };
      } finally {
        setChangingPassword(false);
      }
    },
    [me, session, notify],
  );

  /* --------------------------- ghost in time --------------------------- */

  /**
   * Both directions of "Ghost In Time" go through here, because they have the
   * same three consequences: adopt the new user shape, drop whatever transient
   * editing state is open, and re-read the board under the new rules.
   *
   * Refetching rather than patching local state is the point. On ghosting the
   * server starts hiding everything written since the timestamp, and on revive
   * it stops - so the notes, spaces and capabilities already in memory are
   * stale in both directions and only a fresh read knows the difference.
   */
  const setGhosted = useCallback(
    async (call, { verb, done }) => {
      setGhosting(true);
      try {
        const { user } = await call();
        const next = { ...(me?.user || session?.user), ...user };
        if (session) saveSession(next, session.token);
        setMe((prev) => ({ ...prev, user: next }));
        setSession((prev) => (prev ? { ...prev, user: next } : prev));
        // Any half-finished edit predates the ghosting and must not be
        // submittable afterwards.
        setEditing(null);
        setComposerOpen(false);
        setFeed(emptyFeed);
        // `refreshSpaces` bumps this, which is the notes effect's signal to
        // re-read. Bumping it explicitly covers the case it does not: ghosting
        // from the Lobby leaves `spaceId` unchanged, so without this the board
        // would keep showing the notes the server has just stopped serving.
        await refreshSpaces();
        setAccessVersion((v) => v + 1);
        notify(done(), "info");
      } catch (err) {
        notify(err?.response?.data?.error || `Could not ${verb}`, "error");
      } finally {
        setGhosting(false);
      }
    },
    [me, session, notify, refreshSpaces],
  );

  const handleGhost = useCallback(
    () =>
      setGhosted(ghostAccount, {
        verb: "become a ghost",
        done: () => "You are a ghost. Nothing was deleted - revive whenever you like.",
      }),
    [setGhosted],
  );

  const handleRevive = useCallback(
    () =>
      setGhosted(reviveAccount, {
        verb: "revive",
        done: () => "Welcome back. Everything written since you left is here again.",
      }),
    [setGhosted],
  );

  /* --------------------------- account deletion ------------------------- */

  /**
   * Deletes the account, then signs out.
   *
   * `signOut()` rather than a bare `setSession(null)` because a deleted account
   * leaves real state behind that the auth gate would otherwise still be showing
   * on top of: the last-selected space, the open composer, the rotated token
   * sitting in the panel. Clearing all of it is what makes signing back in land
   * on a clean board rather than somebody else's leftover space.
   *
   * Returns `{ ok, message }` like `handleChangePassword`, so the sidebar keeps
   * the password in the box on a refusal - an OWNS_SPACES answer is an
   * instruction to go and deal with the spaces first, and wiping the field would
   * make that feel like a dead end.
   */
  const handleDeleteAccount = useCallback(
    async (password) => {
      setDeleting(true);
      // Read the handle before signing out, which clears it.
      const handle = (me?.user || session?.user)?.handle;
      try {
        await deleteAccount(password);
        signOut();
        notify(handle ? `@${handle} is gone` : "Your account is gone");
        return { ok: true };
      } catch (err) {
        const message = err?.response?.data?.error || "Could not delete the account";
        notify(message, "error");
        return { ok: false, message };
      } finally {
        setDeleting(false);
      }
    },
    [me, session, notify],
  );

  /* ------------------------------- render ----------------------------- */

  if (!session) {
    return (
      <AuthGate
        onAuthenticated={(next) => {
          setSession(next);
          updateStoredUser(next.user);
        }}
      >
        {/* The toast lives outside the signed-in shell on purpose. Deleting an
            account signs you straight out, and "your account is gone" is exactly
            the confirmation that must survive landing on the auth gate — without
            it the board would just blink from a full sidebar to a login form
            with no explanation. */}
        <Toast toast={toast} onDismiss={() => setToast(null)} />
      </AuthGate>
    );
  }

  const user = me?.user || session.user;

  // Everything below reads this rather than checking the flag again. The server
  // refuses each write independently; this only keeps the UI from offering a
  // button whose only possible outcome is an error.
  const ghosted = Boolean(user.ghostedAt);

  // Every route into mentions and the composer has to leave the drawer closed,
  // because on a phone those are both things the drawer was covering.
  const openMentions = () => {
    setView("mentions");
    setDrawerOpen(false);
  };

  const openComposer = () => {
    setComposerOpen(true);
    // The composer sits at the top of the board and the reader is most likely
    // scrolled well past it.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <div className="shell">
      <Sidebar
        user={user}
        spaces={spaces}
        selection={selection}
        onSelect={selectSpace}
        onCreateSpace={handleCreateSpace}
        onOpenMentions={openMentions}
        mentionCount={feed.items.length}
        onSignOut={signOut}
        onRotateToken={handleRotateToken}
        rotating={rotating}
        rotatedToken={rotatedToken}
        onDismissToken={() => setRotatedToken(null)}
        onChangePassword={handleChangePassword}
        changingPassword={changingPassword}
        onGhost={handleGhost}
        onRevive={handleRevive}
        ghosting={ghosting}
        onDeleteAccount={handleDeleteAccount}
        deleting={deleting}
        drawerOpen={drawerVisible}
        onCloseDrawer={() => setDrawerOpen(false)}
      />

      <main className="main">
        {ghosted && (
          <div className="ghost-banner" role="status">
            <div>
              <strong>You are a ghost.</strong> You can read everything you could
              read when you left, and nothing written since. Posting, spaces and
              requests are closed.
            </div>
            <button type="button" onClick={handleRevive} disabled={ghosting}>
              {ghosting ? "waking…" : "revive"}
            </button>
          </div>
        )}

        <header className="main-head">
          <div className="main-title">
            <h1>{view === "mentions" ? "Your mentions" : space ? space.name : "Lobby"}</h1>
            {view === "mentions" ? (
              <p className="subtitle">notes where somebody tagged you</p>
            ) : space ? (
              <>
                <p className="subtitle">
                  {space.description || "no description"}
                  {" · "}
                  <span className={`chip subtle ${space.visibility}`}>{space.visibility}</span>
                  {space.role && (
                    <span className={`chip subtle ${space.role}`}>you are {space.role}</span>
                  )}
                  {typeof space.memberCount === "number" && (
                    <span className="chip subtle">{space.memberCount} members</span>
                  )}
                </p>
              </>
            ) : (
              <p className="subtitle">the open board — everyone can read and post</p>
            )}
          </div>
          {view === "board" && space && (
            <button type="button" className="ghost" onClick={() => setView("mentions")}>
              mentions
            </button>
          )}
          {view === "mentions" && (
            <button type="button" className="ghost" onClick={() => setView("board")}>
              back to board
            </button>
          )}
        </header>

        {view === "mentions" ? (
          <>
            <div className="mention-feed">
              {feed.items.length === 0 && (
                <p className="empty">
                  nothing yet — tag someone with @handle and it shows up here
                </p>
              )}
              {feed.items.map(({ note }) => (
                <div key={note.id} className="mention-feed-item">
                  <p className="mention-where">
                    in <strong>{note.spaceId ? spaces.find((s) => s.id === note.spaceId)?.name || "a space" : "the Lobby"}</strong>
                  </p>
                  <NoteCard
                    note={note}
                    onEdit={startEdit}
                    onDelete={handleDelete}
                    onRollback={handleRollback}
                    onResize={handleResize}
                    canResize={!ghosted}
                    onAppend={handleAppend}
                    onEditThought={handleEditThought}
                    onDeleteVote={handleDeleteVote}
                    onTag={(handle) => {
                      setSearch(`@${handle}`);
                      setView("board");
                    }}
                  />
                </div>
              ))}
            </div>
            {feed.hasMore && (
              <div className="load-more-wrap">
                <button type="button" className="load-more" onClick={loadMoreFeed}>
                  load more
                </button>
              </div>
            )}
          </>
        ) : space && !canRead ? (
          <AccessPanel
            space={space}
            pendingRequest={space.pendingRequest}
            busy={busy}
            onRequest={handleRequestAccess}
            onWithdraw={handleWithdrawRequest}
            ghosted={ghosted}
          />
        ) : (
          <>
            <Board
              space={space}
              notes={notes}
              search={search}
              onSearch={setSearch}
              editing={editing}
              onEdit={startEdit}
              onCancelEdit={() => setEditing(null)}
              onSubmit={handleSubmit}
              onDelete={handleDelete}
              onRollback={handleRollback}
              onResize={handleResize}
              onAppend={handleAppend}
              onEditThought={handleEditThought}
              onDeleteVote={handleDeleteVote}
              onTag={(handle) => setSearch(`@${handle}`)}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
              busy={busy}
              emptyMessage={
                space ? "no notes here yet" : "No notes yet — start the collection"
              }
              composerCollapsed={isMobile && !composerOpen}
              onExpandComposer={openComposer}
              onCollapseComposer={() => setComposerOpen(false)}
              onRequestJoin={
                space && !space.role && !space.pendingRequest
                  ? () => handleRequestAccess("participant", null)
                  : null
              }
              user={user}
              onWithdrawJoin={
                space && !space.role && space.pendingRequest
                  ? handleWithdrawRequest
                  : null
              }
              requestingJoin={busy}
              ghosted={ghosted}
            />
            {space && (
              <Moderation
                key={space.id}
                space={space}
                caps={space.caps}
                onChanged={refreshSpaces}
                notify={notify}
              />
            )}
            {space && (
              <SpaceSettings
                key={space.id}
                space={space}
                caps={space.caps}
                onChanged={refreshSpaces}
                // Deleting or leaving removes the space the shell is pointed at,
                // so fall back to the Lobby rather than rendering an empty board.
                onLeft={() => selectSpace({ kind: "lobby" })}
                notify={notify}
              />
            )}
          </>
        )}
      </main>

      {isMobile && (
        <TabBar
          onOpenSpaces={() => setDrawerOpen(true)}
          onPost={openComposer}
          onOpenMentions={openMentions}
          mentionCount={feed.items.length}
          canPost={canPost && view !== "mentions"}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
