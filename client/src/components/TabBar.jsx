/**
 * The mobile bottom bar. Rendered only below the `MOBILE_MAX` breakpoint — see
 * `layout.js` for why that value is shared with the CSS.
 *
 * Everything here used to live in the sidebar, which on a phone meant the whole
 * interface scrolled in a column above the notes before you saw a single one.
 * Moving navigation to a fixed bar means the board is the first thing on screen
 * and the controls are reachable with a thumb.
 *
 * Labels are spelled out rather than left to glyphs alone: the bar is the only
 * navigation a touch user has, and a row of three ambiguous icons is not
 * self-explanatory. The glyphs are decorative reinforcement.
 */
export default function TabBar({
  onOpenSpaces,
  onPost,
  onOpenMentions,
  mentionCount,
  canPost,
}) {
  return (
    <nav className="tabbar" aria-label="Main">
      <button type="button" className="tab" onClick={onOpenSpaces}>
        <span className="tab-glyph" aria-hidden="true">
          &#9776;
        </span>
        <span className="tab-label">Spaces</span>
      </button>

      {canPost ? (
        <button type="button" className="tab tab-primary" onClick={onPost}>
          <span className="tab-glyph" aria-hidden="true">
            +
          </span>
          <span className="tab-label">Post</span>
        </button>
      ) : (
        // Keeps Mentions on the right instead of drifting to the centre when
        // this user has read-only access to the current space.
        <span className="tab-spacer" aria-hidden="true" />
      )}

      <button type="button" className="tab" onClick={onOpenMentions}>
        <span className="tab-glyph" aria-hidden="true">
          @
        </span>
        <span className="tab-label">Mentions</span>
        {mentionCount > 0 && (
          <span className="tab-badge">
            {mentionCount > 9 ? "9+" : mentionCount}
            <span className="sr-only"> unread mentions</span>
          </span>
        )}
      </button>
    </nav>
  );
}