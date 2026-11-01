/**
 * The `loom:owner-verification` check inside the completion suite (AD-1):
 * suite authorization injects the check only from the owner check authority
 * its callers obtained from `waveOwnerDuty(graph, wave).check` (INV-3), the check and the
 * result/receipt observation round-trip through the at-rest parsers, and
 * `evaluateWaveCompletionSuite` turns every owner-verification finding into a
 * blocking failure: semantic for missing siblings, a red baseline or a
 * survivor, infrastructure for anything that could not decide.
 *
 * Pure: every value is built from plain data through the production parsers.
 */

import { describe, expect, it } from "vitest";
import {
  OWNER_VERIFICATION_CHECK_ID,
  OWNER_VERIFICATION_CHECK_ID_TEXT,
  completionSuiteDigest,
  evaluateWaveCompletionSuite,
  parseCompletionCheckId,
  ownerCheckOf,
  ownerCheckResult,
  publicationSlotOf,
  rejectionFailures,
  parseAcceptedWaveCompletionReceipt,
  parseAuthorizedWaveCompletionCheck,
  parseWaveCompletionSuiteResult,
  type AuthorizedWaveCompletionSuite,
  type CompletionSuiteEvaluation,
  type RejectedCompletionSuite,
} from "../../src/core/completion-suite";
import { emptyAcceptanceExpectation } from "../../src/core/acceptance-contract";
import { sha256Hex } from "../../src/core/digest";
import type { ArtifactDigest } from "../../src/core/orchestration-contract";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationVerdict,
  OwnerVerificationObservation,
} from "../../src/core/owner-verification/types";
import { canonicalJson } from "../../src/core/review-packet";
import { authorizeWaveCompletionSuite, freezeVerificationManifest } from "../../src/core/verification-manifest";
import type { ActiveWaveGateRegistration } from "../../src/types";
import { digest } from "../fixtures/acceptance-fixtures";
import { invariantId } from "../fixtures/owner-obligation";
import { labelledValue, value } from "../fixtures/parse-result";

const OWNER_CHECK = "loom:owner-verification";
const LINT_CHECK = "loom:full-tier-lint";
const OBLIGATIONS_DIGEST = digest("e") as ArtifactDigest;

const manifest = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
  schemaVersion: 1,
  kind: "loom-verification-manifest",
  checks: [],
}))));

const registration: ActiveWaveGateRegistration = {
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.owner-suite" as ActiveWaveGateRegistration["runId"],
  wave: 1,
  authorityDigest: digest("a"),
  revision: 0,
  terminalOutcome: null,
};

type OwnerAuthority = Readonly<{ obligationsDigest: ArtifactDigest; owed: readonly string[] }>;

/** Authorizes the suite; the test spells owed ids as text, minted here through the id parser. */
const authorize = (owner: OwnerAuthority | null): AuthorizedWaveCompletionSuite =>
  value(authorizeWaveCompletionSuite(manifest, registration, digest("b"), owner === null ? null : { ...owner, owed: owner.owed.map(invariantId) }));

const EXPECTATION = emptyAcceptanceExpectation(1);

const covered: CoverageVerdict = { kind: "covered" };

const verifiedRun = (survivors: number, killed = 3): MutationVerdict => labelledValue("verified run", verifiedMutationOf({
  killed,
  timedOut: 1,
  invalid: 0,
  survivors: Array.from({ length: survivors }, (_, index) => ({
    mutantId: `m${index}`,
    operator: "comparison-flip" as const,
    line: 2 + index,
    column: 7,
    original: "age >= 18",
    replacement: "age < 18",
  })),
  unmutated: 0,
  ownerChangedInWave: true,
}));

const verdict = (invariant: string, coverage: CoverageVerdict, mutation: MutationVerdict): InvariantVerdict => ({
  invariant: invariantId(invariant),
  title: `${invariant} title`,
  owner: "src/rules/owner.ts",
  matrixTest: "tests/rules.matrix.test.ts",
  coverage,
  mutation,
});

const verified = (verdicts: readonly InvariantVerdict[], obligationsDigest = OBLIGATIONS_DIGEST): OwnerVerificationObservation =>
  ({ kind: "verified", obligationsDigest, boundMs: 120_000, verdicts });

/** A result over every authorized check: lint exits 0, the owner check exits `ownerExit`. */
function resultOf(
  authority: AuthorizedWaveCompletionSuite,
  ownerVerification: OwnerVerificationObservation | undefined,
  ownerExit: number,
): Record<string, unknown> {
  return {
    kind: "wave-completion-suite-result",
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave",
      outcome: {
        kind: "observed",
        exitCode: check.checkId === OWNER_CHECK ? ownerExit : 0,
        timedOut: false,
        signal: null,
        report: { kind: "not-required" },
      },
    })),
    ...(ownerVerification === undefined ? {} : { ownerVerification }),
  };
}

const OWES_INV1 = authorize({ obligationsDigest: OBLIGATIONS_DIGEST, owed: ["INV-1"] });

const evaluate = (observation: OwnerVerificationObservation | undefined, exit: number, authority = OWES_INV1): CompletionSuiteEvaluation =>
  evaluateWaveCompletionSuite(authority, resultOf(authority, observation, exit), EXPECTATION);

const rejected = (evaluation: CompletionSuiteEvaluation) => {
  if (evaluation.kind !== "rejected") throw new Error(`expected a rejection, got ${JSON.stringify(evaluation)}`);
  return evaluation;
};

describe("authorizeWaveCompletionSuite injects the owner check only from its owner parameter", () => {
  it("FR-004: without an owner check authority the roster and its digest are byte-identical to the pre-feature roster", () => {
    const suite = authorize(null);
    expect(suite.checks.map((check) => check.checkId)).toEqual([LINT_CHECK]);
    const preFeature = [{ kind: "engine-full-tier-lint", checkId: LINT_CHECK, scope: "wave", reportPolicy: { kind: "not-required" } }];
    expect(suite.suiteDigest).toBe(sha256Hex(canonicalJson({ kind: "wave-completion-suite-roster", checks: preFeature })));
    expect(value(authorizeWaveCompletionSuite(manifest, registration, digest("b"), null)).suiteDigest).toBe(suite.suiteDigest);
  });

  it("the owner parameter is required: a caller must say null for an unstamped graph, never omit it", () => {
    // Compile-time only (typechecked by `tsc -p engine`); the call is never made.
    const omitted = () =>
      // @ts-expect-error -- omitting the owner check authority does not compile
      authorizeWaveCompletionSuite(manifest, registration, digest("b"));
    expect(typeof omitted).toBe("function");
    expect(authorizeWaveCompletionSuite.length).toBe(4);
  });

  it("copies the obligations digest and the owed ids verbatim, owed [] included", () => {
    for (const owed of [[], ["INV-1"], ["INV-3", "INV-1"]]) {
      const suite = authorize({ obligationsDigest: OBLIGATIONS_DIGEST, owed });
      expect(suite.checks.map((check) => check.checkId)).toEqual([LINT_CHECK, OWNER_CHECK]);
      expect(suite.checks[1]).toEqual({
        kind: "engine-owner-verification",
        checkId: OWNER_CHECK,
        scope: "wave",
        reportPolicy: { kind: "not-required" },
        obligationsDigest: OBLIGATIONS_DIGEST,
        owed,
      });
    }
  });

  it("the owner check is part of the suite digest: its presence, digest and owed ids each change it", () => {
    const digests = new Set([
      authorize(null).suiteDigest,
      authorize({ obligationsDigest: OBLIGATIONS_DIGEST, owed: [] }).suiteDigest,
      authorize({ obligationsDigest: OBLIGATIONS_DIGEST, owed: ["INV-1"] }).suiteDigest,
      authorize({ obligationsDigest: digest("f") as ArtifactDigest, owed: ["INV-1"] }).suiteDigest,
    ]);
    expect(digests.size).toBe(4);
    expect(value(completionSuiteDigest(OWES_INV1.checks))).toBe(OWES_INV1.suiteDigest);
  });
});

describe("parseAuthorizedWaveCompletionCheck — the engine owner check", () => {
  const check = OWES_INV1.checks[1]!;

  it("round-trips the authorized owner check", () => {
    expect(value(parseAuthorizedWaveCompletionCheck(JSON.parse(JSON.stringify(check))))).toEqual(check);
  });

  it.each([
    ["another check id", { checkId: "loom:full-tier-lint" }],
    ["a required report", { reportPolicy: { kind: "required-file", path: ".loom/completion-reports/x.xml" } }],
    ["a task scope", { scope: "task" }],
    ["a malformed obligations digest", { obligationsDigest: "nope" }],
    ["owed that is not an array", { owed: "INV-1" }],
    ["a blank owed id", { owed: [" "] }],
    ["an owed id that is not an Invariant id", { owed: ["LC-1"] }],
    ["a repeated owed id", { owed: ["INV-1", "INV-1"] }],
    ["an extra field", { extra: true }],
  ])("refuses %s", (_case, patch) => {
    expect(parseAuthorizedWaveCompletionCheck({ ...check, ...patch }).ok).toBe(false);
  });

  it("a project command may not take the reserved owner check id", () => {
    expect(parseAuthorizedWaveCompletionCheck({
      kind: "project-command", checkId: OWNER_CHECK, scope: "wave", executable: "vitest", args: ["run"], cwd: ".",
      timeoutMs: 1000, reportPolicy: { kind: "not-required" },
    }).ok).toBe(false);
  });
});

describe("the ownerVerification observation on results and receipts", () => {
  const observation = verified([verdict("INV-1", covered, verifiedRun(0))]);

  it("round-trips through the result parser", () => {
    const parsed = value(parseWaveCompletionSuiteResult(resultOf(OWES_INV1, observation, 0)));
    expect(parsed.ownerVerification).toEqual(observation);
  });

  it("a result without the field parses with no observation, as before", () => {
    expect(value(parseWaveCompletionSuiteResult(resultOf(authorize(null), undefined, 0))).ownerVerification).toBeUndefined();
  });

  it.each([
    ["an unknown observation kind", { kind: "maybe" }],
    ["an unknown infrastructure kind", { kind: "unavailable", failure: { kind: "gremlins", detail: "x" } }],
    ["a blank infrastructure detail", { kind: "unavailable", failure: { kind: "plan-drift", detail: "" } }],
    ["a negative bound", { ...observation, boundMs: -1 }],
    ["an unknown coverage kind", verified([{ ...verdict("INV-1", covered, verifiedRun(0)), coverage: { kind: "partial" } } as unknown as InvariantVerdict])],
    ["missing paths that are empty", verified([verdict("INV-1", { kind: "missing", paths: [] } as unknown as CoverageVerdict, verifiedRun(0))])],
    ["an exemption without a reason", verified([verdict("INV-1", covered, { kind: "exempt", reason: " " })])],
    ["a red baseline with no failing testcase", verified([verdict("INV-1", covered, { kind: "red-baseline", failures: [] } as unknown as MutationVerdict)])],
    ["a generated count its tallies do not derive", verified([verdict("INV-1", covered, { ...verifiedRun(0), generated: 99 } as MutationVerdict)])],
    ["an unknown mutation operator", verified([verdict("INV-1", covered, {
      ...verifiedRun(1), survivors: [{ mutantId: "m", operator: "bit-flip", line: 1, column: 1, original: "a", replacement: "b" }],
    } as unknown as MutationVerdict)])],
    ["mutants over an unchanged owner", verified([verdict("INV-1", covered, { ...verifiedRun(0), ownerChangedInWave: false } as MutationVerdict)])],
    ["a verdict Invariant that is not an Invariant id", verified([{ ...verdict("INV-1", covered, verifiedRun(0)), invariant: "lc-1" } as unknown as InvariantVerdict])],
    ["a verified run whose every mutant is invalid", verified([verdict("INV-1", covered,
      { ...verifiedRun(0, 0), timedOut: 0, invalid: 3, generated: 3 } as unknown as MutationVerdict)])],
  ])("refuses %s", (_case, raw) => {
    expect(parseWaveCompletionSuiteResult(resultOf(OWES_INV1, raw as OwnerVerificationObservation, 0)).ok).toBe(false);
  });
});

describe("evaluateWaveCompletionSuite — the owner check's verdict blocks the gate", () => {
  it("FR-001: a covered, fully killed owned Invariant is accepted and its receipt records the observation", () => {
    const observation = verified([verdict("INV-1", covered, verifiedRun(0))]);
    const evaluation = evaluate(observation, 0);
    if (evaluation.kind !== "accepted") throw new Error(JSON.stringify(evaluation));
    expect(evaluation.receipt.ownerVerification).toEqual(observation);
    const reparsed = value(parseAcceptedWaveCompletionReceipt(JSON.parse(JSON.stringify(evaluation.receipt))));
    expect(reparsed).toEqual(evaluation.receipt);
  });

  it("AS-004: AS-005: a Wave owing nothing is accepted with verified [] and the receipt proves the plan agreed", () => {
    const authority = authorize({ obligationsDigest: OBLIGATIONS_DIGEST, owed: [] });
    const evaluation = evaluate(verified([]), 0, authority);
    if (evaluation.kind !== "accepted") throw new Error(JSON.stringify(evaluation));
    expect(evaluation.receipt.ownerVerification).toEqual(verified([]));
  });

  it("FR-014: a missing sibling is a semantic owner-verification rejection naming the Invariant and path", () => {
    const missing: CoverageVerdict = { kind: "missing", paths: ["src/rules/sibling-b.ts"] };
    const evaluation = rejected(evaluate(verified([verdict("INV-1", missing, verifiedRun(0))]), 1));
    expect(rejectionFailures(evaluation).authority).toEqual([]);
    expect(rejectionFailures(evaluation).semantic).toEqual([{
      kind: "owner-verification-rejected",
      checkId: OWNER_CHECK,
      failures: [{ kind: "missing-siblings", invariant: "INV-1", matrixTest: "tests/rules.matrix.test.ts", paths: ["src/rules/sibling-b.ts"] }],
    }]);
  });

  it("FR-014: every survivor of a non-exempt Invariant blocks", () => {
    const evaluation = rejected(evaluate(verified([verdict("INV-1", covered, verifiedRun(2))]), 1));
    const [failure] = rejectionFailures(evaluation).semantic;
    expect(failure).toMatchObject({ kind: "owner-verification-rejected", checkId: OWNER_CHECK });
    expect(failure?.kind === "owner-verification-rejected" ? failure.failures.map((entry) => entry.kind) : []).toEqual(["survivor", "survivor"]);
  });

  it("AS-008: FR-008: a red baseline is a semantic rejection, never a mutation tally", () => {
    const red: MutationVerdict = { kind: "red-baseline", failures: ["matrix > decides admission"] };
    const evaluation = rejected(evaluate(verified([verdict("INV-1", covered, red)]), 1));
    expect(rejectionFailures(evaluation).semantic).toEqual([{
      kind: "owner-verification-rejected",
      checkId: OWNER_CHECK,
      failures: [{ kind: "red-baseline", invariant: "INV-1", matrixTest: "tests/rules.matrix.test.ts", failures: ["matrix > decides admission"] }],
    }]);
  });

  it("AS-017: FR-016: an infrastructure verdict is an infrastructure failure and never counts as a kill", () => {
    const broken: MutationVerdict = { kind: "infrastructure", failure: { kind: "worktree-failed", detail: "git worktree add failed" } };
    const evaluation = rejected(evaluate(verified([verdict("INV-1", covered, broken)]), 1));
    expect(rejectionFailures(evaluation).semantic).toEqual([]);
    expect(rejectionFailures(evaluation).infrastructure).toEqual([{
      kind: "owner-verification-infrastructure",
      checkId: OWNER_CHECK,
      failures: [{ kind: "infrastructure", invariant: "INV-1", failure: { kind: "worktree-failed", detail: "git worktree add failed" } }],
    }]);
  });

  it.each(["no-valid-mutants", "owner-unparseable"] as const)("FR-016: a %s verdict round-trips and is an infrastructure failure, never a pass or a kill", (kind) => {
    const broken: MutationVerdict = { kind: "infrastructure", failure: { kind, detail: "no mutation evidence" } };
    const observed = verified([verdict("INV-1", covered, broken)]);
    expect(value(parseWaveCompletionSuiteResult(resultOf(OWES_INV1, observed, 1))).ownerVerification).toEqual(observed);
    const evaluation = rejected(evaluate(observed, 1));
    expect(rejectionFailures(evaluation).semantic).toEqual([]);
    expect(rejectionFailures(evaluation).infrastructure).toEqual([{
      kind: "owner-verification-infrastructure",
      checkId: OWNER_CHECK,
      failures: [{ kind: "infrastructure", invariant: "INV-1", failure: { kind, detail: "no mutation evidence" } }],
    }]);
  });

  it("FR-002: an unavailable check (the plan could not be re-read) is an infrastructure failure of the whole check", () => {
    const evaluation = rejected(evaluate({ kind: "unavailable", failure: { kind: "plan-unreadable", detail: "ENOENT" } }, 1));
    expect(rejectionFailures(evaluation).infrastructure).toEqual([{
      kind: "owner-verification-infrastructure",
      checkId: OWNER_CHECK,
      failures: [{ kind: "infrastructure", invariant: null, failure: { kind: "plan-unreadable", detail: "ENOENT" } }],
    }]);
  });

  it("AS-018: FR-020: an exempt Invariant with full coverage is accepted and its receipt records the exemption and reason", () => {
    const observation = verified([verdict("INV-1", covered, { kind: "exempt", reason: "generated lookup table" })]);
    const evaluation = evaluate(observation, 0);
    if (evaluation.kind !== "accepted") throw new Error(JSON.stringify(evaluation));
    expect(evaluation.receipt.ownerVerification).toEqual(observation);
  });

  it("FR-020: an exempt Invariant with a missing sibling still blocks", () => {
    const missing: CoverageVerdict = { kind: "missing", paths: ["src/rules/sibling-b.ts"] };
    const evaluation = rejected(evaluate(verified([verdict("INV-1", missing, { kind: "exempt", reason: "equivalent" })]), 1));
    expect(rejectionFailures(evaluation).semantic.map((failure) => failure.kind)).toEqual(["owner-verification-rejected"]);
  });

  it("the owner check's non-zero exit is explained by its findings, never reported as a separate non-zero exit", () => {
    const evaluation = rejected(evaluate(verified([verdict("INV-1", covered, verifiedRun(1))]), 1));
    expect(rejectionFailures(evaluation).semantic.map((failure) => failure.kind)).toEqual(["owner-verification-rejected"]);
  });
});

describe("evaluateWaveCompletionSuite — the observation is bound to the authorized owner check", () => {
  const mismatch = (evaluation: CompletionSuiteEvaluation) =>
    rejectionFailures(rejected(evaluation)).authority.map((failure) => failure.kind);

  it("an authorized owner check without an observation is an authority failure", () => {
    expect(mismatch(evaluate(undefined, 0))).toEqual(["owner-verification-mismatch"]);
  });

  it("an observation the suite never authorized is an authority failure", () => {
    expect(mismatch(evaluate(verified([]), 0, authorize(null)))).toEqual(["owner-verification-mismatch"]);
  });

  it("an observation verified against other obligations is an authority failure", () => {
    const observation = verified([verdict("INV-1", covered, verifiedRun(0))], digest("f") as ArtifactDigest);
    expect(mismatch(evaluate(observation, 0))).toEqual(["owner-verification-mismatch"]);
  });

  it("verdicts for other Invariants than the owed ones are an authority failure", () => {
    expect(mismatch(evaluate(verified([]), 0))).toEqual(["owner-verification-mismatch"]);
    expect(mismatch(evaluate(verified([verdict("INV-2", covered, verifiedRun(0))]), 0))).toEqual(["owner-verification-mismatch"]);
  });

  it("an owner check exit that contradicts its findings is an authority failure", () => {
    expect(mismatch(evaluate(verified([verdict("INV-1", covered, verifiedRun(0))]), 1))).toEqual(["owner-verification-mismatch"]);
    expect(mismatch(evaluate(verified([verdict("INV-1", covered, verifiedRun(1))]), 0))).toEqual(["owner-verification-mismatch"]);
  });

  /** A passing observation whose owner check outcome is overridden by `process`, its exit agreeing with the findings. */
  const withOwnerProcess = (process: Readonly<{ timedOut: boolean; signal: string | null }>): CompletionSuiteEvaluation => {
    const result = resultOf(OWES_INV1, verified([verdict("INV-1", covered, verifiedRun(0))]), 0);
    const checks = (result.checks as readonly Record<string, unknown>[]).map((check) => check.checkId === OWNER_CHECK
      ? { ...check, outcome: { ...(check.outcome as Record<string, unknown>), ...process } }
      : check);
    return evaluateWaveCompletionSuite(OWES_INV1, { ...result, checks }, EXPECTATION);
  };

  it.each([
    ["timed out", { timedOut: true, signal: null }],
    ["signalled", { timedOut: false, signal: "SIGTERM" }],
    ["timed out and signalled", { timedOut: true, signal: "SIGKILL" }],
  ] as const)("an owner check outcome that %s is an authority failure, whatever its exit and findings", (_case, process) => {
    expect(withOwnerProcess({ timedOut: false, signal: null }).kind).toBe("accepted");
    expect(mismatch(withOwnerProcess(process))).toEqual(["owner-verification-mismatch"]);
  });
});

describe("parseAcceptedWaveCompletionReceipt — a receipt proves its owner verification passed", () => {
  it("refuses a receipt whose observation carries a blocking finding", () => {
    const evaluation = evaluate(verified([verdict("INV-1", covered, verifiedRun(0))]), 0);
    if (evaluation.kind !== "accepted") throw new Error(JSON.stringify(evaluation));
    const tampered = {
      ...evaluation.receipt,
      ownerVerification: verified([verdict("INV-1", covered, verifiedRun(1))]),
    };
    expect(parseAcceptedWaveCompletionReceipt(JSON.parse(JSON.stringify(tampered))).ok).toBe(false);
  });

  it("refuses a receipt whose observation changed after its result digest was minted", () => {
    const evaluation = evaluate(verified([verdict("INV-1", covered, verifiedRun(0))]), 0);
    if (evaluation.kind !== "accepted") throw new Error(JSON.stringify(evaluation));
    const tampered = {
      ...evaluation.receipt,
      ownerVerification: verified([verdict("INV-1", covered, verifiedRun(0, 4))]),
    };
    expect(parseAcceptedWaveCompletionReceipt(JSON.parse(JSON.stringify(tampered))).ok).toBe(false);
  });

  /** The receipt with `change` applied and its result digest re-minted, so only the owner proof can refuse it. */
  const resigned = (change: (body: Record<string, unknown>) => Record<string, unknown>) => {
    const evaluation = evaluate(verified([verdict("INV-1", covered, verifiedRun(0))]), 0);
    if (evaluation.kind !== "accepted") throw new Error(JSON.stringify(evaluation));
    const { resultDigest: _digest, ...body } = JSON.parse(JSON.stringify(evaluation.receipt)) as Record<string, unknown>;
    const changed = change(body);
    return { ...changed, resultDigest: sha256Hex(canonicalJson(changed as Parameters<typeof canonicalJson>[0])) };
  };

  it("#132: refuses a re-signed receipt whose roster carries the owner check without its observation", () => {
    const stripped = resigned(({ ownerVerification: _owner, ...rest }) => rest);
    expect(parseAcceptedWaveCompletionReceipt(stripped)).toMatchObject({
      ok: false, error: { errors: ["acceptedReceipt carries loom:owner-verification without its ownerVerification observation"] },
    });
  });

  it("#132: refuses a re-signed receipt carrying an observation its roster has no owner check for", () => {
    const orphaned = resigned((body) => ({
      ...body,
      checks: (body.checks as readonly Record<string, unknown>[]).filter(({ checkId }) => checkId !== OWNER_VERIFICATION_CHECK_ID_TEXT),
    }));
    expect(parseAcceptedWaveCompletionReceipt(orphaned)).toMatchObject({
      ok: false, error: { errors: ["acceptedReceipt.ownerVerification is present, but its roster carries no loom:owner-verification check"] },
    });
  });

  it("#132: refuses a re-signed receipt whose owner check exits other than its clean observation derives", () => {
    const flipped = resigned((body) => ({
      ...body,
      checks: (body.checks as readonly Record<string, unknown>[]).map((check) => check.checkId === OWNER_VERIFICATION_CHECK_ID_TEXT
        ? { ...check, outcome: { ...(check.outcome as Record<string, unknown>), exitCode: 1 } }
        : check),
    }));
    // The observation carries no finding, so it derives exit 0; the receipt's own successful-check proof refuses exit 1.
    expect(parseAcceptedWaveCompletionReceipt(flipped)).toMatchObject({
      ok: false, error: { errors: [`acceptedReceipt.checks check ${OWNER_VERIFICATION_CHECK_ID_TEXT} is not a successful completion result`] },
    });
  });

  it("#132: an untampered receipt passes the owner proof, re-signed or not", () => {
    expect(parseAcceptedWaveCompletionReceipt(resigned((body) => body)).ok).toBe(true);
  });
});

describe("ownerCheckResult — the owner check's one result constructor (#132)", () => {
  it("derives the exit from the observation: 0 with no blocking finding, 1 with one, never chosen", () => {
    const check = ownerCheckOf(OWES_INV1)!;
    const exitOf = (observation: OwnerVerificationObservation) => {
      const { outcome } = ownerCheckResult(check, observation);
      return outcome.kind === "observed" ? outcome.exitCode : null;
    };
    expect(exitOf(verified([verdict("INV-1", covered, verifiedRun(0))]))).toBe(0);
    expect(exitOf(verified([verdict("INV-1", covered, verifiedRun(1))]))).toBe(1);
    expect(exitOf({ kind: "unavailable", failure: { kind: "plan-unreadable", detail: "ENOENT" } })).toBe(1);
    expect(ownerCheckResult(check, verified([]))).toMatchObject({
      checkId: OWNER_VERIFICATION_CHECK_ID, scope: "wave",
      outcome: { kind: "observed", timedOut: false, signal: null, report: { kind: "not-required" } },
    });
  });
});

describe("the reserved owner check id", () => {
  it("is parsed once, and is the id an unauthorized observation's mismatch is reported against", () => {
    expect(OWNER_VERIFICATION_CHECK_ID).toBe(OWNER_VERIFICATION_CHECK_ID_TEXT);
    expect(value(parseCompletionCheckId(OWNER_VERIFICATION_CHECK_ID_TEXT))).toBe(OWNER_VERIFICATION_CHECK_ID);
    expect(rejectionFailures(rejected(evaluate(verified([]), 0, authorize(null)))).authority).toEqual([{
      kind: "owner-verification-mismatch",
      checkId: OWNER_VERIFICATION_CHECK_ID,
      reason: "the result carries an owner-verification observation its suite does not authorize",
    }]);
  });
});

describe("the rejection's cause — one decision for what a rejection means to the gate (#132)", () => {
  const broken: MutationVerdict = { kind: "infrastructure", failure: { kind: "worktree-failed", detail: "git worktree add failed" } };
  const missing: CoverageVerdict = { kind: "missing", paths: ["src/rules/sibling-b.ts"] };

  /** The owner result with the lint check's process replaced by a spawn failure. */
  const lintUnstartable = (observation: OwnerVerificationObservation, ownerExit: number): CompletionSuiteEvaluation => {
    const result = resultOf(OWES_INV1, observation, ownerExit);
    const checks = (result.checks as readonly Record<string, unknown>[]).map((check) => check.checkId === LINT_CHECK
      ? { ...check, outcome: { kind: "spawn-failed", message: "lint could not start" } }
      : check);
    return evaluateWaveCompletionSuite(OWES_INV1, { ...result, checks }, EXPECTATION);
  };

  it.each([
    ["authority: an owner observation the suite does not bind", () => evaluate(undefined, 0), "authority"],
    ["infrastructure: another check could not run, even beside an owner finding", () => lintUnstartable(verified([verdict("INV-1", missing, broken)]), 1), "infrastructure"],
    ["owner-undecided: only the owner check could not decide", () => evaluate(verified([verdict("INV-1", covered, broken)]), 1), "owner-undecided"],
    ["owner-undecided: the whole owner check was unavailable", () => evaluate({ kind: "unavailable", failure: { kind: "plan-unreadable", detail: "ENOENT" } }, 1), "owner-undecided"],
    ["semantic: a decided owner finding", () => evaluate(verified([verdict("INV-1", missing, verifiedRun(0))]), 1), "semantic"],
    ["semantic: a decided finding beside an undecided one", () => evaluate(verified([verdict("INV-1", missing, broken)]), 1), "semantic"],
  ] as const)("%s", (_case, evaluation, kind) => {
    expect(rejected(evaluation()).cause).toBe(kind);
  });

  it("a semantic rejection carries the decided failures, and the owner check's undecided findings beside them", () => {
    const evaluation = rejected(evaluate(verified([verdict("INV-1", missing, broken)]), 1));
    if (evaluation.cause !== "semantic") throw new Error(`expected a semantic rejection, got ${evaluation.cause}`);
    expect(evaluation.semanticFailures.map((failure) => failure.kind)).toEqual(["owner-verification-rejected"]);
    expect(evaluation.ownerUndecided?.kind).toBe("owner-verification-infrastructure");
    expect(rejectionFailures(evaluation).infrastructure).toEqual([evaluation.ownerUndecided]);
  });

  it("an infrastructure rejection holds only the other checks' failures, the owner check's undecided finding beside them", () => {
    const evaluation = rejected(lintUnstartable(verified([verdict("INV-1", missing, broken)]), 1));
    if (evaluation.cause !== "infrastructure") throw new Error(`expected an infrastructure rejection, got ${evaluation.cause}`);
    expect(evaluation.infrastructureFailures.map((failure) => failure.kind)).toEqual(["spawn-failed"]);
    expect(evaluation.ownerUndecided?.kind).toBe("owner-verification-infrastructure");
    expect(rejectionFailures(evaluation).infrastructure.map((failure) => failure.kind)).toEqual(["spawn-failed", "owner-verification-infrastructure"]);
  });

  it("every rejection carries at least one failure: an empty rejection cannot be written", () => {
    const cases = [
      evaluate(undefined, 0),
      lintUnstartable(verified([verdict("INV-1", missing, broken)]), 1),
      evaluate(verified([verdict("INV-1", covered, broken)]), 1),
      evaluate(verified([verdict("INV-1", missing, verifiedRun(0))]), 1),
    ];
    for (const evaluation of cases) {
      const { authority, infrastructure, semantic } = rejectionFailures(rejected(evaluation));
      expect(authority.length + infrastructure.length + semantic.length).toBeGreaterThan(0);
    }
    // @ts-expect-error a rejection names its cause and carries that cause's non-empty failures
    const empty: RejectedCompletionSuite = { kind: "rejected", cause: "authority", authorityFailures: [] };
    expect(empty.kind).toBe("rejected");
  });
});

describe("publicationSlotOf — where a rejected result is published, decided once from its cause", () => {
  const broken: MutationVerdict = { kind: "infrastructure", failure: { kind: "worktree-failed", detail: "git worktree add failed" } };
  const missing: CoverageVerdict = { kind: "missing", paths: ["src/rules/sibling-b.ts"] };

  it.each([
    ["semantic", () => evaluate(verified([verdict("INV-1", missing, verifiedRun(0))]), 1), "result-slot"],
    ["owner-undecided", () => evaluate(verified([verdict("INV-1", covered, broken)]), 1), "owner-attempt"],
    ["authority", () => evaluate(undefined, 0), "none"],
  ] as const)("%s → %s", (_case, evaluation, slot) => {
    expect(publicationSlotOf(rejected(evaluation()))).toBe(slot);
  });
});
