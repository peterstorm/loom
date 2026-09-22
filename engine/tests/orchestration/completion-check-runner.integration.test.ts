import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseAuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionCheck,
} from "../../src/core/completion-suite";
import {
  runCompletionCheck,
  runRemediationCheck,
  type CompletionCheckRunnerResult,
  type RemediationCheckRunnerResult,
} from "../../src/orchestration/completion-check-runner";
import {
  authorizeRemediationChecks,
  createCandidateRepositoryWitness,
  createRemediationCheckScope,
  prepareDefectFamilyAccounting,
  prepareDefectFamilyVerification,
  type AuthorizedRemediationCheck,
} from "../../src/core/defect-family-accounting";
import { parseRepositorySnapshotWitness } from "../../src/core/remediation-machine";
import { VERIFICATION_MANIFEST_KIND, freezeVerificationManifest } from "../../src/core/verification-manifest";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import {
  parseCanonicalRepositoryRoot,
  type CanonicalRepositoryRoot,
} from "../../src/utils/workspace-digest";

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

const roots: string[] = [];

function fixtureRoot(): CanonicalRepositoryRoot {
  const root = canonicalTempDir("loom-completion-runner-");
  roots.push(root);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root });
  if (initialized.status !== 0) throw new Error("runner fixture Git init failed");
  writeFileSync(join(root, ".gitignore"), ".loom/completion-reports/\n");
  cpSync(new URL("../fixtures/completion-process.mjs", import.meta.url), join(root, "completion-process.mjs"));
  const parsed = parseCanonicalRepositoryRoot(root);
  if (!parsed.ok) throw new Error("message" in parsed.error ? parsed.error.message : "root observation drifted");
  return parsed.value;
}

function check(
  mode: string,
  overrides: Partial<{
    executable: string;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
    reportPath: string | null;
  }> = {},
): ProjectCommandCheck {
  const reportPath = overrides.reportPath === undefined ? null : overrides.reportPath;
  const parsed = parseAuthorizedWaveCompletionCheck({
    kind: "project-command",
    checkId: `project:${mode.replace(/[^a-z0-9-]/g, "-")}`,
    scope: "wave",
    executable: overrides.executable ?? "node",
    args: overrides.args ?? ["completion-process.mjs", mode, ...(reportPath === null ? [] : [reportPath])],
    cwd: overrides.cwd ?? ".",
    timeoutMs: overrides.timeoutMs ?? 2_000,
    reportPolicy: reportPath === null
      ? { kind: "not-required" }
      : { kind: "required-file", path: reportPath },
  });
  if (!parsed.ok || parsed.value.kind !== "project-command") throw new Error("invalid runner test check");
  return parsed.value;
}

function execution(result: CompletionCheckRunnerResult) {
  expect(result.ok, result.ok ? "" : `runner refused: ${refusalText(result)}`).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function remediationExecution(result: RemediationCheckRunnerResult) {
  expect(result.ok, result.ok ? "" : `runner refused: ${refusalText(result)}`).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Diagnostic tails can carry up to 64 KiB each; drop them so the refusal
 *  context stays inside assertion-message bounds. */
function refusalText(result: { readonly ok: false; readonly error: unknown }): string {
  const error = result.error as Readonly<Record<string, unknown>>;
  const { diagnostics: _diagnostics, ...rest } = error;
  return JSON.stringify(rest);
}

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (!result.ok) throw new Error(`fixture construction failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

const digest = (character: string): string => character.repeat(64);

function remediationCheck(
  root: CanonicalRepositoryRoot,
  name: string,
  args: readonly string[],
  reportPath = `.loom/completion-reports/${name}.xml`,
  executable = "node",
  timeoutMs = 2_000,
): AuthorizedRemediationCheck {
  const source = standaloneFixture(["src/main.ts"], true).input.standaloneResult;
  const findingId = source.survivingCriticals[0]!.id;
  const accounting = valueOf(prepareDefectFamilyAccounting(source, {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [{ findingId, status: "repaired", repairGroupId: `family:${name}` }],
    groups: [{
      kind: "declared-repair-group",
      provenance: "DECLARED",
      repairGroupId: `family:${name}`,
      findingIds: [findingId],
      rootCause: { provenance: "DECLARED", statement: "The tested behavior regressed." },
      invariant: { provenance: "DECLARED", statement: "The tested behavior remains fixed." },
      siblings: { kind: "none-declared", provenance: "DECLARED", reason: "No siblings declared." },
      checks: [{
        checkId: `project:${name}`,
        historicalRed: {
          kind: "historical-red",
          provenance: "DECLARED",
          statement: "The check distinguishes the historical defect.",
          reference: null,
        },
      }],
    }],
  }));
  const manifest = valueOf(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: VERIFICATION_MANIFEST_KIND,
    checks: [{
      id: `project:${name}`,
      scope: "wave",
      executable,
      args,
      cwd: ".",
      timeoutMs,
      report: { kind: "required-file", path: reportPath },
    }],
  }))));
  const plan = valueOf(prepareDefectFamilyVerification(accounting, manifest));
  if (plan.kind !== "selected-operator-checks") throw new Error("selected remediation plan required");
  const gitWitness = valueOf(parseRepositorySnapshotWitness({
    baseTreeDigest: digest("1"),
    indexDigest: digest("2"),
    worktreeDigest: digest("3"),
  }));
  const candidate = valueOf(createCandidateRepositoryWitness({
    kind: "candidate-repository-witness",
    repositoryRoot: root,
    workspaceDigest: digest("4"),
    pathCount: 1,
    observedPaths: ["src/candidate.ts"],
    gitWitness,
    generatedReportExclusions: [reportPath],
  }));
  const scope = valueOf(createRemediationCheckScope(plan.source, candidate, {
    kind: "standalone-remediation",
    remediationRunId: `run.runner-${name}`,
    sourceRunId: plan.source.sourceRunId,
    registrationDigest: digest("a"),
    candidateWitnessDigest: candidate.digest,
  }));
  return valueOf(authorizeRemediationChecks(plan, scope))[0];
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("completion check process shell", () => {
  it("retains timedOut when SIGTERM is trapped and the process exits zero", async () => {
    const result = execution(await runCompletionCheck(
      check("timeout-exit-zero", { timeoutMs: 200 }),
      fixtureRoot(),
      { terminationGraceMs: 250, hardKillWaitMs: 2_000 },
    ));
    expect(result.checkResult.outcome).toEqual({
      kind: "observed",
      exitCode: 0,
      timedOut: true,
      signal: null,
      report: { kind: "not-required" },
    });
  });

  it("preserves self-signal termination independently from exit code", async () => {
    const result = execution(await runCompletionCheck(check("self-sigterm"), fixtureRoot()));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: null,
      timedOut: false,
      signal: "SIGTERM",
    });
  });

  it("records an exactly-authorized absent report as missing", async () => {
    const result = execution(await runCompletionCheck(
      check("missing-report", { reportPath: ".loom/completion-reports/completion.bin" }),
      fixtureRoot(),
    ));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: 0,
      report: { kind: "missing", path: ".loom/completion-reports/completion.bin" },
    });
  });

  it("produces a fresh report only after reading exact regular-file bytes", async () => {
    const result = execution(await runCompletionCheck(
      check("fresh-report", { reportPath: ".loom/completion-reports/completion.bin" }),
      fixtureRoot(),
    ));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: 0,
      report: {
        kind: "produced",
        path: ".loom/completion-reports/completion.bin",
        byteLength: 4,
      },
    });
    if (result.checkResult.outcome.kind === "observed" && result.checkResult.outcome.report.kind === "produced") {
      expect(result.checkResult.outcome.report.digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("types a post-close report symlink escape as unreadable infrastructure evidence", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, ".loom"));
    const result = execution(await runCompletionCheck(
      check("symlink-report-parent", { reportPath: ".loom/completion-reports/completion.bin" }),
      root,
    ));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: 0,
      report: {
        kind: "unreadable",
        path: ".loom/completion-reports/completion.bin",
      },
    });
  });

  it("treats an unchanged pre-existing report as stale and therefore missing", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, ".loom", "completion-reports", "completion.bin"), "stale");
    const result = execution(await runCompletionCheck(
      check("missing-report", { reportPath: ".loom/completion-reports/completion.bin" }),
      root,
    ));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: 0,
      report: { kind: "missing", path: ".loom/completion-reports/completion.bin" },
    });
  });

  it("returns spawn-failed data for an absent project-local path whose basename is allowlisted", async () => {
    const result = execution(await runCompletionCheck(
      check("missing-executable", { executable: "absent/node" }),
      fixtureRoot(),
    ));
    expect(result.checkResult.outcome).toMatchObject({ kind: "spawn-failed" });
  });

  it("rejects a successful parent whose redirected descendant survives without signalling after leader close", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "parent-exit-sentinel");
    const result = await runCompletionCheck(check("parent-exits-with-descendant", {
      args: ["completion-process.mjs", "parent-exits-with-descendant", "parent-exit-sentinel"],
    }), root, { terminationGraceMs: 250, hardKillWaitMs: 2_000 });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "process-tree-survived", exitCode: 0, signal: null },
    });
    expect(existsSync(sentinel)).toBe(true);
  });

  it("sends no signal after the leader's exit even when a timeout trigger wins the race first", async () => {
    // type-design-analyzer-1: the timeout/cancellation trigger can settle
    // after the spawned leader was already reaped ('exit' precedes 'close'
    // whenever a descendant holds the runner's stdio pipes). In that
    // leader-reaped phase the numeric group id is no longer identity-bound,
    // so the runner sends no signal at all — it classifies and waits exactly
    // like the closed-parent path, and the surviving descendant exits on its
    // own. A regression that escalates in the reaped phase turns this red
    // twice: the recorded signal set is non-empty and the holder is killed
    // before it can write its sentinel.
    const root = fixtureRoot();
    const sentinel = join(root, "holder-survived.txt");
    const signals: (number | NodeJS.Signals)[] = [];
    const actualKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== undefined && signal !== 0) signals.push(signal);
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const result = await runCompletionCheck(check("exit-before-close", {
      args: ["completion-process.mjs", "exit-before-close", "holder-survived.txt", "1500"],
        timeoutMs: 400,
      }), root, { terminationGraceMs: 250, hardKillWaitMs: 4_000 });
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "process-tree-survived",
          exitCode: 0,
          signal: null,
          message: expect.stringContaining("the runner waited for them to exit without signalling an unbound numeric group id"),
        },
      });
    expect(signals).toEqual([]);
    expect(existsSync(sentinel)).toBe(true);
  }, 15_000);

  // pta-4: the leader-reaped arm's remaining classifications. The signal-refusal
  // test above pins the surviving-descendants arm; these four pin the rest of
  // the arm's decision table with the same exit-before-close fixture, so a
  // regression that misclassifies a dissolved tree (fabricating a refusal or,
  // worse, an observed pass over an unconfirmed one) ships undetected without
  // them. All four send no signal: the numeric group id is no longer
  // identity-bound once the leader is reaped.
  it("classifies a late timeout after the group dissolved as an observed run, not a refusal", async () => {
    // Already-gone fast path: the timeout wins after leader exit, the group
    // probe reports provable dissolution, and the runner then waits for parent
    // close before recording the observed run with timedOut: true.
    const root = fixtureRoot();
    const sentinel = join(root, "reaped-observed-survivor.txt");
    const signals: (number | NodeJS.Signals)[] = [];
    const actualKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); // group probe: provably dissolved
      if (signal !== undefined && signal !== 0) signals.push(signal);
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const result = execution(await runCompletionCheck(check("exit-before-close", {
        args: ["completion-process.mjs", "exit-before-close", "reaped-observed-survivor.txt", "2500"],
        timeoutMs: 400,
      }), root, { terminationGraceMs: 250, hardKillWaitMs: 4_000 }));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: 0,
      timedOut: true,
      signal: null,
    });
    expect(signals).toEqual([]);
    expect(existsSync(sentinel)).toBe(true);
  }, 15_000);

  it("classifies a cancellation after the group dissolved as cancelled without signalling", async () => {
    // Cancelled arm: the AbortController aborts while the leader is reaped and
    // the holder descendant still keeps the pipes open; the runner waits for
    // the provable dissolution and the parent close, then reports the
    // infrastructure cancellation — never a signal, never an observed pass.
    const root = fixtureRoot();
    const sentinel = join(root, "reaped-cancelled-survivor.txt");
    const signals: (number | NodeJS.Signals)[] = [];
    const actualKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== undefined && signal !== 0) signals.push(signal);
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const controller = new AbortController();
    const pending = runCompletionCheck(check("exit-before-close", {
        args: ["completion-process.mjs", "exit-before-close", "reaped-cancelled-survivor.txt", "3000"],
        timeoutMs: 10_000,
      }), root, { signal: controller.signal, terminationGraceMs: 250, hardKillWaitMs: 4_000 });
      // The leader exits within milliseconds of spawn; aborting at 500ms
      // lands the cancellation squarely in the leader-reaped phase while the
      // 3000ms holder still withholds close — the margins survive the
      // timer delays a fully loaded suite inflicts on both timers.
      setTimeout(() => controller.abort(), 500);
      expect(await pending).toMatchObject({
        ok: false,
        error: {
          kind: "cancelled",
          exitCode: 0,
          signal: null,
          message: expect.stringContaining("cancelled after its process group dissolved without signalling"),
        },
      });
    expect(signals).toEqual([]);
    expect(existsSync(sentinel)).toBe(true);
  }, 15_000);

  it("refuses a leader-reaped outcome when the group id cannot even be observed", async () => {
    // Unobservable-identity arm: the first group probe fails (EIO — neither
    // ESRCH-gone nor EPERM-eperm), so the reaped-phase trigger cannot even
    // begin to classify and fails closed with the named
    // termination-unconfirmed diagnostic, signalling nothing.
    const signals: (number | NodeJS.Signals)[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) throw Object.assign(new Error("EIO"), { code: "EIO" });
      if (signal !== undefined && signal !== 0) {
        throw new Error(`no signalling may follow an unobservable group: ${String(signal)}`);
      }
      return process.kill(pid, signal);
    }) as typeof process.kill);
    const result = await runCompletionCheck(check("exit-before-close", {
        args: ["completion-process.mjs", "exit-before-close", "reaped-unobservable-survivor.txt", "1500"],
        timeoutMs: 400,
      }), fixtureRoot(), { terminationGraceMs: 250, hardKillWaitMs: 4_000 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "termination-unconfirmed",
        message: expect.stringContaining("timeout completion check ended but process-tree identity could not be observed"),
      },
    });
    expect(signals).toEqual([]);
  }, 15_000);

  it("refuses a leader-reaped outcome when the dissolved group's parent close is unobservable", async () => {
    // Unavailable-parent-close arm: the group is provably gone but the close
    // observation never arrives within the hard-kill wait (the holder still
    // withholds the pipes), so the runner may not count the run as observed
    // and fails closed without signalling the unbound id.
    const signals: (number | NodeJS.Signals)[] = [];
    const actualKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); // group probe: provably dissolved
      if (signal !== undefined && signal !== 0) signals.push(signal);
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const result = await runCompletionCheck(check("exit-before-close", {
        // The 8000ms holder keeps the pipes closed-proving write end far past
        // the 400ms hard-kill race even if a fully loaded suite delays the
        // runner's own 400ms timeout trigger by seconds.
        args: ["completion-process.mjs", "exit-before-close", "reaped-uncloseable-survivor.txt", "8000"],
        timeoutMs: 400,
      }), fixtureRoot(), { terminationGraceMs: 250, hardKillWaitMs: 400 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "termination-unconfirmed",
        message: expect.stringContaining("timeout process group is gone but the parent close observation is unavailable"),
      },
    });
    expect(signals).toEqual([]);
  }, 15_000);

  it("does not signal a same-UID group whose leader PID appeared only after parent close", async () => {
    const signals: (number | NodeJS.Signals)[] = [];
    vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true;
      if (signal !== undefined) signals.push(signal);
      throw new Error("a recycled group must not be signalled");
    }) as typeof process.kill);
    const result = execution(await runCompletionCheck(check("missing-report"), fixtureRoot()));
    expect(result.checkResult.outcome).toMatchObject({ kind: "observed", exitCode: 0, timedOut: false });
    expect(signals).toEqual([]);
  });

  it("kills timeout descendants before they can mutate the workspace", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "timeout-sentinel");
    const result = execution(await runCompletionCheck(check("timeout-with-descendant", {
      args: ["completion-process.mjs", "timeout-with-descendant", "timeout-sentinel"],
      timeoutMs: 100,
    }), root, { terminationGraceMs: 250, hardKillWaitMs: 2_000 }));

    expect(result.checkResult.outcome).toMatchObject({ kind: "observed", timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(existsSync(sentinel)).toBe(false);
  });

  it("escalates an ignored SIGTERM to SIGKILL while retaining timeout", async () => {
    const result = execution(await runCompletionCheck(
      check("ignore-sigterm", { timeoutMs: 200 }),
      fixtureRoot(),
      { terminationGraceMs: 250, hardKillWaitMs: 2_000 },
    ));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: null,
      timedOut: true,
      signal: "SIGKILL",
    });
  });

  it("refuses the timeout outcome when even SIGKILL leaves an EPERM group unprovable, without a third signal", async () => {
    // Post-SIGKILL EPERM arm (pr-test-analyzer-2): the group survived SIGTERM
    // (present through the whole grace window), SIGKILL was dispatched, and
    // the post-SIGKILL probe answers EPERM — a member refuses signalling,
    // which is still not a dissolution proof. The runner refuses with the
    // stage-named message and never sends a third signal.
    const actualKill = process.kill.bind(process);
    const signals: (number | NodeJS.Signals)[] = [];
    let killDispatched = false;
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) {
        if (killDispatched) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return true; // group survives every pre-SIGKILL probe
      }
      if (signal !== undefined) signals.push(signal);
      if (signal === "SIGKILL") killDispatched = true;
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const result = await runCompletionCheck(
        check("ignore-sigterm", { timeoutMs: 200 }),
        fixtureRoot(),
        { terminationGraceMs: 250, hardKillWaitMs: 2_000 },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "termination-unconfirmed",
          message: expect.stringContaining("dissolution could not be confirmed after SIGKILL (EPERM)"),
        },
      });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }, 15_000);

  it("refuses the timeout outcome when the group still exists after SIGKILL containment", async () => {
    // Post-SIGKILL present arm: the group survives even the SIGKILL dispatch
    // as far as every probe can tell, so containment is unprovable and the
    // refusal names the exact stage; no third signal follows.
    const actualKill = process.kill.bind(process);
    const signals: (number | NodeJS.Signals)[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) return true; // group survives every probe
      if (signal !== undefined) signals.push(signal);
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const result = await runCompletionCheck(
        check("ignore-sigterm", { timeoutMs: 200 }),
        fixtureRoot(),
        { terminationGraceMs: 250, hardKillWaitMs: 2_000 },
      );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "termination-unconfirmed",
        message: expect.stringContaining("still exists after SIGKILL containment"),
      },
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }, 15_000);

  it("refuses the timeout outcome when leader death plus EPERM cannot prove the group dissolved, without signalling", async () => {
    // The pre-round-5 design read EPERM-with-dead-leader as "the original group
    // dissolved and the numeric id now names foreign authority" and claimed a
    // contained run on that basis. That evidence cannot distinguish a recycled
    // foreign id from uid-changed survivors (setuid execution inside a project
    // command), so EPERM no longer confirms dissolution anywhere: the runner
    // refuses the timeout outcome fail-closed, and it STILL refuses to signal
    // an id that may no longer name this check's group.
    const actualKill = process.kill.bind(process);
    const signals: (number | NodeJS.Signals)[] = [];
    const probeError = (code: "EPERM" | "ESRCH"): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== undefined) signals.push(signal);
      if (signal === "SIGTERM") return actualKill(pid, signal);
      if (signal === 0 && pid < 0) throw probeError("EPERM");
      if (signal === 0 && pid > 0) throw probeError("ESRCH");
      if (signal === "SIGKILL") throw new Error("unconfirmable process group must not be signalled");
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const result = await runCompletionCheck(
        check("timeout-exit-zero", { timeoutMs: 200 }),
        fixtureRoot(),
        { terminationGraceMs: 250, hardKillWaitMs: 2_000 },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "termination-unconfirmed",
          message: expect.stringContaining("could not be confirmed after SIGTERM (EPERM)"),
        },
      });
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
  });

  it("escalates to SIGKILL when the EPERM group probe still finds the leader alive", async () => {
    // code-reviewer-1: the post-SIGTERM EPERM arm now CORRELATES the leader
    // probe. While the leader exists (even as an unreaped zombie) the numeric
    // group id is provably ours by the module's own invariant, so containment
    // escalates exactly like a plainly surviving group. The unconditional
    // refusal stays reserved for the ambiguous leader-reaped state pinned by
    // the neighbouring test.
    const actualKill = process.kill.bind(process);
    const signals: (number | NodeJS.Signals)[] = [];
    let killDispatched = false;
    const probeError = (code: "EPERM" | "ESRCH"): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (killDispatched) throw probeError("ESRCH"); // post-SIGKILL: group provably gone
        if (pid < 0) throw probeError("EPERM"); // group probe: an unsignalable member
        return actualKill(pid, 0); // leader probe: leader still alive
      }
      if (signal !== undefined) signals.push(signal);
      if (signal === "SIGTERM") return actualKill(pid, signal); // trapped by the child
      if (signal === "SIGKILL") {
        const sent = actualKill(pid, signal);
        killDispatched = true;
        return sent;
      }
      return actualKill(pid, signal);
    }) as typeof process.kill);
    const result = execution(await runCompletionCheck(
        check("ignore-sigterm", { timeoutMs: 200 }),
        fixtureRoot(),
        { terminationGraceMs: 250, hardKillWaitMs: 2_000 },
      ));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: null,
      timedOut: true,
      signal: "SIGKILL",
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  }, 15_000);

  it("reports a closed group whose EPERM probe cannot prove dissolution as termination-unconfirmed without signalling", async () => {
    // Parent-close unconfirmed arm: the parent closed normally, the group
    // probe answers EPERM (at least one member is unsignalable — or the id is
    // foreign), and the leader probe proves the leader reaped. That pair is
    // not a dissolution proof, so the outcome is the named unconfirmed
    // refusal, the wait expires fail-closed, and no signal ever follows an id
    // that may not be ours.
    const signals: (number | NodeJS.Signals)[] = [];
    const probeError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) throw probeError("EPERM"); // group probe: unsignalable member (or foreign id)
      if (signal === 0) throw probeError("ESRCH"); // leader probe: leader reaped
      if (signal !== undefined) signals.push(signal);
      throw new Error(`post-close signalling must be refused: ${String(signal)}`);
    }) as typeof process.kill);
    const result = await runCompletionCheck(
        check("missing-report"),
        fixtureRoot(),
        { hardKillWaitMs: 60 },
      );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "termination-unconfirmed",
        message: expect.stringContaining("dissolution could not be confirmed (EPERM)"),
      },
    });
    expect(signals).toEqual([]);
  });

  /**
   * The parent-close refusal arms that returned diagnostics without any
   * test: the runner may neither accept a parent exit it could not
   * corroborate, nor signal a numeric group id that is no longer
   * identity-bound. All three arms fail closed with the SAME named class,
   * so a regression swapping or dropping the diagnostic kind ships undetected
   * without these pins.
   */
  it("reports an unobservable closed process group as termination-unconfirmed without signalling", async () => {
    // Initial probe error arm (observeClosedProcessGroup error): the parent
    // closed but the group id cannot even be observed (EIO here — neither
    // ESRCH-gone nor EPERM-eperm), so the exit may not count as a successful
    // observation and no signalling may follow an unbound id.
    const probeError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    const signals: (number | NodeJS.Signals)[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) throw probeError("EIO");
      if (signal === 0) return true;
      if (signal !== undefined) signals.push(signal);
      throw new Error(`no descendant signalling may follow an unobservable group: ${String(signal)}`);
    }) as typeof process.kill);
    const result = await runCompletionCheck(check("missing-report"), fixtureRoot());
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "termination-unconfirmed",
        message: expect.stringContaining("process-tree identity could not be observed"),
      },
    });
    expect(signals).toEqual([]);
  });

  it("reports descendants that outlive the post-close wait as termination-unconfirmed without signalling", async () => {
    // Surviving-descendants expiry arm (waitForClosedProcessGroup deadline):
    // the parent closed while the group still had members and they never
    // exited within the hard-kill wait. Post-close signalling is refused
    // because the numeric group id is no longer identity-bound; the outcome
    // is the named termination-unconfirmed class, not a fabricated pass.
    const signals: (number | NodeJS.Signals)[] = [];
    const probeError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) return true; // group probe: still present
      if (signal === 0) throw probeError("ESRCH"); // leader probe: leader gone
      if (signal !== undefined) signals.push(signal);
      throw new Error(`post-close signalling must be refused: ${String(signal)}`);
    }) as typeof process.kill);
    const result = await runCompletionCheck(
        check("missing-report"),
        fixtureRoot(),
        { terminationGraceMs: 250, hardKillWaitMs: 60 },
      );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "termination-unconfirmed",
        message: expect.stringContaining("post-close signalling was refused"),
      },
    });
    expect(signals).toEqual([]);
  });

  it("reports a process-group probe that fails during the post-close wait as termination-unconfirmed", async () => {
    // Settled-wait error arm: the first observation sees surviving
    // descendants, then a later probe fails (EIO) before the deadline. The
    // runner cannot prove the tree emptied, so it fails closed with the same
    // named diagnostic class instead of guessing either polarity.
    let groupProbes = 0;
    const probeError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0 && pid < 0) {
        groupProbes += 1;
        if (groupProbes > 1) throw probeError("EIO");
        return true;
      }
      if (signal === 0) throw probeError("ESRCH");
      throw new Error(`no signalling may follow an unobservable wait: ${String(signal)}`);
    }) as typeof process.kill);
    const result = await runCompletionCheck(check("missing-report"), fixtureRoot());
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "termination-unconfirmed",
        message: expect.stringContaining("process-tree identity could not be observed"),
      },
    });
  });

  it("keeps bounded diagnostic tails", async () => {
    const result = execution(await runCompletionCheck(
      check("diagnostic-tail"),
      fixtureRoot(),
      { diagnosticTailBytes: 64 },
    ));
    expect(Buffer.byteLength(result.diagnostics.stdoutTail)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(result.diagnostics.stderrTail)).toBeLessThanOrEqual(64);
    expect(result.diagnostics).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
    expect(result.diagnostics.stdoutTail).toContain("STDOUT-END");
    expect(result.diagnostics.stderrTail).toContain("STDERR-END");
  });

  it("returns AbortSignal cancellation as infrastructure rather than semantic timeout", async () => {
    const controller = new AbortController();
    const root = fixtureRoot();
    const pending = runCompletionCheck(
      check("ignore-sigterm", { timeoutMs: 5_000 }),
      root,
      { signal: controller.signal, terminationGraceMs: 250, hardKillWaitMs: 2_000 },
    );
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result, result.ok ? "" : `runner refused: ${refusalText(result)}`).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  });

  it("rejects symlink ancestors for cwd and report paths", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "real"));
    symlinkSync("real", join(root, "linked"));

    const cwdResult = await runCompletionCheck(check("missing-report", { cwd: "linked" }), root);
    expect(cwdResult).toMatchObject({ ok: false, error: { kind: "path-rejected", path: "linked" } });

    const reportResult = await runCompletionCheck(
      check("missing-report", { reportPath: "linked/report.bin" }),
      root,
    );
    expect(reportResult).toMatchObject({
      ok: false,
      error: { kind: "path-rejected", path: "linked/report.bin" },
    });
  });
});

describe("standalone remediation check process/report seam", () => {
  function nodeTestArgs(reportPath: string, testPath: string): readonly string[] {
    return [
      "--test",
      "--test-reporter=junit",
      `--test-reporter-destination=${reportPath}`,
      testPath,
    ];
  }

  async function runNodeTest(name: string, testSource: string) {
    const root = fixtureRoot();
    const reportPath = `.loom/completion-reports/${name}.xml`;
    const testPath = `${name}.test.mjs`;
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, testPath), testSource);
    const authorized = remediationCheck(root, name, nodeTestArgs(reportPath, testPath), reportPath);
    return remediationExecution(await runRemediationCheck(authorized, root));
  }

  it("returns proper remediation scope and exact owned bytes from a passing actual Node JUnit run", async () => {
    const result = await runNodeTest(
      "node-pass",
      'import test from "node:test"; import assert from "node:assert"; test("passes", () => assert.equal(1, 1));',
    );

    expect(result.scope.kind).toBe("standalone-remediation");
    expect(result.process).toEqual({ kind: "observed", exitCode: 0, timedOut: false, signal: null });
    expect(result).not.toHaveProperty("passed");
    expect(result.report).toMatchObject({
      outcome: { kind: "produced", path: ".loom/completion-reports/node-pass.xml" },
      parsedReportFacts: { ok: true, value: { total: 1, failed: 0, source: "junit-xml" } },
    });
    if (result.report !== null && "bytes" in result.report) {
      expect(Buffer.isBuffer(result.report.bytes)).toBe(false);
      expect(result.report.bytes.byteLength).toBe(result.report.outcome.byteLength);
      expect(result.report.mode & 0o777).toBe(0o644);
      expect(new TextDecoder().decode(result.report.bytes)).toContain("<testsuites>");
    }
  });

  it("retains failing and all-skipped actual Node JUnit facts without calling either a pass", async () => {
    const failing = await runNodeTest(
      "node-fail",
      'import test from "node:test"; import assert from "node:assert"; test("fails", () => assert.equal(1, 2));',
    );
    expect(failing.process).toMatchObject({ kind: "observed", exitCode: 1 });
    expect(failing.report).toMatchObject({
      parsedReportFacts: { ok: true, value: { total: 1, failed: 1, source: "junit-xml" } },
    });

    const skipped = await runNodeTest(
      "node-all-skip",
      'import test from "node:test"; test("skipped", { skip: true }, () => {});',
    );
    expect(skipped.process).toMatchObject({ kind: "observed", exitCode: 0 });
    expect(skipped.report).toMatchObject({
      parsedReportFacts: { ok: true, value: { total: 0, failed: 0, source: "junit-xml" } },
    });
  });

  it("returns zero and malformed structured report facts without upgrading produced metadata to pass", async () => {
    const root = fixtureRoot();
    const script = "write-report.mjs";
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, script), `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], process.argv[3]);
    `);

    const zeroPath = ".loom/completion-reports/zero.json";
    const zero = remediationExecution(await runRemediationCheck(remediationCheck(
      root,
      "zero",
      [script, zeroPath, JSON.stringify({
        numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      })],
      zeroPath,
    ), root));
    expect(zero.report).toMatchObject({
      outcome: { kind: "produced" },
      parsedReportFacts: { ok: true, value: { total: 0, failed: 0 } },
    });

    const malformedPath = ".loom/completion-reports/malformed.json";
    const malformed = remediationExecution(await runRemediationCheck(remediationCheck(
      root,
      "malformed",
      [script, malformedPath, JSON.stringify({
        numTotalTests: 1, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      })],
      malformedPath,
    ), root));
    expect(malformed.report).toMatchObject({
      outcome: { kind: "produced" },
      parsedReportFacts: { ok: false, error: { reason: "malformed-counts" } },
    });
  });

  it("rejects touching seeded green bytes but accepts identical freshly rewritten bytes", async () => {
    const root = fixtureRoot();
    const reportPath = ".loom/completion-reports/touch.xml";
    const green = '<testsuite tests="1" failures="0"/>';
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, "touch-report.mjs"), `
      import { closeSync, openSync, utimesSync, writeFileSync } from "node:fs";
      const [mode, path, green] = process.argv.slice(2);
      if (mode === "touch") {
        closeSync(openSync(path, "a"));
        utimesSync(path, new Date(), new Date());
      } else writeFileSync(path, green);
    `);
    writeFileSync(join(root, reportPath), green);
    expect(spawnSync("git", ["add", ".gitignore"], { cwd: root }).status).toBe(0);
    const indexBefore = readFileSync(join(root, ".git", "index"));
    const touched = remediationExecution(await runRemediationCheck(remediationCheck(
      root, "touch", ["touch-report.mjs", "touch", reportPath, green], reportPath,
    ), root));
    expect(touched.process).toMatchObject({ kind: "observed", exitCode: 0 });
    expect(touched.report).toMatchObject({ outcome: { kind: "produced", byteLength: 0 }, parsedReportFacts: { ok: false } });
    expect(readFileSync(join(root, ".git", "index"))).toEqual(indexBefore);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      writeFileSync(join(root, reportPath), green);
      const rewritten = remediationExecution(await runRemediationCheck(remediationCheck(
        root, "rewrite", ["touch-report.mjs", "rewrite", reportPath, green], reportPath,
      ), root));
      expect(rewritten.report).toMatchObject({ parsedReportFacts: { ok: true, value: { total: 1, failed: 0 } } });
      expect(readFileSync(join(root, ".git", "index"))).toEqual(indexBefore);
    }
  });

  it("records reset failure without launching or touching tracked, foreign, or inaccessible paths", async () => {
    for (const mode of ["tracked", "not-ignored", "directory", "symlink", "parent-symlink", "permission"] as const) {
      const root = fixtureRoot();
      const parent = join(root, ".loom", "completion-reports");
      const reportPath = ".loom/completion-reports/refused.xml";
      const report = join(root, reportPath);
      mkdirSync(parent, { recursive: true });
      writeFileSync(join(root, "must-not-launch.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("launched", "bad");');
      writeFileSync(join(root, "foreign"), "foreign sentinel");
      if (mode === "directory") mkdirSync(report);
      else if (mode === "symlink") symlinkSync(join(root, "foreign"), report);
      else writeFileSync(report, "stale");
      if (mode === "parent-symlink") {
        rmSync(parent, { recursive: true });
        symlinkSync(root, parent);
      }
      if (mode === "not-ignored") writeFileSync(join(root, ".gitignore"), "");
      const staged = spawnSync("git", ["add", ".gitignore"], { cwd: root });
      expect(staged.status).toBe(0);
      if (mode === "tracked") expect(spawnSync("git", ["add", "-f", reportPath], { cwd: root }).status).toBe(0);
      const index = readFileSync(join(root, ".git", "index"));
      if (mode === "permission") {
        expect(process.getuid?.()).not.toBe(0);
        chmodSync(parent, 0o500);
      }
      try {
        const result = await runRemediationCheck(remediationCheck(root, "refused", ["must-not-launch.mjs"], reportPath), root);
        expect(result, mode).toMatchObject({ ok: false, error: { kind: "report-reset-failed", message: expect.stringContaining("before launch") } });
        expect(existsSync(join(root, "launched"))).toBe(false);
        expect(readFileSync(join(root, "foreign"), "utf8")).toBe("foreign sentinel");
        expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
        if (mode === "tracked" || mode === "permission") expect(readFileSync(report, "utf8")).toBe("stale");
      } finally { if (mode === "permission") chmodSync(parent, 0o700); }
    }
  });

  it("refuses post-reset parent rename/symlink substitution without reading its foreign target", async () => {
    const root = fixtureRoot();
    const reportPath = ".loom/completion-reports/rebound.xml";
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    mkdirSync(join(root, "foreign"));
    const foreign = join(root, "foreign", "rebound.xml");
    const green = '<testsuite tests="1" failures="0"/>';
    writeFileSync(foreign, green);
    writeFileSync(join(root, reportPath), green);
    writeFileSync(join(root, "rebind.mjs"), `
      import { renameSync, symlinkSync } from "node:fs";
      renameSync(".loom/completion-reports", ".loom/moved-reports");
      symlinkSync("../foreign", ".loom/completion-reports");
    `);
    expect(spawnSync("git", ["add", ".gitignore"], { cwd: root }).status).toBe(0);
    const indexBefore = readFileSync(join(root, ".git", "index"));
    const result = remediationExecution(await runRemediationCheck(remediationCheck(root, "rebound", ["rebind.mjs"], reportPath), root));
    expect(result.process).toMatchObject({ kind: "observed", exitCode: 0 });
    expect(result.report).toMatchObject({ outcome: { kind: "unreadable" } });
    expect(readFileSync(foreign, "utf8")).toBe(green);
    expect(readFileSync(join(root, ".git", "index"))).toEqual(indexBefore);
  });

  it("refuses limit+1 report bytes while accepting exactly the byte limit", async () => {
    const root = fixtureRoot();
    const reportPath = ".loom/completion-reports/bounded.xml";
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, "bounded-report.mjs"), `
      import { writeFileSync } from "node:fs";
      const xml = '<testsuite tests="1" failures="0"/>';
      writeFileSync(process.argv[2], xml.padEnd(Number(process.argv[3]), " "));
    `);
    for (const extra of [0, 1]) {
      const result = remediationExecution(await runRemediationCheck(remediationCheck(
        root, "bounded", ["bounded-report.mjs", reportPath, String(8 * 1024 * 1024 + extra)], reportPath,
      ), root));
      expect(result.report).toMatchObject(extra === 0
        ? { outcome: { kind: "produced", byteLength: 8 * 1024 * 1024 }, parsedReportFacts: { ok: true } }
        : { outcome: { kind: "unreadable", message: expect.stringContaining("limit") } });
    }
  });

  it("marks a pre-existing unchanged report stale", async () => {
    const root = fixtureRoot();
    const reportPath = ".loom/completion-reports/stale.json";
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, reportPath), JSON.stringify({
      numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
    }));
    writeFileSync(join(root, "no-report.mjs"), "// intentionally leaves the stale report untouched\n");
    const result = remediationExecution(await runRemediationCheck(remediationCheck(
      root, "stale", ["no-report.mjs"], reportPath,
    ), root));
    expect(result.report).toEqual({ outcome: { kind: "missing", path: reportPath } });
  });

  it("retains non-zero exit, timeout, signal, and spawn-failure independently of green report bytes", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, "raw-outcome.mjs"), `
      import { writeFileSync } from "node:fs";
      const [mode, report] = process.argv.slice(2);
      if (report) writeFileSync(report, JSON.stringify({
        numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      }));
      if (mode === "nonzero") process.exitCode = 7;
      if (mode === "signal") process.kill(process.pid, "SIGTERM");
      if (mode === "timeout") setInterval(() => {}, 1000);
    `);

    for (const [name, expected] of [
      ["nonzero", { exitCode: 7, timedOut: false, signal: null }],
      ["signal", { exitCode: null, timedOut: false, signal: "SIGTERM" }],
      ["timeout", { exitCode: null, timedOut: true, signal: "SIGTERM" }],
    ] as const) {
      const reportPath = `.loom/completion-reports/${name}.json`;
      const authorized = remediationCheck(
        root, name, ["raw-outcome.mjs", name, reportPath], reportPath, "node", name === "timeout" ? 100 : 2_000,
      );
      const result = remediationExecution(await runRemediationCheck(
        authorized,
        root,
        { terminationGraceMs: 250, hardKillWaitMs: 2_000 },
      ));
      expect(result.process).toEqual({ kind: "observed", ...expected });
      expect(result.report).toMatchObject({
        outcome: { kind: "produced" },
        parsedReportFacts: { ok: true, value: { total: 1, failed: 0 } },
      });
    }

    const spawned = remediationExecution(await runRemediationCheck(remediationCheck(
      root,
      "spawn-failed",
      ["--test", "missing.test.mjs"],
      ".loom/completion-reports/spawn-failed.xml",
      "absent/node",
    ), root));
    expect(spawned.process).toMatchObject({ kind: "spawn-failed" });
    expect(spawned.report).toBeNull();
  });

  it("rejects an oversized report while another process keeps appending to it", async () => {
    const root = fixtureRoot();
    const reportPath = ".loom/completion-reports/drifting.json";
    mkdirSync(join(root, ".loom", "completion-reports"), { recursive: true });
    writeFileSync(join(root, "large-report.mjs"), `
      import { writeFileSync } from "node:fs";
      const report = JSON.stringify({
        numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
        padding: "x".repeat(64 * 1024 * 1024),
      });
      writeFileSync(process.argv[2], report);
    `);
    writeFileSync(join(root, "mutate-report.mjs"), `
      import { appendFileSync, existsSync } from "node:fs";
      const path = process.argv[2];
      const mutate = () => {
        if (existsSync(path)) appendFileSync(path, " ");
        setImmediate(mutate);
      };
      mutate();
    `);
    const mutator = spawn("node", ["mutate-report.mjs", reportPath], {
      cwd: root,
      stdio: "ignore",
    });
    try {
      const result = remediationExecution(await runRemediationCheck(remediationCheck(
        root, "drifting", ["large-report.mjs", reportPath], reportPath, "node", 10_000,
      ), root));
      expect(result.process).toMatchObject({ kind: "observed", exitCode: 0 });
      expect(result.report).toMatchObject({
        outcome: { kind: "unreadable", path: reportPath },
      });
    } finally {
      mutator.kill("SIGTERM");
      await new Promise<void>((resolve) => mutator.once("close", () => resolve()));
    }
  }, 15_000);

  it("cancels through AbortSignal only after terminating the process group", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "cancel.mjs"), "setInterval(() => {}, 1000);\n");
    const controller = new AbortController();
    const pending = runRemediationCheck(remediationCheck(
      root, "cancel", ["cancel.mjs"], ".loom/completion-reports/cancel.json", "node", 5_000,
    ), root, { signal: controller.signal, terminationGraceMs: 250, hardKillWaitMs: 2_000 });
    setTimeout(() => controller.abort(), 30);
    expect(await pending).toMatchObject({ ok: false, error: { kind: "cancelled" } });
  });
});
