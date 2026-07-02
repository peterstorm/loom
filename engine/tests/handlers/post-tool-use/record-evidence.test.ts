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
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import recordEvidence from "../../../src/handlers/post-tool-use/record-evidence";
import {
  appendEvidence,
  bindMachineAgent,
  ledgerPath,
  machineBindingPath,
  readEvidence,
  unbindMachineAgent,
} from "../../../src/machine/ledger";
import { epochOf, parseAgentId, parseAgentType } from "../../../src/machine/evidence";
import { SUBAGENT_DIR } from "../../../src/config";

const run = `record-evidence-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;
const sessions = ["contended", "leaked", "ungated", "forged-report", "honest-report"].map(sid);

afterAll(() => {
  for (const s of sessions) {
    for (const path of [ledgerPath(s), machineBindingPath(s), `${SUBAGENT_DIR}/${s}.active`]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

async function bind(session: string, type: string, id: string): Promise<void> {
  const agentType = parseAgentType(type);
  const agentId = parseAgentId(id);
  if (!agentType || !agentId) throw new Error(`test fixture: invalid identity ${type}/${id}`);
  await bindMachineAgent(session, agentType, agentId);
}

const post = (session: string, tool: string, input: Record<string, unknown> = {}) =>
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
      await unbindMachineAgent(s, "code-implementer-agent", "a-1");
      await unbindMachineAgent(s, "code-implementer-agent", "a-2");
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
      await unbindMachineAgent(s, "code-implementer-agent", "a-1");
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
    appendEvidence(s, epoch, [{ kind: "FileWrite", path: reportPath }]);

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

    await unbindMachineAgent(s, "code-implementer-agent", "a-1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("control: an --outputFile NOT written by the agent still vouches (report parsed)", async () => {
    const s = sid("honest-report");
    const dir = mkdtempSync(join(tmpdir(), "loom-honest-report-"));
    const reportPath = join(dir, "results.json");
    await bind(s, "code-implementer-agent", "a-1");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n");
    // Written by the runner (no FileWrite in the epoch), fresh mtime.
    writeFileSync(reportPath, JSON.stringify({ numTotalTests: 5, numFailedTests: 0 }));

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

    const events = readEvidence(s).map((r) => r.event);
    const testRun = events.find((e) => e.kind === "TestRun");
    expect(testRun && testRun.kind === "TestRun" && testRun.report).toEqual({
      total: 5,
      failed: 0,
      source: "vitest-json",
    });

    await unbindMachineAgent(s, "code-implementer-agent", "a-1");
    rmSync(dir, { recursive: true, force: true });
  });
});
