import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPOSITORY } from "./fixtures/repository-roots";

const workflow = readFileSync(join(REPOSITORY, ".github/workflows/ci.yml"), "utf8");

describe("CI verification contract", () => {
  it("verifies pull requests, pushes to main and manual dispatch with the same command, cancelling superseded runs", () => {
    // The repository is private and the macOS leg is metered at 10x: a branch
    // push is validated by its pull_request run, a tag points at a commit main
    // already validated, and a newer run on the same ref replaces the older.
    expect(workflow).toMatch(/\non:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/);
    expect(workflow).not.toMatch(/branches: \["\*\*"\]|tags:/);
    expect(workflow).toMatch(/concurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true/);
    expect(workflow.match(/npm run verify/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/npm run (test|typecheck)|bun test|bunx|npx|continue-on-error|@latest|publish/);
  });

  it("pins full Git history, the measured runtimes, and both existing frozen dependency graphs", () => {
    expect(workflow).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/);
    expect(workflow).toContain('node-version: "22.23.2"');
    // .bun-version is the one Bun pin: CI installs it and asserts the installed Bun is it.
    expect(workflow).toContain("bun-version-file: .bun-version");
    expect(workflow).toContain('test "$(bun --version)" = "$(cat .bun-version)"');
    expect(workflow.match(/bun install --frozen-lockfile/g)).toHaveLength(2);
    expect(workflow).toContain("(cd engine && bun install --frozen-lockfile)");
    expect(workflow).toContain('test -x node_modules/.bin/pi');
    expect(workflow).toContain('test "$(command -v pi)" = "$GITHUB_WORKSPACE/node_modules/.bin/pi"');
  });

  it("verifies on Linux AND macOS with per-OS preflights and per-OS retained logs", () => {
    // The macOS leg exists because the anchored no-follow filesystem layer
    // takes a darwin branch Linux CI never executes; the matrix must keep
    // both legs, must not let one cancel the other, and must retain each
    // leg's log under its own name.
    expect(workflow).toMatch(/matrix:\s*\n\s*os: \[ubuntu-24\.04, macos-15\]/);
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain('test "$(id -u)" -ne 0');
    // Linux-only requirements stay named inside the Linux branch: GNU timeout
    // and Bash 4 are absent on the macOS runner by platform design.
    expect(workflow).toContain('test "$BASH_VERSINFO" -ge 4');
    expect(workflow).toContain('case "$(uname -s)" in');
    expect(workflow).toContain("command -v timeout");
    expect(workflow).toContain("timeout --version");
    expect(workflow).toContain("for tool in jq bash git node npm bun");
    expect(workflow).toMatch(/set -euo pipefail\n\s+npm run verify 2>&1 \| tee verification.log/);
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("name: verification-log-${{ matrix.os }}");
    expect(workflow).toContain("path: verification.log");
    // The shared budget covers the macOS leg, which runs the same suite on a
    // materially slower runner.
    expect(workflow).toContain("timeout-minutes: 60");
  });
});
