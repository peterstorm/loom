/**
 * Handler tests for `helper red-then-green-status`: the read-only shell that
 * parses `--task <id>`, loads the TaskGraph, resolves the Task's live attempt
 * through the injected `liveAttemptEvidence` port (never under Pi), renders
 * through the pure Red-Then-Green Status core and writes stdout, or refuses.
 *
 * Every rendered expectation is either spelled through the core's exported
 * text constants or compared against `renderRedThenGreenStatus` on the same
 * inputs, so these tests pin the shell's wiring, not a second grammar.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import redThenGreenStatus, {
  createRedThenGreenStatusHandler,
  type RedThenGreenStatusPorts,
} from "../../../src/handlers/helpers/red-then-green-status";
import type { LiveAttemptEvidence, LiveAttemptEvidenceFn } from "../../../src/handlers/helpers/stop-check-plan";
import { redThenGreenFailureKind } from "../../../src/core/red-then-green";
import {
  GREEN_STEP,
  IMPLEMENTATION_FILES_HEADING,
  IMPLEMENTATION_WRITE_STEP,
  LIVE_NONE,
  LIVE_NOT_JUDGED,
  LIVE_NOT_OBSERVABLE,
  LIVE_PREFIX,
  LIVE_UNINSPECTABLE,
  LIVE_UNREADABLE,
  NO_TEST_FILES,
  NOT_OWED_REASON_TEXT,
  RED_STEP,
  RTG_NOT_OWED,
  RTG_OWES,
  SHOWN,
  STORED_PENDING,
  STORED_PREFIX,
  TEST_FILES_HEADING,
  UNTRUSTED_ONLY_SUFFIX,
  renderRedThenGreenStatus,
  type RedThenGreenLiveInput,
} from "../../../src/core/red-then-green-status";
import type { RedThenGreenGap } from "../../../src/core/red-then-green-types";
import { UNKNOWN_TASK_PREFIX } from "../../../src/core/stop-check-plan-types";
import type { FrozenVerificationManifest } from "../../../src/core/verification-manifest";
import { COVERED_BY_ACCEPTANCE_CONTRACT } from "../../../src/core/verification-policy";
import { WHITELISTED_HELPERS } from "../../../src/config";
import { KNOWN_HANDLERS, PI_RUNTIME_HANDSHAKE_ROUTES, piRuntimeHandshakeRequired } from "../../../src/handler-routes";
import { DEFAULT_PURE_MODULES } from "../../../src/linter/programmatic/no-io-in-pure-modules";
import type { Evidence } from "../../../src/machine/types";
import { StateManager } from "../../../src/state-manager";
import type { HookResult, Task, TaskGraph } from "../../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../../src/utils/workspace-digest";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { gitProject, statePathIn, writeStateFile } from "../../fixtures/contract-status-fixtures";
import {
  FILES,
  FIXTURE,
  GREEN_COMMAND,
  I6_MANIFEST,
  IMPL,
  IMPL_ONLY,
  OWED_ERA,
  RED_COMMAND,
  TEST_A,
  TEST_B,
  UNTRUSTED_RED_EVENTS,
  base,
  failedProof,
  failing,
  passing,
  report,
  requiredTask,
  waivedTask,
} from "../../fixtures/red-then-green-status-fixtures";
import { graphFixture, protectedGraphFixture, satisfiedProof, taskFixture } from "../../fixtures/task-lifecycle";

// --- Fixtures unique to the helper ---

/** The canonical repository root a live epoch is judged against, as the production port mints one. */
const ROOT: CanonicalRepositoryRoot = (() => {
  const parsed = parseCanonicalRepositoryRoot(canonicalTempDir("loom-red-then-green-status-root-"));
  if (!parsed.ok) throw new Error(`fixture repository root is not canonical: ${parsed.error.kind}`);
  return parsed.value;
})();

/** A TaskGraph's State File text, after proving the production parser admits it. */
function graphJson(tasks: readonly Task[], manifest?: FrozenVerificationManifest): string {
  const raw = {
    spec_trace_version: 2,
    ...graphFixture(tasks),
    ...(manifest === undefined ? {} : { verification_manifest: manifest }),
  };
  protectedGraphFixture(JSON.parse(JSON.stringify(raw)));
  return JSON.stringify(raw);
}

const OWED_JSON = (): string => graphJson([requiredTask("T1", OWED_ERA)], I6_MANIFEST);

// --- Ledger events ---

const SHOWN_EVENTS: readonly Evidence[] = [
  { kind: "TestRun", command: RED_COMMAND, exit: 1, report: report([failing(TEST_A), passing(TEST_B)]) },
  { kind: "FileWrite", path: IMPL, via: "tool" },
  { kind: "TestRun", command: GREEN_COMMAND, exit: 0, report: report([passing(TEST_A), passing(TEST_B)]) },
];

// --- Harness ---

const cleanup: string[] = [];
let inheritedStatePath: string | undefined;
beforeEach(() => {
  inheritedStatePath = process.env.LOOM_STATE_PATH;
});
afterEach(() => {
  if (inheritedStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = inheritedStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const project = (): string => gitProject("loom-red-then-green-status-handler-", cleanup);

/** Writes raw State File text in a fresh project; returns its path and points LOOM_STATE_PATH at it. */
function stateFileText(text: string): string {
  const statePath = writeStateFile(project(), text);
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

type Captured = { readonly writes: string[]; readonly write: (text: string) => void };
const captured = (): Captured => {
  const writes: string[] = [];
  return { writes, write: (text) => { writes.push(text); } };
};

/** A live-attempt port double that records each call and answers `evidence`. */
function recordingLive(evidence: LiveAttemptEvidence): Readonly<{
  port: LiveAttemptEvidenceFn;
  calls: Array<Readonly<{ taskId: string; statePath: string }>>;
}> {
  const calls: Array<Readonly<{ taskId: string; statePath: string }>> = [];
  return { calls, port: (taskId, statePath) => { calls.push({ taskId, statePath }); return evidence; } };
}

const ROOT_PORTS: RedThenGreenStatusPorts = { repositoryRoot: () => ({ ok: true, root: ROOT }) };
const NO_ROOT_REASON = "the protected TaskGraph's repository root is unavailable";
const NO_ROOT_PORTS: RedThenGreenStatusPorts = { repositoryRoot: () => ({ ok: false, reason: NO_ROOT_REASON }) };
const NO_LIVE: LiveAttemptEvidence = { kind: "no-live-attempt" };

type RunOptions = Readonly<{
  live?: LiveAttemptEvidenceFn;
  ports?: RedThenGreenStatusPorts;
  harness?: "claude" | "pi";
}>;

const run = (sink: Captured, args: string[], options: RunOptions = {}): Promise<HookResult> =>
  createRedThenGreenStatusHandler(
    sink.write,
    options.live ?? recordingLive(NO_LIVE).port,
    options.ports ?? ROOT_PORTS,
    options.harness ?? "claude",
  )("", args);

const errorMessage = (result: HookResult): string => {
  expect(result.kind).toBe("error");
  return result.kind === "error" ? result.message : "";
};

/** The lines the core renders for the parsed State File and `live`: the parity oracle. */
function expectedLines(statePath: string, taskId: string, live: RedThenGreenLiveInput): readonly string[] {
  const manager = StateManager.fromPath(statePath);
  if (manager === null) throw new Error("fixture State File was not written");
  const graph: TaskGraph = manager.load();
  const rendering = renderRedThenGreenStatus({ graph, taskId, live });
  if (rendering.kind !== "rendered") throw new Error(`fixture Task ${taskId} is unknown to the renderer`);
  return rendering.lines;
}

/** The single write a rendered run makes, split back into lines. */
const writtenLines = (sink: Captured): readonly string[] => {
  expect(sink.writes).toHaveLength(1);
  const [text] = sink.writes;
  expect(text?.endsWith("\n")).toBe(true);
  return (text ?? "").slice(0, -1).split("\n");
};

/** Renders T1 of `json` through the handler and returns its written lines. */
async function renderedLines(json: string, options: RunOptions = {}): Promise<readonly string[]> {
  stateFileText(json);
  const sink = captured();
  const result = await run(sink, ["--task", "T1"], options);
  expect(result).toEqual({ kind: "passthrough" });
  return writtenLines(sink);
}

// --- Routing and purity enrolment ---

describe("red-then-green-status helper routing", () => {
  it("is routed only as a read-only helper: not whitelisted in the guard, no Pi runtime handshake", () => {
    expect(KNOWN_HANDLERS.helper?.has("red-then-green-status")).toBe(true);
    expect(WHITELISTED_HELPERS).not.toContain("red-then-green-status");
    expect(PI_RUNTIME_HANDSHAKE_ROUTES.has("helper/red-then-green-status")).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "red-then-green-status")).toBe(false);
  });

  it("exports a default handler bound to stdout", () => {
    expect(typeof redThenGreenStatus).toBe("function");
  });

  it("FR-006: the Red-Then-Green Status core is enrolled in the no-io-in-pure-modules defaults", () => {
    expect(DEFAULT_PURE_MODULES).toContain("engine/src/core/red-then-green-status.ts");
    // The one module of its import closure not enrolled before it: the duty's owner.
    expect(DEFAULT_PURE_MODULES).toContain("engine/src/core/implementation-application.ts");
  });
});

// --- Arguments ---

describe("red-then-green-status helper arguments", () => {
  it.each([
    ["no arguments", []],
    ["a valueless --task", ["--task"]],
  ])("refuses %s as a missing --task, before touching the live port", async (_label, args) => {
    stateFileText(OWED_JSON());
    const sink = captured();
    const live = recordingLive(NO_LIVE);

    const message = errorMessage(await run(sink, args, { live: live.port }));

    expect(message).toContain("--task <task-id>");
    expect(live.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });

  it.each([
    ["a trailing positional", ["--task", "T1", "extra"], "extra"],
    ["an unknown flag", ["--task", "T1", "--json"], "--json"],
    ["a flag where the --task value belongs", ["--task", "--json"], "--json"],
  ])("refuses %s naming the unconsumed argument", async (_label, args, unconsumed) => {
    stateFileText(OWED_JSON());
    const sink = captured();
    const live = recordingLive(NO_LIVE);

    const message = errorMessage(await run(sink, args, { live: live.port }));

    expect(message).toContain("unknown or unconsumed argument");
    expect(message).toContain(unconsumed);
    expect(live.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });
});

// --- Refusals and the load boundary ---

describe("red-then-green-status helper refusals", () => {
  it("AS-007: a missing TaskGraph is refused naming the path it looked for, and writes nothing", async () => {
    const statePath = statePathIn(project());
    process.env.LOOM_STATE_PATH = statePath;
    const sink = captured();
    const live = recordingLive(NO_LIVE);

    const result = await run(sink, ["--task", "T1"], { live: live.port });

    expect(result).toEqual({ kind: "error", message: `No task graph at ${statePath}` });
    expect(live.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });

  it("AS-007: an unknown Task id is refused naming the id, and writes nothing", async () => {
    stateFileText(OWED_JSON());
    const sink = captured();

    const result = await run(sink, ["--task", "T9"]);

    expect(result).toEqual({ kind: "error", message: `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph` });
    expect(sink.writes).toEqual([]);
  });

  it("a corrupt TaskGraph is not treated as missing: the refusal carries the load boundary's error", async () => {
    const statePath = stateFileText("{ not json");
    const sink = captured();
    const live = recordingLive(NO_LIVE);

    const message = errorMessage(await run(sink, ["--task", "T1"], { live: live.port }));

    expect(message).toContain("Corrupt state file (invalid JSON)");
    expect(message).toContain(statePath);
    expect(message).not.toContain("No task graph");
    expect(live.calls).toEqual([]);
    expect(sink.writes).toEqual([]);
  });

  it("a graph the parser rejects surfaces the parser's error", async () => {
    stateFileText(JSON.stringify({ tasks: "not-a-list" }));
    const sink = captured();

    expect(errorMessage(await run(sink, ["--task", "T1"]))).toContain("Corrupt state file");
    expect(sink.writes).toEqual([]);
  });
});

// --- The duty and the files ---

describe("red-then-green-status helper duty and files", () => {
  it("AS-001: a non-claimant Task requiring new tests in an I6-era TaskGraph reads that it owes I6", async () => {
    const lines = await renderedLines(OWED_JSON());

    expect(lines[0]).toBe(`T1 (Wave 1, pending): ${RTG_OWES}`);
  });

  it.each([
    ["the TaskGraph predates I6", () => graphJson([requiredTask("T1", "not-owed")]), NOT_OWED_REASON_TEXT["predates-i6"]],
    [
      "the Task is an Acceptance Contract claimant",
      () => graphJson([waivedTask("T1", COVERED_BY_ACCEPTANCE_CONTRACT)], I6_MANIFEST),
      NOT_OWED_REASON_TEXT.claimant,
    ],
    [
      "its new tests are waived",
      () => graphJson([waivedTask("T1", "documentation-only")], I6_MANIFEST),
      `${NOT_OWED_REASON_TEXT["new-tests-waived"]}: documentation-only`,
    ],
  ])("AS-002: I6 is not owed because %s, naming exactly that one reason", async (_label, json, reason) => {
    const lines = await renderedLines(json());

    expect(lines[0]).toBe(`T1 (Wave 1, pending): ${RTG_NOT_OWED} — ${reason}`);
    // No files section for a duty that is not owed.
    expect(lines.some((line) => line.startsWith(TEST_FILES_HEADING) || line === NO_TEST_FILES)).toBe(false);
  });

  it("AS-003: an owed Task lists its test and implementation files in file_list order", async () => {
    const lines = await renderedLines(OWED_JSON());

    expect(lines.slice(1, 7)).toEqual([
      TEST_FILES_HEADING,
      `  ${TEST_A}`,
      `  ${TEST_B}`,
      IMPLEMENTATION_FILES_HEADING,
      `  ${IMPL}`,
      `  ${FIXTURE}`,
    ]);
  });

  it("AS-003: an owed Task whose file_list holds no test file states it has none", async () => {
    const lines = await renderedLines(graphJson([requiredTask("T1", OWED_ERA, IMPL_ONLY)], I6_MANIFEST));

    expect(lines.slice(1, 5)).toEqual([NO_TEST_FILES, IMPLEMENTATION_FILES_HEADING, `  ${IMPL}`, `  ${FIXTURE}`]);
  });
});

// --- The live attempt ---

describe("red-then-green-status helper live attempt", () => {
  it("AS-004: a live attempt that met every step shows each with the ledger entry that met it", async () => {
    const statePath = stateFileText(OWED_JSON());
    const sink = captured();
    const live = recordingLive({ kind: "live", ledger: { kind: "read", events: SHOWN_EVENTS } });

    const result = await run(sink, ["--task", "T1"], { live: live.port });

    expect(result).toEqual({ kind: "passthrough" });
    const lines = writtenLines(sink);
    expect(lines).toContain(`${LIVE_PREFIX} ${SHOWN}`);
    expect(lines).toContain(`  ${RED_STEP} #0 ${RED_COMMAND}`);
    expect(lines).toContain(`  ${IMPLEMENTATION_WRITE_STEP} ${IMPL}`);
    expect(lines).toContain(`  ${GREEN_STEP} #2 ${GREEN_COMMAND}`);
    expect(lines).toEqual(expectedLines(statePath, "T1", { kind: "live", events: SHOWN_EVENTS, repositoryRoot: ROOT }));
    // The port is asked once, for the named Task, against the loaded TaskGraph's path.
    expect(live.calls).toEqual([{ taskId: "T1", statePath }]);
  });

  it("AS-004: a live attempt with an unmet step names the first gap as settlement would", async () => {
    const lines = await renderedLines(OWED_JSON(), {
      live: recordingLive({ kind: "live", ledger: { kind: "read", events: UNTRUSTED_RED_EVENTS } }).port,
    });

    const gap: RedThenGreenGap = { kind: "red-missing", untrustedOnly: true };
    expect(lines).toContain(`${LIVE_PREFIX} ${redThenGreenFailureKind(gap)}${UNTRUSTED_ONLY_SUFFIX}`);
  });

  it("AS-004: a live attempt of a Task that does not owe I6 is not judged", async () => {
    const lines = await renderedLines(graphJson([waivedTask("T1", "documentation-only")], I6_MANIFEST), {
      live: recordingLive({ kind: "live", ledger: { kind: "read", events: SHOWN_EVENTS } }).port,
    });

    expect(lines).toContain(`${LIVE_PREFIX} ${LIVE_NOT_JUDGED}`);
  });

  it("AS-005: a Task with no live attempt states so and shows no live judgment", async () => {
    const lines = await renderedLines(OWED_JSON());

    expect(lines).toContain(LIVE_NONE);
    expect(lines.some((line) => line === `${LIVE_PREFIX} ${SHOWN}`)).toBe(false);
  });

  it("an uninspectable sidecar set renders its reason and exits 0", async () => {
    const reason = "1 implementation attempt sidecar(s) could not be read (boom), so a live attempt of T1 may be missed";
    const lines = await renderedLines(OWED_JSON(), { live: recordingLive({ kind: "uninspectable", reason }).port });

    expect(lines).toContain(`${LIVE_PREFIX} ${LIVE_UNINSPECTABLE} — ${reason}`);
  });

  it("several live attempts render as an unreadable epoch and exit 0", async () => {
    const reason = "2 live implementation attempts name T1";
    const lines = await renderedLines(OWED_JSON(), {
      live: recordingLive({ kind: "live", ledger: { kind: "unreadable", reason } }).port,
    });

    expect(lines).toContain(`${LIVE_PREFIX} ${LIVE_UNREADABLE} — ${reason}`);
  });

  it("an unresolvable repository root renders as an unreadable epoch rather than refusing", async () => {
    const lines = await renderedLines(OWED_JSON(), {
      live: recordingLive({ kind: "live", ledger: { kind: "read", events: SHOWN_EVENTS } }).port,
      ports: NO_ROOT_PORTS,
    });

    expect(lines).toContain(`${LIVE_PREFIX} ${LIVE_UNREADABLE} — ${NO_ROOT_REASON}`);
  });

  it("the repository root is not resolved without a live attempt", async () => {
    let asked = 0;
    const ports: RedThenGreenStatusPorts = { repositoryRoot: () => { asked += 1; return { ok: true, root: ROOT }; } };

    await renderedLines(OWED_JSON(), { ports });

    expect(asked).toBe(0);
  });

  it("the repository root is not resolved for an unreadable ledger: no root travels without a readable epoch", async () => {
    let asked = 0;
    const ports: RedThenGreenStatusPorts = { repositoryRoot: () => { asked += 1; return { ok: true, root: ROOT }; } };
    const reason = "ledger torn";

    const lines = await renderedLines(OWED_JSON(), {
      live: recordingLive({ kind: "live", ledger: { kind: "unreadable", reason } }).port,
      ports,
    });

    expect(asked).toBe(0);
    expect(lines).toContain(`${LIVE_PREFIX} ${LIVE_UNREADABLE} — ${reason}`);
  });

  it("NFR-002: under Pi the live attempt reads as not observable and the port is never called", async () => {
    const live = recordingLive({ kind: "live", ledger: { kind: "read", events: SHOWN_EVENTS } });

    const lines = await renderedLines(OWED_JSON(), { live: live.port, harness: "pi" });

    expect(lines).toContain(LIVE_NOT_OBSERVABLE);
    expect(live.calls).toEqual([]);
  });
});

// --- The stored result ---

describe("red-then-green-status helper stored result", () => {
  it("AS-006: an implemented Task that owed I6 shows its stored red run, implementation write and green run", async () => {
    const task = taskFixture({ ...base("T1", 1, FILES), status: "implemented", proof: satisfiedProof(FILES, OWED_ERA) });
    const lines = await renderedLines(graphJson([task], I6_MANIFEST));

    expect(lines.slice(-4)).toEqual([
      `${STORED_PREFIX} ${SHOWN}`,
      `  ${RED_STEP} #0 npx vitest run`,
      `  ${IMPLEMENTATION_WRITE_STEP} ${IMPL}`,
      `  ${GREEN_STEP} #1 npx vitest run`,
    ]);
  });

  it("AS-006: a Task whose latest settlement failed I6 shows the stored gap", async () => {
    const gap: RedThenGreenGap = { kind: "red-after-first-implementation-write" };
    const task = taskFixture({ ...base("T1", 1, FILES), status: "failed", proof: failedProof(gap) });
    const lines = await renderedLines(graphJson([task], I6_MANIFEST));

    expect(lines.at(-1)).toBe(`${STORED_PREFIX} ${redThenGreenFailureKind(gap)}`);
  });

  it("a pending Task shows its stored result as pending", async () => {
    const lines = await renderedLines(OWED_JSON());

    expect(lines.at(-1)).toBe(`${STORED_PREFIX} ${STORED_PENDING}`);
  });
});

// --- Read-only ---

describe("red-then-green-status helper is read-only", () => {
  it("FR-007: the State File bytes and mtime are unchanged and no lock file appears", async () => {
    const statePath = stateFileText(OWED_JSON());
    const before = readFileSync(statePath);
    const mtimeBefore = statSync(statePath).mtimeMs;
    const entriesBefore = readdirSync(dirname(statePath)).sort();
    const live = recordingLive({ kind: "live", ledger: { kind: "read", events: SHOWN_EVENTS } }).port;

    await run(captured(), ["--task", "T1"], { live });
    await run(captured(), ["--task", "T9"], { live });
    await run(captured(), ["--task", "T1"], { live, harness: "pi" });

    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(statSync(statePath).mtimeMs).toBe(mtimeBefore);
    expect(readdirSync(dirname(statePath)).sort()).toEqual(entriesBefore);
    expect(entriesBefore).toEqual(["active_task_graph.json"]);
  });
});

// --- Through the real CLI (SC-001) ---

const REPO_ROOT = resolve(__dirname, "../../../..");

type CliRun = Readonly<{ stdout: string; stderr: string; status: number | null }>;

/** The real entry point, from the repository root, as Claude Code with no live sidecars. */
function runCli(statePath: string, args: readonly string[]): CliRun {
  const subagents = join(project(), "subagents");
  mkdirSync(subagents);
  const { PI_CODING_AGENT: _pi, PI_CODING_AGENT_DIR: _piDir, ...env } = process.env;
  const result = spawnSync("bun", ["engine/src/cli.ts", "helper", "red-then-green-status", ...args], {
    cwd: REPO_ROOT,
    env: { ...env, LOOM_STATE_PATH: statePath, LOOM_SUBAGENT_DIR: subagents },
    input: "",
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

describe("red-then-green-status through the real CLI", () => {
  it("SC-001: prints exactly the core's lines for a Task with no live attempt and exits 0", () => {
    const statePath = writeStateFile(project(), OWED_JSON());
    const expected = expectedLines(statePath, "T1", { kind: "no-live-attempt" });

    const result = runCli(statePath, ["--task", "T1"]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${expected.join("\n")}\n`);
    expect(result.status).toBe(0);
  });

  it("AS-007: an unknown Task id exits 1 naming the id", () => {
    const statePath = writeStateFile(project(), OWED_JSON());

    const result = runCli(statePath, ["--task", "T9"]);

    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph`);
    expect(result.status).toBe(1);
  });

  it("AS-007: a missing TaskGraph exits 1 naming the path it looked for", () => {
    const statePath = statePathIn(project());

    const result = runCli(statePath, ["--task", "T1"]);

    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`No task graph at ${statePath}`);
    expect(result.status).toBe(1);
  });
});
