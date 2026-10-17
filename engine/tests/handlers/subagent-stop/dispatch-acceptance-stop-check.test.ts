/**
 * The SubagentStop dispatcher runs the Acceptance Stop Check for an
 * implementation agent BEFORE settlement and cleanup: a blocked stop keeps
 * the same agent working, so it must settle nothing and release nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDispatch } from "../../../src/handlers/subagent-stop/dispatch";
import { UNKEPT_BLOCK_COUNTERS, type StopCheckShellPorts } from "../../../src/handlers/subagent-stop/acceptance-stop-check";
import { publishImplementationAttemptSidecar } from "../../../src/implementation-attempt-sidecar";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
} from "../../../src/core/implementation-completion";
import { freezeVerificationManifest } from "../../../src/core/verification-manifest";
import type { HookHandler } from "../../../src/types";
import { sha256Bytes } from "../../../src/core/digest";
import { parseCanonicalRepositoryRoot } from "../../../src/utils/workspace-digest";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { contract, frozenPaths, stateFileJson, surface, task } from "../../fixtures/contract-status-fixtures";

const SESSION = "stop-check-session";
const AGENT = "agent-stop-check";
const SURFACE = surface("payload");
const roots: string[] = [];
const saved = { dir: process.env.LOOM_SUBAGENT_DIR, state: process.env.LOOM_STATE_PATH, project: process.env.CLAUDE_PROJECT_DIR };

afterEach(() => {
  for (const [key, value] of [["LOOM_SUBAGENT_DIR", saved.dir], ["LOOM_STATE_PATH", saved.state], ["CLAUDE_PROJECT_DIR", saved.project]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = canonicalTempDir("loom-dispatch-stop-check-");
  roots.push(root);
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  process.env.CLAUDE_PROJECT_DIR = root;
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

const manifest = () => {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, kind: "loom-verification-manifest", checks: [],
    acceptanceRunner: {
      executable: "vitest", args: ["run", "{files}"], cwd: ".", timeoutMs: 60_000,
      report: { kind: "required-file", path: ".loom/completion-reports/acceptance.junit.xml" },
    },
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
};

function stateFile(root: string): string {
  const roster = [{ file: SURFACE.acceptance, name: "AS-001: one valid call wins", anchors: ["AS-001"] }] as const;
  const frozenContract = contract({
    id: "CT-1", surface: SURFACE, anchors: ["AS-001"],
    freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster: [...roster] as never },
  });
  const raw = JSON.parse(stateFileJson(
    [task("T1", 1, [SURFACE.types, SURFACE.acceptance]), task("T2", 2, ["src/payload.ts"], ["AS-001"])],
    [frozenContract],
  )) as Record<string, unknown>;
  const path = join(root, "active_task_graph.json");
  writeFileSync(path, JSON.stringify({ ...raw, verification_manifest: manifest() }));
  process.env.LOOM_STATE_PATH = path;
  return path;
}

function sidecar(statePath: string): void {
  const instant = parseIsoInstant("2026-10-14T00:00:00.000Z");
  const reservation = parseReservationId("stop-check-reservation");
  if (!instant.ok || !reservation.ok) throw new Error("fixture identity");
  const authority = createImplementationAttemptAuthority({
    taskId: "T2", wave: 2, semanticAttempt: 1, reservationId: reservation.value, headSha: "a".repeat(40),
    reservedAt: instant.value, taskScopeBaseline: [], dirtySetBaseline: [],
  } as never);
  if (!authority.ok) throw new Error(authority.error.errors.join("; "));
  publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: statePath, authority: authority.value });
  // The session pointer the dispatcher resolves the TaskGraph through.
  mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
}

const stop = JSON.stringify({ session_id: SESSION, agent_id: AGENT, agent_type: "code-implementer-agent", hook_event_name: "SubagentStop" });

/** Ports that never decide: the repository root is unavailable, so the check notes and the stop proceeds. */
const inertPorts = (): StopCheckShellPorts => ({
  repositoryRoot: () => ({ ok: false, reason: "repository root unavailable in this fixture" }),
  acquireRunner: () => ({ kind: "acquired", release: () => null }),
  runCheck: async () => { throw new Error("unused"); },
  readReport: () => new Uint8Array(),
  blocks: UNKEPT_BLOCK_COUNTERS,
  pathExists: () => true,
  now: () => Date.now(),
});

describe("dispatch runs the Acceptance Stop Check before settlement", () => {
  it("returns the block, and neither settles the Task nor runs cleanup", async () => {
    const root = project();
    const statePath = stateFile(root);
    sidecar(statePath);
    const before = readFileSync(statePath);
    const cleanupCalls: string[] = [];
    const cleanup: HookHandler = async (stdin) => { cleanupCalls.push(stdin); return { kind: "passthrough" }; };
    // The real check with a runner that reports the owed testcase failing.
    const ports: StopCheckShellPorts = {
      ...inertPorts(),
      repositoryRoot: () => {
        const parsed = parseCanonicalRepositoryRoot(root);
        return parsed.ok ? { ok: true, root: parsed.value } : { ok: false, reason: "root" };
      },
      runCheck: async (check) => {
        const bytes = new TextEncoder().encode(
          `<testsuites tests="1" failures="1"><testsuite name="s" tests="1" failures="1"><testcase classname="${SURFACE.acceptance}" name="AS-001: one valid call wins">` +
          `<failure type="AssertionError"/></testcase></testsuite></testsuites>`);
        writeFileSync(join(root, "report.xml"), bytes);
        return {
          ok: true,
          value: {
            checkResult: {
              checkId: check.checkId, scope: "wave",
              outcome: { kind: "observed", exitCode: 1, timedOut: false, signal: null,
                report: { kind: "produced", path: "report.xml", digest: sha256Bytes(bytes), byteLength: bytes.byteLength } },
            },
            diagnostics: { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
          },
        } as never;
      },
      readReport: (path) => readFileSync(path),
    };

    const result = await runDispatch(stop, [], cleanup, ports);

    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("AS-001: one valid call wins") });
    expect(cleanupCalls).toEqual([]);
    expect(readFileSync(statePath).equals(before)).toBe(true);
  });

  it("lets the stop through to settlement and cleanup when the check cannot decide", async () => {
    const root = project();
    const statePath = stateFile(root);
    sidecar(statePath);
    const cleanupCalls: string[] = [];
    const cleanup: HookHandler = async (stdin) => { cleanupCalls.push(stdin); return { kind: "passthrough" }; };

    const result = await runDispatch(stop, [], cleanup, inertPorts());

    expect(result.kind).not.toBe("block");
    // It reached settlement: the graph resolved, and cleanup ran after it.
    expect(JSON.stringify(result)).not.toContain("no task graph resolvable");
    expect(cleanupCalls).toHaveLength(1);
    // The operator is told why the check did not decide.
    if (result.kind === "passthrough") {
      expect(result.systemMessage).toContain("did not decide (repository root unavailable in this fixture)");
    }
  });

  it("turns a crashing check into an operator note and still settles", async () => {
    const root = project();
    const statePath = stateFile(root);
    sidecar(statePath);
    const cleanupCalls: string[] = [];
    const cleanup: HookHandler = async (stdin) => { cleanupCalls.push(stdin); return { kind: "passthrough" }; };
    const ports: StopCheckShellPorts = {
      ...inertPorts(),
      repositoryRoot: () => { throw new Error("git exploded"); },
    };

    const result = await runDispatch(stop, [], cleanup, ports);

    expect(result.kind).not.toBe("block");
    expect(cleanupCalls).toHaveLength(1);
    if (result.kind === "passthrough") expect(result.systemMessage).toContain("crashed and did not decide: git exploded");
  });
});
