/**
 * The verification manifest's I6/I7 half (AD-4, FR-015..FR-017): the optional
 * `affectedRunner` and `testFileSuffixes` source keys, the frozen `testFiles`
 * every freeze path carries, the digest over both, the legacy engine default
 * that keeps today's bytes for read-time fallbacks, and the affected command.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  type AffectedRunner as ContractAffectedRunner,
  type FrozenStopCheckManifestFields,
} from "../../src/core/affected-stop-check-types";
import {
  MAX_AFFECTED_RUNNER_TIMEOUT_MS as MANIFEST_AFFECTED_TIMEOUT_CAP,
  type AffectedRunner as ManifestAffectedRunner,
} from "../../src/core/verification-manifest";

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameAffectedRunner: MutuallyAssignable<ContractAffectedRunner, ManifestAffectedRunner> = true;

describe("the manifest restates CT-2's affected-runner surface exactly", () => {
  it("FR-015: the timeout cap and the runner type equal CT-2's", () => {
    expect(MANIFEST_AFFECTED_TIMEOUT_CAP).toBe(MAX_AFFECTED_RUNNER_TIMEOUT_MS);
    expect(sameAffectedRunner).toBe(true);
  });
});
import { DEFAULT_TEST_FILE_SUFFIXES, ENGINE_DEFAULT_TEST_FILES } from "../../src/core/test-file-classification";
import {
  ACCEPTANCE_RUNNER_CHECK_ID,
  AFFECTED_RUNNER_CHECK_ID,
  acceptanceRunnerCheck,
  affectedRunnerCheck,
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
  freezeVerificationManifest,
  legacyDefaultVerificationManifest,
  parseFrozenVerificationManifest,
  parseVerificationManifest,
  type AcceptanceRunner,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { deriveWaveCompletionSuiteReadiness } from "../../src/core/wave-completion-suite-readiness";
import type { AcceptedWaveCompletionReceipt } from "../../src/core/completion-suite";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import type { ActiveWaveGateRegistration, TaskGraph } from "../../src/types";
import { evaluateAsRecorded } from "../fixtures/completion-suite-evaluation";

/** The engine default's digest before this feature: every read-time fallback
 *  for a TaskGraph that carries no `verification_manifest` checks receipts
 *  stamped with it. */
const PRE_FEATURE_DEFAULT_DIGEST = "f151b9015dd8afd2c9ff94add17a86f6b5a9b0408931b31af70e9d4629823d6c";

const ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.junit.xml";
const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";

const AFFECTED_RUNNER = Object.freeze({
  executable: "vitest",
  args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "{files}"],
  cwd: "engine",
  timeoutMs: 90_000,
  report: { kind: "required-file", path: AFFECTED_REPORT },
});

const ACCEPTANCE_RUNNER = Object.freeze({
  ...AFFECTED_RUNNER,
  args: ["run", "--reporter=junit", `--outputFile=${ACCEPTANCE_REPORT}`, "{files}"],
  report: { kind: "required-file", path: ACCEPTANCE_REPORT },
});

const bytes = (document: Readonly<Record<string, unknown>>): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ kind: "loom-verification-manifest", checks: [], ...document }));

function frozen(document: Readonly<Record<string, unknown>>): FrozenVerificationManifest {
  const result = freezeVerificationManifest(bytes(document));
  if (!result.ok) throw new Error(result.error.errors.join("; "));
  return result.value;
}

const refusal = (document: Readonly<Record<string, unknown>>): readonly string[] => {
  const result = freezeVerificationManifest(bytes(document));
  return result.ok ? [] : result.error.errors;
};

const fields = (manifest: FrozenVerificationManifest): FrozenStopCheckManifestFields =>
  manifest as FrozenVerificationManifest & FrozenStopCheckManifestFields;

const stored = (manifest: FrozenVerificationManifest): Record<string, unknown> =>
  JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;

const DIGEST_MISMATCH = "frozenVerificationManifest.manifestDigest does not match its canonical authority";

describe("the legacy engine default keeps today's bytes", () => {
  it("FR-017: legacyDefaultVerificationManifest().manifestDigest equals the pre-feature default digest", () => {
    expect(legacyDefaultVerificationManifest().manifestDigest).toBe(PRE_FEATURE_DEFAULT_DIGEST);
    expect(stored(legacyDefaultVerificationManifest())).toEqual({
      schemaVersion: 1,
      kind: "frozen-verification-manifest",
      source: { kind: "engine-default" },
      manifestDigest: PRE_FEATURE_DEFAULT_DIGEST,
      projectChecks: [],
    });
    expect(parseFrozenVerificationManifest(stored(legacyDefaultVerificationManifest())))
      .toEqual({ ok: true, value: legacyDefaultVerificationManifest() });
  });

  it("FR-014: the population default carries the engine-default testFiles, which enters its digest", () => {
    const population = defaultVerificationManifest();

    expect(fields(population).testFiles).toEqual(ENGINE_DEFAULT_TEST_FILES);
    expect(population.manifestDigest).not.toBe(PRE_FEATURE_DEFAULT_DIGEST);
    expect(parseFrozenVerificationManifest(stored(population))).toEqual({ ok: true, value: population });
    const { testFiles: _dropped, ...asLegacy } = stored(population);
    expect(parseFrozenVerificationManifest(asLegacy)).toEqual({ ok: false, error: expect.objectContaining({ errors: [DIGEST_MISMATCH] }) });
  });

  it("FR-017: an engine-default frozen form cannot carry an operator classification or an affected runner", () => {
    const population = stored(defaultVerificationManifest());
    const operatorClassification = parseFrozenVerificationManifest({
      ...population, testFiles: { source: "operator-manifest", suffixes: [".spec.ts"] },
    });
    expect(operatorClassification.ok).toBe(false);
    if (!operatorClassification.ok) {
      expect(operatorClassification.error.errors)
        .toContain("frozenVerificationManifest engine-default source cannot carry an operator-manifest testFiles");
    }
    const runner = parseFrozenVerificationManifest({ ...population, affectedRunner: AFFECTED_RUNNER });
    expect(runner.ok).toBe(false);
    if (!runner.ok) {
      expect(runner.error.errors).toContain("frozenVerificationManifest engine-default source cannot authorize an affected runner");
    }
  });
});

describe("a frozen engine-default classification is provably the engine default", () => {
  const NOT_ENGINE_DEFAULT =
    `frozenVerificationManifest.testFiles.suffixes must equal the engine default (${DEFAULT_TEST_FILE_SUFFIXES.join(", ")}) when source is engine-default`;
  const operatorFileWithDefault = stored(frozen({ schemaVersion: 2 }));
  const operatorFileWithSuffixes = stored(frozen({ schemaVersion: 2, testFileSuffixes: [".it.ts"] }));

  it.each<[string, Record<string, unknown>, readonly string[]]>([
    ["an engine-default source", stored(defaultVerificationManifest()), [".it.ts"]],
    ["an engine-default source", stored(defaultVerificationManifest()), [...DEFAULT_TEST_FILE_SUFFIXES, ".it.ts"]],
    ["an engine-default source", stored(defaultVerificationManifest()), [...DEFAULT_TEST_FILE_SUFFIXES].reverse()],
    ["an operator-file source", operatorFileWithDefault, [".it.ts"]],
    ["an operator-file source", operatorFileWithDefault, DEFAULT_TEST_FILE_SUFFIXES.slice(0, 2)],
  ])("FR-014: FR-017: under %s, engine-default testFiles with non-default suffixes (case %#) is refused by name, though its digest matches", (_label, form, suffixes) => {
    const result = parseFrozenVerificationManifest({ ...form, testFiles: { source: "engine-default", suffixes } });
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ errors: [NOT_ENGINE_DEFAULT] }) });
  });

  it.each<[string, Record<string, unknown>]>([
    ["an engine-default source", stored(defaultVerificationManifest())],
    ["an operator-file source", operatorFileWithDefault],
  ])("FR-014: under %s, engine-default testFiles with exactly the default suffixes parses to the engine default", (_label, form) => {
    const result = parseFrozenVerificationManifest({
      ...form, testFiles: { source: "engine-default", suffixes: [...DEFAULT_TEST_FILE_SUFFIXES] },
    });
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ testFiles: ENGINE_DEFAULT_TEST_FILES }) });
  });

  it("FR-016: operator-manifest testFiles keep their declared suffixes, the default's included", () => {
    const declaredDefault = frozen({ schemaVersion: 2, testFileSuffixes: [...DEFAULT_TEST_FILE_SUFFIXES] });
    expect(fields(declaredDefault).testFiles).toEqual({ source: "operator-manifest", suffixes: DEFAULT_TEST_FILE_SUFFIXES });
    expect(parseFrozenVerificationManifest(stored(declaredDefault))).toEqual({ ok: true, value: declaredDefault });
    expect(parseFrozenVerificationManifest(operatorFileWithSuffixes))
      .toEqual({ ok: true, value: frozen({ schemaVersion: 2, testFileSuffixes: [".it.ts"] }) });
  });
});

describe("wave-completion-suite-readiness falls back to the legacy default", () => {
  const registration: ActiveWaveGateRegistration = {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: "run.legacy-fallback" as ActiveWaveGateRegistration["runId"],
    wave: 1,
    authorityDigest: "a".repeat(64) as ActiveWaveGateRegistration["authorityDigest"],
    revision: 0,
    terminalOutcome: null,
  };
  const workspaceDigest = "b".repeat(64) as ArtifactDigest;

  function receiptUnder(manifest: FrozenVerificationManifest): AcceptedWaveCompletionReceipt {
    const authority = authorizeWaveCompletionSuite(manifest, registration, workspaceDigest);
    if (!authority.ok) throw new Error(authority.error.errors.join("; "));
    const evaluated = evaluateAsRecorded(authority.value, {
      kind: "wave-completion-suite-result",
      runId: authority.value.runId,
      wave: authority.value.wave,
      revision: authority.value.revision,
      authorityDigest: authority.value.authorityDigest,
      manifestDigest: authority.value.manifestDigest,
      suiteDigest: authority.value.suiteDigest,
      workspaceDigest: authority.value.workspaceDigest,
      checks: authority.value.checks.map((check) => ({
        checkId: check.checkId,
        scope: "wave" as const,
        outcome: { kind: "observed" as const, exitCode: 0, timedOut: false, signal: null, report: { kind: "not-required" as const } },
      })),
    });
    if (evaluated.kind !== "accepted") throw new Error("receipt fixture must be accepted");
    return evaluated.receipt;
  }

  const preFeatureGraph = (receipt: AcceptedWaveCompletionReceipt): TaskGraph => ({
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
    active_wave_gate: registration,
    active_wave_completion_suite: receipt,
  });

  it("FR-017: a TaskGraph with no verification_manifest keeps its receipt stamped with the pre-feature default", () => {
    const readiness = deriveWaveCompletionSuiteReadiness(
      preFeatureGraph(receiptUnder(legacyDefaultVerificationManifest())),
      1,
      { kind: "observed", workspaceDigest },
    );

    expect(readiness).toMatchObject({
      kind: "accepted",
      projectVerificationCoverage: { kind: "not-configured", reason: "engine-default" },
    });
  });

  it("FR-017: such a TaskGraph does not adopt the population default's digest", () => {
    const readiness = deriveWaveCompletionSuiteReadiness(
      preFeatureGraph(receiptUnder(defaultVerificationManifest())),
      1,
      { kind: "observed", workspaceDigest },
    );

    expect(readiness).toMatchObject({ kind: "required", detail: expect.stringContaining("manifest digest") });
  });
});

describe("affectedRunner and testFileSuffixes in the source manifest", () => {
  it("AS-015: FR-015: FR-016: a declared affectedRunner and testFileSuffixes freeze, round-trip, and enter the digest", () => {
    const manifest = frozen({
      schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER, affectedRunner: AFFECTED_RUNNER, testFileSuffixes: [".it.ts"],
    });

    expect(fields(manifest).affectedRunner).toEqual(AFFECTED_RUNNER);
    expect(fields(manifest).testFiles).toEqual({ source: "operator-manifest", suffixes: [".it.ts"] });
    expect(Object.isFrozen(fields(manifest).testFiles?.suffixes)).toBe(true);
    expect(parseFrozenVerificationManifest(stored(manifest))).toEqual({ ok: true, value: manifest });
    const withoutAffected = frozen({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER, testFileSuffixes: [".it.ts"] });
    expect(withoutAffected.manifestDigest).not.toBe(manifest.manifestDigest);
    expect(fields(withoutAffected).affectedRunner).toBeUndefined();
    expect(Object.hasOwn(withoutAffected, "affectedRunner")).toBe(false);
  });

  it("AS-015: FR-016: the source parse carries both keys only when declared", () => {
    const parsed = parseVerificationManifest({
      schemaVersion: 2, kind: "loom-verification-manifest", checks: [], affectedRunner: AFFECTED_RUNNER, testFileSuffixes: [".it.ts", ".e2e.ts"],
    });
    expect(parsed).toMatchObject({ ok: true, value: { affectedRunner: AFFECTED_RUNNER, testFileSuffixes: [".it.ts", ".e2e.ts"] } });
    const bare = parseVerificationManifest({ schemaVersion: 2, kind: "loom-verification-manifest", checks: [] });
    expect(bare.ok && Object.keys(bare.value).sort()).toEqual(["checks", "kind", "schemaVersion"]);
  });

  it.each<[string, unknown, string]>([
    ["an empty list", [], "verificationManifest.testFileSuffixes must be a non-empty array of strings"],
    ["a non-array", ".test.ts", "verificationManifest.testFileSuffixes must be a non-empty array of strings"],
    ["a non-string suffix", [".test.ts", 3], "verificationManifest.testFileSuffixes must be a non-empty array of strings"],
    ["an empty suffix", [".test.ts", ""], "verificationManifest.testFileSuffixes[1] must be a non-empty suffix without a path separator"],
    ["a suffix with a path separator", ["tests/.test.ts"], "verificationManifest.testFileSuffixes[0] must be a non-empty suffix without a path separator"],
    ["a repeated suffix", [".test.ts", ".spec.ts", ".test.ts"], "verificationManifest.testFileSuffixes repeats suffixes: .test.ts"],
  ])("AS-016: FR-014: testFileSuffixes with %s is refused naming the failed check", (_label, suffixes, error) => {
    expect(refusal({ schemaVersion: 2, testFileSuffixes: suffixes })).toEqual([error]);
  });

  it.each([
    ["affectedRunner", AFFECTED_RUNNER],
    ["testFileSuffixes", [".test.ts"]],
  ])("AS-017: FR-017: a schema-1 manifest refuses %s as an unknown key", (key, value) => {
    const errors = refusal({ schemaVersion: 1, [key]: value });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain(key);
  });

  it("AS-016: FR-015: the timeout cap is the affected runner's own, below the acceptance runner's", () => {
    const runner = { ...AFFECTED_RUNNER, timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS + 1 };
    expect(refusal({ schemaVersion: 2, acceptanceRunner: { ...runner, report: ACCEPTANCE_RUNNER.report } })).toEqual([]);
    expect(refusal({ schemaVersion: 2, affectedRunner: runner })).toEqual([
      `verificationManifest.affectedRunner.timeoutMs must be at most ${MAX_AFFECTED_RUNNER_TIMEOUT_MS}, inside the stop hook's own timeout`,
    ]);
  });

  it("AS-016: FR-015: the affected runner's report path must differ from the acceptance runner's", () => {
    expect(refusal({
      schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER, affectedRunner: { ...AFFECTED_RUNNER, report: ACCEPTANCE_RUNNER.report },
    })).toEqual([`verificationManifest.affectedRunner.report.path ${ACCEPTANCE_REPORT} is also the acceptanceRunner's report path`]);
  });
});

describe("the frozen affected runner and classification are digest-checked", () => {
  const manifest = frozen({ schemaVersion: 2, acceptanceRunner: ACCEPTANCE_RUNNER, affectedRunner: AFFECTED_RUNNER, testFileSuffixes: [".it.ts"] });

  it.each<[string, (form: Record<string, unknown>) => Record<string, unknown>]>([
    ["the affected runner's report path", (form) => ({ ...form, affectedRunner: { ...AFFECTED_RUNNER, report: { kind: "required-file", path: ".loom/completion-reports/other.xml" } } })],
    ["the affected runner added to a manifest frozen without one", (form) => form],
    ["the suffix order", (form) => ({ ...form, testFiles: { source: "operator-manifest", suffixes: [".it.ts", ".test.ts"] } })],
  ])("AS-019: FR-016: a change to %s after population is refused", (label, tamper) => {
    const base = label.startsWith("the affected runner added")
      ? { ...stored(frozen({ schemaVersion: 2, testFileSuffixes: [".it.ts"] })), affectedRunner: AFFECTED_RUNNER }
      : tamper(stored(manifest));
    expect(parseFrozenVerificationManifest(base)).toEqual({ ok: false, error: expect.objectContaining({ errors: [DIGEST_MISMATCH] }) });
  });

  it("AS-019: FR-016: a frozen affected runner sharing the acceptance runner's report path is refused before the digest", () => {
    const tampered = { ...stored(manifest), affectedRunner: { ...AFFECTED_RUNNER, report: ACCEPTANCE_RUNNER.report } };
    const result = parseFrozenVerificationManifest(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errors)
        .toEqual([`frozenVerificationManifest.affectedRunner.report.path ${ACCEPTANCE_REPORT} is also the acceptanceRunner's report path`]);
    }
  });

  it("AS-019: FR-016: a frozen testFiles with an unknown key or source is refused", () => {
    for (const testFiles of [
      { source: "operator-manifest", suffixes: [".it.ts"], extra: true },
      { source: "somebody", suffixes: [".it.ts"] },
      { source: "operator-manifest", suffixes: [] },
    ]) {
      expect(parseFrozenVerificationManifest({ ...stored(manifest), testFiles }).ok).toBe(false);
    }
  });

  it("FR-016: parse after freeze is the identity over declared suffixes and an optional affected runner", () => {
    const suffix = fc.stringMatching(/^\.[a-z]{1,5}(\.[a-z]{1,3})?$/);
    fc.assert(fc.property(
      fc.option(fc.uniqueArray(suffix, { minLength: 1, maxLength: 4 }), { nil: undefined }),
      fc.boolean(),
      fc.integer({ min: 1, max: MAX_AFFECTED_RUNNER_TIMEOUT_MS }),
      (suffixes, withRunner, timeoutMs) => {
        const document = {
          schemaVersion: 2,
          ...(suffixes === undefined ? {} : { testFileSuffixes: suffixes }),
          ...(withRunner ? { affectedRunner: { ...AFFECTED_RUNNER, timeoutMs } } : {}),
        };
        const result = frozen(document);
        expect(parseFrozenVerificationManifest(stored(result))).toEqual({ ok: true, value: result });
        expect(fields(result).testFiles).toEqual(suffixes === undefined
          ? ENGINE_DEFAULT_TEST_FILES
          : { source: "operator-manifest", suffixes });
      },
    ), { numRuns: 60 });
  });
});

describe("affectedRunnerCheck", () => {
  const runner = fields(frozen({ schemaVersion: 2, affectedRunner: AFFECTED_RUNNER })).affectedRunner as AcceptanceRunner;

  it("AS-015: FR-015: replaces {files} with one argument per changed file, written from the runner cwd", () => {
    const check = affectedRunnerCheck(runner, ["engine/src/a.ts", "engine/tests/a.test.ts"]);

    expect(check).toEqual({
      ok: true,
      value: {
        kind: "project-command",
        checkId: AFFECTED_RUNNER_CHECK_ID,
        scope: "wave",
        executable: "vitest",
        args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "src/a.ts", "tests/a.test.ts"],
        cwd: "engine",
        timeoutMs: 90_000,
        reportPolicy: { kind: "required-file", path: AFFECTED_REPORT },
      },
    });
  });

  it("AS-015: FR-015: forms the command through the same builder as the acceptance runner, under its own check id", () => {
    const affected = affectedRunnerCheck(runner, ["engine/src/a.ts"]);
    const acceptance = acceptanceRunnerCheck(runner, ["engine/src/a.ts"]);
    expect(affected.ok && acceptance.ok).toBe(true);
    if (!affected.ok || !acceptance.ok) return;
    expect({ ...affected.value, checkId: ACCEPTANCE_RUNNER_CHECK_ID }).toEqual(acceptance.value);
    expect(AFFECTED_RUNNER_CHECK_ID).not.toBe(ACCEPTANCE_RUNNER_CHECK_ID);
  });

  it("AS-016: FR-015: refuses a changed file outside the runner cwd, naming the affected runner", () => {
    expect(affectedRunnerCheck(runner, ["engine/src/a.ts", "pi/b.ts"])).toEqual({
      ok: false,
      error: { kind: "invalid-verification-manifest", errors: ["affectedRunner.cwd engine does not contain pi/b.ts"] },
    });
  });
});
