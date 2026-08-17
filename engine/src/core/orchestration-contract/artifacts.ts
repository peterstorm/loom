/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { type ClaudeCodeBinding, type LoomAgentName, type PiBinding } from '../model-profiles';
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

export const ORCHESTRATION_PROGRAMS = [
  "architecture-panel",
  "refutation-panel",
  "wave-gate",
  "standalone-review",
] as const;
export type OrchestrationProgram = (typeof ORCHESTRATION_PROGRAMS)[number];

export type ExactHarnessBinding = Readonly<{
  pi: PiBinding;
  claude: ClaudeCodeBinding;
}>;

export const AGENT_REQUIRED_SKILLS = canonicalRecord({
  "adr-writer-agent": null,
  "arch-designer-agent": "architecture-tech-lead",
  "arch-interviewer-agent": null,
  "architecture-agent": "architecture-tech-lead",
  "architecture-tech-lead": null,
  "arch-judge-agent": null,
  "brainstorm-agent": "brainstorming",
  "clarify-agent": "clarify",
  "code-implementer-agent": "code-implementer",
  "code-reviewer": null,
  "code-simplifier": "distill",
  "comment-analyzer": null,
  "decompose-agent": null,
  "deepen-agent": "deepen",
  "frontend-agent": "nextjs-frontend-design",
  "grill-agent": "grill",
  "java-test-agent": "java-test-engineer",
  "plan-alignment-agent": null,
  "pr-test-analyzer": null,
  "review-verifier-agent": null,
  "security-agent": "security-expert",
  "silent-failure-hunter": null,
  "skill-content-reviewer": null,
  "spec-check-invoker": "spec-check",
  "specify-agent": "specify",
  "test-engineer": null,
  "ts-test-agent": "ts-test-engineer",
  "type-design-analyzer": null,
} satisfies Readonly<Record<LoomAgentName, string | null>>);
