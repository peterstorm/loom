/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { AGENT_POLICIES, type ClaudeCodeBinding, type LoomAgentName, type PiBinding } from '../model-profiles';
import { parseReviewPath } from '../review-packet';
import { canonicalRecord, failure, success, type DomainResult } from './identity';
import { readExactDataRecord } from './bytes';


export type FixedArtifactSlot = Readonly<{
  kind: "fixed-artifact-slot";
  path: string;
}>;

export type FixedArtifactSlotError = Readonly<{
  kind: "invalid-fixed-artifact-slot";
  message: string;
}>;

export function parseFixedArtifactSlot(raw: unknown): DomainResult<FixedArtifactSlot, FixedArtifactSlotError> {
  let path: unknown = raw;
  if (typeof raw !== "string") {
    const record = readExactDataRecord(raw, ["kind", "path"], "fixed artifact slot");
    if (!record.ok) {
      return failure(canonicalRecord({ kind: "invalid-fixed-artifact-slot", message: record.error.message }));
    }
    path = record.value.kind === "fixed-artifact-slot" ? record.value.path : undefined;
  }
  const parsed = parseReviewPath(path, "fixed artifact slot path");
  return parsed.ok
    ? success(canonicalRecord({ kind: "fixed-artifact-slot", path: parsed.value }))
    : failure(canonicalRecord({ kind: "invalid-fixed-artifact-slot", message: parsed.errors.join("; ") }));
}

export const ORCHESTRATION_PROGRAMS = Object.freeze([
  "architecture-panel",
  "refutation-panel",
  "wave-gate",
  "standalone-review",
] as const);
export type OrchestrationProgram = (typeof ORCHESTRATION_PROGRAMS)[number];

export type ExactHarnessBinding = Readonly<{
  pi: PiBinding;
  claude: ClaudeCodeBinding;
}>;

/** Derived projection of the Agent Catalog (core/model-profiles.ts) — the
 *  catalog is the single source for each role's required Skill; this record
 *  only fixes the export shape the orchestration contract has always had. */
export const AGENT_REQUIRED_SKILLS = canonicalRecord(
  Object.fromEntries(
    AGENT_POLICIES.map(({ agent, requiredSkill }) => [agent, requiredSkill]),
  ) as Record<LoomAgentName, string | null>,
);
