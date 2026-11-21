/**
 * store-spec-check helper — end-to-end through the real CLI in a tmp git repo
 * (same pattern as store-test-evidence.test.ts). Covers the stdin-marker
 * happy path (verdict parsed into the closed SpecCheckVerdict union and stored)
 * and the required-marker error paths — the helper's only stdin surface, which
 * had no direct test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import type { TaskGraph } from "../../../src/types";
import { capturedSpecCheck } from "../../../src/core/spec-check";
import { preI6DefaultVerificationManifest } from "../../../src/core/verification-manifest";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

/**
 * Every loadable execute-phase TaskGraph carries a verification_manifest
 * (ADR-0098), so a manual write is an attributable operator override.
 */
const MANUAL_OVERRIDE = "SPEC_CHECK_OVERRIDE: operator re-ran the spec-check by hand";

describe("store-spec-check helper", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `loom-ssc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    // macOS tmpdir() sits behind the system /var → /private/var symlink; the
    // anchored primitives resolve the base once, so the fixture root must be
    // canonical too.
    tmpDir = realpathSync.native(tmpDir);
    const stateDir = join(tmpDir, ".claude", "state");
    mkdirSync(stateDir, { recursive: true });
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    statePath = join(stateDir, "active_task_graph.json");
    const graph: TaskGraph = {
      current_phase: "execute",
      verification_manifest: preI6DefaultVerificationManifest(),
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      tasks: [],
      wave_gates: {},
      current_wave: 1,
    };
    writeFileSync(statePath, JSON.stringify(graph, null, 2));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHelper(stdin: string): { exitCode: number; stderr: string } {
    const result = spawnSync("bun", [CLI_PATH, "helper", "store-spec-check"], {
      cwd: tmpDir,
      encoding: "utf-8",
      input: stdin,
      env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    return { exitCode: result.status ?? -1, stderr: result.stderr ?? "" };
  }

  function readState(): TaskGraph {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  }

  it("stores a parsed verdict + counts + findings from stdin markers", () => {
    const { exitCode } = runHelper(
      [
        "SPEC_CHECK_WAVE: 1",
        MANUAL_OVERRIDE,
        "CRITICAL: requirement REQ-1 not implemented",
        "HIGH: partial coverage of REQ-2",
        "HIGH: missing error path for REQ-3",
        "SPEC_CHECK_CRITICAL_COUNT: 1",
        "SPEC_CHECK_HIGH_COUNT: 2",
        "SPEC_CHECK_VERDICT: BLOCKED",
      ].join("\n"),
    );
    expect(exitCode).toBe(0);
    const spec = readState().spec_check;
    expect(spec).toBeDefined();
    expect(spec!.verdict).toBe("BLOCKED");
    expect(spec!.critical_count).toBe(1);
    expect(spec!.high_count).toBe(2);
    expect(spec!.critical_findings).toEqual(["requirement REQ-1 not implemented"]);
  });

  it("replaces a prior critical spec-check and clears its derived Wave block", () => {
    const blocked: TaskGraph = {
      ...readState(),
      spec_check: capturedSpecCheck({
        wave: 1, runAt: "earlier", criticalFindings: ["earlier blocker"],
      }),
      wave_gates: {
        "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: true },
      },
    };
    writeFileSync(statePath, JSON.stringify(blocked, null, 2));

    const { exitCode } = runHelper([
      "SPEC_CHECK_WAVE: 1",
      MANUAL_OVERRIDE,
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));

    expect(exitCode).toBe(0);
    expect(readState().spec_check?.verdict).toBe("PASSED");
    expect(readState().wave_gates["1"]?.blocked).toBe(false);
  });

  it("fails closed when CRITICAL_COUNT disagrees with the CRITICAL: lines (forged-zero shape)", () => {
    const { exitCode, stderr } = runHelper(
      [
        "SPEC_CHECK_WAVE: 1",
        MANUAL_OVERRIDE,
        "CRITICAL: requirement REQ-1 not implemented",
        "SPEC_CHECK_CRITICAL_COUNT: 0",
        "SPEC_CHECK_HIGH_COUNT: 0",
        "SPEC_CHECK_VERDICT: PASSED",
      ].join("\n"),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("counts must match the findings");
    expect(readState().spec_check).toBeUndefined();
  });

  it("fails closed when HIGH_COUNT disagrees with the HIGH: lines", () => {
    const { exitCode, stderr } = runHelper(
      [
        "SPEC_CHECK_WAVE: 1",
        MANUAL_OVERRIDE,
        "HIGH: partial coverage of REQ-2",
        "SPEC_CHECK_CRITICAL_COUNT: 0",
        "SPEC_CHECK_HIGH_COUNT: 3",
        "SPEC_CHECK_VERDICT: PASSED",
      ].join("\n"),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("counts must match the findings");
    expect(readState().spec_check).toBeUndefined();
  });

  it("refuses a manual write on a modern graph unless it is an attributable override", () => {
    writeFileSync(statePath, JSON.stringify({ ...readState(), spec_trace_version: 2 }, null, 2));

    const { exitCode, stderr } = runHelper([
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("which must be attributable");
    expect(readState().spec_check).toBeUndefined();
  });

  it("accepts a named operator override on a modern graph and says so", () => {
    writeFileSync(statePath, JSON.stringify({ ...readState(), spec_trace_version: 2 }, null, 2));

    const { exitCode, stderr } = runHelper([
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_OVERRIDE: FRs 12-14 are covered in wave 3",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));

    expect(exitCode).toBe(0);
    expect(stderr).toContain("manual operator override: FRs 12-14 are covered in wave 3");
    expect(readState().spec_check).toMatchObject({
      verdict: "PASSED",
      evidence_source: {
        kind: "manual-override",
        reason: "FRs 12-14 are covered in wave 3",
      },
    });
  });

  it("pins the floor argument: the operator override imposes no floor even when a projection would settle rows", () => {
    // The helper's manual settlement path carries separately authorized,
    // attributable `manualOverrideFloor` authority: the operator supplies the
    // transcript on stdin, there is no packet, and the override exists to
    // correct a structural verdict a human judged wrong. A regression
    // to `settledFloorOf(coverageTasks(graph, wave))` would re-project the live
    // graph's count and refuse this honest 0-CRITICAL override against a
    // number the operator was never shown. This fixture has a canonical spec
    // file whose projection settles rows, so only explicit manual authority
    // admits the write.
    const specPath = join(tmpDir, "spec.md");
    writeFileSync(specPath, [
      "# Feature: Override floor pin",
      "",
      "## User Scenarios",
      "",
      "### US1: [P1] Pin the operator override floor",
      "",
      "**Acceptance Scenarios:**",
      "- AS-001: Given a settled row, When the operator overrides, Then no floor is imposed",
      "",
      "## Functional Requirements",
      "",
      "- FR-001: System MUST floor the reported CRITICAL count at the settled count",
      "",
      "## Out of Scope",
      "",
      "- OOS-001: Symbol-level source indexing",
      "",
      "## Appendix: Glossary",
      "",
      "| Term | Definition |",
      "|------|------------|",
      "| Spec Index | A deterministic projection of specification entries |",
    ].join("\n"));
    writeFileSync(statePath, JSON.stringify({
      ...readState(),
      spec_trace_version: 2,
      spec_file: specPath,
    }, null, 2));

    const { exitCode, stderr } = runHelper([
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_OVERRIDE: the structural verdict is wrong, human-judged",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n"));

    expect(exitCode).toBe(0);
    expect(stderr).toContain("manual operator override");
    const spec = readState().spec_check;
    expect(spec?.verdict).toBe("PASSED");
    expect(spec?.critical_count).toBe(0);
  });

  it("fails when the required CRITICAL_COUNT marker is absent", () => {
    const { exitCode, stderr } = runHelper("SPEC_CHECK_VERDICT: PASSED\n");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SPEC_CHECK_CRITICAL_COUNT marker required");
  });

  it("fails when the required VERDICT marker is absent", () => {
    const { exitCode, stderr } = runHelper("SPEC_CHECK_CRITICAL_COUNT: 0\n");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("SPEC_CHECK_VERDICT marker required");
  });
});
