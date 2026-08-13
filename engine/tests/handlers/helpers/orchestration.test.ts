import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderStatus } from "../../../src/handlers/helpers/orchestration";
import { WAVE_REVIEW_AGENTS, type GateDeps } from "../../../src/core/wave-gate-machine";
import { evaluateTaskProof } from "../../../src/core/proof-obligations";
import { parseAgentRequestAuthority, type AgentRequestAuthority } from "../../../src/core/orchestration-contract";
import { persistedWaveAttemptTwoCompatibilityProblem } from "../../../src/handlers/helpers/programs";
import { buildContextPacket, encodeByteSection } from "../../../src/orchestration/context-packets";
import { openRunDirectory, type RunDirHandle } from "../../../src/orchestration/run-directory-handle";
import { readSessionRunBindings } from "../../../src/orchestration/session-run-bindings";

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

function runCli(
  args: readonly string[],
  stdin = "",
  cwd = ENGINE,
  envOverrides: Readonly<Record<string, string | undefined>> = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOOM_STATE_PATH: join(cwd, ".claude", "state", "active_task_graph.json"),
    ...envOverrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return spawnSync("bun", [CLI, "helper", "orchestration", ...args], {
    cwd,
    encoding: "utf-8",
    input: stdin,
    env,
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

  function git(root: string, args: readonly string[]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result;
  }

  function repository(): string {
    const root = project();
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "loom@example.test"]);
    git(root, ["config", "user.name", "Loom Test"]);
    writeFileSync(join(root, "README.md"), "fixture\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-qm", "initial"]);
    return root;
  }

  function lines(count: number, prefix: string): string {
    return `${Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join("\n")}\n`;
  }

  function refutationOutput(handle: RunDirHandle, authority: AgentRequestAuthority): string {
    const context = handle.readContext(authority.contextDigest);
    if (!context.ok) throw new Error(context.error.message);
    const section = context.value.fixedContext.find(({ label }) =>
      label === "wave-refutation-authority" || label === "refutation-authority");
    if (section === undefined) throw new Error("refutation context lacks semantic authority");
    const semantic = JSON.parse(Buffer.from(section.bytes).toString("utf8")) as {
      lens: string;
      findings: readonly { id: string }[];
    };
    return JSON.stringify({
      criterion: semantic.lens,
      verdicts: semantic.findings.map(({ id }) => ({
        finding_id: id,
        verdict: "upheld",
        reasoning: "The current immutable packet still exhibits the finding",
      })),
    });
  }

  /** A refutation verdict transcript with a caller-chosen vote direction. */
  function refutationVerdicts(handle: RunDirHandle, authority: AgentRequestAuthority, verdict: "upheld" | "refuted"): string {
    const context = handle.readContext(authority.contextDigest);
    if (!context.ok) throw new Error(context.error.message);
    const section = context.value.fixedContext.find(({ label }) =>
      label === "wave-refutation-authority" || label === "refutation-authority");
    if (section === undefined) throw new Error("refutation context lacks semantic authority");
    const semantic = JSON.parse(Buffer.from(section.bytes).toString("utf8")) as {
      lens: string;
      findings: readonly { id: string }[];
    };
    return JSON.stringify({
      criterion: semantic.lens,
      verdicts: semantic.findings.map(({ id }) => ({
        finding_id: id,
        verdict,
        reasoning: verdict === "upheld"
          ? "The current immutable packet still exhibits the finding"
          : "The current immutable packet does not exhibit the finding",
      })),
    });
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

  it("rejects a direct-child run directory whose basename is not a valid run identity", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const invalid = join(runsRoot, "invalid run id");
    mkdirSync(invalid, { recursive: true });

    const result = runCli(["resume", "--runs-root", runsRoot, "--run", invalid], "", root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("orchestration-run-id");
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

  it("publishes Pi session capture authority before returning a spawn batch", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.pi-handoff");
    const bindingDir = join(root, "pi-session-bindings");
    const sessionId = "019ff290-ffee-7e86-8ed0-c834c04b7f6e";
    mkdirSync(runDir, { recursive: true });

    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE, {
      PI_CODING_AGENT: "true",
      PI_SESSION_ID: sessionId,
      LOOM_SUBAGENT_DIR: bindingDir,
    });

    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(action.kind).toBe("spawn-batch");
    const bindings = readSessionRunBindings(bindingDir, sessionId);
    expect(bindings.ok).toBe(true);
    if (!bindings.ok) return;
    expect(bindings.value).toEqual([expect.objectContaining({
      runId: "run.pi-handoff",
      runsRoot,
      runDirectory: runDir,
      requestIds: action.requests.map(({ authority }) => authority.requestId).sort(),
    })]);
  });

  it("withholds a Pi spawn batch when PI_SESSION_ID is absent", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.pi-missing-session");
    mkdirSync(runDir, { recursive: true });

    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE, {
      PI_CODING_AGENT: "true",
      PI_SESSION_ID: undefined,
      LOOM_SUBAGENT_DIR: join(root, "bindings"),
    });

    expect(started.status).not.toBe(0);
    expect(started.stdout).not.toContain('"kind": "spawn-batch"');
    expect(started.stderr).toContain("requires PI_SESSION_ID");
  });

  it("withholds a Pi spawn batch when session binding publication fails", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.pi-binding-failure");
    const bindingPath = join(root, "not-a-directory");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(bindingPath, "occupied\n");

    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE, {
      PI_CODING_AGENT: "true",
      PI_SESSION_ID: "019ff290-ffee-7e86-8ed0-c834c04b7f6f",
      LOOM_SUBAGENT_DIR: bindingPath,
    });

    expect(started.status).not.toBe(0);
    expect(started.stdout).not.toContain('"kind": "spawn-batch"');
    expect(started.stderr).toContain("cannot publish Pi orchestration capture authority");
  });

  it("refuses to freeze scope bytes through a symlinked ancestor", () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "loom-frozen-scope-outside-"));
    cleanup.push(outside);
    writeFileSync(join(outside, "secret.ts"), "export const secret = true;\n");
    mkdirSync(join(root, "linked"));
    rmSync(join(root, "linked"), { recursive: true });
    symlinkSync(outside, join(root, "linked"));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-frozen-scope-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.symlinked-frozen-scope");
    mkdirSync(runDir);

    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "code", files: ["linked/secret.ts"], dryRun: false }), root);

    expect(started.status).not.toBe(0);
    expect(started.stderr).toMatch(/ELOOP|too many symbolic|ENOTDIR/i);
  });

  it("freezes untracked files into default scope and accepts findings against them", async () => {
    const root = repository();
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-orchestration-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.untracked-scope");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "new-production.ts"), "export const fresh = 1;\n");
    mkdirSync(join(root, ".claude", "specs", "x", "panel-runs", "run.evidence"), { recursive: true });
    writeFileSync(join(root, ".claude", "specs", "x", "panel-runs", "run.evidence", "verdict.json"), "{}\n");
    mkdirSync(runDir, { recursive: true });

    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "all", files: null, dryRun: false }), root);

    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(action.kind).toBe("spawn-batch");
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const registration = opened.value.readProgramRegistration();
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    const authority = (registration.value as {
      authority: {
        scope: readonly string[];
        changed_paths: { unstaged: readonly string[] };
        review_metadata: { additions: number };
      };
    }).authority;
    expect(authority.scope).toEqual(["src/new-production.ts"]);
    expect(authority.changed_paths.unstaged).toEqual(["src/new-production.ts"]);
    expect(authority.review_metadata.additions).toBe(1);
    const frozenContext = opened.value.readContext(action.requests[0]!.authority.contextDigest);
    expect(frozenContext.ok).toBe(true);
    if (!frozenContext.ok) return;
    const frozenSource = frozenContext.value.fixedContext.find(({ label }) => label === "standalone-frozen-source");
    expect(frozenSource).toBeDefined();
    const frozenPayload = JSON.parse(Buffer.from(frozenSource!.bytes).toString("utf8")) as {
      files: readonly { path: string; kind: string; content?: string }[];
    };
    expect(frozenPayload.files).toContainEqual(expect.objectContaining({
      path: "src/new-production.ts", kind: "text", content: "export const fresh = 1;\n",
    }));
    expect(frozenPayload.files.some(({ path }) => path.includes("panel-runs"))).toBe(false);
    writeFileSync(join(root, "src", "new-production.ts"), "export const changed_after_freeze = true;\n");
    expect(JSON.parse(Buffer.from(frozenSource!.bytes).toString("utf8"))).toEqual(frozenPayload);

    const criticalTranscript = [
      "### Machine Summary",
      "CRITICAL_COUNT: 1",
      "ADVISORY_COUNT: 0",
      "CRITICAL: New production defect",
      "ADVISORY:",
      "",
      "```findings",
      JSON.stringify([{ severity: "critical", file: "src/new-production.ts", line: 1, claim: "New production defect" }]),
      "```",
    ].join("\n");
    const cleanTranscript = [
      "### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "CRITICAL:", "ADVISORY:",
      "", "```findings", "[]", "```",
    ].join("\n");
    for (const [index, request] of action.requests.entries()) {
      const transcript = index === 0 ? criticalTranscript : cleanTranscript;
      expect((await opened.value.captureTranscript(request.authority, [...Buffer.from(transcript)])).ok).toBe(true);
    }

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).kind).toBe("spawn-batch");
  }, 15_000);

  it("counts committed, staged, unstaged, and untracked additions once for reviewer selection", () => {
    const root = repository();
    writeFileSync(join(root, "layered.ts"), "");
    writeFileSync(join(root, "working.ts"), "");
    git(root, ["add", "layered.ts", "working.ts"]);
    git(root, ["commit", "-qm", "add base files"]);
    git(root, ["checkout", "-qb", "feature"]);
    writeFileSync(join(root, "committed.ts"), lines(200, "committed"));
    git(root, ["add", "committed.ts"]);
    git(root, ["commit", "-qm", "feature commit"]);
    writeFileSync(join(root, "layered.ts"), lines(50, "staged"));
    git(root, ["add", "layered.ts"]);
    writeFileSync(join(root, "layered.ts"), lines(75, "final"));
    writeFileSync(join(root, "working.ts"), lines(100, "working"));
    writeFileSync(join(root, "untracked.ts"), lines(150, "untracked"));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-orchestration-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.complete-additions");
    mkdirSync(runDir, { recursive: true });

    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "code", files: null, dryRun: false }), root);

    expect(started.status, started.stderr).toBe(0);
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const registration = opened.value.readProgramRegistration();
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    const authority = (registration.value as {
      authority: {
        scope: readonly string[];
        changed_paths: { unstaged: readonly string[]; staged: readonly string[]; committed: readonly string[] };
        review_metadata: { additions: number; file_count: number };
        reviewers: readonly string[];
      };
    }).authority;
    expect(authority.scope).toEqual(["committed.ts", "layered.ts", "untracked.ts", "working.ts"]);
    expect(authority.changed_paths.unstaged).toEqual(["layered.ts", "untracked.ts", "working.ts"]);
    expect(authority.changed_paths.staged).toEqual(["layered.ts"]);
    expect(authority.changed_paths.committed).toEqual(["committed.ts"]);
    expect(authority.review_metadata).toMatchObject({ additions: 525, file_count: 4 });
    expect(authority.reviewers).toContain("architecture-tech-lead");
  });

  it("blocks corrupt durable publication evidence instead of treating it as absent", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.corrupt-publication");
    mkdirSync(runDir, { recursive: true });
    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE);
    expect(started.status, started.stderr).toBe(0);
    const publicationDirectory = join(runDir, "artifacts", "publications");
    const publication = readdirSync(publicationDirectory)[0];
    expect(publication).toBeDefined();
    writeFileSync(join(publicationDirectory, publication!), "{broken\n");

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", ENGINE);

    expect(resumed.status).not.toBe(0);
    expect(resumed.stdout).not.toContain('"kind": "spawn-batch"');
    expect(resumed.stderr).toContain("invalid JSON");
  });

  it("rejects a Wave reviewer submission when its packet-bound task disappeared", () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    expect(proof.state).toBe("satisfied");
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const graph = {
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {},
      tasks: [{
        id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        critical_findings: [], advisory_findings: [],
      }],
    };
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(graph));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-missing-task-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-missing-task");
    mkdirSync(runDir);
    const started = runCli([
      "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const reviewer = action.requests.find(({ authority }) => authority.role === "code-reviewer");
    expect(reviewer).toBeDefined();
    const registered = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify({ ...registered, tasks: [] }));

    const submitted = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", reviewer!.authority.requestId, "--slot", reviewer!.authority.slotId, "--attempt", "1",
    ], "### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0\n```findings\n[]\n```", root);

    expect(submitted.status).not.toBe(0);
    expect(submitted.stderr).toContain("is no longer in the protected task graph");
  }, 15_000);

  it("rejects a stale issued reviewer request after current Review Packet authority changes", () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {},
      tasks: [{
        id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-stale-request-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-stale-request");
    mkdirSync(runDir);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const reviewer = action.requests.find(({ authority }) => authority.role === "code-reviewer")!.authority;
    const protectedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_run?: Record<string, unknown> }[];
    };
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify({
      ...protectedGraph,
      tasks: protectedGraph.tasks.map((task) => ({
        ...task,
        review_run: { ...task.review_run, packet_id: "f".repeat(64), head_sha: "e".repeat(64) },
      })),
    }));
    const submitted = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", reviewer.requestId, "--slot", reviewer.slotId, "--attempt", "1",
    ], [
      "### Machine Summary", "REVIEW_GENERATION: 0", `REVIEW_PACKET_ID: ${"f".repeat(64)}`,
      "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "```findings", "[]", "```",
      "```review_lifecycle", '{"prior_findings":[]}', "```",
    ].join("\n"), root);

    expect(submitted.status).not.toBe(0);
    expect(submitted.stderr).toContain("does not belong to Task T1's exact current Review Packet slot");
  }, 15_000);

  it("issues a fresh current packet batch after implementation invalidates a completed review generation", () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null, wave_gates: {},
      tasks: [{
        id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1, status: "implemented", proof,
        depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"], test_result: { verdict: "trusted-pass" },
        test_evidence: "passed", new_tests_written: true, new_test_evidence: "present", review_status: "passed",
        review_generation: 0, findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-fresh-generation-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-fresh-generation");
    mkdirSync(runDir);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const before = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown> & { tasks: readonly Record<string, unknown>[] };
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify({
      ...before,
      spec_check: undefined,
      tasks: before.tasks.map((task) => ({
        ...task, review_generation: 1, review_status: "pending", review_run: undefined,
      })),
    }));

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(resumed.status, resumed.stderr).toBe(0);
    const fresh = JSON.parse(resumed.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(fresh.kind, resumed.stdout).toBe("spawn-batch");
    expect(fresh.requests).toHaveLength(6);
    expect(fresh.requests.map(({ authority }) => authority.requestId)).not.toEqual(
      initial.requests.map(({ authority }) => authority.requestId),
    );
    const after = JSON.parse(readFileSync(statePath, "utf8")) as {
      wave_review_epoch?: { batchEpoch: string };
      tasks: readonly { review_run?: { generation: number; head_sha: string } }[];
    };
    expect(after.tasks[0]?.review_run?.generation).toBe(1);
    expect(after.tasks[0]?.review_run?.head_sha).toBe(after.wave_review_epoch?.batchEpoch);

    const staleSpec = initial.requests.find(({ authority }) => authority.role === "spec-check-invoker")!.authority;
    const staleSubmission = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", staleSpec.requestId, "--slot", staleSpec.slotId, "--attempt", "1",
    ], "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED", root);
    expect(staleSubmission.status).not.toBe(0);
    expect(staleSubmission.stderr).toContain("does not belong to the exact current review epoch");
    expect((JSON.parse(readFileSync(statePath, "utf8")) as { spec_check?: unknown }).spec_check).toBeUndefined();
  }, 15_000);

  it("keeps sibling packet recovery authority stable after one task finalizes new findings", () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const task = (id: string) => ({
      id, description: `review ${id}`, agent: "code-implementer-agent", wave: 1, status: "implemented", proof,
      depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"], test_result: { verdict: "trusted-pass" },
      test_evidence: "passed", new_tests_written: true, new_test_evidence: "present", review_status: "passed",
      review_generation: 0, findings: [], critical_findings: [], advisory_findings: [],
    });
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {}, tasks: [task("T1"), task("T2")],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-sibling-stability-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-sibling-stability");
    mkdirSync(runDir);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const graph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { id: string; review_run?: { generation: number; packet_id: string } }[];
    };
    const run = graph.tasks.find(({ id }) => id === "T1")!.review_run!;
    const transcript = (claim: string | null) => [
      "### Machine Summary", `REVIEW_GENERATION: ${run.generation}`, `REVIEW_PACKET_ID: ${run.packet_id}`,
      "CRITICAL_COUNT: 0", `ADVISORY_COUNT: ${claim === null ? 0 : 1}`,
      ...(claim === null ? [] : [`ADVISORY: ${claim}`]),
      "```findings", JSON.stringify(claim === null ? [] : [{ severity: "advisory", file: "src/x.ts", line: 1, claim }]), "```",
      "```review_lifecycle", '{"prior_findings":[]}', "```",
    ].join("\n");
    for (const [index, request] of initial.requests.slice(1, 1 + WAVE_REVIEW_AGENTS.length).entries()) {
      const submitted = runCli([
        "submit", "--runs-root", runsRoot, "--run", runDir,
        "--request", request.authority.requestId, "--slot", request.authority.slotId, "--attempt", "1",
      ], transcript(index === 0 ? "new finding from completed sibling packet" : null), root);
      expect(submitted.status, submitted.stderr).toBe(0);
    }

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(resumed.status, resumed.stderr).toBe(0);
    const action = JSON.parse(resumed.stdout) as { kind: string; requests?: readonly { authority: AgentRequestAuthority }[] };
    expect(action.kind, resumed.stdout).toBe("spawn-batch");
    expect(action.requests?.some(({ authority }) => authority.program === "wave-gate" && authority.attempt === 1)).toBe(true);
    const after = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { id: string; review_run?: unknown; advisory_findings?: readonly string[] }[];
    };
    expect(after.tasks.find(({ id }) => id === "T1")?.review_run).toBeUndefined();
    expect(after.tasks.find(({ id }) => id === "T1")?.advisory_findings).toEqual(["new finding from completed sibling packet"]);
    expect(after.tasks.find(({ id }) => id === "T2")?.review_run).toBeDefined();
  }, 30_000);

  it("recovers current Wave Review Packets with attempt 2 before stale criticals can start refutation", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    expect(proof.state).toBe("satisfied");
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const finding = {
      id: "silent-failure-hunter-15", agent: "silent-failure-hunter", severity: "critical" as const,
      file: "src/x.ts", line: 1, claim: "current packet must finish before this finding is adjudicated",
    };
    const graph = {
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {},
      tasks: [{
        id: "T10", description: "review target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "blocked", review_generation: 0,
        findings: [finding], critical_findings: [finding.claim], advisory_findings: [],
      }],
    };
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(graph));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-review-recovery-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-review-recovery");
    mkdirSync(runDir);
    const started = runCli([
      "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(initial.kind).toBe("spawn-batch");
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    for (const { authority } of initial.requests) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("captured but not accepted")])).ok).toBe(true);
    }

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(resumed.status, resumed.stderr).toBe(0);
    const recovery = JSON.parse(resumed.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority; task: string }[];
    };
    expect(recovery.kind, resumed.stdout).toBe("spawn-batch");
    expect(recovery.requests).toHaveLength(5);
    expect(recovery.requests.every(({ authority }) => authority.program === "wave-gate" && authority.attempt === 2)).toBe(true);
    expect(recovery.requests.some(({ authority }) => authority.role === "review-verifier-agent")).toBe(false);
    for (const { authority } of recovery.requests) {
      const retryPacket = opened.value.readContext(authority.contextDigest);
      expect(retryPacket.ok).toBe(true);
      if (!retryPacket.ok) continue;
      const authoritySection = retryPacket.value.fixedContext.find(({ label }) => label === "wave-review-authority");
      expect(authoritySection).toBeDefined();
      const packetAuthority = JSON.parse(Buffer.from(authoritySection!.bytes).toString("utf8")) as {
        packetId?: string;
        task?: { reviewGeneration?: number; priorFindings?: readonly unknown[]; generation?: unknown; findings?: unknown };
      };
      expect(packetAuthority.packetId).toBeDefined();
      expect(packetAuthority.task?.reviewGeneration).toBeDefined();
      expect(packetAuthority.task?.priorFindings).toBeDefined();
      expect(packetAuthority.task?.generation).toBeUndefined();
      expect(packetAuthority.task?.findings).toBeUndefined();
      const diagnostic = retryPacket.value.variableContext.find(({ label }) =>
        label === "wave-review-attempt-1-rejection");
      expect(diagnostic, `${authority.role} retry must explain why attempt 1 was rejected`).toBeDefined();
      const text = Buffer.from(diagnostic!.bytes).toString("utf8");
      expect(text).toContain("Parser rejection reason:");
      expect(text).toContain("review output omitted REVIEW_PACKET_ID or REVIEW_GENERATION");
      expect(text).toContain('"finding_id"');
      expect(text).toContain('"verdict"');
      expect(text).toContain("REVIEW_GENERATION");
      expect(text).toContain("REVIEW_PACKET_ID");
      const requestTask = recovery.requests.find(({ authority: candidate }) =>
        candidate.requestId === authority.requestId)?.task ?? "";
      expect(requestTask).toContain("YOUR PREVIOUS ATTEMPT WAS REJECTED");
      expect(requestTask).toContain("review output omitted REVIEW_PACKET_ID or REVIEW_GENERATION");
      expect(requestTask).toContain('"finding_id"');
      expect(requestTask).toContain('"verdict"');
    }
    const protectedGraph = JSON.parse(readFileSync(statePath, "utf8")) as { tasks: readonly { review_run?: { slot_authority?: readonly { attempted: number }[] } }[] };
    expect(protectedGraph.tasks[0]?.review_run?.slot_authority?.every(({ attempted }) => attempted === 2)).toBe(true);

    // Simulate a crash after idempotent request reservation but before its
    // publication receipt became durable. Resume must reconcile the complete
    // per-slot intent instead of trusting the raw reservation.
    const publications = join(runDir, "artifacts", "publications");
    for (const name of readdirSync(publications)) {
      const receipt = JSON.parse(readFileSync(join(publications, name), "utf8")) as { requestIds?: readonly string[] };
      if (receipt.requestIds?.some((requestId) => recovery.requests.some(({ authority }) => authority.requestId === requestId))) {
        rmSync(join(publications, name));
      }
    }
    const replayed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(replayed.status, replayed.stderr).toBe(0);
    const replay = JSON.parse(replayed.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(replay.kind, replayed.stdout).toBe("spawn-batch");
    expect(replay.requests.map(({ authority }) => authority.requestId)).toEqual(
      recovery.requests.map(({ authority }) => authority.requestId),
    );

    const active = (JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_run?: { generation: number; packet_id: string; prior_finding_ids: readonly string[] } }[];
    }).tasks[0]?.review_run;
    expect(active).toBeDefined();
    const reviewerTranscript = [
      "### Machine Summary",
      `REVIEW_GENERATION: ${active!.generation}`,
      `REVIEW_PACKET_ID: ${active!.packet_id}`,
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "```findings",
      "[]",
      "```",
      "```review_lifecycle",
      JSON.stringify({ prior_findings: active!.prior_finding_ids.map((finding_id) => ({
        finding_id, verdict: "still_present", reason: "The current packet still contains the behavior",
      })) }),
      "```",
    ].join("\n");
    // Simulate a crash after durable attempt-2 capture but before semantic
    // application. Resume must reconcile that exact transcript, not exhaust it.
    const crashWindow = recovery.requests[0]!.authority;
    expect((await opened.value.captureTranscript(crashWindow, [...Buffer.from(reviewerTranscript)])).ok).toBe(true);
    const reconciled = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(reconciled.status, reconciled.stderr).toBe(0);
    const afterCrash = JSON.parse(reconciled.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(afterCrash.kind, reconciled.stdout).toBe("spawn-batch");
    expect(afterCrash.requests).toHaveLength(4);
    const afterCrashGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_run?: { evidence: readonly { agent: string }[] } }[];
    };
    expect(afterCrashGraph.tasks[0]?.review_run?.evidence.map(({ agent }) => agent)).toEqual([crashWindow.role]);

    let afterReview: ReturnType<typeof runCli> | null = null;
    for (const { authority } of recovery.requests.slice(1)) {
      afterReview = runCli([
        "submit", "--runs-root", runsRoot, "--run", runDir,
        "--request", authority.requestId, "--slot", authority.slotId, "--attempt", "2",
      ], reviewerTranscript, root);
      expect(afterReview.status, afterReview.stderr).toBe(0);
    }
    const specRecovery = JSON.parse(afterReview!.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(specRecovery.kind).toBe("spawn-batch");
    expect(specRecovery.requests).toHaveLength(1);
    expect(specRecovery.requests[0]?.authority).toMatchObject({ role: "spec-check-invoker", attempt: 2, program: "wave-gate" });
    const specAuthority = specRecovery.requests[0]!.authority;
    const afterSpec = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", specAuthority.requestId, "--slot", specAuthority.slotId, "--attempt", "2",
    ], "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED", root);
    expect(afterSpec.status, afterSpec.stderr).toBe(0);
    const freshPanel = JSON.parse(afterSpec.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(freshPanel.kind, afterSpec.stdout).toBe("spawn-batch");
    expect(freshPanel.requests.every(({ authority }) => authority.program === "refutation-panel" &&
      authority.role === "review-verifier-agent")).toBe(true);
    expect((JSON.parse(readFileSync(statePath, "utf8")) as { tasks: readonly { review_run?: unknown }[] }).tasks[0]?.review_run).toBeUndefined();
    for (const [index, request] of freshPanel.requests.entries()) {
      const raw = index === 0 ? "not valid refutation JSON" : refutationOutput(opened.value, request.authority);
      expect((await opened.value.captureTranscript(request.authority, [...Buffer.from(raw)])).ok).toBe(true);
    }
    const retriedPanel = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(retriedPanel.status, retriedPanel.stderr).toBe(0);
    const retryAction = JSON.parse(retriedPanel.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(retryAction.kind, retriedPanel.stdout).toBe("spawn-batch");
    expect(retryAction.requests).toHaveLength(1);
    expect(retryAction.requests[0]?.authority).toMatchObject({
      role: "review-verifier-agent", program: "refutation-panel", attempt: 2,
      slotId: freshPanel.requests[0]!.authority.slotId,
    });
    const rejectedRetry = retryAction.requests[0]!.authority;
    await opened.value.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `capture-rejected:${rejectedRetry.requestId}`,
      recordedAtMs: Date.now(),
      event: {
        kind: "request-capture-rejected",
        requestId: rejectedRetry.requestId,
        slotId: rejectedRetry.slotId,
        attempt: rejectedRetry.attempt,
        diagnostic: "agent exited before final payload capture",
      },
    });
    const exhausted = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(exhausted.status, exhausted.stderr).toBe(0);
    expect(JSON.parse(exhausted.stdout)).toMatchObject({
      kind: "blocked",
      diagnostic: { message: expect.stringContaining("attempt 2 exhausted after capture rejection") },
    });
  }, 30_000);

  it("advances a capture-rejected Wave reviewer attempt 1 to diagnostic-rich attempt 2", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {}, tasks: [{
        id: "T1", description: "attempt-one rejection", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-attempt-one-rejection-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-attempt-one-rejection");
    mkdirSync(runDir);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const rejected = initial.requests.find(({ authority }) => authority.role === WAVE_REVIEW_AGENTS[0])!.authority;
    await opened.value.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: `capture-rejected:${rejected.requestId}`,
      recordedAtMs: Date.now(),
      event: {
        kind: "request-capture-rejected",
        requestId: rejected.requestId,
        slotId: rejected.slotId,
        attempt: rejected.attempt,
        diagnostic: "model exited without a final payload",
      },
    });
    for (const { authority } of initial.requests.filter(({ authority }) => authority.requestId !== rejected.requestId)) {
      const task = authority.role === "spec-check-invoker"
        ? "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED"
        : (() => {
            const graph = JSON.parse(readFileSync(statePath, "utf8")) as { tasks: readonly { review_run?: { generation: number; packet_id: string } }[] };
            const run = graph.tasks[0]!.review_run!;
            return [
              "### Machine Summary", `REVIEW_GENERATION: ${run.generation}`, `REVIEW_PACKET_ID: ${run.packet_id}`,
              "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "CRITICAL:", "ADVISORY:",
              "```findings", "[]", "```", "```review_lifecycle", '{"prior_findings":[]}', "```",
            ].join("\n");
          })();
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(task)])).ok).toBe(true);
    }

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(resumed.status, resumed.stderr).toBe(0);
    const retry = JSON.parse(resumed.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority; task: string }[];
    };
    expect(retry.kind).toBe("spawn-batch");
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0]?.authority).toMatchObject({
      role: rejected.role,
      slotId: rejected.slotId,
      attempt: 2,
    });
    expect(retry.requests[0]?.task).toContain("model exited without a final payload");
    expect(retry.requests[0]?.task).toContain('"finding_id"');
    const lateAttemptOne = await opened.value.captureTranscript(rejected, [...Buffer.from("late")]);
    expect(lateAttemptOne.ok).toBe(false);
    if (!lateAttemptOne.ok) expect(lateAttemptOne.error.message).toContain("terminally rejected");
  }, 30_000);

  it("atomically restarts an exhausted Wave reviewer run with new generations and authority", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    expect(proof.state).toBe("satisfied");
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {},
      tasks: [{
        id: "T1", description: "restart target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-restart-runs-"));
    cleanup.push(runsRoot);
    const previousRun = join(runsRoot, "run.wave-exhausted");
    mkdirSync(previousRun);
    const started = runCli([
      "start", "wave-gate", "--runs-root", runsRoot, "--run", previousRun,
    ], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const previous = openRunDirectory(runsRoot, previousRun);
    if (!previous.ok) throw new Error(previous.error.message);
    for (const { authority } of initial.requests) {
      expect((await previous.value.captureTranscript(authority, [...Buffer.from("malformed attempt one")])).ok).toBe(true);
    }
    const retryResult = runCli(["resume", "--runs-root", runsRoot, "--run", previousRun], "", root);
    expect(retryResult.status, retryResult.stderr).toBe(0);
    let retries = JSON.parse(retryResult.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(retries.kind).toBe("spawn-batch");
    expect(retries.requests).toHaveLength(WAVE_REVIEW_AGENTS.length);

    // Simulate a pre-diagnostic-prompt run: attempt 2 persisted the exact
    // attempt-1 context under its new request identity. Restart compatibility
    // must validate these immutable persisted bytes, not re-render today's
    // richer retry prompt and demand its digest.
    const historicalRequests: { authority: AgentRequestAuthority }[] = [];
    for (const retry of retries.requests) {
      const firstAuthority = initial.requests.find(({ authority }) =>
        authority.slotId === retry.authority.slotId && authority.attempt === 1)!.authority;
      const firstContext = previous.value.readContext(firstAuthority.contextDigest);
      if (!firstContext.ok) throw new Error(firstContext.error.message);
      const legacyContext = buildContextPacket({
        requestId: retry.authority.requestId,
        role: firstContext.value.role,
        requiredSkill: firstContext.value.requiredSkill,
        outputContract: firstContext.value.outputContract,
        fixedContext: firstContext.value.fixedContext,
        variableContext: firstContext.value.variableContext,
      });
      if (!legacyContext.ok) throw new Error(legacyContext.error.message);
      const published = await previous.value.publishContext(legacyContext.value);
      if (!published.ok) throw new Error(published.error.message);
      const legacyAuthority = parseAgentRequestAuthority({
        ...retry.authority,
        contextDigest: legacyContext.value.digest,
      });
      if (!legacyAuthority.ok) throw new Error(legacyAuthority.error.violations.map(({ message }) => message).join("; "));
      expect(persistedWaveAttemptTwoCompatibilityProblem(
        firstAuthority, legacyAuthority.value, firstContext.value, legacyContext.value,
      )).toBeNull();

      const forgedSection = encodeByteSection("forged-retry-context", "untrusted bytes");
      if (!forgedSection.ok) throw new Error(forgedSection.error.message);
      const forgedContext = buildContextPacket({
        ...legacyContext.value,
        variableContext: [...legacyContext.value.variableContext, forgedSection.value],
      });
      if (!forgedContext.ok) throw new Error(forgedContext.error.message);
      const forgedAuthority = parseAgentRequestAuthority({
        ...legacyAuthority.value,
        contextDigest: forgedContext.value.digest,
      });
      if (!forgedAuthority.ok) throw new Error(forgedAuthority.error.violations.map(({ message }) => message).join("; "));
      expect(persistedWaveAttemptTwoCompatibilityProblem(
        firstAuthority, forgedAuthority.value, firstContext.value, forgedContext.value,
      )).toContain("neither a legacy retry nor one diagnostic-rich retry");

      // The engine-issued attempt-2 context is the canonical diagnostic-rich
      // retry and must pass persisted compatibility byte-exactly.
      const retryContext = previous.value.readContext(retry.authority.contextDigest);
      if (!retryContext.ok) throw new Error(retryContext.error.message);
      expect(persistedWaveAttemptTwoCompatibilityProblem(
        firstAuthority, retry.authority, firstContext.value, retryContext.value,
      )).toBeNull();

      // An ATTACKER-reused diagnostic label with arbitrary bytes is not a
      // canonical diagnostic-rich retry: the section bytes must parse as the
      // engine's fixed preamble + non-empty reason + fixed schema tail.
      const forgedDiagnosticSection = encodeByteSection(
        "wave-review-attempt-1-rejection", "attacker-controlled retry instructions",
      );
      if (!forgedDiagnosticSection.ok) throw new Error(forgedDiagnosticSection.error.message);
      const forgedDiagnosticContext = buildContextPacket({
        ...legacyContext.value,
        variableContext: [...legacyContext.value.variableContext, forgedDiagnosticSection.value],
      });
      if (!forgedDiagnosticContext.ok) throw new Error(forgedDiagnosticContext.error.message);
      const forgedDiagnosticAuthority = parseAgentRequestAuthority({
        ...legacyAuthority.value,
        contextDigest: forgedDiagnosticContext.value.digest,
      });
      if (!forgedDiagnosticAuthority.ok) {
        throw new Error(forgedDiagnosticAuthority.error.violations.map(({ message }) => message).join("; "));
      }
      expect(persistedWaveAttemptTwoCompatibilityProblem(
        firstAuthority, forgedDiagnosticAuthority.value, firstContext.value, forgedDiagnosticContext.value,
      )).toContain("neither a legacy retry nor one diagnostic-rich retry");

      rmSync(join(previousRun, "requests", `${retry.authority.requestId}.json`));
      writeFileSync(join(previousRun, "requests", `${retry.authority.requestId}.json`), JSON.stringify(legacyAuthority.value));
      historicalRequests.push({ authority: legacyAuthority.value });
    }
    retries = { ...retries, requests: historicalRequests };

    const forgedRun = join(runsRoot, "run.wave-forged-replacement");
    mkdirSync(forgedRun);
    writeFileSync(join(forgedRun, "checkpoint.json"), JSON.stringify({
      kind: "wave-gate-done",
      receipt: { kind: "forged" },
    }));
    const forged = runCli([
      "restart", "--runs-root", runsRoot, "--run", previousRun, "--new-run", forgedRun,
    ], "", root);
    expect(forged.status).not.toBe(0);
    expect(forged.stderr).toContain("must be pristine");

    const prematureRun = join(runsRoot, "run.wave-premature");
    mkdirSync(prematureRun);
    const premature = runCli([
      "restart", "--runs-root", runsRoot, "--run", previousRun, "--new-run", prematureRun,
    ], "", root);
    expect(premature.status).not.toBe(0);
    expect(premature.stderr).toContain("restart refused before final-attempt rejection");

    for (const { authority } of retries.requests) {
      expect((await previous.value.captureTranscript(authority, [...Buffer.from("malformed attempt two")])).ok).toBe(true);
    }
    const blocked = runCli(["resume", "--runs-root", runsRoot, "--run", previousRun], "", root);
    expect(blocked.status, blocked.stderr).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      kind: "blocked",
      diagnostic: { message: expect.stringContaining("attempt 2 exhausted") },
    });

    const replacementRun = join(runsRoot, "run.wave-replacement");
    mkdirSync(replacementRun);
    const restarted = runCli([
      "restart", "--runs-root", runsRoot, "--run", previousRun, "--new-run", replacementRun,
    ], "", root);
    expect(restarted.status, restarted.stderr).toBe(0);
    const replacement = JSON.parse(restarted.stdout) as {
      kind: string;
      runId: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(replacement.kind).toBe("spawn-batch");
    expect(replacement.runId).toBe("run.wave-replacement");
    expect(replacement.requests).toHaveLength(1 + WAVE_REVIEW_AGENTS.length);
    expect(replacement.requests.every(({ authority }) => authority.runId === "run.wave-replacement" && authority.attempt === 1)).toBe(true);

    const restartedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      active_wave_gate?: { runId: string; wave: number };
      wave_review_epoch?: { runId: string };
      tasks: readonly {
        review_generation?: number;
        review_status?: string;
        review_error?: string;
        review_evidence_failures?: readonly string[];
        review_run?: { generation: number; prior_finding_ids: readonly string[] };
      }[];
    };
    expect(restartedGraph.active_wave_gate).toMatchObject({ runId: "run.wave-replacement", wave: 1 });
    expect(restartedGraph.wave_review_epoch).toMatchObject({ runId: "run.wave-replacement" });
    expect(restartedGraph.tasks[0]).toMatchObject({
      review_generation: 0,
      review_status: "pending",
      review_run: { generation: 0, prior_finding_ids: [] },
    });
    expect(restartedGraph.tasks[0]?.review_error).toBeUndefined();
    expect(restartedGraph.tasks[0]?.review_evidence_failures).toBeUndefined();
    const retirementCheckpoint = await previous.value.readCheckpoint();
    expect(JSON.parse(retirementCheckpoint ?? "null")).toMatchObject({
      kind: "wave-gate-retired",
      previousRunId: "run.wave-exhausted",
      replacementRunId: "run.wave-replacement",
      exhaustedSlots: expect.arrayContaining(WAVE_REVIEW_AGENTS.map((agent) => `T1/${agent}`)),
    });

    // Simulate a crash after protected authority/review-run installation and a
    // strict prefix of request reservations, before the replacement batch
    // publication receipt becomes durable. Resume must complete the exact
    // deterministic batch instead of treating partial issuance as corruption.
    const replacementHandle = openRunDirectory(runsRoot, replacementRun);
    if (!replacementHandle.ok) throw new Error(replacementHandle.error.message);
    const publicationDir = join(replacementRun, "artifacts", "publications");
    for (const name of readdirSync(publicationDir)) rmSync(join(publicationDir, name));
    const requestsDir = join(replacementRun, "requests");
    const requestFiles = readdirSync(requestsDir).sort();
    for (const name of requestFiles.slice(1)) rmSync(join(requestsDir, name));
    const recoveredReplacement = runCli([
      "resume", "--runs-root", runsRoot, "--run", replacementRun,
    ], "", root);
    expect(recoveredReplacement.status, recoveredReplacement.stderr).toBe(0);
    const recoveredBatch = JSON.parse(recoveredReplacement.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(recoveredBatch.kind, recoveredReplacement.stdout).toBe("spawn-batch");
    expect(recoveredBatch.requests.map(({ authority }) => authority.requestId)).toEqual(
      replacement.requests.map(({ authority }) => authority.requestId),
    );

    const replayedRestart = runCli([
      "restart", "--runs-root", runsRoot, "--run", previousRun, "--new-run", replacementRun,
    ], "", root);
    expect(replayedRestart.status, replayedRestart.stderr).toBe(0);
    const replayedBatch = JSON.parse(replayedRestart.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(replayedBatch.kind).toBe("spawn-batch");
    expect(replayedBatch.requests.map(({ authority }) => authority.requestId)).toEqual(
      replacement.requests.map(({ authority }) => authority.requestId),
    );
    expect(await previous.value.readCheckpoint()).toBe(retirementCheckpoint);

    const oldResume = runCli(["resume", "--runs-root", runsRoot, "--run", previousRun], "", root);
    expect(oldResume.status, oldResume.stderr).toBe(0);
    expect(JSON.parse(oldResume.stdout)).toMatchObject({
      kind: "blocked",
      diagnostic: { message: expect.stringContaining("wave-gate-retired") },
    });
  }, 30_000);

  it("preserves accepted partial findings and accepts durable capture rejection during restart", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {}, tasks: [{
        id: "T1", description: "partial restart", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-partial-restart-runs-"));
    cleanup.push(runsRoot);
    const previousRun = join(runsRoot, "run.wave-partial-exhausted");
    mkdirSync(previousRun);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", previousRun], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const graph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_run?: { generation: number; packet_id: string } }[];
    };
    const run = graph.tasks[0]!.review_run!;
    const accepted = [
      "### Machine Summary", `REVIEW_GENERATION: ${run.generation}`, `REVIEW_PACKET_ID: ${run.packet_id}`,
      "CRITICAL_COUNT: 1", "ADVISORY_COUNT: 0", "CRITICAL: partial critical survives restart",
      "```findings", JSON.stringify([{ severity: "critical", file: "src/x.ts", line: 1, claim: "partial critical survives restart" }]), "```",
      "```review_lifecycle", '{"prior_findings":[]}', "```",
    ].join("\n");
    const reviewerRequests = initial.requests.filter(({ authority }) => authority.role !== "spec-check-invoker");
    const first = reviewerRequests[0]!.authority;
    const opened = openRunDirectory(runsRoot, previousRun);
    if (!opened.ok) throw new Error(opened.error.message);
    expect((await opened.value.captureTranscript(first, [...Buffer.from(accepted)])).ok).toBe(true);
    for (const { authority } of initial.requests.filter(({ authority }) => authority.requestId !== first.requestId)) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("malformed attempt one")])).ok).toBe(true);
    }
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", previousRun], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    const retries = JSON.parse(resumed.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    expect(retries.requests).toHaveLength(WAVE_REVIEW_AGENTS.length - 1);
    for (const { authority } of retries.requests) {
      await opened.value.appendEvent({
        schemaVersion: 1,
        sequence: 0,
        dedupKey: `capture-rejected:${authority.requestId}`,
        recordedAtMs: Date.now(),
        event: {
          kind: "request-capture-rejected",
          requestId: authority.requestId,
          slotId: authority.slotId,
          attempt: authority.attempt,
          diagnostic: "agent exited before a final payload",
        },
      });
    }
    const blocked = runCli(["resume", "--runs-root", runsRoot, "--run", previousRun], "", root);
    expect(blocked.status, blocked.stderr).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ kind: "blocked" });

    const replacementRun = join(runsRoot, "run.wave-partial-replacement");
    mkdirSync(replacementRun);
    const restarted = runCli([
      "restart", "--runs-root", runsRoot, "--run", previousRun, "--new-run", replacementRun,
    ], "", root);
    expect(restarted.status, restarted.stderr).toBe(0);
    const lateCapture = await opened.value.captureTranscript(retries.requests[0]!.authority, [...Buffer.from(accepted)]);
    expect(lateCapture.ok).toBe(false);
    if (!lateCapture.ok) expect(lateCapture.error.message).toContain("terminally rejected");
    const restartedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { findings?: readonly { claim: string }[]; review_run?: { prior_finding_ids: readonly string[] } }[];
    };
    expect(restartedGraph.tasks[0]?.findings?.map(({ claim }) => claim)).toContain("partial critical survives restart");
    expect(restartedGraph.tasks[0]?.review_run?.prior_finding_ids).toHaveLength(1);
  }, 30_000);

  it("refuses restart when captured attempt 2 is valid but has not been applied", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {}, tasks: [{
        id: "T1", description: "valid retry", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-valid-retry-runs-"));
    cleanup.push(runsRoot);
    const previousRun = join(runsRoot, "run.wave-valid-retry");
    mkdirSync(previousRun);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", previousRun], JSON.stringify({ wave: 1 }), root);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const opened = openRunDirectory(runsRoot, previousRun);
    if (!opened.ok) throw new Error(opened.error.message);
    for (const { authority } of initial.requests) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("malformed attempt one")])).ok).toBe(true);
    }
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", previousRun], "", root);
    const retries = JSON.parse(resumed.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const active = (JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_run?: { generation: number; packet_id: string; prior_finding_ids: readonly string[] } }[];
    }).tasks[0]!.review_run!;
    const valid = [
      "### Machine Summary", `REVIEW_GENERATION: ${active.generation}`, `REVIEW_PACKET_ID: ${active.packet_id}`,
      "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "CRITICAL:", "ADVISORY:",
      "```findings", "[]", "```", "```review_lifecycle", '{"prior_findings":[]}', "```",
    ].join("\n");
    for (const { authority } of retries.requests.slice(0, -1)) {
      const submitted = runCli([
        "submit", "--runs-root", runsRoot, "--run", previousRun,
        "--request", authority.requestId, "--slot", authority.slotId, "--attempt", "2",
      ], valid, root);
      expect(submitted.status, submitted.stderr).toBe(0);
    }
    const finalValid = retries.requests.at(-1)!.authority;
    // Crash window: final valid bytes landed, but semantic application has not.
    // Applying this slot would close the roster and remove review_run entirely.
    expect((await opened.value.captureTranscript(finalValid, [...Buffer.from(valid)])).ok).toBe(true);
    const replacementRun = join(runsRoot, "run.wave-valid-retry-replacement");
    mkdirSync(replacementRun);
    const restarted = runCli([
      "restart", "--runs-root", runsRoot, "--run", previousRun, "--new-run", replacementRun,
    ], "", root);
    expect(restarted.status).not.toBe(0);
    expect(restarted.stderr).toContain("valid captured attempt-2 evidence");
  }, 30_000);

  it("heals a Wave completion crash between the graph commit and the checkpoint write", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {}, tasks: [{
        id: "T1", description: "completion crash window", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-crash-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-crash-window");
    mkdirSync(runDir);
    const started = runCli([
      "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const active = (JSON.parse(readFileSync(statePath, "utf8")) as {
      active_wave_gate: { runId: string; wave: number; authorityDigest: string };
    }).active_wave_gate;
    expect(active).toMatchObject({ runId: "run.wave-crash-window", wave: 1 });

    // Simulate the exact completion crash window: commitActiveWaveGateCompletion
    // durably wrote the retired graph with completion history, but the terminal
    // checkpoint write never happened. The run directory has NO checkpoint.
    const crashGraph = {
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null,
      wave_gates: {
        "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
      },
      tasks: [{
        id: "T1", description: "completion crash window", agent: "code-implementer-agent", wave: 1,
        status: "completed", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
      wave_gate_history: [{
        schemaVersion: 1,
        kind: "completed-wave-gate",
        runId: active.runId,
        wave: 1,
        authorityDigest: active.authorityDigest,
        revision: 1,
        completionReceipt: {
          kind: "protected-wave-state-committed",
          effectId: "effect:wave-completion:crash-window-test",
          runId: active.runId,
          committedRevision: 1,
          stateDigest: "a".repeat(64),
        },
      }],
    };
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify(crashGraph, null, 2));

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    const outcome = JSON.parse(resumed.stdout) as { kind: string; outcome: { kind: string; runId: string } };
    expect(outcome.kind).toBe("done");
    expect(outcome.outcome).toMatchObject({
      kind: "protected-wave-state-committed",
      runId: active.runId,
    });

    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const checkpoint = await opened.value.readCheckpoint();
    expect(JSON.parse(checkpoint ?? "null")).toMatchObject({
      schemaVersion: 1,
      kind: "wave-gate-done",
      receipt: outcome.outcome,
    });

    const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout).kind).toBe("done");
  }, 30_000);

  it("blocks instead of spinning when a Wave refutation tally upholds every critical (loom#20 Finding 4)", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    expect(proof.state).toBe("satisfied");
    const finding = {
      id: "code-reviewer-7", agent: "code-reviewer", severity: "critical" as const,
      file: "src/x.ts", line: 1, claim: "relative imports bypass the check-imports boundary",
    };
    const graph = {
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {},
      wave_review_epoch: { runId: "run.wave-upheld-tally", wave: 1, batchEpoch: "a".repeat(64) },
      spec_check: {
        wave: 1, run_at: new Date().toISOString(), verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
      tasks: [{
        id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "blocked", review_generation: 0,
        findings: [finding], critical_findings: [finding.claim], advisory_findings: [],
      }],
    };
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(graph));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-upheld-tally-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-upheld-tally");
    mkdirSync(runDir);

    // Start: the seeded closed review state skips the 21-transcript review
    // batch and lands directly on the refutation stage (the reducer stages
    // before the tally are exercised by the review-recovery tests above).
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir],
      JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string; requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(action.kind).toBe("spawn-batch");
    expect(action.requests).toHaveLength(3);
    expect(action.requests.every(({ authority }) =>
      authority.program === "refutation-panel" && authority.attempt === 1)).toBe(true);
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    for (const { authority } of action.requests) {
      const raw = refutationVerdicts(opened.value, authority, "upheld");
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(raw)])).ok).toBe(true);
    }

    // The reducer used to recurse after the tally no matter what: an all-upheld
    // decision changes nothing, so it re-derived the identical snapshot and
    // identical tally forever (~113% CPU, exit 124 at 240s). It must now fall
    // through to the gate decision and report the surviving critical as a
    // blocked Wave Gate.
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    const outcome = JSON.parse(resumed.stdout) as {
      kind: string;
      diagnostic: { kind: string; message: string };
    };
    expect(outcome.kind, resumed.stdout).toBe("blocked");
    expect(outcome.diagnostic.kind).toBe("wave-gate-blocked");
    expect(outcome.diagnostic.message).toContain("1 critical code review findings");
    expect(outcome.diagnostic.message).toContain(finding.claim);

    // The upheld critical must still be live and un-refuted in the graph.
    const protectedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { findings: readonly { id: string; severity: string; claim: string }[];
        critical_findings: readonly string[]; refuted_findings?: readonly unknown[] }[];
    };
    expect(protectedGraph.tasks[0]?.findings).toHaveLength(1);
    expect(protectedGraph.tasks[0]?.findings?.[0]).toMatchObject({ id: finding.id, severity: "critical" });
    expect(protectedGraph.tasks[0]?.critical_findings).toEqual([finding.claim]);
    expect(protectedGraph.tasks[0]?.refuted_findings ?? []).toHaveLength(0);

    // Idempotent termination: a further resume replays the same captured
    // verdicts and must also return blocked, never spin.
    const again = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).kind).toBe("blocked");
  }, 30_000);

  it("passes a Wave whose refutation tally refutes every critical", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    expect(proof.state).toBe("satisfied");
    const finding = {
      id: "code-reviewer-7", agent: "code-reviewer", severity: "critical" as const,
      file: "src/x.ts", line: 1, claim: "relative imports bypass the check-imports boundary",
    };
    const graph = {
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {},
      wave_review_epoch: { runId: "run.wave-refuted-tally", wave: 1, batchEpoch: "b".repeat(64) },
      spec_check: {
        wave: 1, run_at: new Date().toISOString(), verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
      tasks: [{
        id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "blocked", review_generation: 0,
        findings: [finding], critical_findings: [finding.claim], advisory_findings: [],
      }],
    };
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(graph));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-refuted-tally-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-refuted-tally");
    mkdirSync(runDir);

    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir],
      JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as {
      kind: string; requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(action.kind).toBe("spawn-batch");
    expect(action.requests).toHaveLength(3);
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    for (const { authority } of action.requests) {
      const raw = refutationVerdicts(opened.value, authority, "refuted");
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(raw)])).ok).toBe(true);
    }

    // A refuting tally retires the critical and promotes the blocked task:
    // the reducer must still re-derive under the changed snapshot and drive
    // the wave to done.
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    const outcome = JSON.parse(resumed.stdout) as { kind: string; outcome: { kind: string; runId: string } };
    expect(outcome.kind, resumed.stdout).toBe("done");
    expect(outcome.outcome.kind).toBe("protected-wave-state-committed");
    const protectedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { findings: readonly unknown[]; critical_findings: readonly string[];
        refuted_findings: readonly unknown[]; review_status: string }[];
    };
    expect(protectedGraph.tasks[0]?.findings).toHaveLength(0);
    expect(protectedGraph.tasks[0]?.critical_findings).toHaveLength(0);
    expect(protectedGraph.tasks[0]?.refuted_findings).toHaveLength(1);
    expect(protectedGraph.tasks[0]?.review_status).toBe("passed");
    const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(JSON.parse(replay.stdout).kind).toBe("done");
  }, 30_000);

  it("publishes standalone refutation attempt 2 after a malformed attempt-1 verdict", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "changed\n");
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-standalone-refutation-retry-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.standalone-refutation-retry");
    mkdirSync(runDir);
    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "all", files: ["a.txt"], dryRun: false }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const critical = [
      "### Machine Summary", "CRITICAL_COUNT: 1", "ADVISORY_COUNT: 0", "CRITICAL: retry finding",
      "```findings", '[{"severity":"critical","file":"a.txt","line":1,"claim":"retry finding"}]', "```",
    ].join("\n");
    const clean = ["### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "```findings", "[]", "```"].join("\n");
    for (const [index, request] of initial.requests.entries()) {
      expect((await opened.value.captureTranscript(request.authority, [...Buffer.from(index === 0 ? critical : clean)])).ok).toBe(true);
    }
    const panelResult = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(panelResult.status, panelResult.stderr).toBe(0);
    const panel = JSON.parse(panelResult.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(panel.kind).toBe("spawn-batch");
    for (const [index, request] of panel.requests.entries()) {
      const raw = index === 0 ? "malformed" : refutationOutput(opened.value, request.authority);
      expect((await opened.value.captureTranscript(request.authority, [...Buffer.from(raw)])).ok).toBe(true);
    }

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(resumed.status, resumed.stderr).toBe(0);
    const retry = JSON.parse(resumed.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(retry.kind, resumed.stdout).toBe("spawn-batch");
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0]?.authority).toMatchObject({
      attempt: 2, program: "refutation-panel", slotId: panel.requests[0]!.authority.slotId,
    });

    // Complete the retry with a VALID verdict, then drive the run to done. The
    // finalize must persist the canonical T2 refutation checkpoint (event
    // prefix INCLUDING the attempt-1 rejection): re-resuming the done run
    // replays the completion receipt, and a slot accepted on attempt 2 can
    // only be reconstructed from the full event prefix, not from the
    // accepted-only completed-state projection.
    const retryRequest = retry.requests[0]!;
    const valid = refutationOutput(opened.value, retryRequest.authority);
    expect((await opened.value.captureTranscript(retryRequest.authority, [...Buffer.from(valid)])).ok).toBe(true);
    const doneResult = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(doneResult.status, doneResult.stderr).toBe(0);
    expect(JSON.parse(doneResult.stdout).kind).toBe("done");

    // Idempotent done: the durable receipt must restore cleanly after restart.
    const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout).kind).toBe("done");
  }, 30_000);

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

  it("heals a standalone crash after batch publication but before the checkpoint write", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "changed\n");
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-standalone-crash-runs-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.standalone-crash-window");
    mkdirSync(runDir);
    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["a.txt"], dryRun: false }), root);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };

    // Simulate the crash window: publishInitialBatch durably wrote contexts,
    // requests, and the publication receipt, but the awaiting-results
    // checkpoint write never happened.
    rmSync(join(runDir, "checkpoint.json"));

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    const resumedAction = JSON.parse(resumed.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(resumedAction.kind).toBe("spawn-batch");
    expect(resumedAction.requests).toHaveLength(action.requests.length);

    // Reviewers complete cleanly; the run must finish as a normal run would.
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const transcript = [
      "### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "", "```findings", "[]", "```",
    ].join("\n");
    for (const { authority } of resumedAction.requests) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(transcript)])).ok).toBe(true);
    }
    const done = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(done.status, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout).kind).toBe("done");
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
