/**
 * The canonical `AgentRequestAuthority` fixture.
 *
 * `orchestration-acceptance.test.ts` and `publication-faults.test.ts` each
 * declared a near-identical builder, differing only in the default run id and in
 * whether `overrides` was typed. Both are describing the SAME contract shape, so
 * a field added to the real type has to reach both to keep either honest.
 */

import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";

export function agentRequestAuthority(
  runId: string,
  overrides: Record<string, unknown> = {},
): AgentRequestAuthority {
  return {
    runId,
    requestId: "request:reviewer:1",
    slotId: "slot-1",
    program: "wave-gate",
    role: "code-reviewer",
    attempt: 1,
    modelProfile: "general-review",
    harnessBinding: {
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      claude: { harness: "claude-code", model: "sonnet" },
    },
    requiredSkill: null,
    contextDigest: "a".repeat(64),
    outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-1.raw" },
    ...overrides,
  } as AgentRequestAuthority;
}
