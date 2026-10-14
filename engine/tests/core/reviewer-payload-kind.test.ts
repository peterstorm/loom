/**
 * Every current v2 reviewer is told the exact payload kind its slot admits.
 * The issued schema admits both arms and the shared wire contract's example is
 * standalone, so four G1-pilot Wave reviewers emitted `standalone-review` and
 * were refused and retried.
 */
import { describe, expect, it } from "vitest";
import { renderSpawnTaskText, reviewerPayloadKindLine, type SpawnTaskFacts } from "../../src/core/spawn-task-text";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

const DIGEST = "c".repeat(64);

const facts = (standalone: boolean, reviewer: SpawnTaskFacts["reviewer"]): SpawnTaskFacts => ({
  authority: agentRequestAuthority("run.reviewer-kind", {
    requestId: "req-1", contextDigest: DIGEST, program: standalone ? "standalone-review" : "wave-gate",
  }),
  runDirectory: "/run/dir",
  packageRoot: "/pkg",
  standalone,
  descriptor: "",
  instruction: "Complete the request.",
  reviewer,
  panelViewPath: null,
});

describe("reviewer payload kind", () => {
  it("tells a Wave reviewer to emit wave-review and refuses the standalone kind", () => {
    const text = renderSpawnTaskText(facts(false, { version: 2, readObligation: null }));
    expect(text).toContain(reviewerPayloadKindLine(false));
    expect(reviewerPayloadKindLine(false)).toContain('"kind" is "wave-review"');
    expect(reviewerPayloadKindLine(false)).toContain('"packetId" and "generation"');
  });

  it("tells a standalone reviewer to emit standalone-review", () => {
    const text = renderSpawnTaskText(facts(true, { version: 2, readObligation: null }));
    expect(text).toContain('Your payload\'s "kind" is "standalone-review".');
    expect(text).not.toContain('"wave-review"');
  });

  it("leaves archived v1 and successor v3 deliveries, and non-reviewers, untouched", () => {
    for (const reviewer of [{ version: 1 as const, rolePath: "/a.md", wirePath: "/w.md" }, { version: 3 as const }, null]) {
      for (const standalone of [true, false]) {
        expect(renderSpawnTaskText(facts(standalone, reviewer))).not.toContain("Your payload's \"kind\"");
      }
    }
  });
});
