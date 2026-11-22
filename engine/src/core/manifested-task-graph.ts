/**
 * The TaskGraph a Wave Gate reads: one whose Verification Manifest is frozen.
 *
 * `TaskGraph.verification_manifest` stays optional because every Phase before
 * `execute` legitimately carries none: population freezes it in the write that
 * enters `execute`, and the loader refuses an execute-phase graph without it
 * (ADR-0098). The Wave Gate seams parse a graph into this type once, so the
 * readiness projection, the gate check and the completion suite never
 * represent a manifest-less graph. Pure module: no I/O.
 */

import type { TaskGraph } from "../types";
import type { DomainResult } from "./orchestration-contract";
import type { FrozenVerificationManifest } from "./verification-manifest";

export type ManifestedTaskGraph = TaskGraph & Readonly<{ verification_manifest: FrozenVerificationManifest }>;

/** The refusal every Wave Gate seam reports for a graph with no frozen manifest. */
export const MANIFEST_ABSENT_REFUSAL =
  "the TaskGraph carries no frozen verification_manifest: population freezes it on entering execute, " +
  "and no Wave Gate runs before that (ADR-0098)";

const carriesManifest = <G extends TaskGraph>(graph: G): graph is G & ManifestedTaskGraph =>
  graph.verification_manifest !== undefined;

/** `graph` itself, proven to carry its frozen Verification Manifest. */
export function parseManifestedTaskGraph<G extends TaskGraph>(graph: G): DomainResult<G & ManifestedTaskGraph, string> {
  return carriesManifest(graph)
    ? Object.freeze({ ok: true, value: graph })
    : Object.freeze({ ok: false, error: MANIFEST_ABSENT_REFUSAL });
}
