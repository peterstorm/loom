/**
 * CT-2 acceptance: the operator-declared `affectedRunner` and the test-file
 * classification in the verification manifest.
 *
 * The testcases drive the production freezer (`freezeVerificationManifest`)
 * over manifest source bytes, the frozen-form parser
 * (`parseFrozenVerificationManifest`) that every TaskGraph load runs, and the
 * production State File parser. The I7-off reason of a manifest without an
 * `affectedRunner` is read through `helper stop-check-plan`'s handler.
 *
 * Each testcase builds the manifest it needs, so a key the parser refuses
 * fails that testcase alone.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AFFECTED_OFF_REASON_TEXT,
  AFFECTED_SECTION_HEADING,
  AFFECTED_STOP_CHECK_OFF,
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  type FrozenStopCheckManifestFields,
} from "../../src/core/affected-stop-check-types";
import { renderStopCheckPlan } from "../../src/core/acceptance-contract/stop-check-plan";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { createStopCheckPlanHandler } from "../../src/handlers/helpers/stop-check-plan";
import { gitProject, task, writeStateFile } from "../fixtures/contract-status-fixtures";
import { stopCheckGraph } from "../fixtures/stop-check-plan-fixtures";

const ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.junit.xml";
const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";
const VERIFY_REPORT = ".loom/completion-reports/verify.junit.xml";

const ACCEPTANCE_RUNNER = Object.freeze({
  executable: "vitest",
  args: ["run", "--reporter=junit", `--outputFile=${ACCEPTANCE_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: 120_000,
  report: { kind: "required-file", path: ACCEPTANCE_REPORT },
});

const AFFECTED_RUNNER = Object.freeze({
  executable: "vitest",
  args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: { kind: "required-file", path: AFFECTED_REPORT },
});

const WAVE_CHECK = Object.freeze({
  id: "project:verify",
  scope: "wave",
  executable: "vitest",
  args: ["run"],
  cwd: ".",
  timeoutMs: 600_000,
  report: { kind: "required-file", path: VERIFY_REPORT },
});

/** Manifest source bytes; every key is spelled out by the testcase. */
const source = (document: Readonly<Record<string, unknown>>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ kind: "loom-verification-manifest", checks: [], ...document }));

/** The frozen form, failing the testcase with the freezer's refusal. */
function frozen(document: Readonly<Record<string, unknown>>): FrozenVerificationManifest {
  const result = freezeVerificationManifest(source(document));
  if (!result.ok) throw new Error(`manifest refused: ${result.error.errors.join("; ")}`);
  return result.value;
}

/** The I6 and I7 fields of a frozen manifest. */
const fields = (manifest: FrozenVerificationManifest): FrozenStopCheckManifestFields =>
  manifest as FrozenVerificationManifest & FrozenStopCheckManifestFields;

/** The frozen form as stored in a TaskGraph: plain JSON. */
const stored = (manifest: FrozenVerificationManifest): Record<string, unknown> =>
  JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

const refusal = (document: Readonly<Record<string, unknown>>): readonly string[] => {
  const result = freezeVerificationManifest(source(document));
  return result.ok ? [] : result.error.errors;
};

const cleanup: string[] = [];
const saved = { state: process.env.LOOM_STATE_PATH, subagents: process.env.LOOM_SUBAGENT_DIR };
afterEach(() => {
  for (const [key, value] of [["LOOM_STATE_PATH", saved.state], ["LOOM_SUBAGENT_DIR", saved.subagents]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("affectedRunner in the manifest (CT-2)", () => {
  it("AS-015: FR-015: FR-016: an affectedRunner using {files} under the acceptance runner's form checks is frozen and enters the manifest digest", () => {
    const manifest = frozen({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER, affectedRunner: AFFECTED_RUNNER });

    expect(fields(manifest).affectedRunner).toEqual(AFFECTED_RUNNER);
    expect(manifest.acceptanceRunner).toEqual(ACCEPTANCE_RUNNER);
    // The frozen form round-trips through the parser every TaskGraph load runs.
    expect(parseFrozenVerificationManifest(stored(manifest))).toEqual({ ok: true, value: manifest });
    // The runner is inside the digest: dropping it from the frozen form is refused.
    const { affectedRunner: _runner, ...withoutRunner } = stored(manifest);
    const dropped = parseFrozenVerificationManifest(withoutRunner);
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.error.errors).toContain("frozenVerificationManifest.manifestDigest does not match its canonical authority");
  });

  it("AS-015: FR-015: an affectedRunner may be declared without an acceptanceRunner", () => {
    const manifest = frozen({ schemaVersion: 2, affectedRunner: AFFECTED_RUNNER });

    expect(fields(manifest).affectedRunner).toEqual(AFFECTED_RUNNER);
    expect(manifest.acceptanceRunner).toBeUndefined();
    expect(parseFrozenVerificationManifest(stored(manifest))).toEqual({ ok: true, value: manifest });
  });

  it("AS-015: FR-016: a TaskGraph populated with the frozen affectedRunner loads with it through the production State File parser", () => {
    const manifest = frozen({ schemaVersion: 2, affectedRunner: AFFECTED_RUNNER });

    const { graph } = stopCheckGraph({ tasks: [task("T1", 1, ["src/ledger.ts"])], manifest });

    expect(graph.verification_manifest).toEqual(manifest);
    expect(fields(graph.verification_manifest!).affectedRunner).toEqual(AFFECTED_RUNNER);
  });

  // Each form check refuses the affected runner exactly as it refuses the acceptance runner, under its own key.
  it.each<[string, Readonly<Record<string, unknown>>]>([
    ["no {files} argument", { ...AFFECTED_RUNNER, args: ["related", "--run"] }],
    ["two {files} arguments", { ...AFFECTED_RUNNER, args: ["related", "{files}", "{files}"] }],
    ["{files} inside an argument", { ...AFFECTED_RUNNER, args: ["related", "--files={files}", "{files}"] }],
    ["a report outside the protected report root", { ...AFFECTED_RUNNER, report: { kind: "required-file", path: "affected.junit.xml" } }],
    ["a disallowed executable", { ...AFFECTED_RUNNER, executable: "npx" }],
    ["an unknown key", { ...AFFECTED_RUNNER, shell: true }],
    ["a cwd outside the repository", { ...AFFECTED_RUNNER, cwd: "../elsewhere" }],
  ])("AS-016: FR-015: an affectedRunner with %s is refused naming the failed check, exactly as for acceptanceRunner", (_label, runner) => {
    const asAcceptance = refusal({ schemaVersion: 2, acceptanceRunner: runner });
    expect(asAcceptance.length).toBeGreaterThan(0);

    expect(refusal({ schemaVersion: 2, affectedRunner: runner }))
      .toEqual(asAcceptance.map((error) => error.replaceAll("acceptanceRunner", "affectedRunner")));
  });

  it(`AS-016: FR-015: an affectedRunner timeout above ${MAX_AFFECTED_RUNNER_TIMEOUT_MS} ms is refused naming the cap`, () => {
    const runner = { ...AFFECTED_RUNNER, timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS + 1 };

    const errors = refusal({ schemaVersion: 2, affectedRunner: runner });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`verificationManifest.affectedRunner.timeoutMs must be at most ${MAX_AFFECTED_RUNNER_TIMEOUT_MS}`);
    expect(fields(frozen({ schemaVersion: 2, affectedRunner: { ...runner, timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS } })).affectedRunner?.timeoutMs)
      .toBe(MAX_AFFECTED_RUNNER_TIMEOUT_MS);
  });

  it("AS-016: FR-015: an affectedRunner sharing a report path with the acceptance runner or a Wave check is refused naming the conflict", () => {
    const shared = { ...AFFECTED_RUNNER, report: { kind: "required-file", path: ACCEPTANCE_REPORT } };
    const withAcceptance = refusal({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER, affectedRunner: shared });
    expect(withAcceptance).toHaveLength(1);
    expect(withAcceptance[0]).toContain(`verificationManifest.affectedRunner.report.path ${ACCEPTANCE_REPORT}`);
    expect(withAcceptance[0]).toContain("acceptanceRunner");

    const onVerify = { ...AFFECTED_RUNNER, report: { kind: "required-file", path: VERIFY_REPORT } };
    expect(refusal({ schemaVersion: 2, checks: [WAVE_CHECK], affectedRunner: onVerify }))
      .toEqual([`verificationManifest.affectedRunner.report.path ${VERIFY_REPORT} is also a Wave check's report path`]);

    // Distinct report paths are admitted together.
    const manifest = frozen({ schemaVersion: 2, checks: [WAVE_CHECK], acceptanceRunner: ACCEPTANCE_RUNNER, affectedRunner: AFFECTED_RUNNER });
    expect(fields(manifest).affectedRunner?.report.path).toBe(AFFECTED_REPORT);
  });
});

describe("the schema change is additive (CT-2)", () => {
  it.each<[string, Readonly<Record<string, unknown>>]>([
    ["a schema-1 manifest", { schemaVersion: 1 }],
    ["a schema-2 manifest without the new keys", { schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER }],
  ])("AS-017: FR-017: %s stays valid, freezes no affected runner, and classifies test files by the engine default", (_label, document) => {
    const manifest = frozen(document);
    const engineDefault = fields(defaultVerificationManifest()).testFiles;

    expect(fields(manifest).affectedRunner).toBeUndefined();
    expect(engineDefault).toMatchObject({ source: "engine-default" });
    expect(engineDefault?.suffixes).toEqual(expect.arrayContaining([".test.ts", ".spec.ts"]));
    expect(fields(manifest).testFiles).toEqual(engineDefault);
    expect(parseFrozenVerificationManifest(stored(manifest))).toEqual({ ok: true, value: manifest });
  });

  it("AS-017: FR-017: with no affected runner frozen, I7 is off with the stated reason", async () => {
    const manifest = frozen({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER });
    const { graph, json } = stopCheckGraph({ tasks: [task("T1", 1, ["src/ledger.ts"])], manifest });
    const root = gitProject("loom-affected-manifest-", cleanup);
    process.env.LOOM_STATE_PATH = writeStateFile(root, json);
    // No live attempt: the project's runtime directory holds no sidecar.
    process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
    const written: string[] = [];

    const result = await createStopCheckPlanHandler((text) => { written.push(text); })("", ["--task", "T1"]);

    expect(result).toEqual({ kind: "passthrough" });
    const acceptance = renderStopCheckPlan(graph, "T1");
    if (acceptance.kind !== "rendered") throw new Error("T1 is in the fixture graph");
    expect(written.join("").split("\n")).toEqual([
      ...acceptance.lines,
      AFFECTED_SECTION_HEADING,
      `  ${AFFECTED_STOP_CHECK_OFF} — ${AFFECTED_OFF_REASON_TEXT["no-runner"]}`,
      "",
    ]);
  });

  it("FR-016: a declared testFileSuffixes list freezes as the operator's classification", () => {
    const manifest = frozen({ schemaVersion: 2, testFileSuffixes: [".spec.ts", ".it.ts"] });

    expect(fields(manifest).testFiles).toEqual({ source: "operator-manifest", suffixes: [".spec.ts", ".it.ts"] });
    expect(parseFrozenVerificationManifest(stored(manifest))).toEqual({ ok: true, value: manifest });
  });
});

describe("frozen affected runner and test-file pattern are digest-checked (CT-2)", () => {
  type Tamper = (frozenForm: Record<string, unknown>) => Record<string, unknown>;
  const runnerOf = (form: Record<string, unknown>) => form.affectedRunner as Record<string, unknown>;
  const testFilesOf = (form: Record<string, unknown>) => form.testFiles as Record<string, unknown>;

  it.each<[string, Tamper]>([
    ["affected runner's args changed", (form) => ({ ...form, affectedRunner: { ...runnerOf(form), args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "--changed", "{files}"] } })],
    ["affected runner's cwd changed", (form) => ({ ...form, affectedRunner: { ...runnerOf(form), cwd: "src" } })],
    ["affected runner's timeout changed", (form) => ({ ...form, affectedRunner: { ...runnerOf(form), timeoutMs: 60_000 } })],
    ["test-file suffixes changed", (form) => ({ ...form, testFiles: { ...testFilesOf(form), suffixes: [".spec.ts"] } })],
    ["test-file classification source changed", (form) => ({ ...form, testFiles: { ...testFilesOf(form), source: "engine-default" } })],
    ["test-file classification was dropped", ({ testFiles: _testFiles, ...form }) => form],
  ])("AS-019: FR-016: a frozen manifest whose %s after population is refused by the digest check", (_label, tamper) => {
    const manifest = frozen({ schemaVersion: 2, testFileSuffixes: [".spec.ts", ".test.ts"], affectedRunner: AFFECTED_RUNNER });
    expect(parseFrozenVerificationManifest(stored(manifest)).ok).toBe(true);

    const tampered = parseFrozenVerificationManifest(tamper(stored(manifest)));

    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.error.errors).toContain("frozenVerificationManifest.manifestDigest does not match its canonical authority");
  });

  it("AS-019: FR-016: a TaskGraph whose frozen affected runner changed after population does not load", () => {
    const manifest = frozen({ schemaVersion: 2, affectedRunner: AFFECTED_RUNNER });
    const tampered = { ...stored(manifest), affectedRunner: { ...AFFECTED_RUNNER, args: ["related", "--run", "{files}"] } };

    expect(() => stopCheckGraph({ tasks: [task("T1", 1, ["src/ledger.ts"])], manifest: tampered as unknown as FrozenVerificationManifest }))
      .toThrow(/manifestDigest does not match its canonical authority/);
  });
});
