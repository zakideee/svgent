/**
 * Semantic actions carried by scene nodes into rendered SVG metadata.
 *
 * The scene itself remains inert: consumers such as the studio may interpret
 * these attributes, while exported SVG keeps rendering deterministically.
 */
export type SceneAction =
  | "compose-user"
  | "select-choice"
  | "write-choice"
  | "approve"
  | "approve-always"
  | "deny"
  | "replace-image";

export function sceneActionMeta(
  action: SceneAction,
  options: { messageId?: string; optionIndex?: number; imageIndex?: number } = {},
): Record<string, string> {
  return {
    action,
    ...(options.messageId === undefined ? {} : { "message-id": options.messageId }),
    ...(options.optionIndex === undefined ? {} : { "option-index": String(options.optionIndex) }),
    ...(options.imageIndex === undefined ? {} : { "image-index": String(options.imageIndex) }),
  };
}
