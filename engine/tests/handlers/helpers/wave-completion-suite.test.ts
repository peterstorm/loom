import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AuthorizedWaveCompletionCheck,
  type CompletionCheckResult,
} from "../../../src/core/completion-suite";
import { evaluateAsRecorded } from "../../fixtures/completion-suite-evaluation";
import { sha256Hex } from "../../../src/core/digest";
import { parseArtifactDigest, type ArtifactDigest } from "../../../src/core/orchestration-contract";
import { derivePendingTaskProof, evaluateTaskProof } from "../../../src/core/proof-obligations";
import type { AcceptanceContract, AcceptanceTestcase } from "../../../src/core/acceptance-contract";
import { runCompletionCheck as productionRunCompletionCheck } from "../../../src/orchestration/completion-check-runner";
import {
  authorizeWaveCompletionSuite,
  freezeVerificationManifest,
} from "../../../src/core/verification-manifest";
import {
  ensureWaveCompletionSuite,
  observeCurrentWaveWorkspace,
  type RunCompletionCheck,
} from "../../../src/handlers/helpers/wave-completion-suite";
import type { RegisteredWaveGateProgram } from "../../../src/core/wave-gate-program";
import { createRunDirectory, type RunDirHandle } from "../../../src/orchestration/run-directory-handle";
import { StateManager } from "../../../src/state-manager";
import {
  parseNewTestEvidence,
  type ActiveWaveGateRegistration,
  type Task,
  type TaskGraph,
} from "../../../src/types";
import { satisfiedProof } from "../../fixtures/task-lifecycle";

const roots: string[] = [];
const fakeReportDigest = (() => {
  const parsed = parseArtifactDigest("f".repeat(64));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
})();

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function manifest(mode: string, report = true) {
  const parsed = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id: "project:completion",
      scope: "wave",
      executable: mode === "spawn-failure" ? ".loom/bin/node" : "node",
      args: ["completion-check.mjs", mode],
      cwd: ".",
      timeoutMs: 5_000,
      report: report
        ? { kind: "required-file", path: ".loom/completion-reports/result.txt" }
        : { kind: "not-required" },
    }],
  })));
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  return parsed.value;
}

const proof = (() => {
  const evaluated = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: [] },
    { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: [], newTestsWritten: true },
  );
  if (evaluated.state !== "satisfied") throw new Error("proof fixture must be satisfied");
  return evaluated;
})();


function completionScript(): string {
  return `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.argv[2];
const report = ".loom/completion-reports/result.txt";
const state = JSON.parse(readFileSync(".claude/state/active_task_graph.json", "utf8"));
if (state.active_wave_completion_suite !== undefined) process.exit(7);
mkdirSync(".loom/completion-reports", { recursive: true });
const previous = (() => {
  try {
    return Number(readFileSync(report, "utf8"));
  } catch (cause) {
    if (cause?.code === "ENOENT") return 0;
    throw new Error(\`cannot read completion counter \${report}\`, { cause });
  }
})();
if (mode === "success") writeFileSync(report, String(previous + 1));
else if (mode === "nonzero") {
  writeFileSync(report, String(previous + 1));
  process.exit(2);
}
else if (mode === "missing-report") process.exit(0);
else if (mode === "mutate-workspace") {
  writeFileSync("source.ts", "export const value = 2;\\n");
  writeFileSync(report, String(previous + 1));
} else if (mode.startsWith("junit:")) {
  // junit:AS-001=fail,AS-002=pass — one acceptance testcase per anchor, plus
  // one passing ordinary testcase; the runner exits 1 when any case fails.
  const cases = mode.slice("junit:".length).split(",").map((entry) => entry.split("="));
  const failing = cases.filter(([, outcome]) => outcome === "fail").length;
  const testcase = ([anchor, outcome]) =>
    '<testcase classname="tests/payload.acceptance.test.ts" name="payload &gt; ' + anchor + ': decides ' + anchor + '">' +
    (outcome === "fail" ? '<failure message="expected" type="AssertionError">expected</failure>' : '') + '</testcase>';
  writeFileSync(report, [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    '<testsuites name="vitest tests" tests="' + (cases.length + 1) + '" failures="' + failing + '" errors="0">',
    '<testsuite name="tests/other.test.ts" tests="1" failures="0" errors="0" skipped="0">',
    '<testcase classname="tests/other.test.ts" name="plain"></testcase>',
    '</testsuite>',
    '<testsuite name="tests/payload.acceptance.test.ts" tests="' + cases.length + '" failures="' + failing + '" errors="0" skipped="0">',
    ...cases.map(testcase),
    '</testsuite>',
    '</testsuites>',
  ].join("\\n"));
  process.exit(failing > 0 ? 1 : 0);
} else process.exit(3);
`;
}

const ACCEPTANCE_FILE = "tests/payload.acceptance.test.ts";
const ACCEPTANCE_SOURCE = "it('AS-001: decides AS-001', () => expect(wins()).toBe(2));\n";
const ACCEPTANCE_DIGEST = sha256Hex(ACCEPTANCE_SOURCE) as ArtifactDigest;
const rosterEntry = (anchor: string): AcceptanceTestcase =>
  ({ file: ACCEPTANCE_FILE, name: `payload > ${anchor}: decides ${anchor}`, anchors: [anchor] });

/**
 * One contract written by T1 in Wave 1. AS-001 is completed by T2 in Wave 2
 * and AS-002 by T3 in Wave 3, so at Wave 2's gate AS-001 is due and AS-002
 * still pending.
 */
const CONTRACT: AcceptanceContract = {
  schemaVersion: 1,
  id: "CT-1",
  title: "Payload",
  statement: "One valid call wins.",
  contractTask: "T1",
  types: { kind: "none", reason: "the slice declares no shared surface" },
  acceptance: [{ path: ACCEPTANCE_FILE, anchors: ["AS-001", "AS-002"] }],
  supportedDomain: null,
  freeze: { state: "awaiting-red" },
  revisions: [],
};

/** Which gate a contract fixture registers: the contract Wave's (RED), a
 *  claimant Wave's against the frozen roster, or the first gate after a
 *  Contract Revision. */
type ContractStage = "contract-wave" | "claimant-wave" | "after-revision";

const contractFreeze = (stage: ContractStage): AcceptanceContract["freeze"] => {
  const paths = [{ path: ACCEPTANCE_FILE, sha256: ACCEPTANCE_DIGEST }] as const;
  switch (stage) {
    case "contract-wave":
      return { state: "awaiting-red" };
    case "claimant-wave":
      return { state: "frozen", wave: 1, paths, roster: [rosterEntry("AS-001"), rosterEntry("AS-002")] };
    case "after-revision":
      return { state: "revised", paths };
  }
};

/** The revision that produced a revised freeze: the operator re-stamped the
 *  acceptance file over bytes the contract Wave had frozen earlier. */
const contractRevisions = (stage: ContractStage): AcceptanceContract["revisions"] => stage === "after-revision"
  ? [{
      revision: 1,
      reason: "AS-002 asserted the wrong value",
      previous: [{ path: ACCEPTANCE_FILE, sha256: sha256Hex("superseded bytes") as ArtifactDigest }],
      paths: [{ path: ACCEPTANCE_FILE, sha256: ACCEPTANCE_DIGEST }],
      revalidatedTaskIds: [],
    }]
  : [];

/** T1 writes the contract in Wave 1; T2 claims AS-001 in Wave 2; T3 claims AS-002 in Wave 3. */
function contractTasks(stage: ContractStage): Task[] {
  const contractWave = stage === "contract-wave";
  return [{
    id: "T1",
    description: "write the contract",
    agent: "code-implementer-agent",
    wave: 1,
    status: contractWave ? "implemented" : "completed",
    proof: satisfiedProof([ACCEPTANCE_FILE]),
    depends_on: [],
    file_list: [ACCEPTANCE_FILE],
    review_status: contractWave ? "pending" : "passed",
    critical_findings: [],
    advisory_findings: [],
  }, {
    id: "T2",
    description: "turn AS-001 green",
    agent: "code-implementer-agent",
    wave: 2,
    ...(contractWave
      ? { status: "pending" as const, proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/payload.ts"] }) }
      : { status: "implemented" as const, proof: satisfiedProof(["src/payload.ts"]) }),
    depends_on: ["T1"],
    spec_anchors: ["AS-001"],
    file_list: ["src/payload.ts"],
    review_status: "pending",
    critical_findings: [],
    advisory_findings: [],
  }, {
    id: "T3",
    description: "turn AS-002 green",
    agent: "code-implementer-agent",
    wave: 3,
    status: "pending",
    proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: ["src/second.ts"] }),
    depends_on: ["T1"],
    spec_anchors: ["AS-002"],
    file_list: ["src/second.ts"],
  }];
}

type Fixture = Readonly<{
  root: string;
  manager: StateManager;
  handle: RunDirHandle;
  registration: RegisteredWaveGateProgram;
}>;

function fixture(mode: string, report = true): Fixture {
  return buildFixture(mode, report, null);
}

/** A repository whose TaskGraph carries CT-1 at `stage`, gating the stage's Wave. */
function contractFixture(mode: string, stage: ContractStage): Fixture {
  return buildFixture(mode, true, stage);
}

function buildFixture(mode: string, report: boolean, stage: ContractStage | null): Fixture {
  const wave = stage === null || stage === "contract-wave" ? 1 : 2;
  const root = canonicalTempDir("loom-wave-suite-");
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "loom-tests@example.invalid");
  git(root, "config", "user.name", "Loom Tests");
  write(root, ".gitignore", ".loom/bin/\n.loom/completion-reports/\n");
  write(root, "source.ts", "export const value = 1;\n");
  write(root, "completion-check.mjs", completionScript());
  if (stage !== null) {
    write(root, ACCEPTANCE_FILE, ACCEPTANCE_SOURCE);
    write(root, "src/payload.ts", "export const wins = () => 2;\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");

  const active: ActiveWaveGateRegistration = {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: "run.wave-suite" as ActiveWaveGateRegistration["runId"],
    wave,
    authorityDigest: "a".repeat(64) as ActiveWaveGateRegistration["authorityDigest"],
    revision: 0,
    runsRoot: join(root, ".claude/reviews/wave-gate-runs"),
    terminalOutcome: null,
  };
  const graph: TaskGraph = {
    current_phase: "execute",
    current_wave: wave,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: stage === null
      ? [{
          id: "T1",
          description: "run completion suite",
          agent: "code-implementer-agent",
          wave: 1,
          status: "implemented",
          proof,
          depends_on: [],
          test_result: { verdict: "trusted-pass" },
          new_test_observation: parseNewTestEvidence(true, "fixture new-test evidence"),
          review_status: "pending",
          critical_findings: [],
          advisory_findings: [],
        }]
      : contractTasks(stage),
    wave_gates: {},
    verification_manifest: manifest(mode, report),
    active_wave_gate: active,
    ...(stage === null ? {} : { acceptance_contracts: [{ ...CONTRACT, freeze: contractFreeze(stage), revisions: contractRevisions(stage) }] }),
  };
  const statePath = join(root, ".claude/state/active_task_graph.json");
  write(root, ".claude/state/active_task_graph.json", JSON.stringify(graph, null, 2));
  chmodSync(statePath, 0o444);
  mkdirSync(active.runsRoot!, { recursive: true });
  const created = createRunDirectory(active.runsRoot!, active.runId);
  if (!created.ok) throw new Error(created.error.message);
  const registration: RegisteredWaveGateProgram = Object.freeze({
    schemaVersion: 1,
    kind: "wave-gate",
    input: Object.freeze({ wave }),
    taskIds: Object.freeze([wave === 1 ? "T1" : "T2"]),
    authorityDigest: active.authorityDigest,
  });
  return { root, manager: new StateManager(statePath), handle: created.value, registration };
}

async function ensure(f: Fixture) {
  return ensureWaveCompletionSuite({
    handle: f.handle,
    manager: f.manager,
    graph: f.manager.load(),
    registration: f.registration,
  });
}

function reportCount(root: string): number {
  const path = join(root, ".loom/completion-reports/result.txt");
  try {
    return Number(readFileSync(path, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new Error(`cannot read completion counter ${path}`, { cause });
  }
}

function successfulCheckResult(check: AuthorizedWaveCompletionCheck): CompletionCheckResult {
  return Object.freeze({
    checkId: check.checkId,
    scope: check.scope,
    outcome: Object.freeze({
      kind: "observed",
      exitCode: 0,
      timedOut: false,
      signal: null,
      report: check.reportPolicy.kind === "required-file"
        ? Object.freeze({
            kind: "produced",
            path: check.reportPolicy.path,
            digest: fakeReportDigest,
            byteLength: 1,
          })
        : Object.freeze({ kind: "not-required" }),
    }),
  });
}

function successfulFakeCompletionCheck(beforeResult: () => Promise<void>): RunCompletionCheck {
  return async (check, _repositoryRoot) => {
    await beforeResult();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        checkResult: successfulCheckResult(check),
        diagnostics: Object.freeze({
          stdoutTail: "",
          stderrTail: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      }),
    });
  };
}

function advanceActiveRegistration(locked: TaskGraph): TaskGraph {
  const active = locked.active_wave_gate;
  if (active === undefined) throw new Error("fixture requires active Wave Gate authority");
  return { ...locked, active_wave_gate: { ...active, revision: active.revision + 1 } };
}

function resultArtifactAuthority(f: Fixture) {
  const graph = f.manager.load();
  const workspace = observeCurrentWaveWorkspace(graph, f.root);
  if (workspace.kind !== "observed" || graph.active_wave_gate === undefined || graph.verification_manifest === undefined) {
    throw new Error("fixture must carry observable modern completion authority");
  }
  const authorized = authorizeWaveCompletionSuite(
    graph.verification_manifest,
    graph.active_wave_gate,
    workspace.workspaceDigest,
  );
  if (!authorized.ok) throw new Error(authorized.error.errors.join("; "));
  return authorized.value;
}

function resultArtifactRelativePath(f: Fixture): string {
  const authority = resultArtifactAuthority(f);
  return `completion-suites/${authority.suiteDigest}/${authority.workspaceDigest}.json`;
}

function acceptedReceiptForCurrentAuthority(f: Fixture) {
  const authority = resultArtifactAuthority(f);
  const checks = authority.checks.map(successfulCheckResult);
  const evaluated = evaluateAsRecorded(authority, {
    ...authority,
    kind: "wave-completion-suite-result",
    checks,
  });
  if (evaluated.kind !== "accepted") throw new Error("replacement receipt fixture must be accepted");
  return evaluated.receipt;
}

async function publishRawResultArtifact(f: Fixture, raw: unknown): Promise<void> {
  const published = await f.handle.publishArtifactSet([{
    relativePath: resultArtifactRelativePath(f),
    bytes: [...new TextEncoder().encode(typeof raw === "string" ? raw : JSON.stringify(raw))],
  }]);
  if (!published.ok) throw new Error(published.error.message);
}

async function removeActiveReceipt(f: Fixture): Promise<void> {
  await f.manager.update((locked) => {
    const { active_wave_completion_suite: _removed, ...withoutReceipt } = locked;
    return withoutReceipt;
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("modern Wave completion suite shell", () => {
  it("treats only an absent completion counter as zero", () => {
    const root = canonicalTempDir("loom-wave-suite-counter-");
    roots.push(root);
    expect(reportCount(root)).toBe(0);
    const path = join(root, ".loom/completion-reports/result.txt");
    mkdirSync(path, { recursive: true });

    let observed: unknown;
    try {
      reportCount(root);
    } catch (cause) {
      observed = cause;
    }
    expect(observed).toBeInstanceOf(Error);
    if (!(observed instanceof Error)) throw new Error("counter failure must preserve an Error cause");
    expect(observed.message).toContain(path);
    expect(observed.cause).toMatchObject({ code: "EISDIR" });
  });

  it("rejects report exclusions outside the protected completion-report root", () => {
    const parsed = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      kind: "loom-verification-manifest",
      checks: [{
        id: "project:laundered-report",
        scope: "wave",
        executable: "node",
        args: ["completion-check.mjs", "success"],
        cwd: ".",
        timeoutMs: 5_000,
        report: { kind: "required-file", path: "source.ts" },
      }],
    })));
    expect(parsed).toMatchObject({
      ok: false,
      error: { errors: [expect.stringContaining(".loom/completion-reports/")] },
    });
  });

  it("executes in the Run Directory repository from an outside cwd, publishes, installs, and reuses", async () => {
    const f = fixture("success");
    const first = await ensure(f);
    expect(first, JSON.stringify(first)).toMatchObject({
      ok: true,
      value: { kind: "accepted", disposition: "installed" },
    });
    expect(reportCount(f.root)).toBe(1);

    const receipt = f.manager.load().active_wave_completion_suite;
    expect(receipt).toBeDefined();
    const artifact = join(
      f.handle.runDirectory,
      "artifacts/completion-suites",
      receipt!.suiteDigest,
      `${receipt!.workspaceDigest}.json`,
    );
    const published = JSON.parse(readFileSync(artifact, "utf8")) as { checks: unknown[] };
    expect(published.checks).toHaveLength(2);

    const repeated = await ensure(f);
    expect(repeated).toMatchObject({ ok: true, value: { disposition: "reused" } });
    expect(reportCount(f.root)).toBe(1);
  });

  it("returns semantic categories for nonzero and missing-report outcomes without installing a receipt", async () => {
    for (const mode of ["nonzero", "missing-report"] as const) {
      const f = fixture(mode);
      const result = await ensure(f);
      expect(result).toMatchObject({
        ok: false,
        error: {
          diagnostic: {
            categories: ["semantic"],
            checkIds: ["project:completion"],
          },
        },
      });
      expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
    }
  });

  it("leaves infrastructure failures unpublished so environment repair can retry", async () => {
    const f = fixture("spawn-failure", false);
    const relativePath = resultArtifactRelativePath(f);
    const failed = await ensure(f);
    expect(failed).toMatchObject({
      ok: false,
      error: { diagnostic: { categories: ["infrastructure"], checkIds: ["project:completion"] } },
    });
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
    expect(f.handle.readArtifactBytes(relativePath)).toEqual({ ok: true, value: null });

    const repairedExecutable = join(f.root, ".loom/bin/node");
    mkdirSync(dirname(repairedExecutable), { recursive: true });
    writeFileSync(repairedExecutable, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(repairedExecutable, 0o755);
    expect(await ensure(f)).toMatchObject({
      ok: true,
      value: { kind: "accepted", disposition: "installed" },
    });
    const persisted = f.handle.readArtifactBytes(relativePath);
    expect(persisted.ok && persisted.value !== null).toBe(true);
  });

  it("recovers an accepted receipt from its immutable result after a publication-to-state crash", async () => {
    const f = fixture("success");
    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    expect(reportCount(f.root)).toBe(1);

    await removeActiveReceipt(f);
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();

    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    expect(f.manager.load().active_wave_completion_suite).toBeDefined();
    expect(reportCount(f.root)).toBe(1);
  });

  it("replays a persisted exact semantic rejection without rerunning checks", async () => {
    const f = fixture("nonzero");
    const first = await ensure(f);
    expect(first).toMatchObject({
      ok: false,
      error: { diagnostic: { categories: ["semantic"], checkIds: ["project:completion"] } },
    });
    expect(reportCount(f.root)).toBe(1);

    const replayed = await ensure(f);
    expect(replayed).toEqual(first);
    expect(reportCount(f.root)).toBe(1);
  });

  it.each([
    "malformed",
    "stale",
    "authority-rejected",
    "infrastructure-failure",
  ] as const)("blocks an occupied %s result artifact without executing commands", async (variant) => {
    const f = fixture("success");
    if (variant === "malformed") {
      await publishRawResultArtifact(f, "{not-json");
    } else {
      const authority = resultArtifactAuthority(f);
      const staleWorkspaceDigest = authority.workspaceDigest === "f".repeat(64)
        ? "e".repeat(64)
        : "f".repeat(64);
      const checks = variant === "infrastructure-failure"
        ? authority.checks.map((check) => ({
            checkId: check.checkId,
            scope: "wave",
            outcome: check.kind === "project-command"
              ? { kind: "spawn-failed", message: "persisted spawn failure" }
              : {
                  kind: "observed",
                  exitCode: 0,
                  timedOut: false,
                  signal: null,
                  report: { kind: "not-required" },
                },
          }))
        : [];
      await publishRawResultArtifact(f, {
        ...authority,
        kind: "wave-completion-suite-result",
        ...(variant === "stale" ? { workspaceDigest: staleWorkspaceDigest } : {}),
        checks,
      });
    }

    expect(await ensure(f)).toMatchObject({
      ok: false,
      error: { diagnostic: { categories: ["artifact"] } },
    });
    expect(reportCount(f.root)).toBe(0);
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
  });

  it("blocks a workspace-mutating check before artifact or receipt installation", async () => {
    const f = fixture("mutate-workspace");
    const result = await ensure(f);
    expect(result).toMatchObject({ ok: false, error: { diagnostic: { categories: ["workspace"] } } });
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
  });

  it("clears a stale receipt under authority before rerunning and leaves the replacement reusable", async () => {
    const f = fixture("success");
    const initial = await ensure(f);
    expect(initial, JSON.stringify(initial)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    const firstDigest = f.manager.load().active_wave_completion_suite!.workspaceDigest;
    write(f.root, "source.ts", "export const value = 3;\n");

    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    const replacement = f.manager.load().active_wave_completion_suite!;
    expect(replacement.workspaceDigest).not.toBe(firstDigest);
    expect(reportCount(f.root)).toBe(2);
    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "reused" } });
    expect(reportCount(f.root)).toBe(2);
  });

  it("rejects stale-receipt clearing after a concurrent protected-state transition", async () => {
    const f = fixture("success");
    expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "installed" } });
    write(f.root, "source.ts", "export const value = 4;\n");
    const staleGraph = f.manager.load();
    const replacementReceipt = acceptedReceiptForCurrentAuthority(f);
    await f.manager.update((locked) => ({
      ...locked,
      active_wave_completion_suite: replacementReceipt,
    }));
    const mustNotRun: RunCompletionCheck = async () => {
      throw new Error("completion check must not run after stale receipt CAS failure");
    };

    const result = await ensureWaveCompletionSuite({
      handle: f.handle,
      manager: f.manager,
      graph: staleGraph,
      registration: f.registration,
      runCompletionCheck: mustNotRun,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostic: {
          categories: ["state"],
          message: expect.stringContaining("concurrent completion receipt replaced"),
        },
      },
    });
    expect(f.manager.load().active_wave_completion_suite).toEqual(replacementReceipt);
    expect(reportCount(f.root)).toBe(1);
  });

  it("rejects receipt installation after a fake check advances protected state", async () => {
    const f = fixture("success");
    const runCompletionCheck = successfulFakeCompletionCheck(async () => {
      await f.manager.update(advanceActiveRegistration);
    });

    const result = await ensureWaveCompletionSuite({
      handle: f.handle,
      manager: f.manager,
      graph: f.manager.load(),
      registration: f.registration,
      runCompletionCheck,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostic: {
          categories: ["state"],
          message: expect.stringContaining("changed before receipt installation"),
        },
      },
    });
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
    expect(reportCount(f.root)).toBe(0);
  });

  it("requires an authority start path for workspace observation", () => {
    const f = fixture("success");
    const outside = canonicalTempDir("loom-wave-suite-no-git-");
    roots.push(outside);
    expect(observeCurrentWaveWorkspace(f.manager.load(), outside)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("Git resolve-root failed"),
    });
    expect(observeCurrentWaveWorkspace(f.manager.load(), f.handle.runDirectory)).toMatchObject({
      kind: "observed",
    });
  });

  it("fails closed when Run Directory and protected TaskGraph repository authority differ", async () => {
    const f = fixture("success");
    const foreignRepository = canonicalTempDir("loom-wave-suite-foreign-git-");
    roots.push(foreignRepository);
    git(foreignRepository, "init", "-q");
    const foreignRunsRoot = join(foreignRepository, ".claude/reviews/wave-gate-runs");
    mkdirSync(foreignRunsRoot, { recursive: true });
    const foreignHandle = createRunDirectory(foreignRunsRoot, f.handle.runId);
    if (!foreignHandle.ok) throw new Error(foreignHandle.error.message);

    const result = await ensureWaveCompletionSuite({
      handle: foreignHandle.value,
      manager: f.manager,
      graph: f.manager.load(),
      registration: f.registration,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostic: {
          categories: ["authority"],
          message: expect.stringContaining("differs from protected TaskGraph repository"),
        },
      },
    });
    expect(reportCount(f.root)).toBe(0);
    expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
  });

  describe("acceptance contracts at the Wave Gate", () => {
    /** The project check's recorded outcome in the installed receipt. */
    const completionOutcome = (graph: TaskGraph) =>
      graph.active_wave_completion_suite?.checks.find(({ checkId }) => checkId === "project:completion")?.outcome;

    it("accepts the contract Wave's expected RED and stamps the Acceptance Freeze with the receipt", async () => {
      const f = contractFixture("junit:AS-001=fail,AS-002=fail", "contract-wave");
      const result = await ensure(f);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { kind: "accepted", disposition: "installed" } });
      const graph = f.manager.load();
      expect(completionOutcome(graph)).toMatchObject({ exitCode: 1 });
      expect(graph.acceptance_contracts?.[0]?.freeze).toEqual(contractFreeze("claimant-wave"));
      expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "reused" } });
    });

    it("blocks a contract Wave whose acceptance already passes, naming the testcase", async () => {
      const f = contractFixture("junit:AS-001=pass,AS-002=fail", "contract-wave");
      const result = await ensure(f);
      expect(result).toMatchObject({
        ok: false,
        error: {
          diagnostic: {
            categories: ["semantic"],
            message: expect.stringContaining("acceptance testcases pass before any claimant implemented them"),
          },
        },
      });
      expect(f.manager.load().acceptance_contracts?.[0]?.freeze).toEqual({ state: "awaiting-red" });
    });

    it("accepts a claimant Wave whose due testcase passes while a pending one still fails, leaving the freeze alone", async () => {
      const f = contractFixture("junit:AS-001=pass,AS-002=fail", "claimant-wave");
      const result = await ensure(f);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { kind: "accepted", disposition: "installed" } });
      const graph = f.manager.load();
      expect(completionOutcome(graph)).toMatchObject({ exitCode: 1 });
      expect(graph.acceptance_contracts?.[0]?.freeze).toEqual(contractFreeze("claimant-wave"));
    });

    it("blocks a claimant Wave whose due testcase still fails, naming it", async () => {
      const f = contractFixture("junit:AS-001=fail,AS-002=fail", "claimant-wave");
      expect(await ensure(f)).toMatchObject({
        ok: false,
        error: {
          diagnostic: {
            categories: ["semantic"],
            message: expect.stringContaining("due acceptance testcases are not passing: 'payload > AS-001: decides AS-001'"),
          },
        },
      });
      expect(f.manager.load().active_wave_completion_suite).toBeUndefined();
    });

    it("re-records the roster green at the first gate after a Contract Revision, freezing the revised bytes", async () => {
      const f = contractFixture("junit:AS-001=pass,AS-002=fail", "after-revision");
      const result = await ensure(f);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { kind: "accepted", disposition: "installed" } });
      expect(f.manager.load().acceptance_contracts?.[0]?.freeze).toEqual({
        state: "frozen",
        wave: 2,
        paths: [{ path: ACCEPTANCE_FILE, sha256: ACCEPTANCE_DIGEST }],
        roster: [rosterEntry("AS-001"), rosterEntry("AS-002")],
      });
      expect(await ensure(f)).toMatchObject({ ok: true, value: { disposition: "reused" } });
    });

    it("refuses to install when the protected contracts change while the checks run", async () => {
      const f = contractFixture("junit:AS-001=fail,AS-002=fail", "contract-wave");
      const runCompletionCheck: RunCompletionCheck = async (check, repositoryRoot) => {
        const execution = await productionRunCompletionCheck(check, repositoryRoot);
        await f.manager.update((locked) => ({
          ...locked,
          acceptance_contracts: locked.acceptance_contracts?.map((contract) => ({ ...contract, title: "Payload (retitled)" })),
        }));
        return execution;
      };
      const result = await ensureWaveCompletionSuite({
        handle: f.handle,
        manager: f.manager,
        graph: f.manager.load(),
        registration: f.registration,
        runCompletionCheck,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          diagnostic: {
            categories: ["state"],
            message: expect.stringContaining("protected acceptance contracts changed before receipt installation"),
          },
        },
      });
      const graph = f.manager.load();
      expect(graph.active_wave_completion_suite).toBeUndefined();
      expect(graph.acceptance_contracts?.[0]?.freeze).toEqual({ state: "awaiting-red" });
    });

    it("blocks with artifact drift once a frozen acceptance file changes outside any Task", async () => {
      const f = contractFixture("junit:AS-001=fail,AS-002=fail", "contract-wave");
      expect(await ensure(f)).toMatchObject({ ok: true });
      write(f.root, ACCEPTANCE_FILE, "it.skip('AS-001: decides AS-001', () => {});\n");
      expect(await ensure(f)).toMatchObject({
        ok: false,
        error: {
          diagnostic: {
            categories: ["artifact"],
            message: expect.stringContaining(`frozen acceptance drifted: CT-1 '${ACCEPTANCE_FILE}' changed`),
          },
        },
      });
    });
  });

  it("fails closed when the protected TaskGraph path has no Git authority", async () => {
    const f = fixture("success");
    const outside = canonicalTempDir("loom-wave-suite-state-no-git-");
    roots.push(outside);
    const statePath = join(outside, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(f.manager.load(), null, 2));
    chmodSync(statePath, 0o444);
    const manager = new StateManager(statePath);

    const result = await ensureWaveCompletionSuite({
      handle: f.handle,
      manager,
      graph: manager.load(),
      registration: f.registration,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostic: {
          categories: ["authority"],
          message: expect.stringContaining("TaskGraph repository authority is unavailable"),
        },
      },
    });
    expect(reportCount(f.root)).toBe(0);
    expect(manager.load().active_wave_completion_suite).toBeUndefined();
  });
});
