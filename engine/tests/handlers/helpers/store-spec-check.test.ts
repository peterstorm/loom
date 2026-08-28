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

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

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
        "SPEC_CHECK_CRITICAL_COUNT: 1",
        "SPEC_CHECK_HIGH_COUNT: 2",
        "SPEC_CHECK_VERDICT: BLOCKED",
        "CRITICAL: requirement REQ-1 not implemented",
        "HIGH: partial coverage of REQ-2",
        "HIGH: missing error path for REQ-3",
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

  it("fails closed when CRITICAL_COUNT disagrees with the CRITICAL: lines (forged-zero shape)", () => {
    const { exitCode, stderr } = runHelper(
      [
        "SPEC_CHECK_CRITICAL_COUNT: 0",
        "SPEC_CHECK_HIGH_COUNT: 0",
        "SPEC_CHECK_VERDICT: PASSED",
        "CRITICAL: requirement REQ-1 not implemented",
      ].join("\n"),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("counts must match the findings");
    expect(readState().spec_check).toBeUndefined();
  });

  it("fails closed when HIGH_COUNT disagrees with the HIGH: lines", () => {
    const { exitCode, stderr } = runHelper(
      [
        "SPEC_CHECK_CRITICAL_COUNT: 0",
        "SPEC_CHECK_HIGH_COUNT: 3",
        "SPEC_CHECK_VERDICT: PASSED",
        "HIGH: partial coverage of REQ-2",
      ].join("\n"),
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("counts must match the findings");
    expect(readState().spec_check).toBeUndefined();
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
