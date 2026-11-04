/**
 * Shared joins between an inspected IR tree and the engine's bbox facts.
 *
 * An IR label can repeat across occurrences, so a node is paired with its
 * bbox through the inspection's source index rather than by `nodeId`.
 */

import type { InspectionBBox, IRNode, SceneInspection } from "@boundsvg/core";

/** The metadata a source node carries; content, decoration and wrapper nodes carry none. */
export function sourceMeta(node: IRNode): Readonly<Record<string, string>> | undefined {
  return node.ownership.role === "source" ? node.ownership.meta : undefined;
}

/** Each IR node's bbox for this snapshot. Clip wrappers have none. */
export function bboxesByNode(inspection: SceneInspection): ReadonlyMap<IRNode, InspectionBBox> {
  const byNode = new Map<IRNode, InspectionBBox>();
  for (const bbox of inspection.bboxes) {
    const occurrence = inspection.sourceIndex.nodes.get(bbox.nodeIndex);
    if (!occurrence) {
      throw new Error(`inspection has no occurrence for node index ${bbox.nodeIndex}`);
    }
    byNode.set(occurrence.node, bbox);
  }
  return byNode;
}
