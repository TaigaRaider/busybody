# Deployment Summary

## Architecture
- **Frontend**: Vite/React SPA deployed on Vercel
- **Backend**: Express serverless function on Vercel (`api/index.js`)
- **Database**: Turso (libsql) — serverless SQLite
- **Shared code**: everything lives in `lib/`. `api/index.js` (production) and
  `server/src/index.js` (local) are two-line wrappers around `createApp()`, and
  the client imports the note-body parser from `lib/richtext.js` directly. There
  is no duplicated copy of the app to drift.

```
lib/
  app.js         all routes; exports createApp()
  auth.js        password hashing (scrypt) and bearer-token identity (sha256)
  db.js          single libsql client + drizzle instance
  mentions.js    @handle extraction / normalisation
  permissions.js role ranks + capability lists; every guard goes through `allow()`
  richtext.js    colour-span + @tag parser, shared by server, client and tests
  schema.js      canonical Drizzle schema
```

## URLs
| Service | URL |
|---------|-----|
| Frontend | https://thetabloid.vercel.app |
| Backend API | https://tabloid-api.vercel.app |
| Backend (deployment) | https://tabloid-as1qsv10o-taiga-raiders-projects.vercel.app |

## Vercel Projects

### Frontend: `busybody`
- Project ID: `prj_lzZLc71NtU8xE46WpnAZnUR6z7zK`
- Framework: Vite
- Root dir: `client/`

### Backend: `tabloid-api`
- Project ID: `prj_OqQwZ0Xx7Ta1Z8Fw5JFY5Gl6cUd1`
- Team ID: `team_K9WFJgEYcEGQWehLGwMramMD` (taiga-raiders-projects)
- Vercel token: `vcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## Environment Variables (Vercel)

### Backend (tabloid-api)
| Key | Value | Notes |
|-----|-------|-------|
| `TURSO_DATABASE_URL` | `libsql://tabloid-taigaraider.aws-us-east-2.turso.io` | |
| `TURSO_AUTH_TOKEN` | Read-write token (see below) | |
| `CORS_ORIGIN` | `https://thetabloid.vercel.app` | |
| `ADMIN_TOKEN` | *(optional)* | A superuser credential for operational access. Set it, then `Authorization: Bearer <ADMIN_TOKEN>`. **Not** required for normal use. |

### Frontend (busybody)
| Key | Value |
|-----|-------|
| `VITE_API_URL` | `https://tabloid-api.vercel.app` |

## Local Development
```bash
npm install
npm --prefix client install
npm run dev        # migrates, then runs the API (:8080) and Vite (:5173)
```
Individual pieces:
```bash
npm run migrate    # apply/upgrade the schema
npm run dev:api    # API only
npm run dev:client # Vite only
npm test           # 128 tests, node:test, no extra dependencies
```

## Database Migrations

`server/scripts/migrate.mjs` is idempotent and does two jobs: it creates the
schema on an empty database, and it upgrades the legacy (pre-identity) one. Run
it before first use and after any schema change:

```bash
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run migrate
```

What the legacy upgrade does:
- `notes.author_id` changes from a client-chosen TEXT uuid to an INTEGER FK on
  `users.id`. Each distinct legacy uuid becomes one placeholder account
  (`anon-<12-char prefix>`, display name "Archived author").
- Because those placeholders hold no credential, their notes are **admin-only**
  to delete. This is the honest outcome; there is no way to prove who wrote them.
- `notes.editor_color` (unused) is dropped; `notes.space_id` is added and is
  `NULL` for every legacy note, which puts them all in the open Lobby.
- Rows are copied into a temp table and renamed, then `sqlite_sequence` is
  repaired so the autoincrement counter continues past the highest surviving id
  (note ids and their gaps are preserved).
- Re-running is a no-op: the rebuild is skipped once `editor_color` is absent.

`drizzle-kit push` (`npm --prefix server run db-update`) is optional and only
useful for schema pushes against an empty database — it cannot express the
legacy-data upgrade.

## Data Model

| Table | Purpose |
|-------|---------|
| `users` | handle (unique, lowercase), display name, chalk colour (unique), `token_hash` (sha256), `password_hash` (scrypt, nullable), `is_admin` |
| `spaces` | slug (unique), name, description, `owner_id`, `visibility` (`private` \| `public`) |
| `space_members` | (space_id, user_id) PK → role, the access control list |
| `space_requests` | pending/approved/denied/cancelled requests, one row per (space, user) |
| `notes` | space_id (NULL = Lobby), title, body, `author_id`, `author_color`, `history` (capped at 20) |
| `note_mentions` | one row per (note, tagged user); `space_id` denormalised so the feed can filter without joining `notes` |
| `note_layouts` | (note_id, user_id) PK → bento size; layout is personal, so resizing a card never disturbs anyone else's board |

Handles and colours are normalised to lowercase on write, so uniqueness comes
from the `UNIQUE` constraints rather than from an advisory read-then-write check
that could race.

### Note bodies
Plain text with two markups layered on top:
- colour spans — `{% #e06c75 %}text{% end %}`
- user tags — `@handle`

The literal `@handle` stays in `body` (it survives edits and renders inline);
`note_mentions` is the queryable source of truth for the mentions feed.

## Authorization

Roles form a total order: `viewer(1) < participant(2) < moderator(3) < owner(4)`.
Capability lists live in `lib/permissions.js`; every guard calls `allow(user, space, role, action)`.
Admins bypass all checks.

| Capability | Lobby | private, non-member | public, non-member | viewer | participant | moderator | owner |
|------------|-------|---------------------|--------------------|--------|-------------|-----------|-------|
| `discover` (see the space exists) | — | yes | — | — | — | — | — |
| `read_notes` | yes | — | yes | yes | yes | yes | yes |
| `create_note` | yes | — | — | — | yes | yes | yes |
| `edit_any` / `delete_any` | — | — | — | — | — | yes | yes |
| `manage_requests` | — | — | — | — | — | yes | yes |
| `manage_members`, `delete_space` | — | — | — | — | — | — | yes |

Notes:
- **"private" means content-gated, not hidden.** Private spaces are listed to
  everyone (name, description, visibility) so people can ask for access. This is
  deliberate: the request-to-join flow requires the space to be discoverable.
- Requesters may only ask for `viewer` or `participant`. Only holders of
  `manage_members` (owners) may grant `moderator` or `owner`.
- A `viewer` request on a *public* space is granted immediately, since read
  access is already available.
- Tagging someone inside a private space creates a pending `viewer` request for
  them — a tag doubles as an invitation. The notes stay unreadable until an
  owner approves, and the mentions feed filters on live access so an unapproved
  invite leaks nothing.

### Note deletion
`DELETE /notes/:id` is authorized server-side. Allowed for the author, a space
moderator/owner, or an admin. Everyone else gets `403 NOT_PERMITTED`; the client
only hides the button based on the server-provided `perm` flags, it is never the
enforcement point.

## Pagination

All list endpoints take `?limit=&cursor=` and return
`{ items, nextCursor, hasMore }`. The cursor is the row's integer id and results
are ordered newest-first, so paging is stable under concurrent inserts.
`limit` defaults to 20 and is clamped to 50. The client shows a **Load more**
button that walks the cursor; the 5s poll only refreshes the newest page and
merges, so pages you already loaded stay put.

## API Endpoints

All routes except `/ping` require `Authorization: Bearer <token>`.

### Auth
| Method | Path | Status | Description |
|--------|------|--------|-------------|
| GET | `/ping` | 200 | Health check (no auth) |
| POST | `/auth/register` | 201 | `{handle, color, password, displayName?}` → `{user, token}`. Password is 8–200 characters. The first account registered becomes an admin. 409 names the conflicting field. |
| POST | `/auth/login` | 200 | `{handle, password}` → `{user, token}`. Always a freshly issued token; the previous one stops working. Rate-limited per IP+handle. |
| GET | `/auth/me` | 200 | `{user, memberships, pendingRequests, moderating, adminTokenConfigured}` |
| PATCH | `/auth/me` | 200 | Change chalk colour / display name |
| POST | `/auth/change-password` | 200 | `{currentPassword, newPassword}` → `{token}`. Reissues the token, so the caller must adopt the returned one. |
| POST | `/auth/rotate-token` | 200 | Issue a new token; the old one stops working immediately |
| GET | `/users?q=` | 200 | Handle autocomplete for `@mention` |

### Spaces and access
| Method | Path | Status | Description |
|--------|------|--------|-------------|
| GET | `/spaces` | 200 | Every space with your role, capability list and pending-request state |
| POST | `/spaces` | 201 | `{name, description?, visibility?}` — creator becomes owner |
| GET | `/spaces/:idOrSlug` | 200 | One space + role + caps (+ `memberCount` when readable) |
| PATCH | `/spaces/:id` | 200 | Owner only: name, description, visibility |
| DELETE | `/spaces/:id` | 204 | Owner only; notes cascade |
| GET | `/spaces/:id/members` | 200 | Roster (needs read access) |
| PATCH | `/spaces/:id/members/:userId` | 200 | Owner only: change a role |
| DELETE | `/spaces/:id/members/:userId` | 204 | Owner only |
| POST | `/spaces/:id/leave` | 204 | Leave (owners cannot) |
| POST | `/spaces/:id/requests` | 201 | `{role: viewer\|participant, message?}` |
| GET | `/spaces/:id/requests` | 200 | Moderator inbox |
| POST | `/requests/:id/approve` | 200 | `{role?}` — overrides the requested role; escalation past `participant` is owner-only |
| POST | `/requests/:id/deny` | 200 | |
| DELETE | `/requests/:id` | 204 | Withdraw your own pending request |

### Notes
| Method | Path | Status | Description |
|--------|------|--------|-------------|
| GET | `/notes` | 200 | Lobby notes (paginated) |
| POST | `/notes` | 201 | Create in the Lobby |
| GET | `/spaces/:id/notes` | 200 | Space notes; 403 `NEEDS_REQUEST` without read access |
| POST | `/spaces/:id/notes` | 201 | Create in a space; 403 without `create_note` |
| PUT | `/notes/:id` | 200 | Edit; pushes a history entry, re-indexes tags |
| DELETE | `/notes/:id` | 204 | **Authorized**: author, space moderator, or admin |
| PUT | `/notes/:id/rollback` | 200 | Revert one revision |
| PUT | `/notes/:id/layout` | 200 | `{size: small\|wide\|tall\|big}` — your personal board layout |
| GET | `/mentions` | 200 | Notes that tagged you, filtered to what you can still read |

Every note in a response carries `size` (your layout), `author`, `mentions` and
`perm: { isMine, canEdit, canDelete, canRollback }`. The client renders from
those flags instead of re-deriving role logic.

## Authentication Model

The human-facing credential is a **password**. The credential that actually rides
on requests is a **token** the server issues in exchange for it.

- **Passwords** are hashed with scrypt (N=32768, r=8, p=1, 64-byte key, 16-byte
  salt) from `node:crypto`, stored as `scrypt$N$r$p$salt$hash`. They are *not*
  hashed with the SHA-256 used for tokens: a token is 256 bits of CSPRNG output
  with nothing to enumerate, whereas a password is low-entropy and a fast digest
  would let anyone holding a stolen database test billions of guesses a second.
- scrypt was chosen over argon2 because it is built into Node — no native
  dependency, and nothing extra that can fail a serverless build.
- Verification is constant-time, and `/auth/login` deliberately answers
  identically for an unknown handle, an account with no password, and a wrong
  password, so it cannot be used to discover which handles exist.
- Registration, sign-in and password changes all reissue the token. Signing in
  evicts the previous session token, so a token copied out of a shared browser
  stops working as soon as the owner signs in themselves.
- `password_hash` is **nullable**. The `anon-*` placeholder users created by the
  legacy migration carry authorship for old notes but hold no credential and can
  never authenticate; NULL is the accurate representation of that.
- Tokens are still 256-bit random values stored as SHA-256 hashes in
  `users.token_hash`. The raw token is returned exactly once.
- A user id is *not* a credential — this replaces the old scheme where a
  client-chosen uuid doubled as the bearer token and any note could be edited or
  deleted by claiming a different id.
- The client keeps the token in `localStorage` and attaches it via an axios
  interceptor. A 401 clears it and drops back to the auth screen. The password is
  never stored in the browser.
- `ADMIN_TOKEN` remains supported as an env-based superuser. It can delete any
  note but cannot create one or hold a profile.
- `/auth/login` is rate-limited to 10 attempts per 15 minutes per IP+handle and
  answers 429 after that. The counter is in-memory, so on serverless it only
  covers the warm instances serving the request — it is a brake, not a
  guarantee. Real enforcement wants a shared counter in the database.

### Password recovery

There is no email, no reset token and no second factor, so a forgotten password
is otherwise unrecoverable. For that one case:

```sh
TABLOID_NEW_PASSWORD='...' node server/scripts/set-password.mjs <handle>
```

It requires database credentials — already total control of the deployment — and
also revokes the account's current token without printing it. The password is
read from the environment so it does not land in shell history.

## Turso Database
- URL: `libsql://tabloid-taigaraider.aws-us-east-2.turso.io`
- Token: `eyJxxx...`

## Key Files

### `vercel.json` — Vercel config
```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }],
  "cleanUrls": true
}
```
- Rewrites all requests to `/api` → invokes `api/index.js`
- No `functions` block: Vercel auto-detects serverless functions.
- This file is read relative to the **Root Directory**, so it only applies to
  `tabloid-api`. The frontend's root dir is `client/`, so Vercel looks for
  `client/vercel.json` and these rewrites never reach the SPA.

### Root Directory — the setting everything else depends on
One repo, two projects, two different roots. Both are load-bearing:

| Project | Root Directory | Must be, because |
|----------|----------------|------------------|
| `busybody` | `client` | `index.html` and `vite.config.js` only exist there |
| `tabloid-api` | repo root (`.`) | `api/index.js` imports `../lib/app.js` |

Both projects also need **"Include files outside of the Root Directory in the
Build Step"** enabled (`sourceFilesOutsideRootDirectory`), because the client
imports `../../lib/richtext` from outside its own root.

**Do not set `tabloid-api`'s root to `api/`.** That is the failure recorded in
this repo's history: Vercel then runs `npm install` inside `api/`, which has no
`package.json`, and the build dies with

```
npm error enoent Could not read package.json: ENOENT: ... '/vercel/path0/api/package.json'
Error: Command "npm install" exited with 254
```

The symptom is `readyState: ERROR` with `aliasAssigned: null` — and because the
deploy fails, the previously-promoted deployment keeps serving stale code while
the dashboard looks superficially healthy. Check the root dir before assuming a
code problem.

### `package.json` (root) — Dependencies for Vercel build
- `"type": "module"` for ESM
- Deps: express@^5.2.1, cors@^2.8.6, @libsql/client@^0.17.4, drizzle-orm@^1.0.0-rc.4
- Node >= 22. Vercel reads `engines.node`, so this sets the function runtime.
  22 is the floor because `npm test` relies on `node --test` glob support
  (Node 21+).

### `client/src/` — frontend
| File | Role |
|------|------|
| `api.js` | axios client; attaches the bearer token, handles 401 sign-out |
| `session.js` | token persistence (never the password) |
| `App.jsx` | shell: selection, polling, pagination, mutations |
| `components/AuthGate.jsx` | join (handle + chalk + password) and sign in (handle + password) |
| `components/Sidebar.jsx` | lobby, your spaces, discover, mentions |
| `components/Board.jsx` | composer, search, bento grid, load more |
| `components/Composer.jsx` | note composer with `@handle` autocomplete |
| `components/NoteCard.jsx` | one card; renders colour spans and tags |
| `components/AccessPanel.jsx` | request-to-read / request-to-participate |
| `components/Moderation.jsx` | request inbox + member roster |
| `components/Toast.jsx` | transient messages |

## Tests
```bash
npm test
```
`node:test` plus the built-in `fetch`, so there are no test dependencies. Each
test file boots the real Express app against a throwaway SQLite file on an
ephemeral port, meaning the HTTP surface, authorization and migration paths are
all exercised end-to-end.

| File | Covers |
|------|--------|
| `unit.test.js` | tag extraction, colour parsing/re-tagging, role ranks and capability lists |
| `auth.test.js` | registration, uniqueness races, token rotation, admin bootstrap |
| `password.test.js` | scrypt round-trips, sign-in, placeholders that cannot authenticate, rate limiting, password change |
| `notes.test.js` | CRUD, **deletion authorization**, rollback, history cap, cursor pagination, layout persistence |
| `spaces.test.js` | the three access tiers, request/approve/deny, escalation limits, leave/delete |
| `mentions.test.js` | tag indexing, re-indexing on edit/rollback, tag-as-invite, feed filtering by live access |
| `migration.test.js` | legacy schema upgrade, row/id preservation, placeholder authors, idempotency |

### CI
`.github/workflows/ci.yml` runs on every push and pull request to `main`, on
Node 22 and 24:

```
npm ci → npm test → npm --prefix client ci → lint → build
```

The client lint and build steps are not decoration. An unimported stylesheet or
a broken import path passes every server test and still builds — that is
exactly how `App.css` went missing once already. The workflow also asserts that
`lib/richtext.js` exists in a clean checkout, since the client imports it from
outside the Vercel root directory.

## Git
- Repo: `https://github.com/TaigaRaider/busybody`
- Branch: `main`
- Fallback branch: `fallback` (original pre-Vercel code with better-sqlite3)

## Historical Context
- Migrated from Render (failed) to Vercel + Turso
- Switched DB from `better-sqlite3` to `@libsql/client` (Turso)
- 2026-07-29: Replaced 12-color palette grid with native color wheel (`<input type="color">`). Added `GET /colors` endpoint for uniqueness enforcement. Color is claimed per-authorId — shown as "already claimed" if taken by another user. Clicking the color dot reopens the picker; old colors are freed automatically when no notes reference them with that authorId.
- 2026-07-30: Removed admin key password field. Replaced with unified search bar that filters notes live by title/body. Admin auth via sentinel prefix `!{adminKey}` — typing `!{key}` in the search bar triggers authentication, shows admin badge next to input. Any other text filters notes in real-time, stripping color markers for clean matching.
- 2026-10-03: Accounts, mentions, spaces and real authorization landed together:
  - Shared `lib/` extracted; `api/index.js` and `server/src/index.js` became thin wrappers over `createApp()` (they had drifted apart). Root deps aligned to express 5 / drizzle 1.0-rc to remove the version skew.
  - Real bearer-token auth replaced the spoofable `authorId`-as-token scheme.
  - `@mentions` stored in `note_mentions` with a personal mentions feed.
  - Private spaces with request-to-read / request-to-participate tiers.
  - Note deletion is now authorized server-side; the old `PUT /notes` (id in the
    body, no auth) is gone in favour of `PUT /notes/:id`.
  - `history` capped at 20 entries server-side.
  - Cursor pagination with a **Load more** button, replacing 5s full-table polling.
  - Bento layout persisted per (note, user) in `note_layouts` instead of being
    fragile client state.
  - `node:test` suite added; `drizzle.config.js` no longer imports the missing
    `dotenv` dependency.