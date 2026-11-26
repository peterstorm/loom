/**
 * The one composition of an issued request's task text.
 *
 * `issuedRequestInstruction` replaced five call-site instruction literals, and
 * `taskBindingLine` replaced the Task/Wave suffix the Wave publication appended
 * by hand. Both are now functions of the request authority (and its durable
 * context), so the tests here are about totality and about the two facts a
 * reviewer's capture depends on: the instruction it is told to follow, and the
 * Task/Wave binding the capture matcher re-derives from its echoed task.
 */
import { describe, expect, it } from "vitest";
import {
  issuedRequestInstruction,
  taskBindingLine,
  withTaskBinding,
  type IssuedTaskBinding,
} from "../../src/core/issued-request-task";
import { REVIEWER_RESULT_INSTRUCTION } from "../../src/core/spawn-task-text";
import { VERIFICATION_RESULT_KIND } from "../../src/core/security-verification";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

const DIGEST = "d".repeat(64);
const authority = (overrides: Parameters<typeof agentRequestAuthority>[1] = {}) =>
  agentRequestAuthority("run.issued-request-task", { contextDigest: DIGEST, ...overrides });

describe("issuedRequestInstruction", () => {
  it("gives an attempt-1 Wave reviewer and an attempt-1 standalone reviewer the same instruction", () => {
    // The two used to differ by code path alone ("complete the exact Wave review
    // request" vs "emit only the required reviewer result"), which is what made
    // a re-emitted request's text differ from its first emission.
    expect(issuedRequestInstruction(authority({ program: "wave-gate", role: "code-reviewer", attempt: 1 })))
      .toBe(REVIEWER_RESULT_INSTRUCTION);
    expect(issuedRequestInstruction(authority({ program: "standalone-review", role: "code-reviewer", attempt: 1 })))
      .toBe(REVIEWER_RESULT_INSTRUCTION);
  });

  it("names the slot a Wave attempt-2 request retries, by role", () => {
    expect(issuedRequestInstruction(authority({ program: "wave-gate", role: "code-reviewer", attempt: 2 })))
      .toContain("retry the exact current Wave Review Packet slot");
    expect(issuedRequestInstruction(authority({ program: "wave-gate", role: "spec-check-invoker", attempt: 2 })))
      .toContain("retry the exact current Wave spec-check slot");
    expect(issuedRequestInstruction(authority({ program: "wave-gate", role: "spec-check-invoker", attempt: 2 })))
      .not.toContain("Wave Review Packet slot");
  });

  it("keeps the program-specific instructions of the Refutation Panel and the security verifier", () => {
    expect(issuedRequestInstruction(authority({ program: "refutation-panel", role: "review-verifier-agent" })))
      .toContain("complete the exact pending Refutation Panel request");
    expect(issuedRequestInstruction(authority({ program: "security-verification", role: "review-verifier-agent" })))
      .toContain(VERIFICATION_RESULT_KIND);
  });

  it("is defined for every program, role and attempt the authority can name", () => {
    const programs = ["architecture-panel", "refutation-panel", "wave-gate", "standalone-review", "security-verification"] as const;
    const roles = ["code-reviewer", "spec-check-invoker", "review-verifier-agent"] as const;
    for (const program of programs) {
      for (const role of roles) {
        for (const attempt of [1, 2] as const) {
          const instruction = issuedRequestInstruction(authority({ program, role, attempt }));
          expect(instruction.length, `${program}/${role}/${attempt}`).toBeGreaterThan(0);
          expect(instruction, `${program}/${role}/${attempt}`).toContain("LOOM_CONTEXT");
        }
      }
    }
  });
});

describe("taskBindingLine", () => {
  it("writes no line for a request that reviews a scope rather than a bound subject", () => {
    expect(taskBindingLine({ kind: "none" })).toBe("");
  });

  it("writes the Task the reviewer must name back, on its own trailing line", () => {
    const line = taskBindingLine({ kind: "task", taskId: "T1" });
    expect(line).toBe("\nReview Task T1.");
    expect(line.trimEnd().split("\n")).toHaveLength(2);
  });

  it("writes the Wave a spec-check verifies, never a Task line", () => {
    expect(taskBindingLine({ kind: "spec-check", wave: 3 })).toBe("\nSpec-check Wave 3.");
    expect(taskBindingLine({ kind: "spec-check", wave: 3 })).not.toContain("Review Task");
  });

  it("starts every binding with exactly one newline, so the render is never joined onto it", () => {
    const bindings: readonly IssuedTaskBinding[] = [
      { kind: "none" }, { kind: "task", taskId: "T7" }, { kind: "spec-check", wave: 12 },
    ];
    for (const binding of bindings) {
      const line = taskBindingLine(binding);
      if (line === "") continue;
      expect(line.startsWith("\n"), JSON.stringify(binding)).toBe(true);
      expect(line.startsWith("\n\n"), JSON.stringify(binding)).toBe(false);
      expect(line.endsWith("\n"), JSON.stringify(binding)).toBe(false);
      expect(line.slice(1), JSON.stringify(binding)).not.toContain("\n");
    }
  });
});

describe("withTaskBinding", () => {
  it("appends the binding to the render and nothing else", () => {
    expect(withTaskBinding("RENDER", { kind: "task", taskId: "T2" })).toBe("RENDER\nReview Task T2.");
    expect(withTaskBinding("RENDER", { kind: "none" })).toBe("RENDER");
  });

  it("is idempotent in the sense the renderer needs: binding a render cannot change the render", () => {
    const render = "line one\nline two";
    expect(withTaskBinding(render, { kind: "spec-check", wave: 1 }).startsWith(render)).toBe(true);
  });
});
