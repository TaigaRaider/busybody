/**
 * Shared note-body parser.
 *
 * A body is plain text interleaved with two markups:
 *   - colour spans: `{% #e06c75 %}text{% end %}`
 *   - user tags:    `@handle`
 *
 * Used by the client to render and to re-tag on edit. Lives in `lib/` so the
 * server, the client and the test suite all agree on the syntax.
 */

const COLOR_TAG_RE = /\{%\s*([^%]+?)\s*%\}([\s\S]*?)\{%\s*end\s*%\}/g;

const UNTAGGED_COLOR = "var(--gray-400)";
const MENTION_RE = /(^|[^\w@/])(@[a-z0-9][a-z0-9._-]{1,30})/gi;

/**
 * Split a stored body into flat colour segments. Untagged text (including the
 * tail after the last `{% end %}`) is returned with the neutral colour.
 * @param {string} body
 * @returns {{text: string, color: string}[]}
 */
export function parseColorSegments(body) {
  if (!body) return [];
  const parts = [];
  const re = new RegExp(COLOR_TAG_RE.source, "g");
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last)
      parts.push({ text: body.slice(last, m.index), color: UNTAGGED_COLOR });
    parts.push({ text: m[2], color: m[1].trim() });
    last = re.lastIndex;
  }
  if (last < body.length)
    parts.push({ text: body.slice(last), color: UNTAGGED_COLOR });
  return parts;
}

/**
 * Flatten a body into renderable runs, splitting colour spans *and* tagging
 * `@handle` runs so the UI can highlight them.
 *
 * @param {string} body
 * @param {Record<number, {handle: string, color: string}>} [mentions]
 *        resolved mentions keyed by lowercase handle, used to colour the tag
 * @returns {{type: 'text'|'mention', text: string, color: string, handle?: string, userId?: number}[]}
 */
export function renderRuns(body, mentions = {}) {
  const runs = [];
  for (const seg of parseColorSegments(body)) {
    let cursor = 0;
    const re = new RegExp(MENTION_RE.source, "gi");
    let m;
    while ((m = re.exec(seg.text)) !== null) {
      const lead = m[1] || "";
      const at = m.index + lead.length;
      if (at > cursor)
        runs.push({ type: "text", text: seg.text.slice(cursor, at), color: seg.color });
      const handle = m[2].slice(1).toLowerCase();
      const known = mentions[handle];
      runs.push({
        type: "mention",
        text: m[2],
        color: known?.color || seg.color,
        handle,
        userId: known?.id,
      });
      cursor = m.index + m[0].length;
    }
    if (cursor < seg.text.length)
      runs.push({ type: "text", text: seg.text.slice(cursor), color: seg.color });
  }
  return runs;
}

/**
 * Re-apply colour markup after the user edited the plain text in the composer.
 *
 * Walks the original segments and the edited string together: text that still
 * lines up keeps its original author's colour, anything newly typed is chalked
 * in `userColor`. `@handle` tags are ordinary characters here and pass through
 * untouched; they are re-indexed into `note_mentions` on save.
 *
 * @param {string} edited   the edited plain text (markup stripped)
 * @param {{text: string, color: string}[]} segments  segments from parseColorSegments
 * @param {string} userColor
 */
export function rebuildColorBody(edited, segments, userColor) {
  if (!edited) return "";
  const out = [];
  let pos = 0;
  let si = 0;
  while (pos < edited.length) {
    const seg = segments[si];
    if (!seg || seg.text.length === 0) {
      out.push(`{% ${userColor} %}${edited.slice(pos)}{% end %}`);
      pos = edited.length;
    } else if (edited.slice(pos, pos + seg.text.length) === seg.text) {
      out.push(`{% ${seg.color} %}${seg.text}{% end %}`);
      pos += seg.text.length;
      si += 1;
    } else {
      const idx = edited.indexOf(seg.text, pos);
      if (idx > pos) {
        out.push(`{% ${userColor} %}${edited.slice(pos, idx)}{% end %}`);
        pos = idx;
      } else if (idx === pos) {
        out.push(`{% ${seg.color} %}${seg.text}{% end %}`);
        pos += seg.text.length;
        si += 1;
      } else {
        si += 1;
      }
    }
  }
  return out.join("");
}

/** Strip all colour markup; tags (`@handle`) are kept as-is. */
export function stripMarkup(body) {
  if (!body) return "";
  return body
    .replace(/\{%\s*[^%]*?\s*%\}/g, "")
    .replace(/\{%\s*end\s*%\}/g, "");
}
