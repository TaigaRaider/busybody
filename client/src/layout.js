/**
 * The one place the mobile breakpoint is defined for JavaScript.
 *
 * App.css has a matching `@media (width <= 760px)` block. The mobile chrome
 * (bottom bar, nav drawer, collapsed composer) is React-driven while the layout
 * around it is CSS-driven, so the two have to agree on where the line falls. The
 * comment on the media query in App.css points back here.
 */
export const MOBILE_MAX = 760;

export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX}px)`;