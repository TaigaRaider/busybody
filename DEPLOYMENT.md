# Deployment Summary

## Architecture
- **Frontend**: Vite/React SPA deployed on Vercel
- **Backend**: Express serverless function on Vercel (`api/index.js`)
- **Database**: Turso (libsql) — serverless SQLite

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
| Key | Value |
|-----|-------|
| `TURSO_DATABASE_URL` | `libsql://tabloid-taigaraider.aws-us-east-2.turso.io` |
| `TURSO_AUTH_TOKEN` | Read-write token (see below) |
| `CORS_ORIGIN` | `https://thetabloid.vercel.app` |

### Frontend (busybody)
| Key | Value |
|-----|-------|
| `VITE_API_URL` | `https://tabloid-api.vercel.app` |

## Feature Highlights
- **Color wheel picker**: Native `<input type="color">` on first visit — pick any color, not just presets
- **Unique chalk enforcement**: `GET /colors` returns taken colors (excluding own authorId). If a color is already claimed by someone else, the app shows "already claimed" and blocks confirmation
- **Re-pick anytime**: Click your color dot in the header to re-open the picker. Old color is freed when you pick a new one
- **Unified search bar**: Replaces the old admin key field. Filters notes live by title/body (color tags stripped). Type `!{key}` (sentinel `!` + `{adminKey}`) to authenticate as admin — admin badge appears next to search bar, click to logout

## Turso Database
- URL: `libsql://tabloid-taigaraider.aws-us-east-2.turso.io`
- Token: `eyJxxx...`
- Table: `notes` (id INTEGER PK AUTOINCREMENT, title TEXT, body TEXT, created_at TEXT, updated_at TEXT, author_color TEXT, author_id TEXT, editor_color TEXT, history TEXT)

## Key Files

### `api/index.js` — Vercel serverless entry point
- Contains the full Express app (cors, JSON body parser, Turso client, all CRUD routes)
- No imports from `server/` directory (self-contained for Vercel Lambda bundling)
- Export: `export default app`

### `vercel.json` — Vercel config
```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }],
  "functions": {
    "api/index.js": { "maxDuration": 10 }
  }
}
```
- Rewrites all requests to `/api` → invokes `api/index.js`

### `package.json` (root) — Dependencies for Vercel build
- `"type": "module"` for ESM
- Deps: express@^4.21.2, cors@^2.8.5, @libsql/client@^0.14.0, drizzle-orm@^0.38.0

### `client/src/api.js` — Frontend API client
- Base URL from `VITE_API_URL` env var, fallback `http://localhost:8080`
- Exports: `fetchNotes`, `createNote`, `updateNote`, `deleteNote`, `rollbackNote`, `fetchColors`

## API Endpoints
| Method | Path | Status | Description |
|--------|------|--------|-------------|
| GET | `/ping` | 200 | Health check |
| GET | `/colors` | 200 | List taken author colors (excludes own authorId) |
| GET | `/notes` | 200 | List all notes |
| POST | `/notes` | 201 | Create note `{ title, body, color, authorId }` |
| PUT | `/notes` | 200 | Update note `{ id, title, body }` |
| DELETE | `/notes/:id` | 204 | Delete note (auth via authorId or ADMIN_TOKEN) |
| PUT | `/notes/:id/rollback` | 200 | Rollback to last history entry |

## Git
- Repo: `https://github.com/TaigaRaider/busybody`
- Branch: `main`
- Fallback branch: `fallback` (original pre-Vercel code with better-sqlite3)

## Historical Context
- Migrated from Render (failed) to Vercel + Turso
- Switched DB from `better-sqlite3` to `@libsql/client` (Turso)
- Original Express server at `server/src/index.js` (kept for local dev)
- `server/drizzle.config.js` — drizzle-kit config (used for schema pushes)
- `server/src/db/schema.js` — drizzle schema definition
- 2026-07-29: Replaced 12-color palette grid with native color wheel (`<input type="color">`). Added `GET /colors` endpoint for uniqueness enforcement. Color is claimed per-authorId — shown as "already claimed" if taken by another user. Clicking the color dot reopens the picker; old colors are freed automatically when no notes reference them with that authorId.
- 2026-07-30: Removed admin key password field. Replaced with unified search bar that filters notes live by title/body. Admin auth via sentinel prefix `!{adminKey}` — typing `!{key}` in the search bar triggers authentication, shows admin badge next to input. Any other text filters notes in real-time, stripping color markers for clean matching.
