import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseAuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionCheck,
} from "../../src/core/completion-suite";
import {
  runCompletionCheck,
  type CompletionCheckRunnerResult,
} from "../../src/orchestration/completion-check-runner";
import {
  parseCanonicalRepositoryRoot,
  type CanonicalRepositoryRoot,
} from "../../src/utils/workspace-digest";

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

const roots: string[] = [];

function fixtureRoot(): CanonicalRepositoryRoot {
  const root = canonicalTempDir("loom-completion-runner-");
  roots.push(root);
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
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("completion check process shell", () => {
  it("retains timedOut when SIGTERM is trapped and the process exits zero", async () => {
    const result = execution(await runCompletionCheck(
      check("timeout-exit-zero", { timeoutMs: 200 }),
      fixtureRoot(),
      { terminationGraceMs: 250 },
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

  it("rejects a successful parent whose redirected descendant survives and kills the whole group", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "parent-exit-sentinel");
    const result = await runCompletionCheck(check("parent-exits-with-descendant", {
      args: ["completion-process.mjs", "parent-exits-with-descendant", "parent-exit-sentinel"],
    }), root, { terminationGraceMs: 100, hardKillWaitMs: 500 });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "process-tree-survived", exitCode: 0, signal: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(existsSync(sentinel)).toBe(false);
  });

  it("kills timeout descendants before they can mutate the workspace", async () => {
    const root = fixtureRoot();
    const sentinel = join(root, "timeout-sentinel");
    const result = execution(await runCompletionCheck(check("timeout-with-descendant", {
      args: ["completion-process.mjs", "timeout-with-descendant", "timeout-sentinel"],
      timeoutMs: 100,
    }), root, { terminationGraceMs: 100, hardKillWaitMs: 500 }));

    expect(result.checkResult.outcome).toMatchObject({ kind: "observed", timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(existsSync(sentinel)).toBe(false);
  });

  it("escalates an ignored SIGTERM to SIGKILL while retaining timeout", async () => {
    const result = execution(await runCompletionCheck(
      check("ignore-sigterm", { timeoutMs: 200 }),
      fixtureRoot(),
      { terminationGraceMs: 80, hardKillWaitMs: 500 },
    ));
    expect(result.checkResult.outcome).toMatchObject({
      kind: "observed",
      exitCode: null,
      timedOut: true,
      signal: "SIGKILL",
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
      { signal: controller.signal, terminationGraceMs: 30 },
    );
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
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
