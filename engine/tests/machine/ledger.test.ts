import { describe, it, expect, afterAll, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../../src/machine/types";
import * as ledger from "../../src/machine/ledger";
import { SUBAGENT_DIR } from "../../src/config";

// bun/vitest may share SUBAGENT_DIR across suites — isolate via unique
// session ids + targeted cleanup instead of env manipulation.
const run = `ledger-test-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;
const sessions = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "never-seen"].map(sid);

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

const read = (path: string): Evidence => ({ kind: "FileRead", path });
const testRun: Evidence = {
  kind: "TestRun",
  command: "npm test",
  exit: 0,
  report: { total: 5, failed: 0, source: "vitest-json" },
};

describe("evidence ledger", () => {
  it("roundtrips epoch-stamped records through append + read", () => {
    const s = sid("s1");
    ledger.appendEvidence(s, "a1:code-implementer-agent", [read("/a.ts"), testRun]);
    const records = ledger.readEvidence(s);
    expect(records).toEqual([
      { epoch: "a1:code-implementer-agent", event: read("/a.ts") },
      { epoch: "a1:code-implementer-agent", event: testRun },
    ]);
    expect(ledger.eventsForEpoch(records, "a1:code-implementer-agent")).toEqual([read("/a.ts"), testRun]);
    expect(ledger.eventsForEpoch(records, "other:agent")).toEqual([]);
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
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), "a:b")).toEqual([read("/ok.ts"), testRun]);
  });
});

describe("machine binding lifecycle", () => {
  it("bind → sole binding → unbind → gone", async () => {
    const s = sid("s2");
    expect(ledger.readBindings(s)).toEqual([]);
    await ledger.bindMachineAgent(s, "code-implementer-agent", "a-1");
    expect(ledger.readBindings(s)).toEqual([
      { agentId: "a-1", agentType: "code-implementer-agent", epoch: "a-1:code-implementer-agent" },
    ]);
    expect(ledger.soleActiveBinding(s)?.epoch).toBe("a-1:code-implementer-agent");
    await ledger.unbindMachineAgent(s, "code-implementer-agent", "a-1");
    expect(ledger.readBindings(s)).toEqual([]);
    expect(existsSync(ledger.machineBindingPath(s))).toBe(false);
  });

  it("a fresh bind truncates the previous run's ledger (epochs make leftovers inert anyway)", async () => {
    const s = sid("s3");
    await ledger.bindMachineAgent(s, "code-implementer-agent", "a-1");
    ledger.appendEvidence(s, "a-1:code-implementer-agent", [read("/old.ts")]);
    await ledger.unbindMachineAgent(s, "code-implementer-agent", "a-1");

    await ledger.bindMachineAgent(s, "code-implementer-agent", "a-2");
    expect(ledger.readEvidence(s)).toEqual([]);
    // Even if truncation had failed, the new epoch sees nothing:
    expect(ledger.eventsForEpoch(ledger.readEvidence(s), "a-2:code-implementer-agent")).toEqual([]);
    await ledger.unbindMachineAgent(s, "code-implementer-agent", "a-2");
  });

  it("logs skipped malformed binding lines instead of silently dropping them", () => {
    const s = sid("s6");
    writeFileSync(ledger.machineBindingPath(s), "garbage-line-without-a-tab\na-1\tcode-implementer-agent\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(ledger.readBindings(s)).toEqual([
        { agentId: "a-1", agentType: "code-implementer-agent", epoch: "a-1:code-implementer-agent" },
      ]);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("skipped 1 malformed binding line(s)");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a leaked binding — the sole active agent is NOT the bound one — voids attribution", async () => {
    const s = sid("s7");
    await ledger.bindMachineAgent(s, "code-implementer-agent", "a-1");
    // a-1's binding leaked (its cleanup was lost); a-9 is the agent running
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-9\n");
    expect(ledger.soleActiveBinding(s)).toBeNull();
    // the bound agent itself active → attribution restored
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    expect(ledger.soleActiveBinding(s)?.agentId).toBe("a-1");
    await ledger.unbindMachineAgent(s, "code-implementer-agent", "a-1");
  });

  it("contention: second binding or second active agent voids soleActiveBinding", async () => {
    const s = sid("s4");
    await ledger.bindMachineAgent(s, "code-implementer-agent", "a-1");
    expect(ledger.soleActiveBinding(s)).not.toBeNull();

    // Same-type parallel binding → no attribution
    await ledger.bindMachineAgent(s, "code-implementer-agent", "a-2");
    expect(ledger.soleActiveBinding(s)).toBeNull();
    await ledger.unbindMachineAgent(s, "code-implementer-agent", "a-2");
    expect(ledger.soleActiveBinding(s)).not.toBeNull();

    // A second ACTIVE subagent (any type, no machine) also voids it
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\na-9\n");
    expect(ledger.soleActiveBinding(s)).toBeNull();
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    expect(ledger.soleActiveBinding(s)).not.toBeNull();

    await ledger.unbindMachineAgent(s, "code-implementer-agent", "a-1");
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
