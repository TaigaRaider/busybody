import { useCallback, useSyncExternalStore } from "react";

/**
 * Reactive `window.matchMedia`.
 *
 * Needed because the mobile chrome is React state (a drawer, a collapsed
 * composer, a bottom bar) that has to appear at exactly the same width the CSS
 * switches layout at. Deciding "is this a phone" in CSS alone would mean two
 * sources of truth, and they would eventually disagree — the classic result
 * being a bottom bar rendered underneath a desktop sidebar.
 *
 * `useSyncExternalStore` rather than useState + useEffect: the media query list
 * is an external store, and this is the hook built for subscribing to one. The
 * obvious useState version has to call setState inside the effect body to
 * re-read the query, which is the cascading-render pattern React warns against,
 * and it can still render one frame of the wrong layout on a resize.
 */
export default function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      const list = window.matchMedia(query);
      // addEventListener is the modern API; older Safari only has addListener,
      // so fall back rather than silently never updating.
      if (list.addEventListener) {
        list.addEventListener("change", onChange);
        return () => list.removeEventListener("change", onChange);
      }
      list.addListener(onChange);
      return () => list.removeListener(onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  // Server snapshot reports "not mobile", so a non-browser render never produces
  // chrome that only works on a phone.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}