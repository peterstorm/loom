import { describe, it, expect, afterAll, vi } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
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


// Sweep by run prefix, NOT by a hand-maintained session list. The list rotted
// once already: sessions added by a later test leaked `.active` files into the
// shared SUBAGENT_DIR, and a stray roster there makes anyActiveSubagent report
// a live agent — disabling stale-reservation recovery for every project using
// that directory. The failure is far too quiet to police by hand, so cleanup
// derives from the unique run prefix every session id here already carries.
afterAll(() => {
  let entries: readonly string[];
  try {
    entries = readdirSync(SUBAGENT_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(run)) continue;
    try {
      unlinkSync(`${SUBAGENT_DIR}/${name}`);
    } catch {}
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

function parsedLine(line: string) {
  const parsed = ledger.parseEvidenceLine(line);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
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

  it("propagates an inaccessible ledger instead of treating it as empty evidence", () => {
    const s = sid("inaccessible-evidence");
    symlinkSync(ledger.ledgerPath(s), ledger.ledgerPath(s));

    expect(() => ledger.readEvidence(s)).toThrow(/cannot read evidence ledger.*ELOOP/i);
  });

  it("returns typed failures for corrupt, unknown, and epoch-less ledger lines", () => {
    expect(ledger.parseEvidenceLine("{broken")).toMatchObject({ ok: false });
    expect(ledger.parseEvidenceLine('{"epoch":"a:b","event":{"kind":"Unknown"}}')).toMatchObject({ ok: false });
    expect(ledger.parseEvidenceLine('{"event":{"kind":"FileRead","path":"/a.ts"}}')).toMatchObject({ ok: false });
    expect(ledger.parseEvidenceLine('{"epoch":"","event":{"kind":"FileRead","path":"/a.ts"}}')).toMatchObject({ ok: false });
    expect(parsedLine('{"epoch":"a:b","event":{"kind":"FileRead","path":"/a.ts"}}')).toEqual({
      epoch: "a:b",
      event: read("/a.ts"),
    });
  });

  it("a malformed report sub-object demotes to report: null (parseReportField rejection)", () => {
    const parse = (report: unknown) =>
      parsedLine(JSON.stringify({ epoch: "a:b", event: { kind: "TestRun", command: "npm test", exit: 0, report } }));
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
    // Re-mint: valid counts carrying a SMUGGLED extra field parse to EXACTLY
    // {total, failed, source} — the branded summary never carries riders
    // that could ride back out on re-serialization.
    expect(parse({ total: 5, failed: 0, source: "vitest-json", smuggled: "rider" })).toEqual({
      epoch: "a:b",
      event: { kind: "TestRun", command: "npm test", exit: 0, report: { total: 5, failed: 0, source: "vitest-json" } },
    });
  });

  it("stored judgments are ignored — only facts survive the parse", () => {
    const forged = JSON.stringify({
      epoch: "a:b",
      event: { kind: "TestRun", command: "npm test", exit: 1, report: null, passed: true, trusted: true },
    });
    const parsed = parsedLine(forged);
    expect(parsed).toEqual({
      epoch: "a:b",
      event: { kind: "TestRun", command: "npm test", exit: 1, report: null },
    });
  });

  it("one corrupt neighbour invalidates the whole ledger", () => {
    const s = sid("s5");
    appendFileSync(
      ledger.ledgerPath(s),
      `${JSON.stringify({ epoch: "a:b", event: read("/ok.ts") })}\n{torn line\n${JSON.stringify({ epoch: "a:b", event: testRun })}\n`,
    );
    expect(() => ledger.readEvidence(s)).toThrow(/refusing partial evidence.*line 2/i);
  });
});

describe("call-start stamp reads", () => {
  it("returns quiet absence only for ENOENT", () => {
    expect(ledger.callStartFor(sid("callstart-absent"), "toolu_missing")).toBeNull();
  });

  it("diagnoses an inaccessible stamp and remains fail-closed", () => {
    const s = sid("callstart-inaccessible");
    const path = ledger.sessionScopedPath(s, ledger.CALL_START_SUFFIX);
    symlinkSync(path, path);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(ledger.callStartFor(s, "toolu_x")).toBeNull();
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toMatch(/cannot read call-start file .*ELOOP/i);
    } finally {
      stderr.mockRestore();
    }
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

  it("a fresh bind leaves the previous run's ledger intact; epochs make leftovers inert", async () => {
    const s = sid("s3");
    await bind(s, "code-implementer-agent", "a-1");
    ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/old.ts")]);
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-1"));

    await bind(s, "code-implementer-agent", "a-2");
    // The bind no longer unlinks the ledger — that delete raced unlocked
    // appendEvidence writers. The leftover record survives...
    expect(ledger.readEvidence(s)).toHaveLength(1);
    // ...and is inert for the new epoch, which is what actually matters.
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), ep("a-2:code-implementer-agent"))).toEqual([]);
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-2"));
  });

  it("a sibling's bind never destroys a concurrent agent's already-written evidence", async () => {
    // Regression: bindMachineAgent used to unlink the ledger whenever no fresh
    // binding was active. appendEvidence takes no lock, so a parallel batch
    // could lose a still-running sibling's TestRun records, and that sibling's
    // SubagentStop then saw no trusted evidence for its own epoch.
    const s = sid("s3-race");
    await bind(s, "code-implementer-agent", "a-1");
    ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/a1-first.ts")]);

    // A sibling binds while a-1 is still running and still appending.
    await bind(s, "ts-test-agent", "b-1");
    ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/a1-second.ts")]);
    ledger.appendEvidence(s, ep("b-1:ts-test-agent"), [read("/b1.ts")]);

    // Each epoch still sees exactly its own evidence.
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), ep("a-1:code-implementer-agent")))
      .toEqual([read("/a1-first.ts"), read("/a1-second.ts")]);
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), ep("b-1:ts-test-agent")))
      .toEqual([read("/b1.ts")]);

    await ledger.unbindMachineAgent(s, agentType("ts-test-agent"), agentId("b-1"));
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-1"));
  });

  it("a bind after every sibling unbound still preserves the unjudged epoch's evidence", async () => {
    // The exact shape that bit a real run: the fast sibling finishes and
    // unbinds, leaving zero fresh bindings; the next spawn's bind must not
    // delete the slow sibling's records before its SubagentStop reads them.
    const s = sid("s3-unbound");
    await bind(s, "code-implementer-agent", "a-1");
    ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/slow.ts")]);
    await ledger.unbindMachineAgent(s, agentType("code-implementer-agent"), agentId("a-1"));

    await bind(s, "ts-test-agent", "c-1");
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), ep("a-1:code-implementer-agent")))
      .toEqual([read("/slow.ts")]);
    await ledger.unbindMachineAgent(s, agentType("ts-test-agent"), agentId("c-1"));
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

  it("ledger lines with corrupt epochs return typed parse failures", () => {
    expect(ledger.parseEvidenceLine('{"epoch":"no-colon","event":{"kind":"FileRead","path":"/a.ts"}}')).toMatchObject({ ok: false });
    expect(ledger.parseEvidenceLine('{"epoch":"a:b:c","event":{"kind":"FileRead","path":"/a.ts"}}')).toMatchObject({ ok: false });
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

      const loopPath = join(machines, "loop-agent.machine.json");
      symlinkSync(loopPath, loopPath);
      expect(ledger.loadMachine(machines, agentType("loop-agent"))).toMatchObject({
        kind: "invalid",
        error: expect.stringMatching(/cannot read machine definition.*ELOOP/i),
      });

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

// The roster stored identity alone because its original job was COUNTING.
// Authorization needs the ROLE, and on Claude Code `agent_id` is an opaque
// handle no agent-type name can match — so the line carries an optional
// second column. Counting and attribution must be unchanged by it.
describe("roster records the agent role alongside its identity", () => {
  it("round-trips the recorded role without disturbing identity or count", async () => {
    const s = sid("roster-role-1");
    await ledger.markAgentActive(s, agentId("a339f6fd51d78b179"), agentType("code-implementer-agent"));

    expect(ledger.readActiveAgentRoles(s)).toEqual([
      { agentId: "a339f6fd51d78b179", agentType: "code-implementer-agent" },
    ]);
    expect(ledger.countActiveAgents(s)).toBe(1);
  });

  it("keeps a single-column line readable with an unknown role", async () => {
    // Pi passes no type, and rosters written before the column existed must
    // keep parsing rather than being dropped from the count.
    const s = sid("roster-role-2");
    await ledger.markAgentActive(s, agentId("pi-grant-abcdef0123456789"));

    expect(ledger.readActiveAgentRoles(s)).toEqual([
      { agentId: "pi-grant-abcdef0123456789", agentType: null },
    ]);
    expect(ledger.countActiveAgents(s)).toBe(1);
  });

  it("propagates an inaccessible roster instead of standing down as if it were empty", () => {
    const s = sid("roster-inaccessible-read");
    const path = `${SUBAGENT_DIR}/${s}.active`;
    symlinkSync(path, path);

    expect(() => ledger.readActiveAgentRoles(s)).toThrow(/cannot read active roster.*ELOOP/i);
    expect(() => ledger.soleActiveBinding(s)).toThrow(/cannot read active roster.*ELOOP/i);
  });

  it("strict removal reports an inaccessible roster instead of claiming rollback succeeded", async () => {
    const s = sid("roster-inaccessible-removal");
    const path = `${SUBAGENT_DIR}/${s}.active`;
    symlinkSync(path, path);

    await expect(ledger.removeActiveAgentStrict(s, agentId("denied-agent"))).rejects.toThrow(/ELOOP/i);
  });

  it("completion removal rejects an inaccessible roster instead of reporting success", async () => {
    const s = sid("roster-inaccessible-completion");
    const path = `${SUBAGENT_DIR}/${s}.active`;
    symlinkSync(path, path);

    await expect(ledger.removeActiveAgent(s, agentId("finished-agent"))).rejects.toThrow(/ELOOP/i);
  });

  it("binding cleanup rejects an inaccessible binding instead of reporting success", async () => {
    const s = sid("binding-inaccessible-completion");
    const path = ledger.machineBindingPath(s);
    symlinkSync(path, path);

    await expect(ledger.unbindMachineAgent(
      s,
      agentType("code-implementer-agent"),
      agentId("finished-agent"),
    )).rejects.toThrow(/unbindMachineAgent failed.*ELOOP/i);
  });

  it("treats identity as column 0 for duplicate detection", async () => {
    const s = sid("roster-role-3");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await ledger.markAgentActive(s, agentId("a-dup"), agentType("code-implementer-agent"));
      // Same identity, redelivered without a type — still a duplicate.
      await ledger.markAgentActive(s, agentId("a-dup"));
      expect(ledger.countActiveAgents(s)).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("removes a role-carrying entry by identity alone", async () => {
    // markAgentActive/removeActiveAgent must stay symmetric across the
    // agent's start and stop hooks, which only know the id.
    const s = sid("roster-role-4");
    await ledger.markAgentActive(s, agentId("a-keep"), agentType("code-implementer-agent"));
    await ledger.markAgentActive(s, agentId("a-drop"), agentType("code-reviewer"));

    await ledger.removeActiveAgent(s, agentId("a-drop"));

    expect(ledger.readActiveAgentRoles(s)).toEqual([
      { agentId: "a-keep", agentType: "code-implementer-agent" },
    ]);
    expect(ledger.countActiveAgents(s)).toBe(1);
  });

  it("keeps sole-active attribution keyed on identity", async () => {
    // soleActiveBinding compares the roster to the machine binding brand-to-
    // brand; the added column must not break that comparison.
    const s = sid("roster-role-5");
    await bind(s, "code-implementer-agent", "a339f6fd51d78b179");
    await ledger.markAgentActive(s, agentId("a339f6fd51d78b179"), agentType("code-implementer-agent"));

    expect(ledger.soleActiveBinding(s)?.agentId).toBe("a339f6fd51d78b179");
  });
});

describe("duplicate SubagentStart events are idempotent (round-10 Fix 4)", () => {
  it("markAgentActive is a set keyed by agentId — the duplicate never disarms soleActiveBinding", async () => {
    const s = sid("s9");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await bind(s, "code-implementer-agent", "a-1");
      await ledger.markAgentActive(s, agentId("a-1"));
      await ledger.markAgentActive(s, agentId("a-1")); // duplicate delivery
      expect(ledger.countActiveAgents(s)).toBe(1);
      expect(ledger.soleActiveBinding(s)?.agentId).toBe("a-1");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("duplicate SubagentStart ignored");
    } finally {
      stderrSpy.mockRestore();
    }
    // …while a genuinely different agent still contends:
    await ledger.markAgentActive(s, agentId("a-2"));
    expect(ledger.countActiveAgents(s)).toBe(2);
    expect(ledger.soleActiveBinding(s)).toBeNull();
  });

  it("bindMachineAgent skips the duplicate line — the session never LOOKS contended", async () => {
    const s = sid("s10");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await bind(s, "code-implementer-agent", "a-1");
      // Evidence recorded between the two deliveries must survive: the
      // duplicate bind must NOT re-truncate the ledger either.
      ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/a.ts")]);
      await bind(s, "code-implementer-agent", "a-1"); // duplicate delivery
      expect(ledger.readBindings(s)).toHaveLength(1);
      expect(ledger.readEvidence(s)).toHaveLength(1);
      roster(s, "a-1");
      expect(ledger.soleActiveBinding(s)?.agentId).toBe("a-1");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("duplicate SubagentStart ignored");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("callId idempotency stamp (round-10 Fix 6)", () => {
  it("appendEvidence stamps callId; parseEvidenceLine round-trips it; absent stays absent", () => {
    const s = sid("s11");
    ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/a.ts")], "toolu_01");
    ledger.appendEvidence(s, ep("a-1:code-implementer-agent"), [read("/b.ts")]); // no stamp
    const records = ledger.readEvidence(s);
    expect(records).toEqual([
      { epoch: "a-1:code-implementer-agent", event: read("/a.ts"), callId: "toolu_01" },
      { epoch: "a-1:code-implementer-agent", event: read("/b.ts") },
    ]);
  });

  it("eventsForEpoch drops a duplicated delivery (same epoch, callId, event) — old stampless records never dedupe", () => {
    const e = ep("a-1:code-implementer-agent");
    const dup = { epoch: e, event: read("/a.ts"), callId: "toolu_01" } as const;
    const stampless = { epoch: e, event: read("/a.ts") } as const;
    expect(ledger.eventsForEpoch([dup, dup, stampless, stampless], e)).toEqual([
      read("/a.ts"), // deduped delivery
      read("/a.ts"), // old records: kept
      read("/a.ts"),
    ]);
    // Same callId, DIFFERENT events (one call minting several facts): all kept.
    const multi = [
      { epoch: e, event: read("/a.ts"), callId: "c1" },
      { epoch: e, event: { kind: "FileWrite", path: "/x", via: "shell" } as Evidence, callId: "c1" },
      { epoch: e, event: { kind: "FileWrite", path: "/y", via: "shell" } as Evidence, callId: "c1" },
    ];
    expect(ledger.eventsForEpoch(multi, e)).toHaveLength(3);
  });

  it("parseEvidenceLine reads back callId and the FileWrite via field; unknown via fails closed to shell", () => {
    expect(
      parsedLine('{"epoch":"a:b","event":{"kind":"FileRead","path":"/a"},"callId":"toolu_9"}'),
    ).toEqual({ epoch: "a:b", event: { kind: "FileRead", path: "/a" }, callId: "toolu_9" });
    expect(
      parsedLine('{"epoch":"a:b","event":{"kind":"FileWrite","path":"/w","via":"shell"}}').event,
    ).toEqual({ kind: "FileWrite", path: "/w", via: "shell" });
    expect(
      parsedLine('{"epoch":"a:b","event":{"kind":"FileWrite","path":"/w","via":"tool"}}').event,
    ).toEqual({ kind: "FileWrite", path: "/w", via: "tool" });
    // Absent via = old record = tool write (only tool writes were minted
    // historically) — the parse boundary makes the default EXPLICIT.
    expect(
      parsedLine('{"epoch":"a:b","event":{"kind":"FileWrite","path":"/w"}}').event,
    ).toEqual({ kind: "FileWrite", path: "/w", via: "tool" });
    // Garbage via fails CLOSED to "shell": still vetoes, never advances a guard.
    expect(
      parsedLine('{"epoch":"a:b","event":{"kind":"FileWrite","path":"/w","via":"nonsense"}}').event,
    ).toEqual({ kind: "FileWrite", path: "/w", via: "shell" });
    // A non-string callId is ignored, not a parse failure.
    expect(
      parsedLine('{"epoch":"a:b","event":{"kind":"FileRead","path":"/a"},"callId":42}'),
    ).toEqual({ epoch: "a:b", event: { kind: "FileRead", path: "/a" } });
  });
});
