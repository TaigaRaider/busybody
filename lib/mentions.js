/**
 * @handle tag extraction.
 *
 * Note bodies interleave two independent markups:
 *   - colour spans:  `{% #e06c75 %}text{% end %}`
 *   - user tags:     `@handle`
 *
 * Both live in the same `body` string so tags survive edits and render inline.
 * This module is the single parser for the tag syntax and is used by the
 * server (to persist `note_mentions`) and mirrored by `client/src/richText.js`
 * for rendering.
 */

export const HANDLE_RE = /@([a-z0-9][a-z0-9._-]{1,30})/gi;

export const HANDLE_SHAPE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
export const COLOR_SHAPE = /^#[0-9a-f]{6}$/;

/** Leading `@` must not be preceded by a word char (avoids matching emails). */
const SAFE_HANDLE_RE = /(^|[^\w@/])@([a-z0-9][a-z0-9._-]{1,30})/gi;

/**
 * @param {string} body
 * @returns {string[]} lowercased handles, de-duplicated, in first-seen order
 */
export function extractHandles(body) {
  if (!body || !body.includes("@")) return [];
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(SAFE_HANDLE_RE)) {
    const handle = m[2].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

export function normalizeHandle(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

export function isValidHandle(handle) {
  return HANDLE_SHAPE.test(handle);
}

export function normalizeColor(raw) {
  const c = String(raw || "").trim().toLowerCase();
  return COLOR_SHAPE.test(c) ? c : null;
}

/**
 * Strip colour markup and tags so a body can be matched against a search query.
 * @param {string} body
 */
export function toPlainText(body) {
  if (!body) return "";
  return body
    .replace(/\{%\s*[^%]*?\s*%\}/g, "")
    .replace(/\{%\s*end\s*%\}/g, "")
    .trim();
}
