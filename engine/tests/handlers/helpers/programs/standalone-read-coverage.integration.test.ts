import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import {
  READ_COVERAGE_SCOPE_BUDGET_UNITS, STANDALONE_FROZEN_DIFF_SECTION, STANDALONE_READ_COVERAGE_V1, parseFrozenDiff,
} from "../../../../src/core/standalone-read-coverage";
import { unifiedDiff } from "../../../../src/core/unified-diff";
import { parseRegistration } from "../../../../src/handlers/helpers/programs/registration";
import { resumeStandaloneFacade, startStandaloneFacade } from "../../../../src/handlers/helpers/programs/standalone";
import { captureHarnessResult } from "../../../../src/orchestration/harness-capture-runtime";
import { createRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import {
  readCoverageObservationPath, readRecordedObservation, recordReadCoverageObservation,
} from "../../../../src/orchestration/standalone-read-coverage-evidence";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { git } from "../../../fixtures/git-repository";
import { disposeFixturePiSessions, fixturePiEnvironment, withFixturePiSession as inDirectory } from "../../../fixtures/pi-session";
import { captureReviewedTranscript, frozenDiffReaderPages } from "../../../fixtures/read-coverage";
import { value } from "../../../fixtures/parse-result";

/**
 * The shell half of the read obligation (ADR-0022): what a fresh standalone
 * start freezes and registers, what the issued task says, and how capture,
 * submission and admission treat the observation.
 */
const cli = fileURLToPath(new URL("../../../../src/cli.ts", import.meta.url));
const EMPTY = JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [] });
const roots: string[] = [];
afterEach(() => {
  disposeFixturePiSessions();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Requests = readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];

function repository(files: Readonly<Record<string, readonly [string | null, string]>>) {
  const root = canonicalTempDir("loom-read-coverage-");
  roots.push(root);
  mkdirSync(join(root, "runs"));
  const tracked = Object.entries(files).filter(([, [base]]) => base !== null);
  for (const [path, [base]] of tracked) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), base!); }
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
    ["add", ...tracked.map(([path]) => path)], ["commit", "-qm", "fixture baseline"]]) git(root, args);
  for (const [path, [, head]] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), head); }
  return root;
}

async function start(root: string, run: string, files: readonly string[]): Promise<Readonly<{ handle: RunDirHandle; requests: Requests }>> {
  const handle = createRunDirectory(join(root, "runs"), run);
  if (!handle.ok) throw new Error(handle.error.message);
  const started = await inDirectory(root, () => startStandaloneFacade(handle.value, { kind: "code", files, dryRun: false }));
  if (!started.ok) throw new Error(started.message);
  return { handle: handle.value, requests: (started.action as { requests: Requests }).requests };
}

const registration = (handle: RunDirHandle) => {
  const stored = handle.readProgramRegistration();
  if (!stored.ok) throw new Error(stored.error.message);
  return stored.value as Record<string, unknown>;
};

describe("standalone read obligation", () => {
  it("registers the exact policy and freezes each scoped file's diff against the review baseline", async () => {
    const root = repository({ "src/a.ts": ["export const a = 1;\n", "export const a = 2;\n"], "src/new.ts": [null, "export const n = 1;\n"] });
    const { handle, requests } = await start(root, "run.policy", ["src/a.ts", "src/new.ts"]);
    expect(registration(handle).readCoverage).toEqual(STANDALONE_READ_COVERAGE_V1);
    const parsed = parseRegistration(registration(handle));
    expect(parsed.ok && parsed.value.schemaVersion === 2 && parsed.value.readCoverage).toEqual(STANDALONE_READ_COVERAGE_V1);
    for (const { authority, task } of requests) {
      const packet = handle.readContext(authority.contextDigest);
      if (!packet.ok) throw new Error(packet.error.message);
      const section = packet.value.fixedContext.find(({ label }) => label === STANDALONE_FROZEN_DIFF_SECTION)!;
      const diff = parseFrozenDiff(JSON.parse(Buffer.from(section.bytes).toString("utf8")));
      if (!diff.ok) throw new Error(diff.error);
      expect(diff.value.files).toEqual([
        expect.objectContaining({ path: "src/a.ts", text: unifiedDiff("src/a.ts", "export const a = 1;\n", "export const a = 2;\n") }),
        expect.objectContaining({ path: "src/new.ts", text: unifiedDiff("src/new.ts", null, "export const n = 1;\n") }),
      ]);
      expect(task).toContain("LOOM_READ_COVERAGE: every-frozen-diff-unit");
      expect(task).toMatch(/^- src\/a\.ts: \d+ units, 1 page\(s\)$/m);
      expect(task).toMatch(/^- src\/new\.ts: \d+ units, 1 page\(s\)$/m);
    }
  });

  it("refuses a tampered, misplaced or malformed policy instead of silently dropping coverage", async () => {
    const root = repository({ "src/a.ts": ["a\n", "b\n"] });
    const { handle } = await start(root, "run.tamper", ["src/a.ts"]);
    const stored = registration(handle);
    expect(parseRegistration({ ...stored, readCoverage: { ...STANDALONE_READ_COVERAGE_V1, pageUnits: 1 } }).ok).toBe(false);
    expect(parseRegistration({ ...stored, readCoverage: null }).ok).toBe(false);
    const { readCoverage: _, ...withoutCoverage } = stored;
    const historical = parseRegistration(withoutCoverage);
    expect(historical.ok && "readCoverage" in historical.value).toBe(false);
  });

  it("refuses at start a scope whose frozen diff exceeds one reviewer's budget, registering nothing", async () => {
    const huge = Array.from({ length: 12_000 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    expect(huge.length).toBeGreaterThan(READ_COVERAGE_SCOPE_BUDGET_UNITS);
    const root = repository({ "README.md": ["base\n", "base\n"], "src/huge.ts": [null, huge] });
    const handle = createRunDirectory(join(root, "runs"), "run.budget");
    if (!handle.ok) throw new Error(handle.error.message);
    const started = await inDirectory(root, () => startStandaloneFacade(handle.value, { kind: "code", files: ["src/huge.ts"], dryRun: false }));
    expect(started).toMatchObject({ ok: false, message: expect.stringContaining("partition the scope") });
    expect(existsSync(join(handle.value.runDirectory, "program.json"))).toBe(false);
  });

  it("records an unobservable attempt when the adapter supplies no tool outputs, and admission refuses it", async () => {
    const root = repository({ "src/a.ts": ["a\n", "b\n"] });
    const { handle, requests } = await start(root, "run.unobservable", ["src/a.ts"]);
    for (const [index, { authority }] of requests.entries()) {
      value(await handle.recordHarnessCorrelator({ schemaVersion: 1, harness: "claude", nativeId: `native-${index}`,
        requestId: authority.requestId, role: authority.role, attempt: authority.attempt }));
      const outcome = await captureHarnessResult({ harness: "claude", runsRoot: handle.identity.runsRoot, runDirectory: handle.runDirectory,
        nativeId: `native-${index}`, candidates: [{ origin: "final", text: EMPTY }] });
      expect(outcome.kind, JSON.stringify(outcome)).toBe("captured");
      expect(value(readRecordedObservation(handle, authority))).toMatchObject({ transcript: "unobservable" });
    }
    const resumed = await inDirectory(root, () => resumeStandaloneFacade(handle, value(parseRegistration(registration(handle)))));
    if (!resumed.ok) throw new Error(resumed.message);
    const retry = (resumed.action as { kind: string; requests: Requests });
    expect(retry.kind).toBe("spawn-batch");
    expect(retry.requests.every(({ authority }) => authority.attempt === 2)).toBe(true);
    expect(retry.requests[0]!.task).toContain("read coverage was not observed");
  });

  it("keeps the first observation of an attempt; a later delivery never rewrites it", async () => {
    const root = repository({ "src/a.ts": ["a\n", "b\n"] });
    const { handle, requests } = await start(root, "run.first", ["src/a.ts"]);
    const request = requests[0]!.authority;
    const first = value(await recordReadCoverageObservation(handle, request, []));
    const bytes = readFileSync(join(handle.runDirectory, "artifacts", readCoverageObservationPath(request.requestId)));
    const second = value(await recordReadCoverageObservation(handle, request, frozenDiffReaderPages(handle, request)));
    expect(second).toEqual(first);
    expect(readFileSync(join(handle.runDirectory, "artifacts", readCoverageObservationPath(request.requestId)))).toEqual(bytes);
  });

  it("admits a complete read and publishes the review", async () => {
    const root = repository({ "src/a.ts": ["a\n", "b\n"] });
    const { handle, requests } = await start(root, "run.complete", ["src/a.ts"]);
    for (const { authority } of requests) value(await captureReviewedTranscript(handle, authority, [...Buffer.from(EMPTY)]));
    const done = await inDirectory(root, () => resumeStandaloneFacade(handle, value(parseRegistration(registration(handle)))));
    expect(done).toMatchObject({ ok: true, action: { kind: "done" } });
  });

  it("validates submit --tool-outputs before capturing anything", async () => {
    const root = repository({ "src/a.ts": ["a\n", "b\n"] });
    const { handle, requests } = await start(root, "run.submit", ["src/a.ts"]);
    const request = requests[0]!.authority;
    const malformed = join(root, "malformed.json");
    writeFileSync(malformed, JSON.stringify({ pages: [] }));
    const refused = spawnSync("bun", [cli, "helper", "orchestration", "submit", "--runs-root", handle.identity.runsRoot, "--run", handle.runId,
      "--request", request.requestId, "--slot", request.slotId, "--attempt", "1", "--tool-outputs", malformed],
      { cwd: root, env: fixturePiEnvironment(root), encoding: "utf8", input: EMPTY });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("--tool-outputs must be a JSON array of strings");
    expect(value(handle.readCapturedAttempts()).size).toBe(0);
    expect(value(readRecordedObservation(handle, request))).toBeNull();
  });
});
