/**
 * machineToMermaid renderer branches, directly against parsed machines:
 * guard labels (min 1 vs min > 1), terminal with/without requires, and
 * note emission only for non-empty allowedTools.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { machineToMermaid } from "../../src/machine/mermaid";
import { CODE_IMPLEMENTER_MACHINE_RAW, machineFrom } from "../fixtures/machine-definitions";

describe("machineToMermaid", () => {
  it("renders the full shape: entry, guarded transitions, terminal requires, tool notes", () => {
    const m = machineFrom({
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
    const m = machineFrom({
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
    const m = machineFrom({
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

describe("machineToMermaid state ids", () => {
  /** The shipped code-implementer machine's shape: its first phase id carries
   *  a hyphen, which mermaid's stateDiagram grammar rejects (parse error on
   *  `[*] --> read-context` under mermaid 10.9.x and 11.17.x alike). */
  const hyphenMachine = () => machineFrom(CODE_IMPLEMENTER_MACHINE_RAW);

  it("declares an alias for an id the state grammar cannot carry and references only the alias", () => {
    const out = machineToMermaid(hyphenMachine());
    expect(out).toContain("    state \"read-context\" as read_context");
    expect(out).toContain("    [*] --> read_context");
    expect(out).toContain("    read_context --> implement : FileRead");
    expect(out).not.toContain("read-context -->");
    expect(out).not.toContain("note right of read-context");
  });

  it("renders the shipped code-implementer shape to its exact diagram (golden)", () => {
    expect(machineToMermaid(hyphenMachine())).toBe(
      [
        "stateDiagram-v2",
        "    state \"read-context\" as read_context",
        "    [*] --> read_context",
        "    read_context --> implement : FileRead",
        "    implement --> verify : FileWrite",
        "    note right of implement : allows Edit, Write, MultiEdit",
        "    verify --> done : TestRunPassed",
        "    note right of verify : allows Edit, Write, MultiEdit",
        "    done --> [*] : requires TestRunPassed",
        "    note right of done : allows Edit, Write, MultiEdit",
      ].join("\n"),
    );
  });

  it("an id matching [A-Za-z0-9_]+ is never aliased", () => {
    const out = machineToMermaid(hyphenMachine());
    for (const safe of ["implement", "verify", "done"]) {
      expect(out).not.toContain(`state "${safe}" as`);
    }
  });

  it("a display string never carries a raw double quote or a line break", () => {
    const m = machineFrom({
      agent: "a",
      enforcedTools: ["Edit"],
      phases: [
        { id: "a\"b\n c.d", allowedTools: [], advance: { event: "FileRead", min: 1 } },
        { id: "done", terminal: true, allowedTools: [], requires: [] },
      ],
    });
    const lines = machineToMermaid(m).split("\n");
    expect(lines).toHaveLength(5); // header, one alias, entry, transition, terminal
    expect(lines[1]).toBe("    state \"a'b  c.d\" as a_b__c_d");
    expect(lines[2]).toBe("    [*] --> a_b__c_d");
  });

  it("distinct ids never collapse onto one token — a safe id reserves its token even when declared later", () => {
    // Two-pass plan: every grammar-safe id is reserved first, so `a_b` (the
    // second phase, a safe id) keeps the plain token and the earlier unsafe
    // `a-b` takes the suffixed alias. The mapping is a function of the whole
    // machine, never of declaration order alone.
    const m = machineFrom({
      agent: "a",
      enforcedTools: ["Edit"],
      phases: [
        { id: "a-b", allowedTools: [], advance: { event: "FileRead", min: 1 } },
        { id: "a_b", allowedTools: ["Edit"], advance: { event: "FileWrite", min: 1 } },
        { id: "done", terminal: true, allowedTools: [], requires: [] },
      ],
    });
    const out = machineToMermaid(m);
    expect(out).toContain("    state \"a-b\" as a_b_1");
    expect(out).not.toContain("    state \"a_b\" as");
    expect(out).toContain("    a_b_1 --> a_b : FileRead");
    expect(out).toContain("    a_b --> done : FileWrite");
  });

  it("property: no hyphen survives outside quoted display strings and the arrows", () => {
    // The invariant the renderer must keep for mermaid's stateDiagram grammar:
    // every state reference it emits is a bare identifier. Hyphens were the
    // shipped defect (read-context et al. failed to parse under mermaid 10 and
    // 11 alike), so after stripping quoted display strings and the `-->`
    // arrows, no hyphen may remain in the diagram body. Ids are generated as
    // printable strings and routed through the production parser.
    const idArb = fc
      .string({ minLength: 1, maxLength: 24 })
      .filter((s) => /^[\x21-\x7e]+$/.test(s));
    const machineArb = fc
      .uniqueArray(idArb, { minLength: 2, maxLength: 6 })
      .map((ids) => ({
        agent: "a",
        enforcedTools: ["Edit"],
        phases: ids.map((id, i) =>
          i === ids.length - 1
            ? { id, terminal: true, allowedTools: [], requires: [] }
            : { id, allowedTools: [], advance: { event: "FileRead", min: 1 } },
        ),
      }));
    fc.assert(
      fc.property(machineArb, (raw) => {
        const m = machineFrom(raw);
        const body = machineToMermaid(m)
          .split("\n")
          .slice(1) // the stateDiagram-v2 header owns its hyphen
          .map((line) => line.replace(/"[^"]*"/g, "").replace(/-->/g, ""));
        for (const line of body) {
          expect(line).not.toMatch(/-/);
        }
      }),
    );
  });
});
