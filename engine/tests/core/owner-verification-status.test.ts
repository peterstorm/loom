/**
 * T11 / AD-10 status half, core rows: the owner-verification report, the
 * persisted-result read that derives it, the remedy wording (`verdict.ts`,
 * the one source the gate's diagnostic and the readiness rejection share),
 * and the next-action merge. Every row here exercises a pure function:
 * `renderOwnerVerificationStatus`, `ownerVerificationReportOf` over every
 * persisted result observation, and `withOwnerVerificationRemedies`, which
 * reads its remedies off the readiness rejection itself (#135).
 *
 * The shell rows (`renderStatus`, the renderer behind `helper orchestration
 * status [--json]`, and the AS-029/AS-030 human/--json parity) live in
 * `tests/handlers/owner-verification-status-render.test.ts`; both share the
 * persisted-result builder in `tests/fixtures/persisted-completion-result.ts`.
 */

import { describe, expect, it } from "vitest";
import { renderOwnerVerificationStatus } from "../../src/core/owner-verification/status";
import { ownerVerificationFailures, renderOwnerVerificationFailure } from "../../src/core/owner-verification/verdict";
import { ownerVerificationFindingLines, evaluateWaveCompletionSuite } from "../../src/core/completion-suite";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationVerdict,
  OwnerVerificationObservation,
} from "../../src/core/owner-verification/types";
import {
  deriveLoomStatusFromParsedGraph,
  ownerVerificationReportOf,
  withOwnerVerificationRemedies,
} from "../../src/core/loom-status";
import type { LoomStatus, WaveCompletionResultObservation } from "../../src/types";
import { digest } from "../fixtures/acceptance-fixtures";
import { invariantId } from "../fixtures/owner-obligation";
import { emptyAcceptanceExpectation } from "../../src/core/acceptance-contract";
import {
  SURVIVOR,
  ledgerAuthority,
  ledgerGraph,
  ledgerStatusDeps,
  ledgerVerdict,
  ownerVerificationIn,
  persistedOwnerResult,
  suiteResultOf,
  survivorVerdict,
  verifiedRun,
} from "../fixtures/persisted-completion-result";

const verdict = (invariant: string, coverage: CoverageVerdict, mutation: MutationVerdict): InvariantVerdict => ({
  invariant: invariantId(invariant),
  title: `${invariant} title`,
  owner: `src/${invariant}.ts`,
  matrixTest: `tests/${invariant}.matrix.test.ts`,
  coverage,
  mutation,
});

const observed = (verdicts: readonly InvariantVerdict[], boundMs = 60_000): OwnerVerificationObservation =>
  ({ kind: "verified", obligationsDigest: digest("d"), boundMs, verdicts });

/** Each blocking finding's remedy line, as the gate's diagnostic and the readiness rejection word it. */
const remediesOf = (observation: OwnerVerificationObservation): readonly string[] =>
  ownerVerificationFailures(observation).map(renderOwnerVerificationFailure);

describe("the report", () => {
  it("stores no survivor count beside the survivors: the count is derived where it is rendered", () => {
    const survivors = [SURVIVOR, { ...SURVIVOR, mutantId: "e".repeat(64) }];
    const observation = observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors, unmutated: 0 })),
    ]);
    expect(observation.kind === "verified" ? observation.verdicts[0]?.mutation : null).not.toHaveProperty("survived");
    expect(renderOwnerVerificationStatus(observation).join("\n")).toMatch(/survived 2,/);
  });
});

describe("remedy wording: one line per blocking finding (verdict.ts)", () => {
  it("names no remedy without a blocking finding", () => {
    expect(remediesOf(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 2, timedOut: 0, invalid: 1, survivors: [], unmutated: 0 })),
    ]))).toEqual([]);
  });

  it("AS-030: a missing sibling names the Invariant, the matrix test and the path it must import", () => {
    const [remedy, ...rest] = remediesOf(observed([
      verdict("INV-1", { kind: "missing", paths: ["src/jobs/invoice.ts"] }, { kind: "exempt", reason: "r" }),
    ]));
    expect(rest).toEqual([]);
    expect(remedy).toContain("INV-1");
    expect(remedy).toMatch(/strengthen tests\/INV-1\.matrix\.test\.ts to import/);
    expect(remedy).toContain("src/jobs/invoice.ts");
  });

  it("AS-030: a survivor names the Invariant, its owner line and operator, and both remedies", () => {
    const [remedy] = remediesOf(observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [SURVIVOR], unmutated: 0 })),
    ]));
    expect(remedy).toContain("INV-1");
    expect(remedy).toContain(`src/INV-1.ts:${SURVIVOR.line}`);
    expect(remedy).toContain(SURVIVOR.operator);
    expect(remedy).toMatch(/strengthen tests\/INV-1\.matrix\.test\.ts to kill it/);
    expect(remedy).toMatch(/declare a mutation exemption with a reason on INV-1/);
  });

  it("names a red baseline and an infrastructure failure with their Invariant", () => {
    const remedies = remediesOf(observed([
      verdict("INV-2", { kind: "covered" }, { kind: "red-baseline", failures: ["row 3"] }),
      verdict("INV-3", { kind: "covered" }, { kind: "infrastructure", failure: { kind: "spawn-failed", detail: "ENOENT" } }),
    ]));
    expect(remedies).toHaveLength(2);
    expect(remedies[0]).toMatch(/^INV-2: .*red.*row 3/);
    expect(remedies[1]).toMatch(/^INV-3: infrastructure failure \(spawn-failed\)/);
    expect(remediesOf({ kind: "unavailable", failure: { kind: "runner-missing", detail: "no runner" } }))
      .toEqual(["owner verification: infrastructure failure (runner-missing): no runner"]);
  });
});

describe("renderOwnerVerificationStatus", () => {
  it("renders one line per Invariant with coverage, counts, exemption and the bound", () => {
    const lines = renderOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "missing", paths: ["src/x.ts"] }, verifiedRun({ killed: 5, timedOut: 2, invalid: 1, survivors: [SURVIVOR], unmutated: 3 })),
      verdict("INV-2", { kind: "covered" }, { kind: "exempt", reason: "timing-only" }),
    ], 1_500));
    const text = lines.join("\n");
    expect(text).toContain("- ownerVerification: 2 Invariant(s), bound 1500 ms");
    expect(text).toMatch(/INV-1.*coverage missing src\/x\.ts.*generated 9, killed 5, timed out 2, invalid 1, survived 1, unmutated 3/);
    expect(text).toContain(`src/INV-1.ts:${SURVIVOR.line}:${SURVIVOR.column} (${SURVIVOR.operator})`);
    expect(text).toMatch(/INV-2.*coverage pass.*mutation exempt: timing-only/);
  });

  it("renders a red baseline, an infrastructure failure, coverage infrastructure and an unchanged owner", () => {
    const text = renderOwnerVerificationStatus(observed([
      verdict("INV-1", { kind: "infrastructure", failure: { kind: "coverage-bound-exceeded", detail: "too many files" } },
        { kind: "red-baseline", failures: ["row 3"] }),
      verdict("INV-2", { kind: "covered" }, { kind: "infrastructure", failure: { kind: "worktree-failed", detail: "no space" } }),
      verdict("INV-3", { kind: "covered" }, verifiedRun({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 }, false)),
    ])).join("\n");
    expect(text).toMatch(/INV-1.*coverage infrastructure failure \(coverage-bound-exceeded\): too many files; mutation baseline red: row 3/);
    expect(text).toMatch(/INV-2.*mutation infrastructure failure \(worktree-failed\): no space/);
    expect(text).toMatch(/INV-3.*\(owner unchanged in Wave\)/);
  });

  it("renders verdicts in the observation's order and a header alone for a Wave that owes none", () => {
    expect(renderOwnerVerificationStatus(observed([]))).toEqual(["- ownerVerification: 0 Invariant(s), bound 60000 ms"]);
    const text = renderOwnerVerificationStatus(observed([
      verdict("INV-7", { kind: "covered" }, { kind: "exempt", reason: "r" }),
      verdict("INV-2", { kind: "covered" }, { kind: "exempt", reason: "r" }),
    ])).join("\n");
    expect(text.indexOf("INV-7")).toBeLessThan(text.indexOf("INV-2"));
  });

  it("renders not-observed and unavailable reports", () => {
    expect(renderOwnerVerificationStatus({ kind: "not-observed", reason: "the result is unreadable" }).join("\n"))
      .toMatch(/ownerVerification: not observed \(the result is unreadable\)/);
    expect(renderOwnerVerificationStatus({ kind: "unavailable", failure: { kind: "plan-unreadable", detail: "gone" } }).join("\n"))
      .toMatch(/ownerVerification: unavailable \(plan-unreadable\): gone/);
  });
});


describe("renderOwnerVerificationStatus: why a run generated no mutant, and an unresolvable tsconfig", () => {
  it("says when a changed owner offered no mutable construct on its changed lines", () => {
    const text = renderOwnerVerificationStatus(observed([
      verdict("INV-4", { kind: "covered" }, verifiedRun({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 })),
    ])).join("\n");
    expect(text).toMatch(/INV-4.*mutation generated 0, .*unmutated 0 \(no mutable construct on the owner's changed lines\)/);
  });

  it("renders an unresolvable tsconfig as alias-config-unresolvable coverage, and names it in the remedy", () => {
    const failure = { kind: "alias-config-unresolvable", detail: "tsconfig tsconfig.json does not parse" } as const;
    const observation = observed([verdict("INV-5", { kind: "infrastructure", failure }, { kind: "exempt", reason: "r" })]);
    expect(renderOwnerVerificationStatus(observation).join("\n"))
      .toMatch(/INV-5.*coverage infrastructure failure \(alias-config-unresolvable\): tsconfig tsconfig\.json does not parse/);
    expect(remediesOf(observation)).toEqual(["INV-5: infrastructure failure (alias-config-unresolvable): tsconfig tsconfig.json does not parse"]);
  });
});

// ---------------------------------------------------------------------------
// The persisted result read and the next-action merge
// ---------------------------------------------------------------------------

const OWNER_REMEDY = /owner verification blocks the Wave Gate/;

describe("ownerVerificationReportOf: the persisted result, decided once", () => {
  it("reports no persisted result as not observed, whether status read none or was given none", () => {
    for (const result of [undefined, { kind: "absent" } as const]) {
      expect(ownerVerificationReportOf(result)).toEqual({ kind: "not-observed", reason: "no persisted completion result" });
    }
  });

  it("reports a persisted result status could not read as not observed, naming the read failure", () => {
    expect(ownerVerificationReportOf({ kind: "unavailable", reason: "EIO" }))
      .toEqual({ kind: "not-observed", reason: "the persisted completion result is unavailable: EIO" });
  });

  it("reports a persisted result without owner verification as not observed, saying so", () => {
    const result = suiteResultOf(ledgerAuthority(false), () => 0);
    expect(ownerVerificationReportOf({ kind: "observed", result }))
      .toEqual({ kind: "not-observed", reason: "the persisted completion result carries no owner verification" });
  });

  it("reports a persisted owner verification as the observation itself, with no status-only copy", () => {
    const result = persistedOwnerResult([survivorVerdict()]);
    expect(ownerVerificationReportOf(result)).toBe(ownerVerificationIn(result));
  });
});

describe("#135: the readiness rejection and its remedies are one value", () => {
  /** The status document of `result`, its readiness fact, and the rejection the gate judged it as. */
  const derived = (result: WaveCompletionResultObservation) => {
    const { ownerVerification: _report, ...status } = deriveLoomStatusFromParsedGraph({ ok: true, value: ledgerGraph() }, ledgerStatusDeps(result));
    const suite = status.facts.waveCompletionSuiteReadiness;
    if (suite.kind !== "known") throw new Error("fixture suite readiness must be known");
    if (result.kind !== "observed") throw new Error("fixture result must be observed");
    const evaluation = evaluateWaveCompletionSuite(ledgerAuthority(true), result.result, emptyAcceptanceExpectation(1));
    return { status, readiness: suite.value, evaluation };
  };

  it("the rejection carries the gate diagnostic's own owner lines, and the next action names exactly them", () => {
    const { status, readiness, evaluation } = derived(persistedOwnerResult([survivorVerdict()]));
    if (readiness.kind !== "rejected" || evaluation.kind !== "rejected") throw new Error("fixture suite must be rejected");
    expect(readiness.ownerVerificationRemedies).toEqual(ownerVerificationFindingLines(evaluation));
    expect(readiness.ownerVerificationRemedies).toHaveLength(1);
    const ownerReasons = status.next.reasons.filter(({ message }) => OWNER_REMEDY.test(message)).map(({ message }) => message);
    expect(ownerReasons).toEqual(readiness.ownerVerificationRemedies!.map((remedy) => `owner verification blocks the Wave Gate: ${remedy}`));
  });

  it("adds one completion-prerequisite reason per remedy the rejection carries, after the routed reasons", () => {
    const { status, readiness } = derived(persistedOwnerResult([ledgerVerdict(
      { kind: "missing", paths: ["src/api/post.ts"] },
      verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [SURVIVOR], unmutated: 0 }),
    )]));
    if (readiness.kind !== "rejected" || readiness.ownerVerificationRemedies === null) throw new Error("fixture must reject for owner verification");
    expect(readiness.ownerVerificationRemedies).toHaveLength(2);
    const routed: LoomStatus = {
      ...status,
      next: { ...status.next, reasons: [status.next.reasons[0]!] },
    };
    const merged = withOwnerVerificationRemedies(routed);
    expect(merged.next.reasons.slice(1)).toEqual(readiness.ownerVerificationRemedies.map((remedy) => ({
      kind: "completion-prerequisite-failed", taskId: null, message: `owner verification blocks the Wave Gate: ${remedy}`,
    })));
  });

  it("adds none when the rejection carries no owner remedy, whatever the persisted observation says", () => {
    const { status, readiness } = derived(persistedOwnerResult([survivorVerdict()]));
    if (readiness.kind !== "rejected") throw new Error("fixture suite must be rejected");
    const withoutOwner: LoomStatus = {
      ...status,
      facts: {
        ...status.facts,
        waveCompletionSuiteReadiness: { kind: "known", value: { ...readiness, failureKinds: ["non-zero-exit"], ownerVerificationRemedies: null } },
      },
    };
    expect(withOwnerVerificationRemedies(withoutOwner)).toBe(withoutOwner);
  });

  it("a rejection without owner findings carries no remedy: a project check that fails alone", () => {
    const authority = ledgerAuthority(true);
    const result = persistedOwnerResult([ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 }))]);
    if (result.kind !== "observed") throw new Error("fixture result must be observed");
    const failing = { kind: "observed" as const, result: { ...result.result, checks: result.result.checks.map((check, index) =>
      index === 0 ? { ...check, outcome: { ...check.outcome, exitCode: 1 } } : check) } };
    const evaluation = evaluateWaveCompletionSuite(authority, failing.result, emptyAcceptanceExpectation(1));
    if (evaluation.kind !== "rejected") throw new Error("a failing lint check must reject");
    expect(ownerVerificationFindingLines(evaluation)).toEqual([]);
    const { readiness } = derived(failing);
    expect(readiness).toMatchObject({ kind: "rejected", ownerVerificationRemedies: null });
  });
});
