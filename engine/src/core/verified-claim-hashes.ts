/**
 * Re-anchoring Requirement Content Hashes when a Wave Gate completes.
 *
 * A claim's recorded hash is minted when its edge is created (population or
 * amendment), so it names the text at claim time. A Wave that passes after the
 * text changed was verified against the new text, and keeping the claim-time
 * hash would report drift on a Requirement that was in fact verified. Completion
 * therefore records the hashes of the exact bytes spec-check reviewed, and from
 * then on the hash means "the text this claim was last verified against". That
 * is what lets a later Wave's projection report a Requirement rewritten after
 * its Wave passed.
 *
 * Pure: the shell supplies the Spec Index it observed; this module proves that
 * the index came from the bytes the Wave review epoch recorded before using it.
 */

import type { TaskGraph, WaveSpecCheckDocumentsAuthority } from "../types";
import { recordedAnchorHashes, type SpecIndexAvailability } from "./requirement-coverage";

/**
 * The completed graph with every `wave` Task's claim hashes set to the reviewed
 * text, or the same graph when nothing proves what was reviewed: no epoch
 * documents, no Spec Index, or an index parsed from other bytes or another
 * path. A claim the reviewed index does not define keeps its recorded hash,
 * since there is no verified text to record for it.
 */
export function reanchorVerifiedClaims(
  graph: TaskGraph,
  wave: number,
  reviewed: WaveSpecCheckDocumentsAuthority | undefined,
  specIndex: SpecIndexAvailability,
): TaskGraph {
  if (reviewed === undefined || specIndex.kind !== "indexed" ||
      specIndex.path !== reviewed.spec.path || specIndex.contentDigest !== reviewed.spec.contentDigest) {
    return graph;
  }
  const tasks = graph.tasks.map((task) => {
    const anchors = task.spec_anchors ?? [];
    if (task.wave !== wave || anchors.length === 0) return task;
    const recorded = task.spec_anchor_hashes ?? {};
    const hashes = { ...recorded, ...recordedAnchorHashes(specIndex.index, anchors) };
    const same = Object.keys(hashes).length === Object.keys(recorded).length &&
      Object.entries(hashes).every(([claim, hash]) => recorded[claim] === hash);
    return same ? task : { ...task, spec_anchor_hashes: Object.freeze(hashes) };
  });
  return tasks.every((task, at) => task === graph.tasks[at]) ? graph : { ...graph, tasks };
}
