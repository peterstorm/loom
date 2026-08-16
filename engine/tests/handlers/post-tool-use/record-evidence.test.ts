/**
 * The recorder's NEVER-BLOCKS contract, pinned on degenerate input: whatever
 * arrives on stdin — empty, malformed, identity-less, or input that makes
 * the internals throw — the handler returns a passthrough result. The
 * PreToolUse gate is the blocking half; a recorder that could block would
 * turn an evidence bug into a bricked session.
 *
 * Also pins the contended-session stderr note (the recorder used to stand
 * down silently while the gate logged) and the path-traversal fail-safe.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recordEvidence from "../../../src/handlers/post-tool-use/record-evidence";
import {
  appendEvidence,
  bindMachineAgent,
  ledgerPath,
  machineBindingPath,
  readEvidence,
  recordCallStart,
  unbindMachineAgent,
} from "../../../src/machine/ledger";
import {
  CALL_START_SUFFIX,
  epochOf,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type SessionId,
} from "../../../src/machine/evidence";
import { SUBAGENT_DIR } from "../../../src/config";

const run = `record-evidence-${process.pid}-${Date.now()}`;
// Ledger API takes the branded SessionId; parse once at construction.
const sid = (name: string) => parseSessionId(`${run}-${name}`)!;
const sessions = ["contended", "leaked", "ungated", "forged-report", "honest-report", "one-call-forge", "dup-delivery", "stale-artifact"].map(sid);

afterAll(() => {
  for (const s of sessions) {
    for (const path of [ledgerPath(s), machineBindingPath(s), `${SUBAGENT_DIR}/${s}.active`, `${SUBAGENT_DIR}/${s}${CALL_START_SUFFIX}`]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

async function bind(session: SessionId, type: string, id: string): Promise<void> {
  const agentType = parseAgentType(type);
  const agentId = parseAgentId(id);
  if (!agentType || !agentId) throw new Error(`test fixture: invalid identity ${type}/${id}`);
  await bindMachineAgent(session, agentType, agentId);
}

const post = (session: SessionId, tool: string, input: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: session, tool_name: tool, tool_input: input, cwd: "/tmp" });

describe("recorder never blocks — degenerate input contract", () => {
  it("empty stdin → passthrough", async () => {
    expect((await recordEvidence("", [])).kind).toBe("passthrough");
    expect((await recordEvidence("   ", [])).kind).toBe("passthrough");
  });

  it("malformed JSON → passthrough with a stderr note, never a block", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await recordEvidence("{not json", []);
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough");
    expect(text).toContain("record-evidence:");
  });

  it("missing session_id or tool_name → passthrough", async () => {
    expect((await recordEvidence(JSON.stringify({ tool_name: "Read" }), [])).kind).toBe("passthrough");
    expect((await recordEvidence(JSON.stringify({ session_id: "s-1" }), [])).kind).toBe("passthrough");
    expect((await recordEvidence(JSON.stringify({}), [])).kind).toBe("passthrough");
  });

  it("an internal throw (path-traversal session id) → passthrough + stderr, nothing written", async () => {
    const evil = "../../record-evidence-escape";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await recordEvidence(
      JSON.stringify({ session_id: evil, tool_name: "Read", tool_input: { file_path: "/a" } }),
      [],
    );
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();
    expect(result.kind).toBe("passthrough"); // never a block — fail-safe is standing down
    expect(text).toContain("invalid session id");
    expect(existsSync(`${SUBAGENT_DIR}/${evil}.evidence.jsonl`)).toBe(false);
  });
});

describe("recorder stands down LOUDLY on unattributable gated sessions", () => {
  it("contended (two bindings): stderr note + nothing recorded", async () => {
    const s = sid("contended");
    await bind(s, "code-implementer-agent", "a-1");
    await bind(s, "code-implementer-agent", "a-2");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\na-2\n");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await recordEvidence(post(s, "Read", { file_path: "/a" }), []);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(result.kind).toBe("passthrough");
      expect(text).toContain(`standing down for ${s}`);
      expect(readEvidence(s)).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
      await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
      await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-2")!);
    }
  });

  it("leaked binding (empty roster): stderr note + nothing recorded", async () => {
    const s = sid("leaked");
    await bind(s, "code-implementer-agent", "a-1");
    // no .active roster at all — the leaked-binding shape
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await recordEvidence(post(s, "Read", { file_path: "/a" }), []);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(result.kind).toBe("passthrough");
      expect(text).toContain(`standing down for ${s}`);
      expect(readEvidence(s)).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
      await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
    }
  });

  it("ungated session (no binding file): silent passthrough — no stderr noise", async () => {
    const s = sid("ungated");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await recordEvidence(post(s, "Read", { file_path: "/a" }), []);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(result.kind).toBe("passthrough");
      expect(text).not.toContain("standing down");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("agent-authored --outputFile artifacts cannot vouch (epoch FileWrite veto)", () => {
  it("an explicit --outputFile the agent WROTE this epoch is rejected loudly — TestRun keeps report: null", async () => {
    const s = sid("forged-report");
    const dir = mkdtempSync(join(tmpdir(), "loom-forged-report-"));
    const reportPath = join(dir, "results.json");
    const epoch = epochOf(parseAgentId("a-1")!, parseAgentType("code-implementer-agent")!);
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    // The agent wrote the "report" itself (a FileWrite in its own epoch)…
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 5, numFailedTests: 0 }));
    appendEvidence(s, epoch, [{ kind: "FileWrite", path: reportPath, via: "tool" }]);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // …then ran a "test" whose --outputFile points at that very file.
      const result = await recordEvidence(
        JSON.stringify({
          session_id: s,
          tool_name: "Bash",
          tool_input: { command: `npx vitest run --outputFile=${reportPath}` },
          tool_response: { exit_code: 0, stdout: "" },
          cwd: dir,
        }),
        [],
      );
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain(`rejecting --outputFile '${reportPath}'`);
    } finally {
      stderrSpy.mockRestore();
    }

    const events = readEvidence(s).map((r) => r.event);
    const testRun = events.find((e) => e.kind === "TestRun");
    expect(testRun).toBeDefined();
    // report: null → judgeTestRun says untrusted, never trusted-pass.
    expect(testRun && testRun.kind === "TestRun" && testRun.report).toBeNull();

    await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ONE-call staging is vetoed too: `printf '{…}' > r.json; npx vitest --outputFile=r.json` cannot vouch (round-10 Fix 1)", async () => {
    const s = sid("one-call-forge");
    const dir = mkdtempSync(join(tmpdir(), "loom-one-call-forge-"));
    const reportPath = join(dir, "r.json");
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    // The forged artifact exists and is fresh, exactly as if the printf in
    // the SAME command line had just written it. The persisted ledger is
    // EMPTY — only the current call's own shell-write targets can veto.
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 5, numFailedTests: 0 }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await recordEvidence(
        JSON.stringify({
          session_id: s,
          tool_name: "Bash",
          tool_input: {
            command: `printf '{"numTotalTests":5,"numFailedTests":0}' > ${reportPath}; npx vitest --version --outputFile=${reportPath}`,
          },
          tool_response: { exit_code: 0, stdout: "" },
          cwd: dir,
        }),
        [],
      );
      expect(result.kind).toBe("passthrough");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain(`rejecting --outputFile '${reportPath}'`);
    } finally {
      stderrSpy.mockRestore();
    }

    const events = readEvidence(s).map((r) => r.event);
    const testRun = events.find((e) => e.kind === "TestRun");
    expect(testRun).toBeDefined();
    // report: null → judgeTestRun says untrusted — never a forged trusted-pass.
    expect(testRun && testRun.kind === "TestRun" && testRun.report).toBeNull();
    // The staged target itself was minted as a SHELL write (never advances guards).
    const staged = events.find((e) => e.kind === "FileWrite");
    expect(staged && staged.kind === "FileWrite" && staged.via).toBe("shell");

    await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a RELATIVE staged target is vetoed against the call's cwd (mint-time resolution, round-10 Fix 8)", async () => {
    // Distinct session id: a bind no longer unlinks the ledger (that delete
    // raced unlocked appendEvidence writers), so sharing the previous test's
    // session would let its FileWrite leak into this one's lookup.
    const s = sid("relative-forge");
    const dir = mkdtempSync(join(tmpdir(), "loom-relative-forge-"));
    const reportPath = join(dir, "r.json");
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 5, numFailedTests: 0 }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // First call stages via a RELATIVE redirect target…
      await recordEvidence(
        JSON.stringify({
          session_id: s,
          tool_name: "Bash",
          tool_input: { command: "printf '{}' > r.json" },
          tool_response: { exit_code: 0, stdout: "" },
          cwd: dir,
        }),
        [],
      );
      // …second call vouches with the ABSOLUTE path. The ledger recorded the
      // stage resolved against the FIRST call's cwd, so the veto still hits.
      await recordEvidence(
        JSON.stringify({
          session_id: s,
          tool_name: "Bash",
          tool_input: { command: `npx vitest --version --outputFile=${reportPath}` },
          tool_response: { exit_code: 0, stdout: "" },
          cwd: dir,
        }),
        [],
      );
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain(`rejecting --outputFile '${reportPath}'`);
    } finally {
      stderrSpy.mockRestore();
    }
    const staged = readEvidence(s).map((r) => r.event).find((e) => e.kind === "FileWrite");
    // Mint-time resolution: the ledger carries the absolute path.
    expect(staged && staged.kind === "FileWrite" && staged.path).toBe(reportPath);

    await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
    rmSync(dir, { recursive: true, force: true });
  });

  it("control: a call-start-stamped --outputFile NOT written by the agent still vouches (report parsed)", async () => {
    const s = sid("honest-report");
    const dir = mkdtempSync(join(tmpdir(), "loom-honest-report-"));
    const reportPath = join(dir, "results.json");
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    // The PreToolUse hook stamped the call start, THEN the runner wrote the
    // report (no FileWrite in the epoch, mtime after the stamp).
    await recordCallStart(s, "toolu_honest", Date.now());
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 5, numFailedTests: 0 }));

    const result = await recordEvidence(
      JSON.stringify({
        session_id: s,
        tool_name: "Bash",
        tool_input: { command: `npx vitest run --outputFile=${reportPath}` },
        tool_response: { exit_code: 0, stdout: "" },
        tool_use_id: "toolu_honest",
        cwd: dir,
      }),
      [],
    );
    expect(result.kind).toBe("passthrough");

    const events = readEvidence(s).map((r) => r.event);
    const testRun = events.find((e) => e.kind === "TestRun");
    expect(testRun && testRun.kind === "TestRun" && testRun.report).toEqual({
      total: 5,
      failed: 0,
      source: "vitest-json",
    });

    await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("call-scoped report freshness (call-start ordering)", () => {
  it("a pre-staged artifact from BEFORE the call start yields report: null even inside the recency window", async () => {
    const s = sid("stale-artifact");
    const dir = mkdtempSync(join(tmpdir(), "loom-stale-artifact-"));
    const reportPath = join(dir, "results.json");
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    // A REAL sibling run's artifact, 5 minutes old — previously (window-only
    // freshness) this re-vouched a later command that ran no tests.
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 5, numFailedTests: 0 }));
    const staleMtime = (Date.now() - 5 * 60 * 1000) / 1000;
    utimesSync(reportPath, staleMtime, staleMtime);
    // THIS call starts now.
    await recordCallStart(s, "toolu_stale", Date.now());

    await recordEvidence(
      JSON.stringify({
        session_id: s,
        tool_name: "Bash",
        tool_input: { command: `npx vitest run --outputFile=${reportPath}` },
        tool_response: { exit_code: 0, stdout: "" },
        tool_use_id: "toolu_stale",
        cwd: dir,
      }),
      [],
    );

    const events = readEvidence(s).map((r) => r.event);
    const testRun = events.find((e) => e.kind === "TestRun");
    expect(testRun).toBeDefined();
    // report: null → judgeTestRun says untrusted — the stale artifact
    // cannot mint a trusted pass for a call it predates.
    expect(testRun && testRun.kind === "TestRun" && testRun.report).toBeNull();

    await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
    rmSync(dir, { recursive: true, force: true });
  });

  it("no call-start stamp (missing tool_use_id) → artifact-backed report rejected loudly, report: null", async () => {
    const s = sid("stale-artifact");
    const dir = mkdtempSync(join(tmpdir(), "loom-no-stamp-"));
    const reportPath = join(dir, "results.json");
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 5, numFailedTests: 0 }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await recordEvidence(
        JSON.stringify({
          session_id: s,
          tool_name: "Bash",
          tool_input: { command: `npx vitest run --outputFile=${reportPath}` },
          tool_response: { exit_code: 0, stdout: "" },
          cwd: dir,
        }),
        [],
      );
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("no call-start stamp");
    } finally {
      stderrSpy.mockRestore();
    }

    const events = readEvidence(s).map((r) => r.event);
    const testRun = events.findLast((e) => e.kind === "TestRun");
    expect(testRun && testRun.kind === "TestRun" && testRun.report).toBeNull();

    await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("duplicated PostToolUse deliveries never double-count (round-10 Fix 6)", () => {
  it("the same tool_use_id delivered twice folds to ONE event set", async () => {
    const s = sid("dup-delivery");
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");

    const delivery = JSON.stringify({
      session_id: s,
      tool_name: "Write",
      tool_input: { file_path: "/tmp/impl.ts" },
      tool_use_id: "toolu_dup_01",
      cwd: "/tmp",
    });
    await recordEvidence(delivery, []);
    await recordEvidence(delivery, []); // re-delivered by the harness

    const records = readEvidence(s);
    expect(records).toHaveLength(2); // both lines land in the append-only ledger…
    const epoch = epochOf(parseAgentId("a-1")!, parseAgentType("code-implementer-agent")!);
    // …but the fold boundary sees the call ONCE.
    const { eventsForEpoch } = await import("../../../src/machine/evidence");
    expect(eventsForEpoch(records, epoch)).toEqual([
      { kind: "FileWrite", path: "/tmp/impl.ts", via: "tool" },
    ]);

    await unbindMachineAgent(s, parseAgentType("code-implementer-agent")!, parseAgentId("a-1")!);
  });
});
