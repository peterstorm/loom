/**
 * INV-4 matrix: one evidence minting rule for both harnesses (SC-007, AS-036).
 *
 * The same tool-call fixtures are delivered through both sibling entry points
 * of the owner module `engine/src/machine/tool-evidence-recorder.ts`:
 * - Claude Code: the PostToolUse recorder `runRecordEvidence`, fed hook
 *   payloads (`engine/src/handlers/post-tool-use/record-evidence.ts`);
 * - Pi: the child `tool_result` recorder (`pi/evidence-recorder.ts`), fed Pi
 *   tool-result events.
 * Both write into one in-memory registry. The matrix asserts that the two
 * ledgers hold identical facts, with identical idempotency keys, in identical
 * order, and that those facts are the expected ones, so identity is never
 * vacuous. Rows cover read, write, edit, multi-edit, a failed file tool, a
 * bash redirect, mv / git mv / cp, an unrelated tool, and test runs with a
 * Vitest JSON report, a Bun JUnit report, a stale report and an
 * agent-authored report.
 *
 * A source scan pins the rule's ownership: no production module but the two
 * owners mints (`extractEvidence(`) or appends (`.appendEvidence(`).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runRecordEvidence } from "../../src/handlers/post-tool-use/record-evidence";
import {
  epochOf,
  eventsForEpoch,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type AgentId,
  type SessionId,
  type SessionTaskGraphPointerBinding,
} from "../../src/machine";
import type { EvidenceRecord } from "../../src/machine/types";
import { claudeToolCall, piToolCall } from "../../src/core/harness-tool-call";
import { createPiEvidenceRecorder } from "../../../pi/evidence-recorder";
import { createPiChildWriteGrants } from "../../../pi/child-write-grant";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { inMemorySessionRegistry } from "./fake-session-registry";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const temp = canonicalTempDir("loom-evidence-minting-matrix-");
const repo = join(temp, "repo");
mkdirSync(join(repo, "src"), { recursive: true });

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

const session = (raw: string): SessionId => {
  const parsed = parseSessionId(raw);
  if (parsed === null) throw new Error(`fixture session ${raw} must parse`);
  return parsed;
};
const agent = (raw: string): AgentId => {
  const parsed = parseAgentId(raw);
  if (parsed === null) throw new Error(`fixture agent ${raw} must parse`);
  return parsed;
};
const IMPLEMENTER = (() => {
  const parsed = parseAgentType("code-implementer-agent");
  if (parsed === null) throw new Error("fixture agent type must parse");
  return parsed;
})();

// ─── Fixtures: one tool call, described once, spelled per harness ─────────

type Row = Readonly<{
  name: string;
  claude: Readonly<{ tool_name: string; tool_input: Record<string, unknown>; tool_response: unknown }>;
  pi: Readonly<{ toolName: string; input: Record<string, unknown>; content: unknown; isError: boolean; details?: unknown }>;
  /** What the tool did on disk, between its call-start stamp and its result. */
  effect?: () => void;
}>;

const text = (value: string) => [{ type: "text", text: value }];
const abs = (path: string): string => join(repo, path);

function vitestJson(failed: boolean): string {
  return JSON.stringify({
    numTotalTestSuites: 1,
    numPassedTestSuites: failed ? 0 : 1,
    numFailedTestSuites: failed ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: failed ? 0 : 1,
    numFailedTests: failed ? 1 : 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: Date.now(),
    success: !failed,
    testResults: [{
      name: abs("tests/feature.test.ts"),
      status: failed ? "failed" : "passed",
      message: "",
      startTime: Date.now(),
      endTime: Date.now(),
      assertionResults: [{
        ancestorTitles: ["feature"],
        fullName: "feature works",
        title: "works",
        status: failed ? "failed" : "passed",
        duration: 1,
        failureMessages: failed ? ["AssertionError"] : [],
      }],
    }],
  });
}

const JUNIT = '<testsuites><testsuite name="tests/feature.test.ts" tests="2" failures="0">' +
  '<testcase classname="tests/feature.test.ts" name="a"/><testcase classname="tests/feature.test.ts" name="b"/>' +
  "</testsuite></testsuites>";

const vitestReport = join(temp, "vitest-report.json");
const junitReport = join(temp, "bun-report.xml");
const staleReport = join(temp, "stale-report.json");
const stagedReport = join(temp, "staged-report.json");

function bashRow(name: string, command: string, exit: number, stdout = "", effect?: () => void): Row {
  return {
    name,
    claude: { tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false, exit_code: exit } },
    pi: { toolName: "bash", input: { command }, content: text(stdout), isError: exit !== 0, details: undefined },
    effect,
  };
}

function fileRow(name: string, claudeTool: string, piTool: string, path: string, extra: Record<string, unknown>, failed = false): Row {
  return {
    name,
    claude: {
      tool_name: claudeTool,
      tool_input: { file_path: path, ...extra },
      tool_response: failed ? { is_error: true, error: "old_string not found" } : { filePath: path },
    },
    pi: { toolName: piTool, input: { path, ...extra }, content: text(failed ? "Could not find text" : "ok"), isError: failed },
  };
}

const ROWS: readonly Row[] = [
  fileRow("read", "Read", "read", abs("README.md"), {}),
  fileRow("write", "Write", "write", abs("notes.md"), { content: "notes\n" }),
  fileRow("edit", "Edit", "edit", abs("src/feature.ts"), { old_string: "0", new_string: "1" }),
  fileRow("multi-edit", "MultiEdit", "multi_edit", abs("src/multi.ts"), { edits: [] }),
  fileRow("failed edit mints nothing", "Edit", "edit", abs("src/missing.ts"), { old_string: "x", new_string: "y" }, true),
  fileRow("unrelated tool mints nothing", "Grep", "grep", abs("src"), { pattern: "x" }),
  bashRow("bash redirect", "printf 'log\\n' > build.log", 0),
  bashRow("mv", "mv build.log build.moved.log", 0),
  bashRow("git mv", "git mv src/legacy.ts src/renamed.ts", 0),
  bashRow("cp", "cp README.md docs.md", 0),
  bashRow(
    "vitest run with a fresh JSON report",
    `npx vitest run tests/feature.test.ts --reporter=json --outputFile=${vitestReport}`,
    1,
    " Tests  1 failed (1)\n",
    () => writeFileSync(vitestReport, vitestJson(true)),
  ),
  bashRow(
    "bun run with a fresh JUnit report",
    `bun test --reporter=junit --reporter-outfile=${junitReport}`,
    0,
    "2 pass\n0 fail\n",
    () => writeFileSync(junitReport, JUNIT),
  ),
  bashRow("stale report cannot vouch", `npx vitest run --reporter=json --outputFile=${staleReport}`, 0),
  fileRow("agent stages a report", "Write", "write", stagedReport, { content: vitestJson(false) }),
  bashRow("agent-authored report cannot vouch", `npx vitest run --reporter=json --outputFile=${stagedReport}`, 0),
  bashRow("failing bun run without a report", "bun test tests/feature.test.ts", 1, "0 pass\n1 fail\n"),
];

/** The facts the rows must mint, in order (report summaries checked by shape). */
const EXPECTED = [
  { kind: "FileRead", path: abs("README.md") },
  { kind: "FileWrite", path: abs("notes.md"), via: "tool" },
  { kind: "FileWrite", path: abs("src/feature.ts"), via: "tool" },
  { kind: "FileWrite", path: abs("src/multi.ts"), via: "tool" },
  { kind: "FileWrite", path: abs("build.log"), via: "shell" },
  { kind: "FileWrite", path: abs("build.moved.log"), via: "shell" },
  { kind: "FileWrite", path: abs("src/renamed.ts"), via: "shell" },
  { kind: "FileWrite", path: abs("docs.md"), via: "shell" },
  {
    kind: "TestRun",
    command: `npx vitest run tests/feature.test.ts --reporter=json --outputFile=${vitestReport}`,
    exit: 1,
    report: expect.objectContaining({ total: 1, failed: 1, source: "vitest-json" }),
  },
  {
    kind: "TestRun",
    command: `bun test --reporter=junit --reporter-outfile=${junitReport}`,
    exit: 0,
    report: expect.objectContaining({ total: 2, failed: 0 }),
  },
  { kind: "TestRun", command: `npx vitest run --reporter=json --outputFile=${staleReport}`, exit: 0, report: null },
  { kind: "FileWrite", path: stagedReport, via: "tool" },
  { kind: "TestRun", command: `npx vitest run --reporter=json --outputFile=${stagedReport}`, exit: 0, report: null },
  { kind: "TestRun", command: "bun test tests/feature.test.ts", exit: 1, report: null },
];

// ─── Delivery through each sibling entry point ────────────────────────────

const registry = inMemorySessionRegistry();
const claudeSession = session("matrix-claude-session");
const claudeAgent = agent("claude-impl-1");
const parentSession = session("matrix-pi-parent-session");
const childSession = session("matrix-pi-child-session");
const piGrantAgent = agent("pi-grant-0123456789abcdef");
const pointer = { directory: "/state", pointerName: "p", registryName: "r", target: "/graph.json" } as unknown as SessionTaskGraphPointerBinding;

const callIdFor = (index: number): string => `call-${index}`;

/** A stale report that already sits on disk before either delivery. */
function stageStaleReport(): void {
  writeFileSync(staleReport, vitestJson(false));
  const longAgo = new Date(Date.now() - 60 * 60_000);
  utimesSync(staleReport, longAgo, longAgo);
}

async function deliverToClaude(): Promise<void> {
  await registry.markActive(claudeSession, claudeAgent);
  await registry.bind(claudeSession, IMPLEMENTER, claudeAgent);
  for (const [index, row] of ROWS.entries()) {
    const callId = callIdFor(index);
    await registry.recordCallStart(claudeSession, callId, Date.now());
    row.effect?.();
    await runRecordEvidence(JSON.stringify({
      session_id: claudeSession,
      agent_id: claudeAgent,
      cwd: repo,
      tool_use_id: callId,
      ...row.claude,
    }), registry);
  }
}

async function deliverToPi(): Promise<void> {
  const grants = createPiChildWriteGrants();
  grants.active.set(childSession, {
    kind: "active",
    agentId: piGrantAgent,
    pointerBinding: pointer,
    evidenceLedger: { sessionId: parentSession, agentType: IMPLEMENTER },
  });
  const recorder = createPiEvidenceRecorder(grants, {
    registry,
    nowMs: () => Date.now(),
    writeStderr: () => undefined,
  });
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => childSession } };
  for (const [index, row] of ROWS.entries()) {
    const callId = callIdFor(index);
    // The child's `tool_call` guard stamps under the CHILD session.
    await registry.recordCallStart(childSession, callId, Date.now());
    row.effect?.();
    recorder.recordToolResult({ type: "tool_result", toolCallId: callId, ...row.pi }, ctx);
  }
}

const keyed = (records: readonly EvidenceRecord[], epoch: string) =>
  records.filter((record) => record.epoch === epoch).map(({ event, callId }) => ({ event, callId }));

describe("INV-4: one evidence minting rule for both harnesses", () => {
  it("AS-036: the same fixtures through Claude Code's recorder and the Pi child recorder mint identical facts in identical order", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      stageStaleReport();
      await deliverToClaude();
      stageStaleReport();
      await deliverToPi();
    } finally {
      vi.restoreAllMocks();
    }

    const claudeEpoch = epochOf(claudeAgent, IMPLEMENTER);
    const piEpoch = epochOf(piGrantAgent, IMPLEMENTER);
    const claudeFacts = eventsForEpoch(registry.readEvidence(claudeSession), claudeEpoch);
    const piFacts = eventsForEpoch(registry.readEvidence(parentSession), piEpoch);

    expect(claudeFacts).toEqual(EXPECTED);
    expect(piFacts).toEqual(claudeFacts);
    // Same idempotency keys, record for record.
    expect(keyed(registry.readEvidence(parentSession), piEpoch))
      .toEqual(keyed(registry.readEvidence(claudeSession), claudeEpoch));
    // The Pi child records into the parent's ledger only, never its own.
    expect(registry.readEvidence(childSession)).toEqual([]);
  });

  it("both harness adapters normalize every row to the same tool, outcome and call id", () => {
    for (const [index, row] of ROWS.entries()) {
      const claude = claudeToolCall({ ...row.claude, tool_use_id: callIdFor(index), cwd: repo });
      const pi = piToolCall({ toolCallId: callIdFor(index), ...row.pi }, repo);
      const { input: _claudeInput, ...claudeRest } = claude;
      const { input: _piInput, ...piRest } = pi;
      expect(piRest, row.name).toEqual(claudeRest);
    }
  });

  it("both harness adapters read an inherited object key as an unrelated tool, never a prototype member", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const claude = claudeToolCall({ tool_name: name, tool_input: {}, tool_response: {}, tool_use_id: "call-x", cwd: repo });
      const pi = piToolCall({ toolName: name, toolCallId: "call-x", input: {}, content: [], isError: false }, repo);
      expect(claude, name).toEqual({ tool: "Other", input: {}, callId: "call-x", cwd: repo });
      expect(pi, name).toEqual(claude);
    }
  });

  it("only the owner modules mint or append ledger facts (source scan of engine/src and pi)", () => {
    const allowed = new Set([
      "engine/src/machine/extract-evidence.ts",
      "engine/src/machine/tool-evidence-recorder.ts",
    ]);
    const pattern = /\bextractEvidence\(|\.appendEvidence\(/;
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        if (name === "node_modules") continue;
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) {
          const repositoryPath = relative(ROOT, path);
          if (!allowed.has(repositoryPath) && pattern.test(readFileSync(path, "utf-8"))) offenders.push(repositoryPath);
        }
      }
    };
    walk(join(ROOT, "engine", "src"));
    walk(join(ROOT, "pi"));
    expect(offenders).toEqual([]);
  });
});
