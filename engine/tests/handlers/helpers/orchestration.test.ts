import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderStatus } from "../../../src/handlers/helpers/orchestration";
import type { GateDeps } from "../../../src/core/wave-gate-machine";
import type { AgentRequestAuthority } from "../../../src/core/orchestration-contract";
import { openRunDirectory } from "../../../src/orchestration/run-directory-handle";

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const deps: GateDeps = {
  loadPlanModels: () => ({ kind: "none" }),
  fileExists: () => true,
};

const FACT_CATEGORIES = [
  "location",
  "tasks",
  "failedProofObligations",
  "testReadiness",
  "reviewRuns",
  "findingCounts",
  "refutationPanelNeed",
  "waveGateCompletionEligibility",
] as const;

function executeGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current_phase: "execute",
    current_wave: 1,
    spec_dir: ".claude/specs/x",
    phase_artifacts: {},
    skipped_phases: [],
    wave_gates: {},
    tasks: [
      { id: "T1", description: "d", agent: "code-implementer-agent", wave: 1, status: "implemented", depends_on: [] },
      { id: "T2", description: "d", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] },
    ],
    ...overrides,
  };
}

function runCli(args: readonly string[], stdin = "", cwd = ENGINE) {
  return spawnSync("bun", [CLI, "helper", "orchestration", ...args], {
    cwd,
    encoding: "utf-8",
    input: stdin,
    env: { ...process.env, LOOM_STATE_PATH: join(cwd, ".claude", "state", "active_task_graph.json") },
  });
}

// --- status -----------------------------------------------------------------

describe("orchestration status", () => {
  it("renders every fact category in the JSON form", () => {
    const parsed = JSON.parse(renderStatus(executeGraph(), deps, true)) as {
      facts: Record<string, unknown>;
      next: { action: { kind: string }; reasons: unknown[] };
    };

    expect(Object.keys(parsed.facts).sort()).toEqual([...FACT_CATEGORIES].sort());
    expect(parsed.next.reasons.length).toBeGreaterThan(0);
  });

  it("renders exactly one typed next action", () => {
    const parsed = JSON.parse(renderStatus(executeGraph(), deps, true)) as {
      next: { action: unknown };
    };

    expect(Array.isArray(parsed.next.action)).toBe(false);
    expect(parsed.next.action).not.toBeNull();
  });

  it("keeps the human and JSON forms in agreement about the action and reasons", () => {
    const graph = executeGraph();
    const json = JSON.parse(renderStatus(graph, deps, true)) as {
      next: { action: { kind: string }; reasons: { message: string }[] };
    };
    const human = renderStatus(graph, deps, false);

    expect(human).toContain(`nextAction: ${json.next.action.kind}`);
    for (const reason of json.next.reasons) expect(human).toContain(reason.message);
  });

  it("names every fact category in the human form too", () => {
    const human = renderStatus(executeGraph(), deps, false);

    for (const category of FACT_CATEGORIES) expect(human).toContain(category);
  });

  it("keeps every category present as unavailable when authority is malformed", () => {
    const parsed = JSON.parse(renderStatus({ not: "a task graph" }, deps, true)) as {
      facts: Record<string, { kind: string }>;
      next: { action: { kind: string } };
    };

    // The contract's whole point: no fabricated zero-or-ready values.
    expect(Object.keys(parsed.facts).sort()).toEqual([...FACT_CATEGORIES].sort());
    for (const category of FACT_CATEGORIES) expect(parsed.facts[category]?.kind).toBe("unavailable");
    expect(parsed.next.action.kind).toBe("blocked");
  });

  it("reports an unreadable state file as unavailable rather than crashing", () => {
    const parsed = JSON.parse(renderStatus({ __unreadable: "ENOENT" }, deps, true)) as {
      next: { action: { kind: string } };
    };

    expect(parsed.next.action.kind).toBe("blocked");
  });

  it("never reports a ready action from a graph it could not parse", () => {
    for (const malformed of [null, 42, "graph", [], { tasks: "no" }]) {
      const parsed = JSON.parse(renderStatus(malformed, deps, true)) as {
        next: { action: { kind: string } };
      };
      expect(parsed.next.action.kind).toBe("blocked");
    }
  });
});

// --- CLI --------------------------------------------------------------------

describe("orchestration CLI", () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "loom-orchestration-"));
    cleanup.push(root);
    mkdirSync(join(root, ".claude", "state"), { recursive: true });
    return root;
  }

  it("prints a status even when no state file exists", () => {
    const result = runCli(["status"], "", project());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Loom Status v1");
    expect(result.stdout).toContain("nextAction: blocked");
  });

  it("emits machine-readable JSON under --json", () => {
    const root = project();
    writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), JSON.stringify(executeGraph()));

    const result = runCli(["status", "--json"], "", root);

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("rejects an unknown operation with usage rather than a crash", () => {
    const result = runCli(["teleport"], "", project());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });

  it("requires both --runs-root and --run to bind a run", () => {
    const result = runCli(["resume", "--run", "/tmp/nowhere"], "", project());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--runs-root");
  });

  it("refuses a run directory that is not a child of its runs root", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const outside = join(root, "elsewhere", "run.x");
    mkdirSync(runsRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const result = runCli(["resume", "--runs-root", runsRoot, "--run", outside], "", root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot bind run directory");
  });

  it("retries a malformed-but-JSON architecture candidate instead of minting success", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.architecture-malformed");
    mkdirSync(runDir, { recursive: true });
    const started = runCli([
      "start", "architecture", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ input: { candidateLenses: ["simplicity-first"], judgeCriteria: ["fit"] }, events: [] }), root);
    expect(started.status).toBe(0);
    const request = (JSON.parse(started.stdout) as {
      requests: readonly Readonly<{ authority: AgentRequestAuthority }>[];
    }).requests[0]!.authority;

    const submitted = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", request.requestId, "--slot", request.slotId, "--attempt", "1",
    ], "{}", root);

    expect(submitted.status).toBe(0);
    const action = JSON.parse(submitted.stdout) as { kind: string; requests: readonly { attempt: number }[] };
    expect(action.kind).toBe("spawn-batch");
    expect(action.requests).toHaveLength(1);
    expect(action.requests[0]?.attempt).toBe(2);
  });

  it("starts, submits to, and idempotently resumes a registered refutation reducer", async () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.refutation-facade");
    mkdirSync(runDir, { recursive: true });
    const program = JSON.stringify({
      input: {
        criticalFindingIds: ["T1:finding-1"],
        lenses: ["reproduction", "intent"],
      },
      events: [],
    });

    const started = runCli([
      "start", "refutation", "--runs-root", runsRoot, "--run", runDir,
    ], program, root);
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout).kind).toBe("spawn-batch");
    expect(JSON.parse(started.stdout).requests).toHaveLength(2);

    const startedAction = JSON.parse(started.stdout) as {
      requests: readonly Readonly<{ authority: AgentRequestAuthority }>[];
    };
    const firstRequest = startedAction.requests[0]!.authority;
    const secondRequest = startedAction.requests[1]!.authority;
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const issued = opened.value.readIssuedRequests();
    expect(issued.ok && issued.value).toHaveLength(2);
    const firstSubmitted = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", firstRequest.requestId, "--slot", firstRequest.slotId, "--attempt", "1",
    ], JSON.stringify({
      criterion: "reproduction",
      verdicts: [{ finding_id: "T1:finding-1", verdict: "upheld", reasoning: "trigger remains reachable" }],
    }), root);
    expect(firstSubmitted.status).toBe(0);
    expect(JSON.parse(firstSubmitted.stdout).kind).toBe("spawn-batch");

    const secondSubmitted = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", secondRequest.requestId, "--slot", secondRequest.slotId, "--attempt", "1",
    ], JSON.stringify({
      criterion: "intent",
      verdicts: [{ finding_id: "T1:finding-1", verdict: "upheld", reasoning: "no documented exception" }],
    }), root);
    expect(secondSubmitted.status).toBe(0);
    const engineAction = JSON.parse(secondSubmitted.stdout);
    expect(engineAction).toEqual({ kind: "done", panel: "refutation", outcome: "completed" });

    // Historical complete remains an idempotent compatibility adapter; new
    // callers never attest deterministic outcomes.
    const completed = runCli([
      "complete", "--runs-root", runsRoot, "--run", runDir,
      "--operation", "refutation-tally",
    ], "", root);
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(completed.status).toBe(0);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(completed.stdout)).toEqual(JSON.parse(resumed.stdout));
    expect(JSON.parse(completed.stdout)).toEqual({
      kind: "done",
      panel: "refutation",
      outcome: "completed",
    });
    const result = JSON.parse(readFileSync(join(runDir, "artifacts", "result.json"), "utf-8")) as {
      kind: string;
      outcomes: readonly { finding_id: string; survives: boolean }[];
    };
    expect(result.kind).toBe("refutation-panel-result");
    expect(result.outcomes).toEqual([{ finding_id: "T1:finding-1", survives: true, refuted_by: [], votes: expect.any(Array) }]);
  }, 15_000);

  it("resumes an anchored run idempotently without spawning anything", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.orchestration-1");
    mkdirSync(runDir, { recursive: true });

    const first = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    const second = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
    expect(JSON.parse(first.stdout).runId).toBe("run.orchestration-1");
  });

  it("refuses a capture for a request that was never reserved", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.orchestration-2");
    mkdirSync(runDir, { recursive: true });

    const result = runCli(
      ["submit", "--runs-root", runsRoot, "--run", runDir, "--request", "r1", "--slot", "s1", "--attempt", "1"],
      "some output",
      root,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("never reserved");
  });

  it("records a native harness correlator against reserved authority", async () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.orchestration-correlator");
    mkdirSync(runDir, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const request = {
      runId: "run.orchestration-correlator",
      requestId: "request:reviewer:1",
      slotId: "slot-1",
      program: "wave-gate",
      role: "code-reviewer",
      attempt: 1,
      modelProfile: "general-review",
      harnessBinding: {
        pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
        claude: { harness: "claude-code", model: "sonnet" },
      },
      requiredSkill: null,
      contextDigest: "a".repeat(64),
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-1.raw" },
    } as AgentRequestAuthority;
    expect((await opened.value.reserveRequest(request)).ok).toBe(true);

    const result = runCli([
      "correlate", "--runs-root", runsRoot, "--run", runDir,
      "--request", request.requestId, "--harness", "pi", "--native-id", "tool-call:0",
      "--agent", request.role,
    ], "", root);

    expect(result.status).toBe(0);
    const stored = opened.value.readHarnessCorrelator("pi", "tool-call:0");
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.requestId).toBe(request.requestId);
  });

  it.each([
    ["wave-gate", { wave: null }],
    ["remediation", { sourceRunsRoot: "/missing", sourceRun: "/missing/run", supportPaths: [] }],
  ] as const)("exposes the %s façade and returns a typed blocked action when authority is unavailable", (program, input) => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, `run.${program}`);
    mkdirSync(runDir, { recursive: true });
    const result = runCli(["start", program, "--runs-root", runsRoot, "--run", runDir], JSON.stringify(input), root);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).kind).toBe("blocked");
  });

  it("drives a registered standalone review from spawn-batch to idempotent done", async () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.standalone-facade");
    mkdirSync(runDir, { recursive: true });
    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as { kind: string; requests: { authority: AgentRequestAuthority }[] };
    expect(action.kind).toBe("spawn-batch");
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const transcript = [
      "### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "", "```findings", "[]", "```",
    ].join("\n");
    for (const request of action.requests) {
      expect((await opened.value.captureTranscript(request.authority, [...Buffer.from(transcript)])).ok).toBe(true);
    }
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", ENGINE);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).kind).toBe("done");
    const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", ENGINE);
    expect(JSON.parse(replay.stdout).kind).toBe("done");
  });

  it("installs only a standalone-authorized dirty set through the remediation façade", async () => {
    const repository = project();
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-remediation-facade-runs-"));
    cleanup.push(runsRoot);
    const git = (args: readonly string[]) => spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    expect(git(["init", "-q"]).status).toBe(0);
    git(["config", "user.email", "loom@example.test"]);
    git(["config", "user.name", "Loom Test"]);
    writeFileSync(join(repository, "a.txt"), "old\n");
    git(["add", "a.txt"]); git(["commit", "-qm", "initial"]);
    writeFileSync(join(repository, "a.txt"), "new\n");
    const sourceRun = join(runsRoot, "source");
    const remediationRun = join(runsRoot, "remediation");
    mkdirSync(sourceRun); mkdirSync(remediationRun);
    const started = runCli(["start", "standalone-review", "--runs-root", runsRoot, "--run", sourceRun],
      JSON.stringify({ kind: "comments", files: ["a.txt"], dryRun: false }), repository);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as { requests: { authority: AgentRequestAuthority }[] };
    const opened = openRunDirectory(runsRoot, sourceRun);
    if (!opened.ok) throw new Error(opened.error.message);
    const transcript = ["### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "", "```findings", "[]", "```"].join("\n");
    for (const request of action.requests) {
      expect((await opened.value.captureTranscript(request.authority, [...Buffer.from(transcript)])).ok).toBe(true);
    }
    expect(runCli(["resume", "--runs-root", runsRoot, "--run", sourceRun], "", repository).status).toBe(0);
    const remediated = runCli(["start", "remediation", "--runs-root", runsRoot, "--run", remediationRun], JSON.stringify({
      sourceRunsRoot: runsRoot, sourceRun, supportPaths: [],
    }), repository);
    expect(remediated.status, remediated.stderr).toBe(0);
    expect(JSON.parse(remediated.stdout).kind).toBe("done");
    expect(git(["diff", "--cached", "--name-only"]).stdout.trim()).toBe("a.txt");
  });

  it("records a user decision durably in the run's event log", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.orchestration-3");
    mkdirSync(runDir, { recursive: true });

    const result = runCli(
      ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-1"],
      JSON.stringify({ kind: "approve" }),
      root,
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).kind).toBe("decision-recorded");
  });

  it("refuses a decision that is not JSON rather than recording it", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.orchestration-4");
    mkdirSync(runDir, { recursive: true });

    const result = runCli(
      ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-1"],
      "approve please",
      root,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("JSON object");
  });

  it("refuses an empty decision rather than treating silence as approval", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.orchestration-5");
    mkdirSync(runDir, { recursive: true });

    const result = runCli(
      ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-1"],
      "",
      root,
    );

    expect(result.status).not.toBe(0);
  });
});
