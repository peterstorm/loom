import { describe, it, expect } from "vitest";
import { detectPhase } from "../../src/handlers/pre-tool-use/validate-phase-order";
import { VALID_TRANSITIONS } from "../../src/config";

describe("detectPhase (pure)", () => {
  it("maps known phase agents", () => {
    expect(detectPhase("brainstorm-agent", "")).toBe("brainstorm");
    expect(detectPhase("specify-agent", "")).toBe("specify");
    expect(detectPhase("clarify-agent", "")).toBe("clarify");
    expect(detectPhase("architecture-agent", "")).toBe("architecture");
    expect(detectPhase("decompose-agent", "")).toBe("decompose");
  });

  it("maps impl agents to execute", () => {
    expect(detectPhase("code-implementer-agent", "")).toBe("execute");
    expect(detectPhase("java-test-agent", "")).toBe("execute");
    expect(detectPhase("ts-test-agent", "")).toBe("execute");
    expect(detectPhase("frontend-agent", "")).toBe("execute");
  });

  it("maps review agents to execute", () => {
    expect(detectPhase("review-invoker", "")).toBe("execute");
    expect(detectPhase("spec-check-invoker", "")).toBe("execute");
  });

  it("falls back to prompt keywords", () => {
    expect(detectPhase("custom-agent", "brainstorm ideas")).toBe("brainstorm");
    expect(detectPhase("custom-agent", "write specification")).toBe("specify");
    expect(detectPhase("custom-agent", "resolve NEEDS CLARIFICATION markers")).toBe("clarify");
    expect(detectPhase("custom-agent", "design architecture")).toBe("architecture");
  });

  it("returns unknown for unrecognized agents", () => {
    expect(detectPhase("random-agent", "do stuff")).toBe("unknown");
  });
});

describe("VALID_TRANSITIONS", () => {
  it("init allows architecture (for --skip-specify)", () => {
    expect(VALID_TRANSITIONS["init"]).toContain("architecture");
  });

  it("init allows brainstorm and specify", () => {
    expect(VALID_TRANSITIONS["init"]).toContain("brainstorm");
    expect(VALID_TRANSITIONS["init"]).toContain("specify");
  });
});
