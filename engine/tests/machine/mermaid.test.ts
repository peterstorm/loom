/**
 * machineToMermaid renderer branches, directly against parsed machines:
 * guard labels (min 1 vs min > 1), terminal with/without requires, and
 * note emission only for non-empty allowedTools.
 */

import { describe, it, expect } from "vitest";
import { machineToMermaid } from "../../src/machine/mermaid";
import { parseMachine } from "../../src/machine/parse-machine";
import type { MachineDef } from "../../src/machine/types";

function machine(raw: unknown): MachineDef {
  const parsed = parseMachine(raw);
  if (!parsed.ok) throw new Error(`test fixture machine invalid: ${parsed.error}`);
  return parsed.value;
}

describe("machineToMermaid", () => {
  it("renders the full shape: entry, guarded transitions, terminal requires, tool notes", () => {
    const m = machine({
      agent: "code-implementer-agent",
      enforcedTools: ["Edit", "Write"],
      phases: [
        { id: "read", allowedTools: [], advance: { event: "FileRead", min: 1 } },
        { id: "impl", allowedTools: ["Edit", "Write"], advance: { event: "FileWrite", min: 2 } },
        { id: "done", terminal: true, allowedTools: ["Edit"], requires: [{ event: "TestRunPassed", min: 1 }, { event: "FileWrite", min: 2 }] },
      ],
    });
    const lines = machineToMermaid(m).split("\n");
    expect(lines[0]).toBe("stateDiagram-v2");
    expect(lines).toContain("    [*] --> read");
    expect(lines).toContain("    read --> impl : FileRead"); // min 1 → bare event
    expect(lines).toContain("    impl --> done : FileWrite >= 2"); // min > 1 → threshold shown
    expect(lines).toContain("    done --> [*] : requires TestRunPassed AND FileWrite >= 2");
    expect(lines).toContain("    note right of impl : allows Edit, Write");
    expect(lines).toContain("    note right of done : allows Edit");
    // read allows nothing → no note for it
    expect(lines.some((l) => l.includes("note right of read"))).toBe(false);
  });

  it("terminal phase with EMPTY requires renders a bare exit transition (no dangling ': requires')", () => {
    const m = machine({
      agent: "a",
      enforcedTools: ["Edit"],
      phases: [
        { id: "work", allowedTools: ["Edit"], advance: { event: "FileWrite", min: 1 } },
        { id: "done", terminal: true, allowedTools: [], requires: [] },
      ],
    });
    const lines = machineToMermaid(m).split("\n");
    expect(lines).toContain("    done --> [*]");
    expect(lines.some((l) => l.includes("requires"))).toBe(false);
  });

  it("phases with empty allowedTools emit no note lines at all", () => {
    const m = machine({
      agent: "a",
      enforcedTools: ["Edit"],
      phases: [
        { id: "work", allowedTools: [], advance: { event: "FileRead", min: 1 } },
        { id: "done", terminal: true, allowedTools: [], requires: [] },
      ],
    });
    expect(machineToMermaid(m)).not.toContain("note right of");
  });
});
