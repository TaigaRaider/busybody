/**
 * Space roles and capability checks.
 *
 * Roles form a total order. A capability check is always
 * `can(space, role, action)` so the server stays the single source of truth —
 * the client only mirrors these flags for affordances, never for enforcement.
 */

export const RANKS = {
  viewer: 1,
  participant: 2,
  moderator: 3,
  owner: 4,
};

export const rank = (role) => RANKS[role] ?? 0;

const MODERATOR_CAPS = [
  "read_notes",
  "create_note",
  "edit_own",
  "delete_own",
  "edit_any",
  "delete_any",
  "manage_requests",
];

export const MEMBER_CAPS = {
  viewer: ["read_notes"],
  participant: ["read_notes", "create_note", "edit_own", "delete_own"],
  moderator: MODERATOR_CAPS,
  owner: [
    ...MODERATOR_CAPS,
    "manage_members",
    "delete_space",
  ],
};

// The public Lobby (space_id IS NULL). Everyone is a participant-level reader;
// there is no per-space moderator concept. The board is a shared collection, so
// any signed-in user may also edit any post — a public note is a public fact
// and the board is where people come to correct it. Deletion stays with the
// author: `edit_any` without `delete_any` means a stranger can rewrite a post
// but only the author can take it down, which is what keeps a shared board
// curated rather than wreckable.
const LOBBY_CAPS = ["read_notes", "create_note", "edit_own", "delete_own", "edit_any"];

// Non-members of a public space may read but not write.
const PUBLIC_SPACE_CAPS = ["read_notes"];

// Non-members of a private space see only that it exists (via the discover
// list) and may file a request. They cannot read notes.
const PRIVATE_SPACE_CAPS = ["discover"];

/**
 * @param {object|null} space  null means the Lobby
 * @param {string|null} role   the caller's membership role, if any
 */
export function capsFor(space, role) {
  if (!space) return new Set(LOBBY_CAPS);
  const r = rank(role);
  if (r > 0) return new Set(MEMBER_CAPS[role] || []);
  return new Set(
    space.visibility === "public" ? PUBLIC_SPACE_CAPS : PRIVATE_SPACE_CAPS,
  );
}

export function can(space, role, action) {
  return capsFor(space, role).has(action);
}

/** True while the account holder has made themselves a ghost. */
export const isGhosted = (user) => Boolean(user?.ghostedAt);

/**
 * The capabilities a ghost keeps. Everything else - posting, editing,
 * approving requests, renaming a space - is closed. This is the whole feature
 * in one list, which is why it lives here and not spread across routes.
 */
export const GHOST_CAPS = new Set(["read_notes", "discover"]);

/** Whether a ghosted caller may still perform `action`. */
export function ghostAllows(action) {
  return GHOST_CAPS.has(action);
}

/**
 * Admins bypass every space check. A ghost is refused every write regardless
 * of role, because ghosting is something the holder chose and nothing a space
 * owner (or the ghost's own admin flag, if they had one) should be able to
 * quietly undo.
 */
export function allow(user, space, role, action) {
  if (user?.isAdmin && !isGhosted(user)) return true;
  if (isGhosted(user) && !ghostAllows(action)) return false;
  return can(space, role, action);
}

/**
 * Rank an approval/membership grant may assign. Moderators may hand out the
 * requestable tiers; only holders of `manage_members` (owners) may mint other
 * moderators or co-owners.
 *
 * @param {object} user
 * @param {object|null} space  the space the grant applies to
 * @param {string|null} role   the grantor's role in that space
 * @param {string} requested   the role being granted
 * @returns {string|null} the role to grant, or null when it is not permitted
 */
export function grantableRole(user, space, role, requested) {
  // A ghost grants nothing at all. This has to be checked before the rank test
  // below, which would otherwise wave a moderator's viewer grants through.
  if (isGhosted(user)) return null;
  if (allow(user, space, role, "manage_members")) return requested;
  return rank(requested) > rank("participant") ? null : requested;
}
