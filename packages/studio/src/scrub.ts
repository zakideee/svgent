import type { SessionMessage } from "@svgent/scene";

type ScrubInsertionAnchor = {
  afterMessageId: string | null;
  beforeMessageId: string | null;
};

/**
 * Insert a user turn at the scrub playhead without losing a manual slide
 * boundary. Inserting before the first message of a slide transfers that
 * boundary to the new message so it stays on the page the user was viewing.
 */
export function insertAtScrubAnchor(
  source: readonly SessionMessage[],
  inserted: SessionMessage,
  anchor: ScrubInsertionAnchor,
): SessionMessage[] {
  const messages = [...source];
  const afterIndex =
    anchor.afterMessageId === null
      ? -1
      : messages.findIndex((message) => message.id === anchor.afterMessageId);
  const beforeIndex =
    anchor.beforeMessageId === null
      ? -1
      : messages.findIndex((message) => message.id === anchor.beforeMessageId);
  const insertionIndex =
    afterIndex >= 0 ? afterIndex + 1 : beforeIndex >= 0 ? beforeIndex : messages.length;
  const before = messages[insertionIndex];
  let message = inserted;
  if (before?.pageBreakBefore) {
    message = { ...inserted, pageBreakBefore: true };
    // Clear, not false: an explicit false now joins pages, and this spot
    // should simply fall back to the automatic count.
    const { pageBreakBefore: _cleared, ...rest } = before;
    messages[insertionIndex] = rest;
  }
  messages.splice(insertionIndex, 0, message);
  return messages;
}
