import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../../src/machine/types";
import * as ledger from "../../src/machine/ledger";

// bun test runs all files in one process, so SUBAGENT_DIR resolves once
// globally — isolate via unique session ids + targeted cleanup instead.
const run = `ledger-test-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;
const sessions = ["s1", "s2", "s3", "s4", "never-seen"].map(sid);

afterAll(() => {
  for (const s of sessions) {
    for (const path of [ledger.ledgerPath(s), ledger.machineBindingPath(s)]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

const read = (path: string): Evidence => ({ kind: "FileRead", path });
const testRun: Evidence = {
  kind: "TestRun",
  command: "npm test",
  exit: 0,
  report: { total: 5, failed: 0, source: "vitest-json" },
  passed: true,
  trusted: true,
};

describe("evidence ledger", () => {
  it("roundtrips events through append + read", () => {
    ledger.appendEvidence(sid("s1"), [read("/a.ts"), testRun]);
    expect(ledger.readEvidence(sid("s1"))).toEqual([read("/a.ts"), testRun]);
  });

  it("reads [] for a session with no ledger", () => {
    expect(ledger.readEvidence(sid("never-seen"))).toEqual([]);
  });

  it("skips corrupt and unknown ledger lines", () => {
    expect(ledger.parseEvidenceLine("{broken")).toBeNull();
    expect(ledger.parseEvidenceLine('{"kind":"Unknown","x":1}')).toBeNull();
    expect(ledger.parseEvidenceLine('{"kind":"FileRead"}')).toBeNull();
    expect(ledger.parseEvidenceLine('{"kind":"FileRead","path":"/a.ts"}')).toEqual(read("/a.ts"));
  });

  it("parses TestRun lines strictly (passed/trusted must be booleans)", () => {
    expect(ledger.parseEvidenceLine(JSON.stringify(testRun))).toEqual(testRun);
    expect(ledger.parseEvidenceLine(JSON.stringify({ ...testRun, trusted: "yes" }))).toBeNull();
    expect(ledger.parseEvidenceLine(JSON.stringify({ ...testRun, passed: 1 }))).toBeNull();
  });
});

describe("machine binding lifecycle", () => {
  it("bind → active → unbind → gone", () => {
    expect(ledger.activeMachineAgents(sid("s2"))).toEqual([]);
    ledger.bindMachineAgent(sid("s2"), "code-implementer-agent");
    expect(ledger.activeMachineAgents(sid("s2"))).toEqual(["code-implementer-agent"]);
    ledger.unbindMachineAgent(sid("s2"), "code-implementer-agent");
    expect(ledger.activeMachineAgents(sid("s2"))).toEqual([]);
    expect(existsSync(ledger.machineBindingPath(sid("s2")))).toBe(false);
  });

  it("a fresh bind starts a new epoch: previous ledger is deleted", () => {
    ledger.bindMachineAgent(sid("s3"), "code-implementer-agent");
    ledger.appendEvidence(sid("s3"), [read("/old.ts")]);
    ledger.unbindMachineAgent(sid("s3"), "code-implementer-agent");

    // Sequential subagent: must NOT inherit evidence from the earlier run
    ledger.bindMachineAgent(sid("s3"), "code-implementer-agent");
    expect(ledger.readEvidence(sid("s3"))).toEqual([]);
    ledger.unbindMachineAgent(sid("s3"), "code-implementer-agent");
  });

  it("parallel binds share the epoch (no mid-run ledger wipe)", () => {
    ledger.bindMachineAgent(sid("s4"), "code-implementer-agent");
    ledger.appendEvidence(sid("s4"), [read("/a.ts")]);
    ledger.bindMachineAgent(sid("s4"), "code-implementer-agent");
    expect(ledger.readEvidence(sid("s4"))).toEqual([read("/a.ts")]);
    expect(ledger.activeMachineAgents(sid("s4"))).toHaveLength(2);

    ledger.unbindMachineAgent(sid("s4"), "code-implementer-agent");
    expect(ledger.activeMachineAgents(sid("s4"))).toHaveLength(1);
    ledger.unbindMachineAgent(sid("s4"), "code-implementer-agent");
    expect(ledger.activeMachineAgents(sid("s4"))).toEqual([]);
  });
});

describe("machine registry", () => {
  it("loadMachine: none for unknown agents, machine for valid files, invalid for bad files", () => {
    const machines = mkdtempSync(join(tmpdir(), "loom-machines-"));
    try {
      expect(ledger.loadMachine(machines, "nope-agent")).toEqual({ kind: "none" });

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
      expect(ledger.loadMachine(machines, "good-agent").kind).toBe("machine");

      writeFileSync(join(machines, "bad-agent.machine.json"), "{broken");
      expect(ledger.loadMachine(machines, "bad-agent").kind).toBe("invalid");

      // agent field must match the filename binding
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
      expect(ledger.loadMachine(machines, "mismatch-agent").kind).toBe("invalid");
    } finally {
      rmSync(machines, { recursive: true, force: true });
    }
  });
});
