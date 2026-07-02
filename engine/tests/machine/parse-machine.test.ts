import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMachine, parseMachineJson } from "../../src/machine/parse-machine";

const valid = {
  agent: "code-implementer-agent",
  enforcedTools: ["Edit", "Write"],
  phases: [
    { id: "read", allowedTools: [], advance: { event: "FileRead", min: 1 } },
    { id: "done", terminal: true, allowedTools: ["Edit", "Write"], requires: [{ event: "TestRunPassed" }] },
  ],
};

describe("parseMachine", () => {
  it("accepts a valid machine", () => {
    const result = parseMachine(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases).toHaveLength(2);
      expect(result.value.phases[1].requires[0]).toEqual({ event: "TestRunPassed", min: 1 });
    }
  });

  it("defaults requirement min to 1", () => {
    const result = parseMachine(valid);
    expect(result.ok && result.value.phases[0].advance?.min).toBe(1);
  });

  it("rejects non-object input", () => {
    expect(parseMachine([]).ok).toBe(false);
    expect(parseMachine("x").ok).toBe(false);
    expect(parseMachine(null).ok).toBe(false);
  });

  it("rejects missing/empty agent", () => {
    expect(parseMachine({ ...valid, agent: "" }).ok).toBe(false);
    expect(parseMachine({ ...valid, agent: undefined }).ok).toBe(false);
  });

  it("rejects empty enforcedTools", () => {
    expect(parseMachine({ ...valid, enforcedTools: [] }).ok).toBe(false);
  });

  it("rejects enforcedTools outside the gate's wired jurisdiction (hooks.json matchers)", () => {
    const result = parseMachine({ ...valid, enforcedTools: ["Edit", "Bash"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"Bash"');
      expect(result.error).toContain("only wired for");
    }
  });

  it("rejects fewer than 2 phases", () => {
    expect(parseMachine({ ...valid, phases: [valid.phases[1]] }).ok).toBe(false);
  });

  it("rejects duplicate phase ids", () => {
    const dup = {
      ...valid,
      phases: [
        { id: "read", allowedTools: [], advance: { event: "FileRead" } },
        { id: "read", allowedTools: [], advance: { event: "FileWrite" } },
        valid.phases[1],
      ],
    };
    const result = parseMachine(dup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("duplicate");
  });

  it("rejects terminal phase that is not last", () => {
    const bad = {
      ...valid,
      phases: [
        { id: "done", terminal: true, allowedTools: [] },
        { id: "read", allowedTools: [], advance: { event: "FileRead" } },
      ],
    };
    expect(parseMachine(bad).ok).toBe(false);
  });

  it("rejects last phase without terminal: true", () => {
    const bad = {
      ...valid,
      phases: [
        { id: "read", allowedTools: [], advance: { event: "FileRead" } },
        { id: "write", allowedTools: [], advance: { event: "FileWrite" } },
      ],
    };
    expect(parseMachine(bad).ok).toBe(false);
  });

  it("rejects non-terminal phase without advance", () => {
    const bad = {
      ...valid,
      phases: [{ id: "read", allowedTools: [] }, valid.phases[1]],
    };
    expect(parseMachine(bad).ok).toBe(false);
  });

  it("rejects terminal phase with advance", () => {
    const bad = {
      ...valid,
      phases: [
        valid.phases[0],
        { id: "done", terminal: true, allowedTools: [], advance: { event: "FileRead" } },
      ],
    };
    expect(parseMachine(bad).ok).toBe(false);
  });

  it("rejects unknown event tokens (no expression language)", () => {
    const bad = {
      ...valid,
      phases: [
        { id: "read", allowedTools: [], advance: { event: "files_read > 0" } },
        valid.phases[1],
      ],
    };
    const result = parseMachine(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("event must be one of");
  });

  it("rejects non-positive min", () => {
    const bad = {
      ...valid,
      phases: [
        { id: "read", allowedTools: [], advance: { event: "FileRead", min: 0 } },
        valid.phases[1],
      ],
    };
    expect(parseMachine(bad).ok).toBe(false);
  });

  it("rejects allowedTools outside enforcedTools jurisdiction", () => {
    const bad = {
      ...valid,
      phases: [
        { id: "read", allowedTools: ["Bash"], advance: { event: "FileRead" } },
        valid.phases[1],
      ],
    };
    const result = parseMachine(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not in enforcedTools");
  });

  it("rejects requires on non-terminal phases", () => {
    const bad = {
      ...valid,
      phases: [
        { id: "read", allowedTools: [], advance: { event: "FileRead" }, requires: [{ event: "TestRun" }] },
        valid.phases[1],
      ],
    };
    expect(parseMachine(bad).ok).toBe(false);
  });

  it("rejects invalid JSON text", () => {
    expect(parseMachineJson("{nope").ok).toBe(false);
  });
});

describe("shipped machine definitions", () => {
  it("code-implementer-agent.machine.json parses and matches its agent", () => {
    const path = join(__dirname, "../../../machines/code-implementer-agent.machine.json");
    const result = parseMachineJson(readFileSync(path, "utf-8"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agent).toBe("code-implementer-agent");
      // R1 is real: the first phase must not allow any file-modifying tool
      expect(result.value.phases[0].allowedTools).toEqual([]);
      expect(result.value.enforcedTools).toEqual(expect.arrayContaining(["Edit", "Write", "MultiEdit"]));
    }
  });
});
