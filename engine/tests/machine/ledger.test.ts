import { describe, it, expect, afterAll, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../../src/machine/types";
import type { SessionId } from "../../src/machine";
import { reportSummary } from "./report-summary";
import * as ledger from "../../src/machine";
import { SUBAGENT_DIR } from "../../src/config";

// bun/vitest may share SUBAGENT_DIR across suites — isolate via unique
// session ids + targeted cleanup instead of env manipulation.
const run = `ledger-test-${process.pid}-${Date.now()}`;
// The ledger API takes the branded SessionId — parse once at construction
// (the run/name chars are all SessionId-legal, so the assertion never fires).
const sid = (name: string) => ledger.parseSessionId(`${run}-${name}`)!;
const sessions = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "never-seen"].map(sid);

afterAll(() => {
  for (const s of sessions) {
    for (const path of [
      ledger.ledgerPath(s),
      ledger.machineBindingPath(s),
      `${SUBAGENT_DIR}/${s}.active`,
    ]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

// bindMachineAgent takes BRANDED identity — tests go through the same
// smart constructors production uses.
function agentId(s: string) {
  const v = ledger.parseAgentId(s);
  if (v === null) throw new Error(`test fixture: invalid agent id ${JSON.stringify(s)}`);
  return v;
}
function agentType(s: string) {
  const v = ledger.parseAgentType(s);
  if (v === null) throw new Error(`test fixture: invalid agent type ${JSON.stringify(s)}`);
  return v;
}
const bind = (s: SessionId, type: string, id: string) =>
  ledger.bindMachineAgent(s, agentType(type), agentId(id));

// Epochs are branded — tests go through the same parse boundary readers use.
function ep(s: string) {
  const v = ledger.parseEpoch(s);
  if (v === null) throw new Error(`test fixture: invalid epoch ${JSON.stringify(s)}`);
  return v;
}

/** Put exactly these agents on the session's `.active` roster. */
function roster(s: string, ...ids: string[]): void {
  writeFileSync(`${SUBAGENT_DIR}/${s}.active`, ids.map((i) => `${i}\n`).join(""));
}

const read = (path: string): Evidence => ({ kind: "FileRead", path });
const testRun: Evidence = {
  kind: "TestRun",
  command: "npm test",
  exit: 0,
  report: reportSummary(5, 0),
};

describe("evidence ledger", () => {
  it("roundtrips epoch-stamped records through append + read", () => {
    const s = sid("s1");
    ledger.appendEvidence(s, ep("a1:code-implementer-agent"), [read("/a.ts"), testRun]);
    const records = ledger.readEvidence(s);
    expect(records).toEqual([
      { epoch: "a1:code-implementer-agent", event: read("/a.ts") },
      { epoch: "a1:code-implementer-agent", event: testRun },
    ]);
    expect(ledger.eventsForEpoch(records, ep("a1:code-implementer-agent"))).toEqual([read("/a.ts"), testRun]);
    expect(ledger.eventsForEpoch(records, ep("other:agent"))).toEqual([]);
  });

  it("reads [] for a session with no ledger", () => {
    expect(ledger.readEvidence(sid("never-seen"))).toEqual([]);
  });

  it("skips corrupt, unknown, and epoch-less ledger lines", () => {
    expect(ledger.parseEvidenceLine("{broken")).toBeNull();
    expect(ledger.parseEvidenceLine('{"epoch":"a:b","event":{"kind":"Unknown"}}')).toBeNull();
    expect(ledger.parseEvidenceLine('{"event":{"kind":"FileRead","path":"/a.ts"}}')).toBeNull();
    expect(ledger.parseEvidenceLine('{"epoch":"","event":{"kind":"FileRead","path":"/a.ts"}}')).toBeNull();
    expect(ledger.parseEvidenceLine('{"epoch":"a:b","event":{"kind":"FileRead","path":"/a.ts"}}')).toEqual({
      epoch: "a:b",
      event: read("/a.ts"),
    });
  });

  it("a malformed report sub-object demotes to report: null (isReportSummary rejection)", () => {
    const parse = (report: unknown) =>
      ledger.parseEvidenceLine(
        JSON.stringify({ epoch: "a:b", event: { kind: "TestRun", command: "npm test", exit: 0, report } }),
      );
    const demoted = { epoch: "a:b", event: { kind: "TestRun", command: "npm test", exit: 0, report: null } };
    // wrong types / missing fields / unknown source / non-object
    expect(parse({ total: "5", failed: 0, source: "vitest-json" })).toEqual(demoted);
    expect(parse({ total: 5, source: "vitest-json" })).toEqual(demoted);
    expect(parse({ total: 5, failed: 0, source: "handwritten" })).toEqual(demoted);
    expect(parse("5 passed")).toEqual(demoted);
    expect(parse([])).toEqual(demoted);
    // a well-formed report survives
    expect(parse({ total: 5, failed: 0, source: "vitest-json" })).toEqual({
      epoch: "a:b",
      event: { kind: "TestRun", command: "npm test", exit: 0, report: { total: 5, failed: 0, source: "vitest-json" } },
    });
  });

  it("stored judgments are ignored — only facts survive the parse", () => {
    const forged = JSON.stringify({
      epoch: "a:b",
      event: { kind: "TestRun", command: "npm test", exit: 1, report: null, passed: true, trusted: true },
    });
    const parsed = ledger.parseEvidenceLine(forged);
    expect(parsed).toEqual({
      epoch: "a:b",
      event: { kind: "TestRun", command: "npm test", exit: 1, report: null },
    });
  });

  it("valid lines survive corrupt neighbours mid-file", () => {
    const s = sid("s5");
    appendFileSync(
      ledger.ledgerPath(s),
      `${JSON.stringify({ epoch: "a:b", event: read("/ok.ts") })}\n{torn line\n${JSON.stringify({ epoch: "a:b", event: testRun })}\n`,
    );
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), ep("a:b"))).toEqual([read("/ok.ts"), testRun]);
  });
});

describe("machine binding lifecycle", () => {
  it("bind → sole binding (with the bound agent rostered) → unbind → gone", async () => {
    const s = sid("s2");
    expect(ledger.readBindings(s)).toEqual([]);
    await bind(s, "code-implementer-agent", "a-1");
    expect(ledger.readBindings(s)).toEqual([
      { agentId: "a-1", agentType: "code-implementer-agent", epoch: "a-1:code-implementer-agent" },
    ]);
    // A binding with an EMPTY roster is the leaked-binding shape → stand down.
    expect(ledger.soleActiveBinding(s)).toBeNull();
    roster(s, "a-1");
    expect(ledger.soleActiveBinding(s)?.epoch).toBe("a-1:code-implementer-agent");
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-1"));
    expect(ledger.readBindings(s)).toEqual([]);
    expect(existsSync(ledger.machineBindingPath(s))).toBe(false);
  });

  it("a fresh bind truncates the previous run's ledger (epochs make leftovers inert anyway)", async () => {
    const s = sid("s3");
    await bind(s, "code-implementer-agent", "a-1");
    ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/old.ts")]);
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-1"));

    await bind(s, "code-implementer-agent", "a-2");
    expect(ledger.readEvidence(s)).toEqual([]);
    // Even if truncation had failed, the new epoch sees nothing:
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), ep("a-2:code-implementer-agent"))).toEqual([]);
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-2"));
  });

  it("logs skipped malformed binding lines instead of silently dropping them", () => {
    const s = sid("s6");
    // A line without the bind stamp (old 2-field wire format) is malformed too.
    writeFileSync(
      ledger.machineBindingPath(s),
      `garbage-line-without-a-tab\na-1\tcode-implementer-agent\na-1\tcode-implementer-agent\t${Date.now()}\n`,
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(ledger.readBindings(s)).toEqual([
        { agentId: "a-1", agentType: "code-implementer-agent", epoch: "a-1:code-implementer-agent" },
      ]);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("skipped 2 malformed binding line(s)");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a leaked binding — the sole active agent is NOT the bound one — voids attribution", async () => {
    const s = sid("s7");
    await bind(s, "code-implementer-agent", "a-1");
    // a-1's binding leaked (its cleanup was lost); a-9 is the agent running
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-9\n");
    expect(ledger.soleActiveBinding(s)).toBeNull();
    // the bound agent itself active → attribution restored
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    expect(ledger.soleActiveBinding(s)?.agentId).toBe("a-1");
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-1"));
  });

  it("contention: second binding or second active agent voids soleActiveBinding", async () => {
    const s = sid("s4");
    await bind(s, "code-implementer-agent", "a-1");
    roster(s, "a-1");
    expect(ledger.soleActiveBinding(s)).not.toBeNull();

    // Same-type parallel binding → no attribution
    await bind(s, "code-implementer-agent", "a-2");
    expect(ledger.soleActiveBinding(s)).toBeNull();
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-2"));
    expect(ledger.soleActiveBinding(s)).not.toBeNull();

    // A second ACTIVE subagent (any type, no machine) also voids it
    roster(s, "a-1", "a-9");
    expect(ledger.soleActiveBinding(s)).toBeNull();
    roster(s, "a-1");
    expect(ledger.soleActiveBinding(s)).not.toBeNull();

    // An EMPTY roster (leaked binding) also voids it
    roster(s);
    expect(ledger.soleActiveBinding(s)).toBeNull();

    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-1"));
  });
});

describe("branded agent identity — the bind boundary charset", () => {
  it("parseAgentId / parseAgentType reject reserved characters and empty strings", () => {
    for (const bad of ["", "a\tb", "a\nb", "a\rb", "a:b", "a-1:code-implementer-agent"]) {
      expect(ledger.parseAgentId(bad)).toBeNull();
      expect(ledger.parseAgentType(bad)).toBeNull();
    }
    expect(ledger.parseAgentId("a-1")).toBe("a-1");
    expect(ledger.parseAgentType("code-implementer-agent")).toBe("code-implementer-agent");
  });

  it("parseAgentId / parseAgentType reject path-unsafe input — the brand also proves machineDefPath safety", () => {
    for (const bad of [
      "a/b",
      "/etc",
      "a\\b",
      "..",
      "a..b",
      "../../outside",
      "a b",
      " ",
      "evil/../../machines",
    ]) {
      expect(ledger.parseAgentId(bad), `id ${JSON.stringify(bad)}`).toBeNull();
      expect(ledger.parseAgentType(bad), `type ${JSON.stringify(bad)}`).toBeNull();
    }
    // A single dot stays valid — only `..` traversal is rejected.
    expect(ledger.parseAgentType("agent.v2")).toBe("agent.v2");
  });

  it("readBindings drops lines whose fields contain reserved characters (epoch would desync)", () => {
    const s = sid("s8");
    // a ':' inside the id would make the recorded epoch ambiguous with the
    // reader's epochOf(agent_id, agent_type) — such a line is malformed.
    const now = Date.now();
    writeFileSync(
      ledger.machineBindingPath(s),
      `evil:id\tcode-implementer-agent\t${now}\na-1\tcode-implementer-agent\t${now}\textra-field\na-1\tcode-implementer-agent\t${now}\n`,
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(ledger.readBindings(s)).toEqual([
        { agentId: "a-1", agentType: "code-implementer-agent", epoch: "a-1:code-implementer-agent" },
      ]);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("skipped 2 malformed binding line(s)");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("branded session identity — the path-construction boundary", () => {
  it("parseSessionId rejects separators, traversal, whitespace, and empty", () => {
    for (const bad of ["", "a/b", "a\\b", "..", "a..b", "../../etc/passwd", "a b", "a\tb", "a\nb"]) {
      expect(ledger.parseSessionId(bad)).toBeNull();
    }
    expect(ledger.parseSessionId("abc-123_DEF.4")).toBe("abc-123_DEF.4");
  });

  it("a traversal string never yields a branded id, so no path constructor can be reached with one", () => {
    // The runtime throw in the ledger is gone by design: parseSessionId is the
    // single boundary, and every path constructor/reader now takes the branded
    // SessionId (unreachable-by-type with a raw string). The traversal defense
    // therefore lives entirely at this parse step.
    for (const evil of ["../../../etc/cron.d/x", "a/b", "..", " ", "../outside"]) {
      expect(ledger.parseSessionId(evil)).toBeNull();
    }
  });

  it("a branded id builds paths only under SUBAGENT_DIR", () => {
    const s = ledger.parseSessionId("branded-abc.123_DEF")!;
    expect(ledger.ledgerPath(s).startsWith(`${SUBAGENT_DIR}/`)).toBe(true);
    expect(ledger.machineBindingPath(s).startsWith(`${SUBAGENT_DIR}/`)).toBe(true);
    expect(ledger.ledgerPath(s)).not.toContain("..");
  });
});

describe("branded epochs — the deserialization boundary", () => {
  it("parseEpoch accepts exactly what epochOf produces", () => {
    expect(ledger.parseEpoch("a-1:code-implementer-agent")).toBe("a-1:code-implementer-agent");
    const id = ledger.parseAgentId("a-1")!;
    const type = ledger.parseAgentType("code-implementer-agent")!;
    expect(ledger.parseEpoch(ledger.epochOf(id, type))).toBe(ledger.epochOf(id, type));
  });

  it("parseEpoch rejects colon-less, empty-half, and multi-colon strings", () => {
    for (const bad of ["", "no-colon", ":type", "id:", "a:b:c", "a\tb:c", "a:b\nc"]) {
      expect(ledger.parseEpoch(bad)).toBeNull();
    }
  });

  it("ledger lines with corrupt epochs are skipped at read time", () => {
    expect(ledger.parseEvidenceLine('{"epoch":"no-colon","event":{"kind":"FileRead","path":"/a.ts"}}')).toBeNull();
    expect(ledger.parseEvidenceLine('{"epoch":"a:b:c","event":{"kind":"FileRead","path":"/a.ts"}}')).toBeNull();
  });
});

describe("machine registry", () => {
  it("loadMachine: none for unknown agents, machine for valid files, invalid for bad files", () => {
    const machines = mkdtempSync(join(tmpdir(), "loom-machines-"));
    try {
      // loadMachine takes BRANDED AgentType — the parse boundary is what
      // keeps machineDefPath inside machinesDir.
      expect(ledger.loadMachine(machines, agentType("nope-agent"))).toEqual({ kind: "none" });

      writeFileSync(
        join(machines, "good-agent.machine.json"),
        JSON.stringify({
          agent: "good-agent",
          enforcedTools: ["Edit"],
          phases: [
            { id: "a", allowedTools: [], advance: { event: "FileRead" } },
            { id: "z", terminal: true, allowedTools: ["Edit"], requires: [] },
          ],
        }),
      );
      expect(ledger.loadMachine(machines, agentType("good-agent")).kind).toBe("machine");

      writeFileSync(join(machines, "bad-agent.machine.json"), "{broken");
      expect(ledger.loadMachine(machines, agentType("bad-agent")).kind).toBe("invalid");

      writeFileSync(
        join(machines, "mismatch-agent.machine.json"),
        JSON.stringify({
          agent: "other-agent",
          enforcedTools: ["Edit"],
          phases: [
            { id: "a", allowedTools: [], advance: { event: "FileRead" } },
            { id: "z", terminal: true, allowedTools: [], requires: [] },
          ],
        }),
      );
      expect(ledger.loadMachine(machines, agentType("mismatch-agent")).kind).toBe("invalid");
    } finally {
      rmSync(machines, { recursive: true, force: true });
    }
  });
});
