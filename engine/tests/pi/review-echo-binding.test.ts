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
 *
 * Entries are built in the production envelope shape — the raw
 * `details.results` elements `pi/subagent-stop.ts` hands to
 * `parsePiSubagentResults` — never in the parser's own output shape.
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

const facts = (overrides: Partial<SpawnTaskFacts> = {}): SpawnTaskFacts => ({
  authority: agentRequestAuthority("run.review-echo-binding", {
    requestId: "req-1",
    contextDigest: DIGEST,
    role: "code-reviewer",
  }),
  runDirectory: "/run/dir",
  packageRoot: "/pkg",
  standalone: false,
  descriptor: "",
  instruction: REVIEWER_RESULT_INSTRUCTION,
  reviewer: null,
  panelViewPath: null,
  ...overrides,
});

/** The fresh extraction-only render, exactly as Pi's re-render composes it. */
const renderedTask = renderSpawnTaskText(facts());
/** The issued task: publication appends the Task binding after the render. */
const issuedTask = `${renderedTask}\nReview Task T1.`;

const reservation = Object.freeze({
  agentType: "code-reviewer",
  taskId: "T1",
  kind: "non-implementation" as const,
});
const retryReservation = Object.freeze({
  agentType: "code-reviewer",
  taskId: null,
  kind: "non-implementation" as const,
});

/** One `details.results` element in the exact shape production hands the parser. */
const result = (task: string): unknown =>
  ({ agent: "code-reviewer", task, exitCode: 0, messages: [] });

const canonical = canonicalSpawnTaskText(renderedTask, issuedTask);

describe("the Pi extraction-only canonical re-render keeps the echo binding", () => {
  it("keeps the issued task: the publication's binding suffix extends the fresh render", () => {
    expect(canonical).toEqual({ kind: "issued-kept", task: issuedTask });
  });

  it("the capture matcher accepts a reserved T1 slot whose echo carries the canonical task", () => {
    const missing = classifyMissingReservedResults([reservation], [result(canonical.task)], false);
    expect(missing.reviews).toEqual([]);
  });

  it("a parseable echo that dropped the binding line is rejected for exactly that reason", () => {
    // The drifted echo PARSES fine — the rejection is the binding semantics
    // (`extractTaskId` finds no Task-ID token in the fresh render), not an
    // envelope shape rejection.
    const missing = classifyMissingReservedResults([reservation], [result(renderedTask)], false);
    expect(missing.reviews).toHaveLength(1);
    expect(missing.reviews[0]?.index).toBe(0);
  });

  it("the fresh-render fallback matches an attempt-2-shaped reservation (no Task binding)", () => {
    // The tolerance the canonicalSpawnTaskText comment asserts, proved: the
    // attempt-2 retry reservation derives no Task binding from its task text,
    // so the fallback render's null extraction still matches.
    const missing = classifyMissingReservedResults([retryReservation], [result(renderedTask)], false);
    expect(missing.reviews).toEqual([]);
  });

  it("the standalone route keeps its marker and binding through the same composition", () => {
    const standaloneRendered = renderSpawnTaskText(facts({ standalone: true }));
    const standaloneIssued = `${standaloneRendered}\nReview Task T1.`;
    const standaloneCanonical = canonicalSpawnTaskText(standaloneRendered, standaloneIssued);
    expect(standaloneCanonical).toEqual({ kind: "issued-kept", task: standaloneIssued });
    const missing = classifyMissingReservedResults([reservation], [result(standaloneCanonical.task)], false);
    expect(missing.reviews).toEqual([]);
  });
});
