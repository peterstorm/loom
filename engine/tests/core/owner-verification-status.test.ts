/**
 * T11 / AD-10 status half, core rows: the one owner-verification status
 * value (the report and its remedies), the persisted-result read that derives
 * it, and the next-action merge that consumes it. Every row here exercises a
 * pure function: `observedOwnerVerificationStatus` over every verdict kind
 * and blocking finding, `renderOwnerVerificationStatus`,
 * `ownerVerificationStatusOf` over every persisted result observation, and
 * `withOwnerVerificationRemedies` over the readiness gate.
 *
 * The shell rows (`renderStatus`, the renderer behind `helper orchestration
 * status [--json]`, and the AS-029/AS-030 human/--json parity) live in
 * `tests/handlers/owner-verification-status-render.test.ts`; both share the
 * persisted-result builder in `tests/fixtures/persisted-completion-result.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  observedOwnerVerificationStatus,
  ownerVerificationNotObserved,
  renderOwnerVerificationStatus,
} from "../../src/core/owner-verification/status";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationVerdict,
  OwnerVerificationObservation,
} from "../../src/core/owner-verification/types";
import {
  deriveLoomStatusFromParsedGraph,
  ownerVerificationStatusOf,
  withOwnerVerificationRemedies,
} from "../../src/core/loom-status";
import type { LoomStatus, WaveCompletionResultObservation } from "../../src/types";
import { digest } from "../fixtures/acceptance-fixtures";
import { invariantId } from "../fixtures/owner-obligation";
import {
  SURVIVOR,
  ledgerAuthority,
  ledgerGraph,
  ledgerStatusDeps,
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

const remediesOf = (observation: OwnerVerificationObservation): readonly string[] =>
  observedOwnerVerificationStatus(observation).remedies;

describe("observedOwnerVerificationStatus: the report", () => {
  it("reports the persisted observation itself, verdicts and bound as the gate judged them, with no status-only copy", () => {
    const observation = observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 5, timedOut: 2, invalid: 1, survivors: [SURVIVOR], unmutated: 3 })),
      verdict("INV-2", { kind: "missing", paths: ["src/a.ts"] }, { kind: "exempt", reason: "timing-only" }),
    ], 90_000);
    expect(observedOwnerVerificationStatus(observation).report).toBe(observation);
  });

  it("reports the whole check's infrastructure failure when it could not run", () => {
    const failure = { kind: "plan-drift", detail: "the plan gained INV-9" } as const;
    const observation: OwnerVerificationObservation = { kind: "unavailable", failure };
    expect(observedOwnerVerificationStatus(observation).report).toEqual({ kind: "unavailable", failure });
  });

  it("stores no survivor count beside the survivors: the count is derived where it is rendered", () => {
    const survivors = [SURVIVOR, { ...SURVIVOR, mutantId: "e".repeat(64) }];
    const observation = observed([
      verdict("INV-1", { kind: "covered" }, verifiedRun({ killed: 1, timedOut: 0, invalid: 0, survivors, unmutated: 0 })),
    ]);
    const { report } = observedOwnerVerificationStatus(observation);
    expect(report.kind === "verified" ? report.verdicts[0]?.mutation : null).not.toHaveProperty("survived");
    expect(renderOwnerVerificationStatus(report).join("\n")).toMatch(/survived 2,/);
  });
});

describe("observedOwnerVerificationStatus: the remedies", () => {
  it("names no remedy without a blocking finding, and none for a status that observed nothing", () => {
    expect(ownerVerificationNotObserved("no persisted completion result").remedies).toEqual([]);
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

describe("ownerVerificationStatusOf: the persisted result, decided once", () => {
  it("reports no persisted result as not observed, owing no remedy, whether status read none or was given none", () => {
    for (const result of [undefined, { kind: "absent" } as const]) {
      expect(ownerVerificationStatusOf(result)).toEqual({
        report: { kind: "not-observed", reason: "no persisted completion result" }, remedies: [],
      });
    }
  });

  it("reports a persisted result status could not read as not observed, naming the read failure, owing no remedy", () => {
    expect(ownerVerificationStatusOf({ kind: "unavailable", reason: "EIO" })).toEqual({
      report: { kind: "not-observed", reason: "the persisted completion result is unavailable: EIO" }, remedies: [],
    });
  });

  it("reports a persisted result without owner verification as not observed, saying so", () => {
    const result = suiteResultOf(ledgerAuthority(false), () => 0);
    expect(ownerVerificationStatusOf({ kind: "observed", result })).toEqual({
      report: { kind: "not-observed", reason: "the persisted completion result carries no owner verification" }, remedies: [],
    });
  });

  it("reports a persisted owner verification as itself, with its blocking findings as remedies", () => {
    const result = persistedOwnerResult([survivorVerdict()]);
    const ownerVerification = ownerVerificationIn(result);
    expect(ownerVerificationStatusOf(result)).toEqual(observedOwnerVerificationStatus(ownerVerification));
    expect(ownerVerificationStatusOf(result).remedies).toHaveLength(1);
  });
});

describe("withOwnerVerificationRemedies: the readiness gate", () => {
  /** The routed status of `result` (remedies already merged) and its owner-verification status. */
  const derived = (result: WaveCompletionResultObservation) => {
    const { ownerVerification: _report, ...status } = deriveLoomStatusFromParsedGraph({ ok: true, value: ledgerGraph() }, ledgerStatusDeps(result));
    return { status, owner: ownerVerificationStatusOf(result) };
  };

  it("adds one reason per remedy when the suite rejected the Wave for owner verification", () => {
    const { status, owner } = derived(persistedOwnerResult([survivorVerdict()]));
    const merged = withOwnerVerificationRemedies(status, owner);
    expect(merged.next.reasons).toHaveLength(status.next.reasons.length + owner.remedies.length);
    expect(merged.next.reasons.at(-1)?.message).toMatch(OWNER_REMEDY);
  });

  it("adds none when the persisted result carries a survivor but the suite was rejected only for another failure kind", () => {
    const { status, owner } = derived(persistedOwnerResult([survivorVerdict()]));
    const suite = status.facts.waveCompletionSuiteReadiness;
    if (suite.kind !== "known" || suite.value.kind !== "rejected") throw new Error("fixture suite must be rejected");
    const otherOnly: LoomStatus = {
      ...status,
      facts: { ...status.facts, waveCompletionSuiteReadiness: { ...suite, value: { ...suite.value, failureKinds: ["non-zero-exit"] } } },
    };
    expect(owner.remedies).not.toEqual([]);
    expect(withOwnerVerificationRemedies(otherOnly, owner)).toBe(otherOnly);
  });

  it("explains a rejection for owner verification whose status observed nothing to remedy, naming the not-observed reason", () => {
    const { status } = derived(persistedOwnerResult([survivorVerdict()]));
    const merged = withOwnerVerificationRemedies(status, ownerVerificationNotObserved("no persisted completion result"));
    expect(merged.next.reasons).toEqual([
      ...status.next.reasons,
      {
        kind: "completion-prerequisite-failed", taskId: null,
        message: "owner verification rejected the Wave but no per-Invariant remedy could be read (no persisted completion result)",
      },
    ]);
  });

  it("explains a rejection for owner verification whose observation names no blocking Invariant", () => {
    const result = persistedOwnerResult([survivorVerdict()]);
    const { status } = derived(result);
    const observation = ownerVerificationIn(result);
    if (observation.kind !== "verified") throw new Error("fixture owner verification must be verified");
    const merged = withOwnerVerificationRemedies(status, observedOwnerVerificationStatus({ ...observation, verdicts: [] }));
    expect(merged.next.reasons.at(-1)).toEqual({
      kind: "completion-prerequisite-failed", taskId: null,
      message: "owner verification rejected the Wave but no per-Invariant remedy could be read " +
        "(the persisted owner verification names no blocking Invariant)",
    });
    expect(merged.next.reasons).toHaveLength(status.next.reasons.length + 1);
  });
});
