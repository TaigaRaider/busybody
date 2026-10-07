import { useState } from "react";
import { deleteSpace, leaveSpace, updateSpace } from "../api";

/**
 * Owner controls (rename, describe, change visibility, delete) and the member
 * "leave" action.
 *
 * All four endpoints have existed on the server since the beginning but had no
 * button anywhere, so a space could be created and never edited again. The
 * server stays the authority on who may do what — this only mirrors `caps` to
 * decide what to render.
 */
export default function SpaceSettings({ space, caps, onChanged, onLeft, notify }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description || "");
  const [visibility, setVisibility] = useState(space.visibility);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The form fields are seeded from props above rather than reset in an effect.
  // The parent gives this component a `key`, so a space switch remounts it —
  // cheaper to reason about than synchronising, and it guarantees the previous
  // space's name never sits in the input.

  const canEdit = caps.includes("manage_members");
  const canDelete = caps.includes("delete_space");
  const isOwner = space.role === "owner";
  // Leaving is for members who are not the owner; the server refuses the owner
  // ("transfer or delete the space instead"), so do not offer a dead button.
  const canLeave = Boolean(space.role) && !isOwner;

  if (!canEdit && !canLeave) return null;

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateSpace(space.id, {
        name: name.trim(),
        description: description.trim(),
        visibility,
      });
      notify("Space updated");
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err?.response?.data?.error || "Could not save the space");
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    if (saving) return;
    // Deleting takes every note with it and cannot be undone, so it is two taps
    // and names what is lost.
    const ok = window.confirm(
      `Delete "${space.name}"? Every note in it goes too. This cannot be undone.`,
    );
    if (!ok) {
      setConfirmDelete(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteSpace(space.id);
      notify("Space deleted");
      onChanged();
      onLeft?.();
    } catch (err) {
      setError(err?.response?.data?.error || "Could not delete the space");
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  };

  const leave = async () => {
    if (saving) return;
    const ok = window.confirm(
      `Leave "${space.name}"? You will need to request access to come back.`,
    );
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      await leaveSpace(space.id);
      notify(`Left ${space.name}`);
      onChanged();
      onLeft?.();
    } catch (err) {
      setError(err?.response?.data?.error || "Could not leave the space");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-settings">
      {/* Not a tab, so not a button: this block has no siblings to switch
          between, and a focusable label is a lie to a screen reader. */}
      <div className="mod-tabs">
        <span className="settings-tab">Settings</span>
      </div>

      {canEdit && !editing && (
        <div className="mod-body">
          <dl className="settings-facts">
            <div>
              <dt>Name</dt>
              <dd>{space.name}</dd>
            </div>
            <div>
              <dt>Visibility</dt>
              <dd>{space.visibility}</dd>
            </div>
            <div>
              <dt>Your role</dt>
              <dd>{space.role}</dd>
            </div>
          </dl>
          <div className="row">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            {canDelete &&
              (confirmDelete ? (
                <>
                  <button type="button" className="danger" disabled={saving} onClick={destroy}>
                    {saving ? "Deleting…" : "Yes, delete it"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete space
                </button>
              ))}
            {canLeave && (
              <button type="button" className="ghost" disabled={saving} onClick={leave}>
                {saving ? "Leaving…" : "Leave space"}
              </button>
            )}
          </div>
        </div>
      )}

      {canEdit && editing && (
        <form className="mod-body space-create" onSubmit={save}>
          <p className="rekey-title">Edit space</p>
          <input
            value={name}
            maxLength={80}
            placeholder="Space name"
            aria-label="Space name"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            value={description}
            maxLength={300}
            placeholder="What is it for? (optional)"
            aria-label="Space description"
            onChange={(e) => setDescription(e.target.value)}
          />
          <select
            value={visibility}
            aria-label="Visibility"
            onChange={(e) => setVisibility(e.target.value)}
          >
            <option value="private">private — request to read or post</option>
            <option value="public">public — anyone can read</option>
          </select>
          {error && <p className="gate-error">{error}</p>}
          <div className="row">
            <button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setEditing(false);
                setError(null);
                setName(space.name);
                setDescription(space.description || "");
                setVisibility(space.visibility);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && !editing && <p className="gate-error settings-error">{error}</p>}
    </section>
  );
}