import { eq } from "drizzle-orm";

import {
  noteLayouts,
  noteMentions,
  notes,
  noteThoughts,
  retiredHandles,
  spaceMembers,
  spaceRequests,
  spaces,
  users,
} from "./schema.js";

/**
 * Account deletion, shared by `DELETE /auth/me` and the operator script.
 *
 * It lives here rather than inline in the route because two callers that each
 * owned a copy of this would drift: the operator script exists precisely for
 * accounts the route cannot serve, so a silent divergence would mean the
 * recovery path quietly stopped matching what the product promises.
 *
 * The contract, in one line: everything that is only about the departing person
 * is destroyed, and everything they contributed to a shared space is still there
 * with their name on it in grey.
 *
 *   gone    the account, its token and password, every membership, request,
 *           mention of it and card layout — all of which are only ever about
 *           this person
 *   stays   every note it wrote and every thought it appended, body intact,
 *           with the byline greyed out
 *
 * A note in a shared space is not the author's alone to destroy: deleting a
 * membership should not silently gut a roomful of other people's reading. The
 * snapshot `author_handle` is what makes that honest, and `retired_handles`
 * keeps the name unclaimable so the grey byline cannot be impersonated later.
 *
 * Returns a plain result object rather than throwing or writing a response, so
 * the route can map it onto HTTP and the script can print it.
 *
 * @param dbx     a drizzle handle (`db`, or a transaction)
 * @param user    the users row to remove
 * @param now     ISO timestamp for the retirement record
 * @returns `{ ok: true }` or `{ ok: false, code, error, spaces? }`
 */
export async function deleteAccountData(dbx, user, now = new Date().toISOString()) {
  // `spaces.owner_id` is NOT NULL with no ON DELETE, so a space cannot outlive
  // its owner. Refusing mirrors the existing rule that an owner cannot simply
  // leave: transfer the space or delete it first, then come back.
  const owned = await dbx
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(eq(spaces.ownerId, user.id));
  if (owned.length)
    return {
      ok: false,
      code: "OWNS_SPACES",
      error: `You still own ${owned.length === 1 ? "a space" : "spaces"}: ${owned
        .map((s) => s.name)
        .join(", ")}. Delete or hand those over first.`,
      spaces: owned.map((s) => ({ id: s.id, name: s.name })),
    };

  // There is no way to make an admin, so the last one deleting themselves leaves
  // a board nobody can moderate and nobody can ever put right. Guarding that is
  // about the site's recoverability, not about overruling a choice about their
  // own content. Applies to the operator script too — it is the same hazard.
  if (user.isAdmin) {
    const admins = await dbx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, 1));
    if (admins.length <= 1)
      return {
        ok: false,
        code: "LAST_ADMIN",
        error:
          "You are the only admin, and there is no way to appoint another. Hand over to somebody else first.",
      };
  }

  // Break every reference that has no ON DELETE action, then let the cascading
  // ones go with the row. Ordering matters only in that the handle retirement
  // and the row deletion must both land or neither should: written before the
  // delete, so a failure here aborts the transaction rather than leaving a
  // reusable handle behind a grey byline that already points at it.
  await dbx.update(notes).set({ authorId: null }).where(eq(notes.authorId, user.id));
  // Their appended thoughts grey out the same way their notes do: the snapshot
  // handle and chalk stay on the card, but the account link dies with them.
  await dbx
    .update(noteThoughts)
    .set({ authorId: null })
    .where(eq(noteThoughts.authorId, user.id));
  await dbx
    .update(spaceMembers)
    .set({ addedBy: null })
    .where(eq(spaceMembers.addedBy, user.id));
  await dbx
    .update(spaceRequests)
    .set({ resolvedBy: null })
    .where(eq(spaceRequests.resolvedBy, user.id));
  await dbx.delete(noteLayouts).where(eq(noteLayouts.userId, user.id));
  await dbx.delete(noteMentions).where(eq(noteMentions.userId, user.id));
  await dbx.delete(spaceRequests).where(eq(spaceRequests.userId, user.id));
  await dbx.delete(spaceMembers).where(eq(spaceMembers.userId, user.id));
  await dbx.insert(retiredHandles).values({ handle: user.handle, deletedAt: now });
  await dbx.delete(users).where(eq(users.id, user.id));

  return { ok: true };
}
