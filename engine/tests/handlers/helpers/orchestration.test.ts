import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observedAdvisoryApproval, renderStatus } from "../../../src/handlers/helpers/orchestration";
import { WAVE_REVIEW_AGENTS, type GateDeps } from "../../../src/core/wave-gate-machine";
import { evaluateTaskProof } from "../../../src/core/proof-obligations";
import { parseAgentRequestAuthority, type AgentRequestAuthority } from "../../../src/core/orchestration-contract";
import { agentRequestAuthority } from "../../fixtures/agent-request-authority";
import { parseRegisteredFacadeProgram } from "../../../src/handlers/helpers/programs";
import {
  replayStandaloneResultFromEvidence,
  type StandaloneCaptureWitness,
} from "../../../src/handlers/helpers/programs/standalone";
import { persistedWaveAttemptTwoCompatibilityProblem, prepareOrphanedWaveGateRecovery } from "../../../src/handlers/helpers/programs/wave-gate";
import { captureKey } from "../../../src/core/harness-capture";
import { buildContextPacket, encodeByteSection } from "../../../src/orchestration/context-packets";
import { openRunDirectory, inspectRunDirectoryEntry, type RunDirHandle } from "../../../src/orchestration/run-directory-handle";
import { readSessionRunBindings } from "../../../src/orchestration/session-run-bindings";
import type { Task, TaskGraph } from "../../../src/types";
import {
  captureLoomRuntimeIdentity,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../../../src/runtime-compatibility";

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CURRENT_RUNTIME = captureLoomRuntimeIdentity(PACKAGE_ROOT);
const CLI = join(ENGINE, "src", "cli.ts");
const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  // This file intentionally drives many synchronous child CLIs. Yield between
  // cases so Vitest can acknowledge task-update RPCs instead of timing out
  // while the worker remains continuously occupied by spawnSync calls.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

const deps: GateDeps = {
  loadPlanModels: () => ({
    kind: "loaded",
    models: { lifecycles: [], pipeline: null, invariants: [], strays: [] },
  }),
  filePresence: () => ({ ok: true, exists: true }),
};

const FACT_CATEGORIES = [
  "location",
  "tasks",
  "failedProofObligations",
  "testReadiness",
  "reviewRuns",
  "findingCounts",
  "refutationPanelNeed",
  "waveCompletionSuiteReadiness",
  "waveGateCompletionEligibility",
] as const;

function executeGraph(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    current_phase: "execute",
    current_wave: 1,
    spec_dir: ".claude/specs/x",
    phase_artifacts: {},
    skipped_phases: [],
    plan_file: "plan.md",
    wave_gates: {},
    tasks: [
      { id: "T1", description: "d", agent: "code-implementer-agent", wave: 1, status: "implemented", depends_on: [] },
      { id: "T2", description: "d", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] },
    ],
    ...overrides,
  };
}

function modelFreePlan(root: string): string {
  const path = join(root, "plan.md");
  writeFileSync(path, "# Model-free plan\n");
  return path;
}

function specCheckDocuments(specFile: string | null, planFile: string | null) {
  const document = (path: string | null) => path === null
    ? { path: null, contentDigest: null }
    : { path, contentDigest: createHash("sha256").update(readFileSync(path)).digest("hex") };
  return { spec: document(specFile), plan: document(planFile) };
}

function replayFromCapturedEvidence(handle: RunDirHandle) {
  const registration = handle.readProgramRegistration();
  if (!registration.ok || registration.value === null) throw new Error("expected standalone registration");
  const parsed = parseRegisteredFacadeProgram(registration.value);
  if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review") {
    throw new Error("expected parsed standalone registration");
  }
  const issued = handle.readIssuedRequests();
  const captured = handle.readCapturedAttempts();
  if (!issued.ok) throw new Error(issued.error.message);
  if (!captured.ok) throw new Error(captured.error.message);
  const witnesses = new Map<string, StandaloneCaptureWitness>();
  for (const authority of issued.value) {
    const key = captureKey(authority.slotId, authority.attempt);
    if (!captured.value.has(key)) continue;
    const bytes = handle.readTranscriptBytes(authority);
    if (!bytes.ok) throw new Error(bytes.error.message);
    witnesses.set(key, Object.freeze({
      requestId: authority.requestId,
      role: authority.role,
      contextDigest: authority.contextDigest,
      digest: createHash("sha256").update(bytes.value).digest("hex"),
      byteLength: bytes.value.byteLength,
    }));
  }
  return replayStandaloneResultFromEvidence(handle, parsed.program, witnesses);
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
  // The ambient session's own runtime handshake must not leak into the spawned
  // CLI: it names the runtime the OUTER Pi process loaded, which is stale once
  // this checkout has changed (exactly the skew the CLI guard is designed to
  // catch). The test publishes its own checkout-consistent identity below.
  delete env[PI_EXTENSION_RUNTIME_ROOT_ENV];
  delete env[PI_EXTENSION_RUNTIME_REVISION_ENV];
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  if (env.PI_CODING_AGENT === "true") {
    env[PI_EXTENSION_RUNTIME_ROOT_ENV] ??= CURRENT_RUNTIME.packageRoot;
    env[PI_EXTENSION_RUNTIME_REVISION_ENV] ??= CURRENT_RUNTIME.revision;
  }
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

  it("never calls an unverified registered run healthy and reports proven directory absence as orphaned", () => {
    const active = executeGraph({
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "run.status-orphan", wave: 1,
        authorityDigest: "a".repeat(64), revision: 0, terminalOutcome: null,
      },
    });
    const unverified = renderStatus(active, deps, true);
    expect(unverified).not.toContain("healthy");
    expect(unverified).toContain("registered-run-suspended");

    const orphaned = renderStatus(active, deps, true, {
      kind: "absent", runId: "run.status-orphan", path: "/runs/run.status-orphan",
    });
    expect(orphaned).not.toContain("healthy");
    expect(orphaned).toContain("orphaned active Wave Gate run run.status-orphan");
    expect(orphaned).toContain("authoritative Run Directory does not exist");
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

  it("treats a Run Directory observation for a DIFFERENT run as unavailable, never healthy (round-29 fail-closed status)", () => {
    const active = executeGraph({
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "run.status-owner", wave: 1,
        authorityDigest: "a".repeat(64), revision: 0, terminalOutcome: null,
      },
    });
    // A "present" observation for the wrong run id — even a perfectly healthy
    // directory — must not be conflated with THIS run's authority.
    const mismatched = renderStatus(active, deps, true, {
      kind: "present", runId: "run.stranger", path: "/runs/run.stranger",
    });
    expect(mismatched).toContain("run.stranger, not active run run.status-owner");
    expect(JSON.parse(mismatched).next.action.kind).toBe("blocked");

    const absentWrongRun = renderStatus(active, deps, true, {
      kind: "absent", runId: "run.stranger", path: "/runs/run.stranger",
    });
    expect(JSON.parse(absentWrongRun).next.action.kind).toBe("blocked");
    expect(absentWrongRun).not.toContain("orphaned active Wave Gate run run.status-owner");
  });

  it("reports an INVALID run-directory observation (symlinked entry) as unavailable, never healthy", () => {
    const active = executeGraph({
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "run.status-invalid", wave: 1,
        authorityDigest: "a".repeat(64), revision: 0, terminalOutcome: null,
      },
    });
    const invalid = renderStatus(active, deps, true, {
      kind: "invalid", runId: "run.status-invalid", path: "/runs/run.status-invalid",
      message: "expected a directory but found symlink",
    });
    expect(invalid).toContain("cannot verify authoritative Run Directory");
    expect(invalid).toContain("expected a directory but found symlink");
    expect(JSON.parse(invalid).next.action.kind).toBe("blocked");
  });
});

// --- inspectRunDirectoryEntry (round-29: symlink/non-directory occupied proofs) ---

describe("observedAdvisoryApproval", () => {
  it("preserves malformed graph authority as unavailable rather than not approved", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await observedAdvisoryApproval({ malformed: true }, {
        kind: "present",
        runId: "run.malformed-advisory-graph",
        path: "/unused/run.malformed-advisory-graph",
      })).toEqual({
        kind: "unavailable",
        reason: expect.stringContaining("missing current_phase"),
      });
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain("cannot determine advisory approval for run.malformed-advisory-graph");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("inspectRunDirectoryEntry", () => {
  it("classifies a symlink at the run path as occupied, never as a usable directory", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-inspect-")));
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(runsRoot, { recursive: true });
    symlinkSync("/nonexistent", join(runsRoot, "run.symlink"));

    const inspected = inspectRunDirectoryEntry(runsRoot, join(runsRoot, "run.symlink"));
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.error.message);
    expect(inspected.value).toEqual({
      kind: "occupied",
      reference: { runsRoot, runDirectory: join(runsRoot, "run.symlink"), runId: "run.symlink" },
      entryKind: "symlink",
    });
  });

  it("classifies a non-directory entry (file) as occupied, never as a usable directory", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-inspect-")));
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(runsRoot, { recursive: true });
    writeFileSync(join(runsRoot, "run.notadir"), "not a directory\n");

    const inspected = inspectRunDirectoryEntry(runsRoot, join(runsRoot, "run.notadir"));
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.error.message);
    expect(inspected.value).toEqual({
      kind: "occupied",
      reference: { runsRoot, runDirectory: join(runsRoot, "run.notadir"), runId: "run.notadir" },
      entryKind: "other",
    });
  });

  it("classifies a missing entry as absent and a real directory as a directory", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-inspect-")));
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(join(runsRoot, "run.real"), { recursive: true });

    const absent = inspectRunDirectoryEntry(runsRoot, join(runsRoot, "run.gone"));
    expect(absent.ok).toBe(true);
    if (!absent.ok) throw new Error(absent.error.message);
    expect(absent.value.kind).toBe("absent");

    const present = inspectRunDirectoryEntry(runsRoot, join(runsRoot, "run.real"));
    expect(present.ok).toBe(true);
    if (!present.ok) throw new Error(present.error.message);
    expect(present.value.kind).toBe("directory");
  });
});

// --- orphan recovery pure transition (round-29: direct unit coverage) ---

describe("prepareOrphanedWaveGateRecovery", () => {
  const activeRunId = "run.orphan-unit";
  const authorityDigest = "a".repeat(64);

  function graph(): TaskGraph {
    return {
      current_phase: "execute",
      current_wave: 1,
      spec_dir: ".claude/specs/x",
      phase_artifacts: {},
      skipped_phases: [],
      wave_gates: {},
      spec_check: undefined,
      wave_review_epoch: { runId: activeRunId, batchEpoch: "old-epoch" },
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: activeRunId, wave: 1,
        authorityDigest, revision: 0, terminalOutcome: null, runsRoot: "/runs",
      },
      tasks: [
        {
          id: "T1", description: "wave-1 with review run", agent: "code-implementer-agent",
          wave: 1, status: "implemented", depends_on: [],
          review_run: {
            packet_id: "d".repeat(64), generation: 2, expected_agents: ["code-reviewer"],
            evidence: [{
              agent: "code-reviewer", prior_assessments: [],
              new_findings: [{ severity: "advisory", file: "f.ts", line: 1, claim: "preserve me" }],
            }],
            prior_finding_ids: [],
          },
          review_status: "blocked", review_generation: 7,
        } as unknown as Task,
        {
          id: "T2", description: "wave-1 without review run", agent: "code-implementer-agent",
          wave: 1, status: "implemented", depends_on: [],
        } as unknown as Task,
        {
          id: "T3", description: "wave-2 with review run", agent: "architecture-tech-lead",
          wave: 2, status: "implemented", depends_on: [],
          review_run: {
            packet_id: "e".repeat(64), generation: 4, expected_agents: ["architecture-tech-lead"],
            evidence: [], prior_finding_ids: [],
          },
          review_status: "blocked", review_generation: 9,
        } as unknown as Task,
      ],
    } as unknown as TaskGraph;
  }

  it("refuses a replacement with the same run identity", () => {
    const prepared = prepareOrphanedWaveGateRecovery(
      graph(),
      { runId: activeRunId, wave: 1, authorityDigest },
      "/runs",
      activeRunId,
      "/runs",
    );
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.message).toContain("distinct replacement");
  });

  it("refuses when the protected authority (wave, run id, digest) is not exact", () => {
    const g = graph();
    for (const expected of [
      { runId: "run.other", wave: 1, authorityDigest },
      { runId: activeRunId, wave: 2, authorityDigest },
      { runId: activeRunId, wave: 1, authorityDigest: "b".repeat(64) },
    ]) {
      const prepared = prepareOrphanedWaveGateRecovery(g, expected, "/runs", "run.orphan-replacement", "/runs");
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) expect(prepared.message).toContain("exact protected active run ID");
    }
  });

  it("resets only the protected wave's review runs, preserving accepted findings and every other task", () => {
    const g = graph();
    const t2 = g.tasks[1]!;
    const t3 = g.tasks[2]!;
    const prepared = prepareOrphanedWaveGateRecovery(
      g,
      { runId: activeRunId, wave: 1, authorityDigest },
      "/runs",
      "run.orphan-replacement",
      "/runs",
    );
    if (!prepared.ok) throw new Error(prepared.message);
    const next = prepared.value.graph;

    expect(next.active_wave_gate).toMatchObject({
      runId: "run.orphan-replacement", wave: 1, runsRoot: "/runs", terminalOutcome: null,
    });
    expect(next.spec_check).toBeUndefined();
    expect(next.wave_review_epoch).toBeUndefined();

    // T1: review run reset, findings preserved, generation kept.
    const t1 = next.tasks.find((task) => task.id === "T1")!;
    expect(t1.review_run).toBeUndefined();
    expect(t1.review_status).toBe("pending");
    expect(t1.review_generation).toBe(7);
    expect(t1.findings).toHaveLength(1);
    expect(t1.findings![0]).toMatchObject({ agent: "code-reviewer", severity: "advisory", claim: "preserve me" });
    expect(t1.critical_findings).toEqual([]);

    // T2 (same wave, no review run) and T3 (other wave) are byte-identical.
    expect(next.tasks.find((task) => task.id === "T2")).toBe(t2);
    expect(next.tasks.find((task) => task.id === "T3")).toBe(t3);

    expect(next.orphaned_wave_gate_history).toEqual([expect.objectContaining({
      kind: "orphaned-wave-gate-retirement",
      runId: activeRunId,
      wave: 1,
      authorityDigest,
      reason: "authoritative-run-directory-missing",
      runsRoot: "/runs",
      runDirectory: "/runs/run.orphan-unit",
      replacementRunId: "run.orphan-replacement",
    })]);
    expect(prepared.value.registration).toMatchObject({
      schemaVersion: 1, kind: "wave-gate", input: { wave: 1 },
      orphanRecovery: { previousRunId: activeRunId, previousAuthorityDigest: authorityDigest },
    });
  });
});

// --- CLI --------------------------------------------------------------------

describe("orchestration CLI", () => {
  function project(): string {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-orchestration-")));
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

  it("refuses a status --runs-root that does not match the graph's protected runs root", () => {
    const root = project();
    const protectedRoot = join(root, ".claude", "reviews", "wave-gate-runs");
    mkdirSync(protectedRoot, { recursive: true });
    writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), JSON.stringify(executeGraph({
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "run.status-root", wave: 1,
        authorityDigest: "a".repeat(64), revision: 0, terminalOutcome: null,
        runsRoot: protectedRoot,
      },
    })));

    const result = runCli(["status", "--json", "--runs-root", join(root, "elsewhere")], "", root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("does not match protected root");
    expect(JSON.parse(result.stdout).next.action.kind).toBe("blocked");
  });

  it("reports a SYMLINKED run-directory entry as an invalid observation, never a healthy one", () => {
    const root = project();
    const runsRoot = join(root, ".claude", "reviews", "wave-gate-runs");
    mkdirSync(runsRoot, { recursive: true });
    symlinkSync("/nonexistent-orphan-target", join(runsRoot, "run.status-symlink"));
    writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), JSON.stringify(executeGraph({
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "run.status-symlink", wave: 1,
        authorityDigest: "a".repeat(64), revision: 0, terminalOutcome: null,
      },
    })));

    const result = runCli(["status", "--json"], "", root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("cannot verify authoritative Run Directory");
    expect(result.stdout).toContain("symlink");
    expect(JSON.parse(result.stdout).next.action.kind).toBe("blocked");
  });

  it("retries a malformed-but-JSON architecture candidate instead of minting success", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.architecture-malformed");
    mkdirSync(runDir, { recursive: true });
    const started = runCli([
      "start", "architecture", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ input: { candidateLenses: ["simplicity-first"], judgeCriteria: ["codebase fit + effort"] }, events: [] }), root);
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
      resultDigest: null,
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

  it("rejects a non-canonical explicit scope before publishing reviewer context", () => {
    const root = repository();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "secret.ts"), "export const secret = true;\n");
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-noncanonical-scope-runs-")));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.noncanonical-scope");
    mkdirSync(runDir);

    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "code", files: ["src/../secret.ts"], dryRun: false }), root);

    expect(started.status).not.toBe(0);
    expect(started.stderr).toContain("must be canonical and must not contain traversal segments");
    expect(readdirSync(join(runDir, "contexts"))).toEqual([]);
    expect(existsSync(join(runDir, "program.json"))).toBe(false);
  });

  it("refuses to freeze scope bytes through a symlinked ancestor", () => {
    const root = repository();
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-frozen-scope-outside-")));
    cleanup.push(outside);
    writeFileSync(join(outside, "secret.ts"), "export const secret = true;\n");
    mkdirSync(join(root, "linked"));
    rmSync(join(root, "linked"), { recursive: true });
    symlinkSync(outside, join(root, "linked"));
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-frozen-scope-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-orchestration-runs-")));
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
      headRevision: string;
      files: readonly { path: string; kind: string; content?: string }[];
    };
    expect(frozenPayload.headRevision).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-orchestration-runs-")));
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

  it("preserves the parser cause and Run Directory for malformed facade checkpoints", () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const standaloneRun = join(runsRoot, "run.malformed-standalone-checkpoint");
    const remediationRun = join(runsRoot, "run.malformed-remediation-checkpoint");
    mkdirSync(standaloneRun, { recursive: true });
    mkdirSync(remediationRun);

    const standaloneStarted = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", standaloneRun,
    ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE);
    expect(standaloneStarted.status, standaloneStarted.stderr).toBe(0);
    writeFileSync(join(standaloneRun, "checkpoint.json"), "{broken\n");

    const standaloneResumed = runCli(["resume", "--runs-root", runsRoot, "--run", standaloneRun], "", ENGINE);
    expect(standaloneResumed.status).not.toBe(0);
    expect(standaloneResumed.stderr).toContain(`standalone review checkpoint is invalid JSON for ${standaloneRun}:`);

    const remediationStarted = runCli([
      "start", "remediation", "--runs-root", runsRoot, "--run", remediationRun,
    ], JSON.stringify({ sourceRunsRoot: runsRoot, sourceRun: "run.absent-source", supportPaths: [] }), root);
    expect(remediationStarted.status, remediationStarted.stderr).toBe(0);
    writeFileSync(join(remediationRun, "checkpoint.json"), "{broken\n");

    const remediationResumed = runCli(["resume", "--runs-root", runsRoot, "--run", remediationRun], "", root);
    expect(remediationResumed.status).not.toBe(0);
    expect(remediationResumed.stderr).toContain(`remediation checkpoint is invalid JSON for ${remediationRun}:`);
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-missing-task-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-stale-request-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-fresh-generation-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-sibling-stability-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-review-recovery-runs-")));
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

  it("derives the spec-check retry from the CURRENT epoch when the journal holds an older epoch's spec-check attempt 1 (loom#20 Finding 5)", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const finding = {
      id: "finding-1", agent: "silent-failure-hunter", severity: "critical" as const,
      file: "src/x.ts", line: 1, claim: "a critical spec gap claim",
    };
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: modelFreePlan(root), wave_gates: {}, tasks: [{
        id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "pending", review_generation: 0,
        findings: [finding], critical_findings: [finding.claim], advisory_findings: [],
      }],
    }));
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-spec-retry-epoch-runs-")));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-spec-retry-epoch");
    mkdirSync(runDir);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(initial.kind).toBe("spawn-batch");
    expect(initial.requests.some(({ authority }) => authority.role === "spec-check-invoker" && authority.attempt === 1)).toBe(true);
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);

    const batchEpochOf = (authority: AgentRequestAuthority): string => {
      const read = opened.value.readContext(authority.contextDigest);
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.error.message);
      const section = read.value.fixedContext.find(({ label }) => label === "wave-review-authority");
      expect(section).toBeDefined();
      const authoritySection = JSON.parse(Buffer.from(section!.bytes).toString("utf8")) as { batchEpoch?: unknown };
      expect(typeof authoritySection.batchEpoch).toBe("string");
      return authoritySection.batchEpoch as string;
    };

    const reviewersOf = (batch: readonly { authority: AgentRequestAuthority }[]) =>
      batch.filter(({ authority }) => authority.role !== "spec-check-invoker");
    const specCheckOf = (batch: readonly { authority: AgentRequestAuthority }[]) =>
      batch.find(({ authority }) => authority.role === "spec-check-invoker")!.authority;
    const acceptedReviewerTranscript = (run: { generation: number; packet_id: string; prior_finding_ids: readonly string[] }): string => [
      "### Machine Summary",
      `REVIEW_GENERATION: ${run.generation}`,
      `REVIEW_PACKET_ID: ${run.packet_id}`,
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "```findings",
      "[]",
      "```",
      "```review_lifecycle",
      JSON.stringify({ prior_findings: run.prior_finding_ids.map((finding_id) => ({
        finding_id, verdict: "resolved_by_remediation", reason: "verified fixed in this packet",
      })) }),
      "```",
    ].join("\n");
    const specFailureOutput = [
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "HIGH: a spec gap claim that breaks count reconciliation",
      "SPEC_CHECK_VERDICT: BLOCKED",
    ].join("\n");
    const specPassOutput = "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED";

    // --- epoch 1: every attempt-1 transcript is captured but unusable, so the
    // gate issues attempt-2 retries for the reviewers. Applying those captured
    // retries closes the packets, and the recursion that follows derives the
    // spec-check retry from epoch 1's own attempt-1 (the only one in the
    // journal at this point) — the single-epoch happy path.
    for (const { authority } of reviewersOf(initial.requests)) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("captured but not accepted")])).ok).toBe(true);
    }
    expect((await opened.value.captureTranscript(specCheckOf(initial.requests), [...Buffer.from(specFailureOutput)])).ok).toBe(true);
    const epochOneRetries = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(epochOneRetries.status, epochOneRetries.stderr).toBe(0);
    const epochOneRetryBatch = JSON.parse(epochOneRetries.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(epochOneRetryBatch.kind, epochOneRetries.stdout).toBe("spawn-batch");
    expect(epochOneRetryBatch.requests.length).toBeGreaterThan(0);
    expect(epochOneRetryBatch.requests.every(({ authority }) => authority.attempt === 2)).toBe(true);
    expect(epochOneRetryBatch.requests.every(({ authority }) => authority.role !== "spec-check-invoker")).toBe(true);
    const epochOneRun = (JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_run?: { generation: number; packet_id: string; prior_finding_ids: readonly string[] } }[];
    }).tasks[0]?.review_run;
    expect(epochOneRun).toBeDefined();
    for (const { authority } of reviewersOf(epochOneRetryBatch.requests)) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(acceptedReviewerTranscript(epochOneRun!))])).ok).toBe(true);
    }
    const firstEpochSpecRetry = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(firstEpochSpecRetry.status, firstEpochSpecRetry.stderr).toBe(0);
    const epochOneSpecSpawn = JSON.parse(firstEpochSpecRetry.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(epochOneSpecSpawn.kind, firstEpochSpecRetry.stdout).toBe("spawn-batch");
    expect(epochOneSpecSpawn.requests).toHaveLength(1);
    expect(epochOneSpecSpawn.requests[0]?.authority).toMatchObject({ role: "spec-check-invoker", attempt: 2, program: "wave-gate" });
    // Leave the epoch-1 spec retry uncaptured: the run is about to install a
    // SECOND epoch, which is exactly the state that used to poison the lookup.

    // --- epoch 2: an implementation write invalidates the review while the
    // epoch-1 spec retry is still outstanding, so a fresh packet batch (and a
    // fresh review epoch) installs in the SAME run. The journal now holds TWO
    // spec-check attempt-1 authorities from DIFFERENT batch epochs.
    const invalidated = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_status: string; review_generation: number }[];
    };
    invalidated.tasks = [{
      ...invalidated.tasks[0]!, review_status: "pending", review_generation: 1,
    }];
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify(invalidated));
    const epochTwoStart = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(epochTwoStart.status, epochTwoStart.stderr).toBe(0);
    const epochTwoBatch = JSON.parse(epochTwoStart.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(epochTwoBatch.kind, epochTwoStart.stdout).toBe("spawn-batch");
    expect(epochTwoBatch.requests).toHaveLength(initial.requests.length);
    expect(epochTwoBatch.requests.some(({ authority }) => authority.role === "spec-check-invoker" && authority.attempt === 1)).toBe(true);
    const epochTwoEpoch = (JSON.parse(readFileSync(statePath, "utf8")) as {
      wave_review_epoch?: { batchEpoch?: string };
    }).wave_review_epoch?.batchEpoch;
    expect(typeof epochTwoEpoch).toBe("string");
    expect(epochTwoEpoch).not.toBe(batchEpochOf(specCheckOf(initial.requests)));

    const epochTwoRun = (JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { review_run?: { generation: number; packet_id: string; prior_finding_ids: readonly string[] } }[];
    }).tasks[0]?.review_run;
    expect(epochTwoRun).toBeDefined();
    // Epoch-1 review closed before the invalidation, so the prior finding was
    // already retired; the fresh packet has no remaining prior findings.
    for (const { authority } of reviewersOf(epochTwoBatch.requests)) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("captured but not accepted")])).ok).toBe(true);
    }
    expect((await opened.value.captureTranscript(specCheckOf(epochTwoBatch.requests), [...Buffer.from(specFailureOutput)])).ok).toBe(true);
    const epochTwoRetries = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(epochTwoRetries.status, epochTwoRetries.stderr).toBe(0);
    const epochTwoRetryBatch = JSON.parse(epochTwoRetries.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(epochTwoRetryBatch.kind, epochTwoRetries.stdout).toBe("spawn-batch");
    expect(epochTwoRetryBatch.requests.length).toBeGreaterThan(0);
    expect(epochTwoRetryBatch.requests.every(({ authority }) => authority.attempt === 2 && authority.role !== "spec-check-invoker")).toBe(true);
    for (const { authority } of reviewersOf(epochTwoRetryBatch.requests)) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(acceptedReviewerTranscript(epochTwoRun!))])).ok).toBe(true);
    }

    // --- the regression: applying those captured epoch-2 reviewer retries
    // closes the packets, and the recursion re-enters the facade with NO
    // collecting packet — so currentIssued is the UNFILTERED issued journal.
    // That journal contains epoch-1's spec-check attempt-1 (and its uncaptured
    // attempt-2) BEFORE epoch-2's attempt-1, and a role-only lookup picks the
    // stale one; the retry derived from it binds the OLD batchEpoch and the
    // captured transcript fails the exact-epoch gate as a durable terminal
    // block. The retry must instead derive from epoch-2's attempt-1 — the
    // exact epoch the graph persists.
    const epochTwoSpecRetry = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(epochTwoSpecRetry.status, epochTwoSpecRetry.stderr).toBe(0);
    const specRetry = JSON.parse(epochTwoSpecRetry.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(specRetry.kind, epochTwoSpecRetry.stdout).toBe("spawn-batch");
    expect(specRetry.requests).toHaveLength(1);
    expect(specRetry.requests[0]?.authority).toMatchObject({ role: "spec-check-invoker", attempt: 2, program: "wave-gate" });
    expect(specRetry.requests[0]?.authority.requestId).not.toBe(epochOneSpecSpawn.requests[0]?.authority.requestId);
    expect(batchEpochOf(specRetry.requests[0]!.authority)).toBe(epochTwoEpoch);

    // Capturing the CURRENT-epoch retry with a passing alignment result must
    // reconcile and let the gate complete instead of blocking on the stale
    // epoch authority.
    const retryAuthority = specRetry.requests[0]!.authority;
    const afterSpec = runCli([
      "submit", "--runs-root", runsRoot, "--run", runDir,
      "--request", retryAuthority.requestId, "--slot", retryAuthority.slotId, "--attempt", "2",
    ], specPassOutput, root);
    expect(afterSpec.status, afterSpec.stderr).toBe(0);
    expect(afterSpec.stdout).not.toContain("could not be reconciled");
    const finalAction = JSON.parse(afterSpec.stdout) as { kind: string };
    expect(finalAction.kind, afterSpec.stdout).toBe("done");
  }, 30_000);

  it("degrades to a wave-blocked verdict when the spec-check attempt-1 context is unreadable (never throws)", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const finding = {
      id: "finding-1", agent: "silent-failure-hunter", severity: "critical" as const,
      file: "src/x.ts", line: 1, claim: "a critical spec gap claim",
    };
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {}, tasks: [{
        id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "pending", review_generation: 0,
        findings: [finding], critical_findings: [finding.claim], advisory_findings: [],
      }],
    }));
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-spec-retry-lost-context-")));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-spec-retry-lost-context");
    mkdirSync(runDir);
    const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(initial.kind).toBe("spawn-batch");
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const specCheck = initial.requests.find(({ authority }) => authority.role === "spec-check-invoker" && authority.attempt === 1)!.authority;
    const reviewers = initial.requests.filter(({ authority }) => authority !== specCheck);
    for (const { authority } of reviewers) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("captured but not accepted")])).ok).toBe(true);
    }
    expect((await opened.value.captureTranscript(specCheck, [...Buffer.from(
      "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: BLOCKED")])).ok).toBe(true);
    // The reviewer attempt-2 derivation reads every attempt-1 context before
    // the spec retry derivation does — remove them ALL so whichever scan hits
    // the gap first must degrade to a verdict, not throw out of the facade.
    for (const { authority } of initial.requests) {
      rmSync(join(runDir, "contexts", `${authority.contextDigest}.json`), { force: true });
    }
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    const verdict = JSON.parse(resumed.stdout) as { kind: string; diagnostic?: { kind: string; message: string } };
    expect(verdict.kind).toBe("blocked");
    expect(verdict.diagnostic?.kind).toBe("wave-gate-blocked");
    expect(verdict.diagnostic?.message.length).toBeGreaterThan(0);
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-attempt-one-rejection-runs-")));
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

  it("drains safe sibling retries before blocking an exhausted Wave reviewer generation", async () => {
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
        id: "T1", description: "mixed retry target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-mixed-retry-runs-")));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-mixed-retry");
    mkdirSync(runDir);
    const started = runCli([
      "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    for (const { authority } of initial.requests) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("malformed attempt one")])).ok).toBe(true);
    }
    const retryResult = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(retryResult.status, retryResult.stderr).toBe(0);
    const retries = JSON.parse(retryResult.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(retries.kind).toBe("spawn-batch");
    expect(retries.requests).toHaveLength(WAVE_REVIEW_AGENTS.length);

    const [exhausted, ...pending] = retries.requests;
    expect((await opened.value.captureTranscript(
      exhausted!.authority,
      [...Buffer.from("malformed attempt two")],
    )).ok).toBe(true);
    const draining = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(draining.status, draining.stderr).toBe(0);
    const drainBatch = JSON.parse(draining.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(drainBatch.kind).toBe("spawn-batch");
    expect(drainBatch.requests.map(({ authority }) => authority.requestId)).toEqual(
      pending.map(({ authority }) => authority.requestId),
    );
    for (const { authority } of drainBatch.requests) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from("malformed attempt two")])).ok).toBe(true);
    }
    const blocked = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(blocked.status, blocked.stderr).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      kind: "blocked",
      diagnostic: { message: expect.stringContaining("attempt 2 exhausted") },
    });

    const replacementRun = join(runsRoot, "run.wave-mixed-replacement");
    mkdirSync(replacementRun);
    const restarted = runCli([
      "restart", "--runs-root", runsRoot, "--run", runDir, "--new-run", replacementRun,
    ], "", root);
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(restarted.stdout)).toMatchObject({ kind: "spawn-batch", runId: "run.wave-mixed-replacement" });
  }, 30_000);

  it("atomically recovers an orphaned active Wave Gate without losing review history", async () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    writeFileSync(join(root, "src-x.ts"), "export const x = 1;\n");
    const activeFinding = {
      id: "code-reviewer-7", agent: "code-reviewer", severity: "critical" as const,
      file: "src/x.ts", line: 1, claim: "preserve active finding",
    };
    const refutedFinding = {
      id: "silent-failure-hunter-3", agent: "silent-failure-hunter", severity: "critical" as const,
      file: "src/x.ts", line: 2, claim: "preserve refuted finding",
    };
    const resolvedFinding = {
      id: "type-design-analyzer-2", agent: "type-design-analyzer", severity: "critical" as const,
      file: "src/x.ts", line: 3, claim: "preserve resolved finding",
    };
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, wave_gates: {}, tasks: [{
        id: "T1", description: "orphan recovery target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "blocked", review_generation: 7,
        findings: [activeFinding], critical_findings: [activeFinding.claim], advisory_findings: [],
        refuted_findings: [{
          finding: refutedFinding,
          refutations: [{ lens: "intent", reason: "not applicable to the protected behavior" }],
        }],
        resolved_findings: [{
          finding: resolvedFinding,
          resolution: {
            kind: "resolved_by_remediation", generation: 6, packet_id: "d".repeat(64), head_sha: "e".repeat(40),
            expected_agents: ["code-reviewer"],
            assessments: [{
              agent: "code-reviewer", finding_id: resolvedFinding.id,
              verdict: "resolved_by_remediation", reason: "fixed in the prior generation",
            }],
          },
        }],
      }],
    }));
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-orphan-runs-")));
    cleanup.push(runsRoot);
    const oldRun = join(runsRoot, "run.wave-orphaned");
    mkdirSync(oldRun);
    const started = runCli([
      "start", "wave-gate", "--runs-root", runsRoot, "--run", oldRun,
    ], JSON.stringify({ wave: 1 }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as {
      kind: string; requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(initial.kind, started.stdout).toBe("spawn-batch");

    const startedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      active_wave_gate: { runId: string; wave: number; authorityDigest: string; runsRoot: string };
      wave_review_epoch: { runId: string; batchEpoch: string };
      tasks: readonly (Record<string, unknown> & {
        review_generation: number;
        review_run: Record<string, unknown> & {
          packet_id: string;
          slot_authority: readonly { agent: string; slot_id: string; attempted: 1 | 2 }[];
        };
      })[];
    };
    const oldPacketId = startedGraph.tasks[0]!.review_run.packet_id;
    expect(startedGraph.active_wave_gate.runsRoot).toBe(runsRoot);
    const acceptedPartialClaim = "preserve accepted partial packet finding";
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify({
      ...startedGraph,
      tasks: startedGraph.tasks.map((task) => {
        const slot = task.review_run.slot_authority.find(({ agent }) => agent === "code-reviewer");
        if (slot === undefined) throw new Error("orphan recovery fixture lacks code-reviewer slot authority");
        return {
          ...task,
          review_run: {
            ...task.review_run,
            evidence: [{
              agent: "code-reviewer",
              slot_id: slot.slot_id,
              attempted: slot.attempted,
              prior_assessments: [{
                finding_id: activeFinding.id, verdict: "still_present", reason: "still present in partial evidence",
              }],
              new_findings: [{ severity: "advisory", file: "src/x.ts", line: 4, claim: acceptedPartialClaim }],
            }],
          },
        };
      }),
      spec_check: {
        wave: 1, run_at: "stale", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
    }));
    chmodSync(statePath, 0o444);

    const replacementRun = join(runsRoot, "run.wave-orphan-replacement");
    mkdirSync(replacementRun);
    const recoveryArgs = [
      "recover-orphan", "--runs-root", runsRoot,
      "--run-id", startedGraph.active_wave_gate.runId,
      "--wave", String(startedGraph.active_wave_gate.wave),
      "--digest", startedGraph.active_wave_gate.authorityDigest,
      "--new-run", replacementRun,
    ] as const;

    const foreignRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-foreign-root-")));
    cleanup.push(foreignRoot);
    const foreignReplacement = join(foreignRoot, "run.wave-orphan-replacement");
    mkdirSync(foreignReplacement);
    const foreignRootArgs = recoveryArgs.map((value, index) =>
      recoveryArgs[index - 1] === "--runs-root" ? foreignRoot
        : recoveryArgs[index - 1] === "--new-run" ? foreignReplacement
          : value);
    const wrongRoot = runCli(foreignRootArgs, "", root);
    expect(wrongRoot.status).not.toBe(0);
    expect(wrongRoot.stderr).toContain("does not match authoritative root");

    const stillPresent = runCli(recoveryArgs, "", root);
    expect(stillPresent.status).not.toBe(0);
    expect(stillPresent.stderr).toContain("still exists");

    // Refusal: the replacement must be a DISTINCT run identity — pointing the
    // recovery at the orphan run itself is refused before any fs proof.
    const sameRun = runCli(recoveryArgs.map((value, index) =>
      recoveryArgs[index - 1] === "--new-run" ? oldRun : value), "", root);
    expect(sameRun.status).not.toBe(0);
    expect(sameRun.stderr).toContain("distinct replacement");
    rmSync(oldRun, { recursive: true });

    // Refusal: a replacement that is not pristine (stray bytes beyond
    // authority/program) must not be clobbered by recovery.
    writeFileSync(join(replacementRun, "stray.txt"), "not pristine");
    const nonPristine = runCli(recoveryArgs, "", root);
    expect(nonPristine.status).not.toBe(0);
    expect(nonPristine.stderr).toContain("must be pristine");
    rmSync(replacementRun, { recursive: true });
    mkdirSync(replacementRun);

    // Refusal: a replacement already registered under DIFFERENT authority must
    // not be silently re-registered by recovery.
    {
      const opened = openRunDirectory(runsRoot, replacementRun);
      if (!opened.ok) throw new Error(opened.error.message);
      const registered = await opened.value.registerProgram({
        schemaVersion: 1, kind: "wave-gate", input: Object.freeze({ wave: 9 }),
        taskIds: Object.freeze([]), authorityDigest: "b".repeat(64),
      });
      if (!registered.ok) throw new Error(registered.error.message);
      const preRegistered = runCli(recoveryArgs, "", root);
      expect(preRegistered.status).not.toBe(0);
      expect(preRegistered.stderr).toContain("already registered under different authority");
      rmSync(replacementRun, { recursive: true });
      mkdirSync(replacementRun);
    }

    const wrongRun = runCli(recoveryArgs.map((value, index) =>
      recoveryArgs[index - 1] === "--run-id" ? "run.not-the-owner" : value), "", root);
    expect(wrongRun.status).not.toBe(0);
    expect(wrongRun.stderr).toContain("exact protected active run ID, wave, authority digest");
    const wrongWave = runCli(recoveryArgs.map((value, index) =>
      recoveryArgs[index - 1] === "--wave" ? "2" : value), "", root);
    expect(wrongWave.status).not.toBe(0);
    expect(wrongWave.stderr).toContain("exact protected active run ID, wave, authority digest");
    const wrongDigest = runCli(recoveryArgs.map((value, index) =>
      recoveryArgs[index - 1] === "--digest" ? "f".repeat(64) : value), "", root);
    expect(wrongDigest.status).not.toBe(0);
    expect(wrongDigest.stderr).toContain("exact protected active run ID, wave, authority digest");

    const status = runCli(["status", "--json", "--runs-root", runsRoot], "", root);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("orphaned active Wave Gate run run.wave-orphaned");
    expect(status.stdout).not.toContain("healthy-run-suspended");

    const subagentDir = join(root, "subagents");
    mkdirSync(subagentDir);
    writeFileSync(join(subagentDir, "live.active"), "reviewer\tcode-reviewer\n");
    writeFileSync(join(subagentDir, "live.task_graph"), statePath);
    const activeRefusal = runCli(recoveryArgs, "", root, { LOOM_SUBAGENT_DIR: subagentDir });
    expect(activeRefusal.status).not.toBe(0);
    expect(activeRefusal.stderr).toContain("subagent is active");
    rmSync(join(subagentDir, "live.active"));

    const recovered = runCli(recoveryArgs, "", root, { LOOM_SUBAGENT_DIR: subagentDir });
    expect(recovered.status, recovered.stderr).toBe(0);
    const batch = JSON.parse(recovered.stdout) as {
      kind: string; runId: string; requests: readonly { authority: AgentRequestAuthority }[];
    };
    expect(batch.kind).toBe("spawn-batch");
    expect(batch.runId).toBe("run.wave-orphan-replacement");
    expect(batch.requests).toHaveLength(1 + WAVE_REVIEW_AGENTS.length);
    expect(batch.requests.every(({ authority }) =>
      authority.runId === "run.wave-orphan-replacement" && authority.attempt === 1)).toBe(true);

    const after = JSON.parse(readFileSync(statePath, "utf8")) as {
      spec_check?: unknown;
      active_wave_gate: { runId: string; wave: number; authorityDigest: string };
      wave_review_epoch: { runId: string; batchEpoch: string };
      orphaned_wave_gate_history: readonly {
        kind: string; runId: string; wave: number; authorityDigest: string; reason: string;
        runsRoot: string; runDirectory: string;
        replacementRunId: string; replacementAuthorityDigest: string;
      }[];
      tasks: readonly {
        review_generation: number; review_run: { packet_id: string; generation: number };
        findings: readonly unknown[]; refuted_findings: readonly unknown[]; resolved_findings: readonly unknown[];
      }[];
    };
    expect(after.spec_check).toBeUndefined();
    expect(after.active_wave_gate).toMatchObject({ runId: "run.wave-orphan-replacement", wave: 1 });
    expect(after.wave_review_epoch.runId).toBe("run.wave-orphan-replacement");
    expect(after.wave_review_epoch.batchEpoch).not.toBe(startedGraph.wave_review_epoch.batchEpoch);
    expect(after.tasks[0]).toMatchObject({ review_generation: 7, review_run: { generation: 7 } });
    expect(after.tasks[0]!.review_run.packet_id).not.toBe(oldPacketId);
    expect(after.tasks[0]!.findings).toEqual([
      activeFinding,
      expect.objectContaining({ agent: "code-reviewer", severity: "advisory", claim: acceptedPartialClaim }),
    ]);
    expect(after.tasks[0]!.refuted_findings).toHaveLength(1);
    expect(after.tasks[0]!.resolved_findings).toHaveLength(1);
    expect(after.orphaned_wave_gate_history).toEqual([expect.objectContaining({
      kind: "orphaned-wave-gate-retirement",
      runId: "run.wave-orphaned",
      wave: 1,
      authorityDigest: startedGraph.active_wave_gate.authorityDigest,
      reason: "authoritative-run-directory-missing",
      runsRoot: runsRoot,
      runDirectory: oldRun,
      replacementRunId: "run.wave-orphan-replacement",
      replacementAuthorityDigest: after.active_wave_gate.authorityDigest,
    })]);

    const replay = runCli(recoveryArgs, "", root, { LOOM_SUBAGENT_DIR: subagentDir });
    expect(replay.status, replay.stderr).toBe(0);
    const replayBatch = JSON.parse(replay.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    expect(replayBatch.requests.map(({ authority }) => authority.requestId)).toEqual(
      batch.requests.map(({ authority }) => authority.requestId),
    );
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-restart-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-partial-restart-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-valid-retry-runs-")));
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-crash-runs-")));
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
      wave_review_epoch: {
        runId: "run.wave-upheld-tally", wave: 1, batchEpoch: "a".repeat(64),
        specCheckDocuments: specCheckDocuments(null, null),
      },
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-upheld-tally-runs-")));
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
    const planFile = modelFreePlan(root);
    const graph = {
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: planFile, wave_gates: {},
      wave_review_epoch: {
        runId: "run.wave-refuted-tally", wave: 1, batchEpoch: "b".repeat(64),
        specCheckDocuments: specCheckDocuments(null, planFile),
      },
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
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-refuted-tally-runs-")));
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

  it("blocks protected completion when automatic full-tier lint fails", () => {
    const root = repository();
    const proof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
    );
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "x.ts"), "console.log('full-tier violation');\n");
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    const planFile = modelFreePlan(root);
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: planFile, wave_gates: {},
      wave_review_epoch: {
        runId: "run.wave-lint-block", wave: 1, batchEpoch: "b".repeat(64),
        specCheckDocuments: specCheckDocuments(null, planFile),
      },
      spec_check: {
        wave: 1, run_at: new Date().toISOString(), verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
      tasks: [{
        id: "T1", description: "lint target", agent: "code-implementer-agent", wave: 1,
        status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
        test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
        new_test_evidence: "present", review_status: "passed", review_generation: 0,
        findings: [], critical_findings: [], advisory_findings: [],
      }],
    }));
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-wave-lint-block-runs-")));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.wave-lint-block");
    mkdirSync(runDir);

    const started = runCli([
      "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ wave: 1 }), root);

    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as { kind: string; diagnostic: { message: string } };
    expect(action.kind).toBe("blocked");
    expect(action.diagnostic.message).toContain("WAVE-GATE LINT");
    expect(action.diagnostic.message).toContain("no-console");
    const protectedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
      tasks: readonly { status: string }[];
      wave_gate_history?: readonly unknown[];
    };
    expect(protectedGraph.tasks[0]?.status).toBe("implemented");
    expect(protectedGraph.wave_gate_history ?? []).toEqual([]);
  });

  it("publishes standalone refutation attempt 2 after a malformed attempt-1 verdict", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "changed\n");
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-standalone-refutation-retry-runs-")));
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
    const panel = JSON.parse(panelResult.stdout) as {
      kind: string; requests: readonly { authority: AgentRequestAuthority; task: string }[];
    };
    expect(panel.kind).toBe("spawn-batch");
    for (const [index, request] of panel.requests.entries()) {
      const raw = index === 0 ? "malformed" : refutationOutput(opened.value, request.authority);
      expect((await opened.value.captureTranscript(request.authority, [...Buffer.from(raw)])).ok).toBe(true);
    }

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(resumed.status, resumed.stderr).toBe(0);
    const retry = JSON.parse(resumed.stdout) as {
      kind: string; requests: readonly { authority: AgentRequestAuthority; task: string }[];
    };
    expect(retry.kind, resumed.stdout).toBe("spawn-batch");
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0]?.authority).toMatchObject({
      attempt: 2, program: "refutation-panel", slotId: panel.requests[0]!.authority.slotId,
    });
    // Regression: this prompt used to be BYTE-IDENTICAL to attempt 1 — the
    // engine re-asked the identical question and got the identical malformed
    // shape back, exhausting the slot. It must name what was refused and
    // restate the one-JSON-object contract.
    const retryTask = retry.requests[0]!.task;
    expect(retryTask).toContain("Your previous attempt was rejected:");
    expect(retryTask).toContain("refutation verdict is not valid JSON");
    expect(retryTask).toContain("exactly one JSON object and nothing else");
    expect(retryTask).not.toBe(panel.requests[0]!.task);

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
    const evidenceReplay = replayFromCapturedEvidence(opened.value);
    expect(evidenceReplay, evidenceReplay.ok ? "" : evidenceReplay.message).toMatchObject({ ok: true });

    // Idempotent done: the durable receipt must restore cleanly after restart.
    const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout).kind).toBe("done");
  }, 30_000);

  it("drives a registered standalone review from spawn-batch to idempotent done", async () => {
    const root = project();
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.standalone-facade");
    const bindingDir = join(root, "pi-session-bindings");
    const sessionId = "019ff290-ffee-7e86-8ed0-c834c04b7f6f";
    const piEnv = {
      PI_CODING_AGENT: "true",
      PI_SESSION_ID: sessionId,
      LOOM_SUBAGENT_DIR: bindingDir,
    } as const;
    mkdirSync(runDir, { recursive: true });
    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE, piEnv);
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
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", ENGINE, piEnv);
    expect(resumed.status, resumed.stderr).toBe(0);
    const done = JSON.parse(resumed.stdout) as { kind: string; outcome: { digest: string } };
    expect(done.kind).toBe("done");
    expect(readSessionRunBindings(bindingDir, sessionId)).toMatchObject({
      ok: true,
      value: [{ runId: "run.standalone-facade", resultDigest: done.outcome.digest }],
    });
    const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", ENGINE, piEnv);
    expect(JSON.parse(replay.stdout).kind).toBe("done");
  });

  it("returns an actionable failure when an existing result cannot be verified", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "changed\n");
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.standalone-result-collision");
    mkdirSync(runDir, { recursive: true });
    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["a.txt"], dryRun: false }), root);
    expect(started.status, started.stderr).toBe(0);
    const action = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const transcript = [
      "### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "", "```findings", "[]", "```",
    ].join("\n");
    for (const { authority } of action.requests) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(transcript)])).ok).toBe(true);
    }
    mkdirSync(join(runDir, "result.json"));

    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);

    expect(resumed.status).not.toBe(0);
    expect(resumed.stderr).toContain("cannot verify existing standalone result after exclusive publication collision");
  });

  it("advances a capture-rejected standalone reviewer attempt 1 to diagnostic-rich attempt 2", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "changed\n");
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-standalone-capture-rejection-runs-")));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.standalone-capture-rejection");
    mkdirSync(runDir);
    const started = runCli([
      "start", "standalone-review", "--runs-root", runsRoot, "--run", runDir,
    ], JSON.stringify({ kind: "comments", files: ["a.txt"], dryRun: false }), root);
    expect(started.status, started.stderr).toBe(0);
    const initial = JSON.parse(started.stdout) as { requests: readonly { authority: AgentRequestAuthority }[] };
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const rejected = initial.requests[0]!.authority;
    // Reproduce the harness adapter's exact durable state for a child that
    // exited without a final text payload: the capture runtime persistently
    // rejects the attempt AND records the audited rejection event.
    expect((await opened.value.rejectCapture(rejected, "no-final-payload: result carried no final text payload")).ok).toBe(true);
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
        diagnostic: "no-final-payload: result carried no final text payload",
      },
    });
    const cleanTranscript = ["### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "", "```findings", "[]", "```"].join("\n");
    for (const { authority } of initial.requests.filter(({ authority }) => authority.requestId !== rejected.requestId)) {
      expect((await opened.value.captureTranscript(authority, [...Buffer.from(cleanTranscript)])).ok).toBe(true);
    }
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(resumed.status, resumed.stderr).toBe(0);
    const retry = JSON.parse(resumed.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority; task: string }[];
    };
    // Exactly the frozen attempt-2 authority for the rejected slot — not the
    // terminally rejected attempt-1 request again.
    expect(retry.kind).toBe("spawn-batch");
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0]?.authority).toMatchObject({
      slotId: rejected.slotId,
      role: rejected.role,
      attempt: 2,
    });
    expect(retry.requests[0]?.task).toContain("no-final-payload: result carried no final text payload");
    expect(retry.requests[0]?.task).toContain("### Machine Summary");

    // A later resume has no fresh rejection in its per-pass set. It must read
    // the durable diagnostic from LC-2 state when reissuing the exact retry.
    const reissued = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(reissued.status, reissued.stderr).toBe(0);
    const reissuedRetry = JSON.parse(reissued.stdout) as {
      kind: string;
      requests: readonly { authority: AgentRequestAuthority; task: string }[];
    };
    expect(reissuedRetry.kind).toBe("spawn-batch");
    expect(reissuedRetry.requests).toHaveLength(1);
    expect(reissuedRetry.requests[0]?.authority.requestId).toBe(retry.requests[0]?.authority.requestId);
    expect(reissuedRetry.requests[0]?.task).toContain("no-final-payload: result carried no final text payload");

    // The terminal rejection still binds: late bytes for attempt 1 cannot
    // overwrite it, and only the exact attempt-2 authority closes the slot.
    const lateAttemptOne = await opened.value.captureTranscript(rejected, [...Buffer.from("late")]);
    expect(lateAttemptOne.ok).toBe(false);
    if (!lateAttemptOne.ok) expect(lateAttemptOne.error.message).toContain("terminally rejected");

    // The retry lands, the roster completes, and the run reaches idempotent done.
    const retryRequest = retry.requests[0]!;
    expect((await opened.value.captureTranscript(retryRequest.authority, [...Buffer.from(cleanTranscript)])).ok).toBe(true);
    const done = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(done.status, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout).kind).toBe("done");
    const evidenceReplay = replayFromCapturedEvidence(opened.value);
    expect(evidenceReplay, evidenceReplay.ok ? "" : evidenceReplay.message).toMatchObject({ ok: true });
    const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
    expect(JSON.parse(replay.stdout).kind).toBe("done");
  }, 30_000);
  it("heals a standalone crash after batch publication but before the checkpoint write", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "changed\n");
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-standalone-crash-runs-")));
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

  /**
   * A repository with one committed-then-edited file, and a standalone review
   * run over it already driven to `done` with clean reviewer transcripts.
   *
   * This ~20-line arrangement — git init, identity, commit, dirty edit, start
   * the review, capture every slot, resume — was written out verbatim per
   * remediation test. Duplicated setup is how two tests end up believing
   * different things about the state they share.
   */
  async function cleanStandaloneReviewFixture(slug: string) {
    const repository = project();
    const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), slug)));
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
    return { repository, runsRoot, sourceRun, remediationRun, git };
  }

  it("installs only a standalone-authorized dirty set through the remediation façade", async () => {
    const { repository, runsRoot, sourceRun, remediationRun, git } = await cleanStandaloneReviewFixture("loom-remediation-facade-runs-");
    const remediated = runCli(["start", "remediation", "--runs-root", runsRoot, "--run", remediationRun], JSON.stringify({
      sourceRunsRoot: runsRoot, sourceRun, supportPaths: [],
    }), repository);
    expect(remediated.status, remediated.stderr).toBe(0);
    expect(JSON.parse(remediated.stdout).kind).toBe("done");
    expect(git(["diff", "--cached", "--name-only"]).stdout.trim()).toBe("a.txt");
  });

  /**
   * The one blocked cause whose recovery is NOT "resume the same run".
   *
   * `supportPaths` arrive in the start input, `registerProgram` is O_EXCL and
   * content-equal, so the authorized set is frozen at registration: a dirty
   * path the remediation itself produced outside the frozen review scope — a
   * plan file, a regression pin — can never be authorized by the run that
   * refused it, however many times it resumes. The diagnostic used to name the
   * offending paths and stop, leaving the operator to derive that immutability
   * from `run-directory-handle.ts` and guess that a fresh run was the remedy.
   */
  it("tells an unauthorized dirty path to start a fresh run, not to resume this one", async () => {
    const { repository, runsRoot, sourceRun, remediationRun, git } = await cleanStandaloneReviewFixture("loom-remediation-unauthorized-runs-");

    // A regression pin the remediation itself added: dirty, real, and outside
    // the frozen review scope — so `supportPaths` is its only authorization.
    writeFileSync(join(repository, "pin.test.ts"), "regression pin\n");
    const blocked = runCli(["start", "remediation", "--runs-root", runsRoot, "--run", remediationRun], JSON.stringify({
      sourceRunsRoot: runsRoot, sourceRun, supportPaths: [],
    }), repository);

    expect(blocked.status, blocked.stderr).toBe(0);
    const diagnostic = (JSON.parse(blocked.stdout) as { kind: string; diagnostic: { message: string } });
    expect(diagnostic.kind).toBe("blocked");
    expect(diagnostic.diagnostic.message).toContain("unauthorized dirty paths: pin.test.ts");
    expect(diagnostic.diagnostic.message).toContain("this run's start input is immutable");
    expect(diagnostic.diagnostic.message).toContain("start a FRESH remediation run");

    // And the advice is true: resuming the same run repeats the refusal, while
    // a fresh run that registers the path as a supportPath installs it.
    const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", remediationRun], "", repository);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).kind).toBe("blocked");

    const freshRun = join(runsRoot, "remediation-2");
    mkdirSync(freshRun);
    const fresh = runCli(["start", "remediation", "--runs-root", runsRoot, "--run", freshRun], JSON.stringify({
      sourceRunsRoot: runsRoot, sourceRun, supportPaths: ["pin.test.ts"],
    }), repository);
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout).kind).toBe("done");
    expect(git(["diff", "--cached", "--name-only"]).stdout.trim().split("\n").sort())
      .toEqual(["a.txt", "pin.test.ts"]);
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
    expect(result.stderr).toContain("decision must be valid JSON:");
    expect(result.stderr).toMatch(/Unexpected|JSON/);
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

  /**
   * Naming a fresh run, and the claim that naming it must not cost.
   *
   * `--run` and the remediation payload's `sourceRun` both arrive beside the
   * runs-root they belong to, so the bare run name is the natural way to write
   * either — and both used to fail with a diagnostic about the direct-child
   * RELATION, which sent the operator to re-check a path that was never wrong.
   * `start` additionally required the directory to already exist, so every run
   * began with a `mkdir -p` whose only purpose was to satisfy a check the
   * engine owns, and it claimed that directory BEFORE reading stdin — so a
   * malformed payload burned a run name that `registerProgram` would then
   * refuse to reuse under a corrected payload.
   */
  describe("naming a fresh run", () => {
    it("creates a Run Directory named by its bare run id under --runs-root", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(runsRoot, { recursive: true });

      const started = runCli([
        "start", "standalone-review", "--runs-root", runsRoot, "--run", "run.bare-name",
      ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE);

      expect(started.status, started.stderr).toBe(0);
      expect(JSON.parse(started.stdout).kind).toBe("spawn-batch");
      expect(JSON.parse(started.stdout).runId).toBe("run.bare-name");
      expect(existsSync(join(runsRoot, "run.bare-name", "authority.json"))).toBe(true);
    });

    it("resolves a full relative path to the same run as its bare name", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(runsRoot, { recursive: true });
      const input = JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false });

      const started = runCli(["start", "standalone-review", "--runs-root", runsRoot, "--run", "run.same-run"], input, ENGINE);
      const resumedByPath = runCli([
        "resume", "--runs-root", runsRoot, "--run", join(runsRoot, "run.same-run"),
      ], "", ENGINE);
      const resumedByName = runCli(["resume", "--runs-root", runsRoot, "--run", "run.same-run"], "", ENGINE);

      expect(started.status, started.stderr).toBe(0);
      expect(resumedByPath.status, resumedByPath.stderr).toBe(0);
      expect(JSON.parse(resumedByName.stdout)).toEqual(JSON.parse(resumedByPath.stdout));
    });

    it("still refuses a run directory that is not a direct child of its runs-root", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(join(runsRoot, "nested"), { recursive: true });

      const nested = runCli([
        "start", "standalone-review", "--runs-root", runsRoot, "--run", join(runsRoot, "nested", "run.deep"),
      ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE);

      expect(nested.status).not.toBe(0);
      expect(nested.stderr).toContain("direct child");
      expect(existsSync(join(runsRoot, "nested", "run.deep"))).toBe(false);
    });

    it("never creates the runs-root itself", () => {
      const root = project();
      const absentRoot = join(root, "runs-that-do-not-exist");

      const started = runCli([
        "start", "standalone-review", "--runs-root", absentRoot, "--run", "run.no-root",
      ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE);

      expect(started.status).not.toBe(0);
      expect(started.stderr).toContain("runs root");
      expect(existsSync(absentRoot)).toBe(false);
    });

    it("refuses a malformed payload without claiming the run directory", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(runsRoot, { recursive: true });

      const invalidJson = runCli([
        "start", "standalone-review", "--runs-root", runsRoot, "--run", "run.invalid-json",
      ], "{not json", ENGINE);
      const invalidShape = runCli([
        "start", "standalone-review", "--runs-root", runsRoot, "--run", "run.invalid-shape",
      ], JSON.stringify({ kind: "not-a-review-kind", files: null, dryRun: false }), ENGINE);

      expect(invalidJson.status).not.toBe(0);
      expect(invalidJson.stderr).toContain("invalid JSON");
      expect(existsSync(join(runsRoot, "run.invalid-json"))).toBe(false);
      expect(invalidShape.status).not.toBe(0);
      expect(existsSync(join(runsRoot, "run.invalid-shape"))).toBe(false);
    });

    it("names sourceRun as the offender, before the remediation run is claimed", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(join(runsRoot, "nested"), { recursive: true });

      const started = runCli([
        "start", "remediation", "--runs-root", runsRoot, "--run", "remediation.bad-source",
      ], JSON.stringify({
        sourceRunsRoot: runsRoot,
        sourceRun: join("nested", "run.not-a-child"),
        supportPaths: [],
      }), root);

      expect(started.status).not.toBe(0);
      expect(started.stderr).toContain("sourceRun");
      expect(existsSync(join(runsRoot, "remediation.bad-source"))).toBe(false);
    });

    it("accepts a bare sourceRun naming a run beside its own runs-root", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(runsRoot, { recursive: true });

      // The source review run does not exist yet, so the drive still blocks —
      // but on the SOURCE's own state, with the attribution the relation
      // failure used to swallow, rather than on the reference's shape.
      const started = runCli([
        "start", "remediation", "--runs-root", runsRoot, "--run", "remediation.bare-source",
      ], JSON.stringify({
        sourceRunsRoot: runsRoot,
        sourceRun: "run.absent-review",
        supportPaths: [],
      }), root);

      expect(started.status, started.stderr).toBe(0);
      const action = JSON.parse(started.stdout) as { kind: string; diagnostic: { message: string } };
      expect(action.kind).toBe("blocked");
      expect(action.diagnostic.message).toContain("source run: ");
      expect(action.diagnostic.message).toContain("does not exist");
    });
  });

  /**
   * Re-submitting an attempt that is already captured.
   *
   * This is the EXPECTED outcome on a harness that captures transcripts itself:
   * the extension stores the raw bytes at spawn completion and the parent's
   * follow-up submit merely confirms it. The confirmation used to arrive as a
   * bare sentence on stderr with a failing exit code — byte-identical to a real
   * error — because the short-circuit that reads stored bytes covered only the
   * legacy panel registration, and a façade run fell through to a capture whose
   * exclusive write could then only fail.
   */
  describe("idempotent submit", () => {
    it("re-emits the run's action instead of failing on an already-captured attempt", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(runsRoot, { recursive: true });
      const started = runCli([
        "start", "standalone-review", "--runs-root", runsRoot, "--run", "run.idempotent-submit",
      ], JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }), ENGINE);
      expect(started.status, started.stderr).toBe(0);
      const action = JSON.parse(started.stdout) as {
        requests: readonly { authority: AgentRequestAuthority }[];
      };
      const request = action.requests[0]!.authority;
      const transcript = [
        "### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "CRITICAL:", "ADVISORY:",
        "", "```findings", "[]", "```",
      ].join("\n");
      const submit = () => runCli([
        "submit", "--runs-root", runsRoot, "--run", "run.idempotent-submit",
        "--request", request.requestId, "--slot", request.slotId, "--attempt", "1",
      ], transcript, ENGINE);

      const first = submit();
      const second = submit();

      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
      // The stored evidence stays authoritative — the repeat never overwrote it.
      const stored = readFileSync(
        join(runsRoot, "run.idempotent-submit", "transcripts", request.slotId, "attempt-1.raw"),
        "utf-8",
      );
      expect(stored).toBe(transcript);
    }, 15_000);

    it("reports the idempotent outcome as JSON on a run with no registered program", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      const runDir = join(runsRoot, "run.unregistered-submit");
      mkdirSync(runDir, { recursive: true });
      const opened = openRunDirectory(runsRoot, runDir);
      if (!opened.ok) throw new Error(opened.error.message);
      const request = agentRequestAuthority("run.unregistered-submit");
      const parsed = parseAgentRequestAuthority(request);
      if (!parsed.ok) throw new Error("fixture authority is malformed");
      const submit = () => runCli([
        "submit", "--runs-root", runsRoot, "--run", runDir,
        "--request", request.requestId, "--slot", request.slotId, "--attempt", "1",
      ], "reviewer bytes", root);

      return opened.value.reserveRequest(parsed.value).then((reserved) => {
        expect(reserved.ok).toBe(true);
        const first = submit();
        const second = submit();

        expect(first.status, first.stderr).toBe(0);
        expect(JSON.parse(first.stdout).kind).toBe("captured");
        expect(second.status, second.stderr).toBe(0);
        expect(JSON.parse(second.stdout)).toEqual({
          kind: "already-captured",
          requestId: request.requestId,
          slotId: request.slotId,
          attempt: 1,
        });
      });
    });
  });

  /**
   * The user-approval gate — `decide` and `complete`.
   *
   * `decide` is how an operator's advisory approval enters a Wave Gate run, and
   * every one of its refusals guards an authority boundary: a decision for a
   * different Wave, for a different run, for a decision id that is not the
   * pending one, or a payload that is not the exact approval shape. `complete`
   * likewise refuses a caller-attested outcome, because a deterministic engine
   * operation's result is derived, never asserted by whoever invokes the CLI.
   *
   * Every existing test drove `decide` against a run with NO registered program
   * — the branch that just records the decision and returns. The whole
   * wave-gate branch (authority match, expected decision id, approval shape)
   * and every `complete` refusal were unexercised, so an approval for the wrong
   * wave, or a hand-supplied "succeeded", had nothing standing in its way but
   * unproven code.
   */
  describe("the user-approval gate", () => {
    /** A Wave-Gate run whose registration is live, so `decide` takes its wave branch. */
    function startedWaveRun(label: string) {
      const root = repository();
      const proof = evaluateTaskProof(
        { newTestsRequired: true, declaredArtifacts: ["src/x.ts"] },
        { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/x.ts"], newTestsWritten: true },
      );
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
      const statePath = join(root, ".claude", "state", "active_task_graph.json");
      writeFileSync(statePath, JSON.stringify({
        current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
        spec_file: null, plan_file: modelFreePlan(root), wave_gates: {},
        tasks: [{
          id: "T1", description: "review target", agent: "code-implementer-agent", wave: 1,
          status: "implemented", proof, depends_on: [], file_list: ["src/x.ts"], files_modified: ["src/x.ts"],
          test_result: { verdict: "trusted-pass" }, test_evidence: "passed", new_tests_written: true,
          new_test_evidence: "present", review_status: "passed", review_generation: 0,
          findings: [], critical_findings: [], advisory_findings: [],
        }],
      }));
      const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), `loom-${label}-runs-`)));
      cleanup.push(runsRoot);
      const runDir = join(runsRoot, `run.${label}`);
      mkdirSync(runDir);
      const started = runCli(["start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], JSON.stringify({ wave: 1 }), root);
      expect(started.status, started.stderr).toBe(0);
      return { root, runsRoot, runDir, statePath };
    }

    it("drives the façade-emitted advisory request through decide and resume to done", () => {
      const { root, runsRoot, runDir, statePath } = startedWaveRun("decide-end-to-end");
      const protectedGraph = JSON.parse(readFileSync(statePath, "utf8")) as {
        tasks: readonly Record<string, unknown>[];
        [key: string]: unknown;
      };
      const advisory = {
        id: "comment-analyzer-1",
        agent: "comment-analyzer",
        severity: "advisory",
        file: "src/x.ts",
        line: 1,
        claim: "prefer the façade-owned lifecycle request",
      };
      chmodSync(statePath, 0o644);
      writeFileSync(statePath, JSON.stringify({
        ...protectedGraph,
        spec_check: {
          wave: 1,
          run_at: new Date().toISOString(),
          verdict: "PASSED",
          critical_count: 0,
          high_count: 0,
          critical_findings: [],
          high_findings: [],
          medium_findings: [],
        },
        tasks: protectedGraph.tasks.map((task) => ({
          ...task,
          review_status: "passed",
          review_run: undefined,
          findings: [advisory],
          critical_findings: [],
          advisory_findings: [advisory.claim],
        })),
      }));

      const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
      expect(resumed.status, resumed.stderr).toBe(0);
      const awaiting = JSON.parse(resumed.stdout) as {
        kind: string;
        request: { requestId: string; advisories: readonly unknown[] };
      };
      expect(awaiting.kind).toBe("await-user");
      expect(awaiting.request.advisories).toHaveLength(1);

      const status = runCli(["status", "--json", "--runs-root", runsRoot], "", root);
      expect(status.status, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout).next.action).toMatchObject({
        kind: "await-user",
        request: { requestId: awaiting.request.requestId },
      });

      const decided = runCli(
        ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", awaiting.request.requestId],
        JSON.stringify({ kind: "approve" }),
        root,
      );

      expect(decided.status, decided.stderr).toBe(0);
      expect(JSON.parse(decided.stdout)).toMatchObject({
        kind: "done",
        outcome: { kind: "protected-wave-state-committed" },
      });
      const replay = runCli(["resume", "--runs-root", runsRoot, "--run", runDir], "", root);
      expect(replay.status, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout).kind).toBe("done");
    }, 15_000);

    it("refuses a decision id that is not the exact pending advisory request", () => {
      const { root, runsRoot, runDir } = startedWaveRun("decide-wrong-id");

      const result = runCli(
        ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-not-the-pending-one"],
        JSON.stringify({ kind: "approve" }),
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("is not the exact pending advisory request");
    });

    it("refuses a decision when the protected Wave authority no longer describes this run", () => {
      const { root, runsRoot, runDir, statePath } = startedWaveRun("decide-authority-drift");
      // The graph's active Wave Gate is re-pointed at another run: an approval
      // recorded here would advance a gate this run does not own.
      const graph = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      const active = graph["active_wave_gate"] as Record<string, unknown>;
      const epoch = graph["wave_review_epoch"] as Record<string, unknown>;
      chmodSync(statePath, 0o644);
      writeFileSync(statePath, JSON.stringify({
        ...graph,
        active_wave_gate: { ...active, runId: "run.some-other-wave" },
        wave_review_epoch: { ...epoch, runId: "run.some-other-wave" },
      }));

      const result = runCli(
        ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-1"],
        JSON.stringify({ kind: "approve" }),
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("protected active Wave Gate authority differs from this decision run");
    });

    it("refuses a decision when the protected Wave authority cannot be read at all", () => {
      const { root, runsRoot, runDir, statePath } = startedWaveRun("decide-authority-unreadable");
      chmodSync(statePath, 0o644);
      writeFileSync(statePath, "{not json");

      const result = runCli(
        ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-1"],
        JSON.stringify({ kind: "approve" }),
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cannot read protected Wave authority");
    });

    it("refuses a decision payload that is not exactly an approval", () => {
      const { root, runsRoot, runDir, statePath } = startedWaveRun("decide-shape");
      // Reach the shape check with an authority-matching, correctly-named
      // decision id, so the refusal can only come from the payload.
      const graph = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      const active = graph["active_wave_gate"] as Record<string, unknown>;
      expect(active["runId"]).toBe(`run.decide-shape`);

      for (const payload of [
        { kind: "reject" },
        { kind: "approve", extra: true },
        { approve: true },
        {},
      ]) {
        const result = runCli(
          ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-1"],
          JSON.stringify(payload),
          root,
        );
        // Either the decision-id check or the shape check refuses; what matters
        // is that no non-approval payload is ever recorded.
        expect(result.status, JSON.stringify(payload)).not.toBe(0);
      }
    });

    it("refuses a decision against a program that does not accept user decisions", () => {
      const root = repository();
      const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-decide-wrong-program-runs-")));
      cleanup.push(runsRoot);
      const runDir = join(runsRoot, "run.decide-wrong-program");
      mkdirSync(runDir);
      writeFileSync(join(root, "a.txt"), "one\n");
      const started = runCli(
        ["start", "standalone-review", "--runs-root", runsRoot, "--run", runDir],
        JSON.stringify({ kind: "all", files: ["a.txt"], dryRun: false }),
        root,
      );
      expect(started.status, started.stderr).toBe(0);

      const result = runCli(
        ["decide", "--runs-root", runsRoot, "--run", runDir, "--request", "advisory-1"],
        JSON.stringify({ kind: "approve" }),
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not accept user decisions");
    });

    it("refuses a decision with no --request at all", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      const runDir = join(runsRoot, "run.decide-no-request");
      mkdirSync(runDir, { recursive: true });

      const result = runCli(
        ["decide", "--runs-root", runsRoot, "--run", runDir],
        JSON.stringify({ kind: "approve" }),
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--request");
    });

    it("refuses a caller-attested outcome on `complete`", () => {
      const { root, runsRoot, runDir } = startedWaveRun("complete-forged-outcome");

      for (const forged of [["--outcome", "succeeded"], ["--error", "it failed"]]) {
        const result = runCli(
          ["complete", "--runs-root", runsRoot, "--run", runDir, "--operation", "refutation-tally", ...forged],
          "",
          root,
        );

        expect(result.status, forged.join(" ")).not.toBe(0);
        expect(result.stderr).toContain("do not accept caller-attested outcomes");
      }
    });

    it("refuses `complete` without a registered panel program", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      const runDir = join(runsRoot, "run.complete-unregistered");
      mkdirSync(runDir, { recursive: true });

      const result = runCli(
        ["complete", "--runs-root", runsRoot, "--run", runDir, "--operation", "refutation-tally"],
        "",
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("registered panel program");
    });

    it("refuses `complete` with no --operation", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      const runDir = join(runsRoot, "run.complete-no-operation");
      mkdirSync(runDir, { recursive: true });

      const result = runCli(
        ["complete", "--runs-root", runsRoot, "--run", runDir],
        "",
        root,
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--operation is required");
    });
  });

  /**
   * Orienting inside a run, and retiring one.
   *
   * Both operations exist because the answers used to live outside the engine.
   * "What state is this run in, and is it recoverable or stale?" meant reading
   * `checkpoint.json`, `program.json`, and `events/` by hand with `jq`, then
   * cross-referencing each transcript slot for a rejection marker. "Which run
   * replaced this one?" had no answer at all: run directories are never
   * deleted, so a superseded run sits in a listing of dozens looking exactly
   * like a live one, and the only record of the supersession was a parent
   * session's notes — which the next operator does not have.
   */
  describe("inspecting and retiring a run", () => {
    /** A standalone run with one captured slot and one rejected slot. */
    async function reviewRun(label: string) {
      const root = repository();
      const runsRoot = join(root, "runs");
      mkdirSync(runsRoot, { recursive: true });
      // Select a scope whose roster lets this fixture capture one slot and
      // reject another, exercising both inspection projections.
      writeFileSync(join(root, "README.md"), "fixture, revised\n");
      const started = runCli(
        ["start", "standalone-review", "--runs-root", runsRoot, "--run", label],
        JSON.stringify({ kind: "comments", files: ["README.md"], dryRun: false }),
        root,
      );
      expect(started.status, started.stderr).toBe(0);
      const action = JSON.parse(started.stdout) as { requests: { authority: AgentRequestAuthority }[] };
      const opened = openRunDirectory(runsRoot, label);
      if (!opened.ok) throw new Error(opened.error.message);
      const [captured, rejected] = action.requests;
      if (captured === undefined || rejected === undefined) throw new Error("expected at least two reviewer slots");
      const transcript = [
        "### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "", "```findings", "[]", "```",
      ].join("\n");
      expect((await opened.value.captureTranscript(captured.authority, [...Buffer.from(transcript)])).ok).toBe(true);
      expect((await opened.value.rejectCapture(
        rejected.authority,
        'agent-failed: exited without a successful result (exitCode=0, stopReason=error, errorMessage="Connection error.")',
      )).ok).toBe(true);
      return { root, runsRoot, captured: captured.authority, rejected: rejected.authority };
    }

    it("answers program, state, per-slot capture, and the rejection diagnostic in one read", async () => {
      const { root, runsRoot } = await reviewRun("run.inspect-mixed");

      const inspected = runCli(["inspect", "--runs-root", runsRoot, "--run", "run.inspect-mixed"], "", root);

      expect(inspected.status, inspected.stderr).toBe(0);
      expect(inspected.stdout).toContain("run:       run.inspect-mixed");
      expect(inspected.stdout).toContain("program:   standalone-review");
      expect(inspected.stdout).toContain("state:     awaiting-results");
      expect(inspected.stdout).toContain("1 captured, 1 rejected");
      expect(inspected.stdout).toContain('stopReason=error, errorMessage="Connection error."');
      expect(inspected.stdout).toContain("abandoned: no");
    });

    it("projects the same facts into the JSON form", async () => {
      const { root, runsRoot, rejected } = await reviewRun("run.inspect-json");

      const inspected = runCli(["inspect", "--runs-root", runsRoot, "--run", "run.inspect-json", "--json"], "", root);

      expect(inspected.status, inspected.stderr).toBe(0);
      const projection = JSON.parse(inspected.stdout) as {
        kind: string;
        program: { value: { kind: string; program?: string } };
        slots: { value: { slotId: string; capture: string; diagnostic: string | null }[] };
      };
      expect(projection.kind).toBe("run-inspection");
      expect(projection.program.value).toEqual({ kind: "registered", program: "standalone-review" });
      expect(projection.slots.value.find(({ slotId }) => slotId === rejected.slotId))
        .toMatchObject({ capture: "rejected", diagnostic: expect.stringContaining("agent-failed") });
    });

    it("inspects a bare run directory without inventing a program or a state", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(join(runsRoot, "run.inspect-bare"), { recursive: true });

      const inspected = runCli(["inspect", "--runs-root", runsRoot, "--run", "run.inspect-bare"], "", root);

      expect(inspected.status, inspected.stderr).toBe(0);
      expect(inspected.stdout).toContain("program:   none registered");
      expect(inspected.stdout).toContain("state:     no checkpoint written");
      expect(inspected.stdout).toContain("0 issued");
    });

    it("records a supersession and then refuses every operation that would advance the run", async () => {
      const { root, runsRoot } = await reviewRun("run.abandon-source");
      mkdirSync(join(runsRoot, "run.abandon-replacement"), { recursive: true });

      const abandoned = runCli([
        "abandon", "--runs-root", runsRoot, "--run", "run.abandon-source",
        "--superseded-by", "run.abandon-replacement",
        "--reason", "every slot died on the shared endpoint",
      ], "", root);

      expect(abandoned.status, abandoned.stderr).toBe(0);
      expect(JSON.parse(abandoned.stdout)).toMatchObject({
        kind: "run-abandoned",
        runId: "run.abandon-source",
        supersededBy: "run.abandon-replacement",
      });

      // The retained run stays readable — that is why it was retained.
      const inspected = runCli(["inspect", "--runs-root", runsRoot, "--run", "run.abandon-source"], "", root);
      expect(inspected.status, inspected.stderr).toBe(0);
      expect(inspected.stdout).toContain("abandoned: yes — superseded by run.abandon-replacement");

      const resumed = runCli(["resume", "--runs-root", runsRoot, "--run", "run.abandon-source"], "", root);
      expect(resumed.status).not.toBe(0);
      expect(resumed.stderr).toContain("was abandoned (superseded by run.abandon-replacement)");
      expect(resumed.stderr).toContain("advance the run that replaced it instead");
    });

    /**
     * `bindLiveRun`'s docstring says an UNREADABLE marker refuses too, and that
     * branch is the safety net for the whole feature: a marked run whose marker
     * cannot be parsed may already have a successor holding its authority, so
     * "advance it anyway" is least defensible exactly there. Nothing pinned it,
     * so an inverted condition or a dropped branch would have gone green.
     */
    it("refuses to advance a run whose abandonment marker is unreadable", async () => {
      const { root, runsRoot } = await reviewRun("run.abandon-corrupt");
      writeFileSync(join(runsRoot, "run.abandon-corrupt", "abandoned.json"), "{ not json");

      for (const operation of [
        ["resume", "--runs-root", runsRoot, "--run", "run.abandon-corrupt"],
        ["submit", "--runs-root", runsRoot, "--run", "run.abandon-corrupt",
         "--request", "request:whatever", "--slot", "slot:whatever", "--attempt", "1"],
        ["correlate", "--runs-root", runsRoot, "--run", "run.abandon-corrupt",
         "--request", "request:whatever", "--harness", "claude", "--native-id", "x", "--agent", "code-reviewer"],
        ["complete", "--runs-root", runsRoot, "--run", "run.abandon-corrupt", "--operation", "op"],
        ["decide", "--runs-root", runsRoot, "--run", "run.abandon-corrupt", "--request", "decision:x"],
      ]) {
        const refused = runCli(operation, "", root);
        expect(refused.status, `${operation[0]} must refuse an unreadable marker`).not.toBe(0);
      }

      // `inspect` is a pure read, so it still answers — that is the point of
      // retaining a retired run at all.
      const inspected = runCli(["inspect", "--runs-root", runsRoot, "--run", "run.abandon-corrupt"], "", root);
      expect(inspected.status, inspected.stderr).toBe(0);
    });

    /**
     * The marker is immutable, so a typo'd or cross-root pointer would be
     * frozen into the run forever — worse than no pointer, because it reads as
     * authoritative.
     */
    it("refuses a replacement that is not an existing run under the same root", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(join(runsRoot, "run.abandon-typo"), { recursive: true });

      const abandoned = runCli([
        "abandon", "--runs-root", runsRoot, "--run", "run.abandon-typo",
        "--superseded-by", "run.does-not-exist", "--reason", "x",
      ], "", root);

      expect(abandoned.status).not.toBe(0);
      expect(abandoned.stderr).toContain("is not an existing run directory under");
      expect(existsSync(join(runsRoot, "run.abandon-typo", "abandoned.json"))).toBe(false);
    });

    it("refuses an abandonment with no reason, and one that names itself", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(join(runsRoot, "run.abandon-invalid"), { recursive: true });

      const noReason = runCli(
        ["abandon", "--runs-root", runsRoot, "--run", "run.abandon-invalid"], "", root);
      expect(noReason.status).not.toBe(0);
      expect(noReason.stderr).toContain("--reason");

      const itself = runCli([
        "abandon", "--runs-root", runsRoot, "--run", "run.abandon-invalid",
        "--superseded-by", "run.abandon-invalid", "--reason", "x",
      ], "", root);
      expect(itself.status).not.toBe(0);
      expect(itself.stderr).toContain("a run cannot supersede itself");
    });

    it("stays idempotent on an identical repeat and refuses a conflicting one", () => {
      const root = project();
      const runsRoot = join(root, "runs");
      mkdirSync(join(runsRoot, "run.abandon-twice"), { recursive: true });
      const abandon = (reason: string) => runCli(
        ["abandon", "--runs-root", runsRoot, "--run", "run.abandon-twice", "--reason", reason], "", root);

      expect(abandon("scope was dropped").status).toBe(0);
      expect(abandon("scope was dropped").status).toBe(0);

      const conflicting = abandon("a different story");
      expect(conflicting.status).not.toBe(0);
      expect(conflicting.stderr).toContain("already abandoned under a different marker");
    });

    it("lists both operations in the usage text so they are discoverable", () => {
      const usage = runCli(["not-an-operation"], "", project());

      expect(usage.status).not.toBe(0);
      expect(usage.stderr).toContain("inspect --runs-root <root> --run <run-directory> [--json]");
      expect(usage.stderr).toContain("abandon --runs-root <root> --run <run-directory> --reason <text>");
    });
  });
});
