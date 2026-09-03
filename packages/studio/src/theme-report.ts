/**
 * The theme a studio hands to the page it sits on.
 *
 * The studio's own shell takes the theme as an attribute in the render that
 * changes it. A host that paints the page to match — which is what an embedded
 * studio's surroundings usually want — hears about it through a callback, and
 * when that callback is a passive effect the page is repainted a frame behind
 * the studio: on first mount the studio comes up in its theme over a page still
 * in whatever it had.
 *
 * So the host is told before paint. That makes the callback part of the
 * studio's commit, which is a real cost to impose on whoever writes it, and the
 * public type says so.
 */

import { useEffectEvent, useLayoutEffect } from "react";

/**
 * Calls `onChange` with the theme on mount and on every change to it, before
 * the browser paints either.
 *
 * The theme is passed rather than closed over: it is what the effect fires on,
 * and an event that reads it invisibly leaves the dependency looking spurious.
 */
export function useReportedTheme<T>(theme: T, onChange: ((theme: T) => void) | undefined): void {
  const report = useEffectEvent((current: T) => onChange?.(current));
  useLayoutEffect(() => {
    report(theme);
  }, [theme]);
}
