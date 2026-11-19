/**
 * The reviewer echo-binding contract: the canonical task a Pi extraction-only
 * child is dispatched with must still carry the Task binding the wave
 * publication appends after the rendered task, because the capture matcher
 * re-derives that binding from the child's echoed task (pi/reserved-results.ts,
 * `classifyMissingReservedResults`). A canonical re-render that dropped the
 * binding line — here the wording drift that erased it — terminally rejects
 * every attempt-1 reviewer capture and forces a whole attempt-2 round
 * (fugue-dags wave-gate, 2026-11-18): the matcher's diagnostic names the slot
 * "missing or mismatched" although the child ran to exit 0.
 */
import { describe, expect, it } from "vitest";
import { classifyMissingReservedResults } from "../../../pi/reserved-results";
import {
  canonicalSpawnTaskText,
  renderSpawnTaskText,
  REVIEWER_RESULT_INSTRUCTION,
  type SpawnTaskFacts,
} from "../../src/core/spawn-task-text";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

const DIGEST = "c".repeat(64);

const facts = (instruction: string): SpawnTaskFacts => ({
  authority: agentRequestAuthority("run.review-echo-binding", {
    requestId: "req-1",
    contextDigest: DIGEST,
    role: "code-reviewer",
  }),
  runDirectory: "/run/dir",
  packageRoot: "/pkg",
  standalone: false,
  descriptor: "",
  instruction,
  reviewer: null,
  panelViewPath: null,
});

/** The fresh extraction-only render, exactly as Pi's re-render composes it. */
const renderedTask = renderSpawnTaskText(facts(REVIEWER_RESULT_INSTRUCTION));
/** The issued task: publication appends the Task binding after the render. */
const issuedTask = `${renderedTask}\nReview Task T1.`;

const reservation = Object.freeze({
  agentType: "code-reviewer",
  taskId: "T1",
  kind: "non-implementation" as const,
});
const batchWith = (task: string): readonly unknown[] => [
  Object.freeze({ ok: true, result: Object.freeze({ agent: "code-reviewer", task, exitCode: 0, messages: [] }) }),
];

describe("the Pi extraction-only canonical re-render keeps the echo binding", () => {
  it("the canonical task equals the issued task byte-for-byte", () => {
    expect(canonicalSpawnTaskText(renderedTask, issuedTask)).toBe(issuedTask);
  });

  it("the capture matcher accepts a reserved T1 slot whose echo carries the canonical task", () => {
    const canonical = canonicalSpawnTaskText(renderedTask, issuedTask);
    const missing = classifyMissingReservedResults([reservation], batchWith(canonical), false);
    expect(missing.reviews).toEqual([]);
  });

  it("a canonical task that drops the binding line is exactly the rejection the matcher reports", () => {
    const drifted = renderSpawnTaskText(facts(
      "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required result.",
    ));
    const missing = classifyMissingReservedResults([reservation], batchWith(drifted), false);
    expect(missing.reviews).toHaveLength(1);
    expect(missing.reviews[0]?.index).toBe(0);
  });
});
