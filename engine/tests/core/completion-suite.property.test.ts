import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FULL_TIER_LINT_CHECK_ID_TEXT,
  MAX_COMPLETION_CHECK_TIMEOUT_MS,
  MIN_COMPLETION_CHECK_TIMEOUT_MS,
  completionSuiteDigest,
  createAuthorizedWaveCompletionSuite,
  evaluateWaveCompletionSuite,
  parseAcceptedWaveCompletionReceipt,
  parseAuthorizedWaveCompletionCheck,
  parseAuthorizedWaveCompletionSuite,
  parseCompletionCheckId,
  parseCompletionCheckResult,
  parseCompletionProcessOutcome,
  parseCompletionReportOutcome,
  parseRegistrationRevision,
  parseWaveCompletionSuiteResult,
  parseWaveNumber,
  type AuthorizedWaveCompletionSuite,
  type AcceptedWaveCompletionReceipt,
  type CompletionCheckResult,
} from "../../src/core/completion-suite";
import { canonicalJson, sha256Hex } from "../../src/core/review-packet";

const digest = (character: string): string => character.repeat(64);

const notRequiredPolicy = () => Object.freeze({ kind: "not-required" as const });
const requiredFilePolicy = (path = ".loom/completion-reports/completion.json") => Object.freeze({
  kind: "required-file" as const,
  path,
});

const lintCheck = Object.freeze({
  kind: "engine-full-tier-lint" as const,
  checkId: FULL_TIER_LINT_CHECK_ID_TEXT,
  scope: "wave" as const,
  reportPolicy: notRequiredPolicy(),
});

const projectCheck = (
  checkId: string,
  reportPolicy: "required" | "not-required" = "not-required",
) => Object.freeze({
  kind: "project-command" as const,
  checkId,
  scope: "wave" as const,
  executable: "bun",
  args: Object.freeze(["test", "--runInBand"]),
  cwd: ".",
  timeoutMs: 60_000,
  reportPolicy: reportPolicy === "required" ? requiredFilePolicy() : notRequiredPolicy(),
});

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
}

function authorityFor(checks: readonly unknown[]): AuthorizedWaveCompletionSuite {
  return valueOf(createAuthorizedWaveCompletionSuite({
    runId: "run.wave-suite",
    wave: 3,
    revision: 7,
    authorityDigest: digest("a"),
    manifestDigest: digest("b"),
    workspaceDigest: digest("c"),
    checks,
  }));
}

function passingResult(
  authority: AuthorizedWaveCompletionSuite,
  checks: readonly unknown[] = authority.checks.map((check) => ({
    checkId: check.checkId,
    scope: "wave" as const,
    outcome: {
      kind: "observed" as const,
      exitCode: 0,
      timedOut: false,
      signal: null,
      report: check.reportPolicy.kind === "required-file"
        ? {
            kind: "produced" as const,
            path: check.reportPolicy.path,
            digest: digest("d"),
            byteLength: 1_024,
          }
        : { kind: "not-required" as const },
    },
  })),
): unknown {
  return {
    kind: "wave-completion-suite-result",
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks,
  };
}

const safeSuffix = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/);
const uniqueCheckIds = fc.uniqueArray(
  safeSuffix.map((suffix) => `project:${suffix}`),
  { minLength: 1, maxLength: 12 },
);

function permute<T>(values: readonly T[], seed: number): readonly T[] {
  const offset = Math.abs(seed) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)].reverse();
}

function expectRejectedForAuthority(result: ReturnType<typeof evaluateWaveCompletionSuite>, kind: string): void {
  expect(result.kind).toBe("rejected");
  if (result.kind === "rejected") {
    expect(result.authorityFailures.some((failure) => failure.kind === kind)).toBe(true);
  }
}

function withRawReport(check: CompletionCheckResult, report: unknown): unknown {
  return { ...check, outcome: { ...check.outcome, report } };
}

function acceptedReceiptFor(authority: AuthorizedWaveCompletionSuite): AcceptedWaveCompletionReceipt {
  const evaluated = evaluateWaveCompletionSuite(authority, passingResult(authority));
  if (evaluated.kind !== "accepted") throw new Error("fixture evaluation failed");
  return evaluated.receipt;
}

function withResultDigest(raw: Record<string, unknown>): Record<string, unknown> {
  const { resultDigest: _discarded, ...body } = raw;
  return { ...body, resultDigest: sha256Hex(canonicalJson(body as never)) };
}

function deepFrozen(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return true;
  return Object.isFrozen(raw) && Object.values(raw).every(deepFrozen);
}

describe("completion-suite exact parsers", () => {
  it("are total over arbitrary unknown values", () => {
    const parsers = [
      parseCompletionCheckId,
      parseAcceptedWaveCompletionReceipt,
      parseWaveNumber,
      parseRegistrationRevision,
      parseAuthorizedWaveCompletionCheck,
      parseCompletionReportOutcome,
      parseCompletionProcessOutcome,
      parseCompletionCheckResult,
      parseAuthorizedWaveCompletionSuite,
      parseWaveCompletionSuiteResult,
      completionSuiteDigest,
    ] as const;

    fc.assert(fc.property(fc.anything({ maxDepth: 5 }), (raw) => {
      for (const parser of parsers) {
        expect(() => parser(raw)).not.toThrow();
        expect(typeof parser(raw).ok).toBe("boolean");
      }
    }), { numRuns: 500 });
  });

  it("rejects surplus fields at every parsed record arm", () => {
    const authority = authorityFor([lintCheck, projectCheck("project:test", "required")]);
    const cases: readonly [string, () => { readonly ok: boolean }][] = [
      ["engine authorized check", () => parseAuthorizedWaveCompletionCheck({ ...lintCheck, surplus: true })],
      ["project authorized check", () => parseAuthorizedWaveCompletionCheck({
        ...projectCheck("project:surplus"), surplus: true,
      })],
      ["spawn failure", () => parseCompletionProcessOutcome({ kind: "spawn-failed", message: "ENOENT", surplus: true })],
      ["not-required policy", () => parseAuthorizedWaveCompletionCheck({
        ...lintCheck, reportPolicy: { kind: "not-required", surplus: true },
      })],
      ["required-file policy", () => parseAuthorizedWaveCompletionCheck({
        ...projectCheck("project:policy", "required"),
        reportPolicy: { ...requiredFilePolicy(), surplus: true },
      })],
      ["not-required report", () => parseCompletionReportOutcome({ kind: "not-required", surplus: true })],
      ["missing report", () => parseCompletionReportOutcome({
        kind: "missing", path: ".loom/completion-reports/completion.json", surplus: true,
      })],
      ["unreadable report", () => parseCompletionReportOutcome({
        kind: "unreadable", path: ".loom/completion-reports/completion.json", message: "EACCES", surplus: true,
      })],
      ["produced report", () => parseCompletionReportOutcome({
        kind: "produced", path: ".loom/completion-reports/completion.json", digest: digest("d"), byteLength: 12, surplus: true,
      })],
      ["observed process", () => parseCompletionProcessOutcome({
        kind: "observed", exitCode: 0, timedOut: false, signal: null,
        report: { kind: "not-required" }, surplus: true,
      })],
      ["check result", () => parseCompletionCheckResult({
        checkId: FULL_TIER_LINT_CHECK_ID_TEXT,
        scope: "wave",
        outcome: {
          kind: "observed", exitCode: 0, timedOut: false, signal: null,
          report: { kind: "not-required" },
        },
        surplus: true,
      })],
      ["authorized suite", () => parseAuthorizedWaveCompletionSuite({ ...authority, surplus: true })],
      ["accepted receipt", () => parseAcceptedWaveCompletionReceipt({ ...acceptedReceiptFor(authority), surplus: true })],
      ["suite result", () => parseWaveCompletionSuiteResult({ ...(passingResult(authority) as object), surplus: true })],
    ];
    for (const [label, parse] of cases) expect(parse().ok, label).toBe(false);
  });

  it("parses only bounded commands and canonical repository-relative paths", () => {
    for (const timeoutMs of [MIN_COMPLETION_CHECK_TIMEOUT_MS, MAX_COMPLETION_CHECK_TIMEOUT_MS]) {
      expect(parseAuthorizedWaveCompletionCheck({ ...projectCheck("project:bounds"), timeoutMs }).ok).toBe(true);
    }
    for (const timeoutMs of [
      MIN_COMPLETION_CHECK_TIMEOUT_MS - 1,
      MAX_COMPLETION_CHECK_TIMEOUT_MS + 1,
      1.5,
    ]) {
      expect(parseAuthorizedWaveCompletionCheck({ ...projectCheck("project:bounds"), timeoutMs }).ok).toBe(false);
    }
    expect(parseAuthorizedWaveCompletionCheck({ ...projectCheck("project:root"), cwd: "." }).ok).toBe(true);
    for (const cwd of ["./engine", "engine/../reports", "/tmp"]) {
      expect(parseAuthorizedWaveCompletionCheck({ ...projectCheck("project:path"), cwd }).ok).toBe(false);
    }
    expect(parseAuthorizedWaveCompletionCheck({
      ...projectCheck("project:report", "required"),
      reportPolicy: requiredFilePolicy("../outside.json"),
    }).ok).toBe(false);
    expect(parseAuthorizedWaveCompletionCheck({
      ...projectCheck("project:sparse-args"), args: Array(1),
    }).ok).toBe(false);
  });

  it("rejects inline evaluation and generic command dispatch", () => {
    const unsafeCommands = [
      ["sh", ["-c", "npm test"]],
      ["bash", ["-lc", "npm test"]],
      ["node", ["-e", "process.exit()"]],
      ["bun", ["--eval=process.exit()"]],
      ["python3", ["-cprint(1)"]],
      ["powershell", ["-Command", "Get-ChildItem"]],
      ["cmd", ["/c", "npm test"]],
      ["env", ["bun", "test"]],
      ["xargs", ["bun", "test"]],
    ] as const;
    for (const [executable, args] of unsafeCommands) {
      expect(parseAuthorizedWaveCompletionCheck({
        ...projectCheck("project:unsafe"), executable, args: [...args],
      }).ok, `${executable} ${args.join(" ")}`).toBe(false);
    }
  });

  it("freezes commands, argument arrays, report policies, and report outcomes", () => {
    const parsedCheck = valueOf(parseAuthorizedWaveCompletionCheck(projectCheck("project:frozen", "required")));
    expect(parsedCheck.kind).toBe("project-command");
    if (parsedCheck.kind === "project-command") {
      expect(Object.isFrozen(parsedCheck)).toBe(true);
      expect(Object.isFrozen(parsedCheck.args)).toBe(true);
      expect(Object.isFrozen(parsedCheck.reportPolicy)).toBe(true);
    }
    const parsedReport = valueOf(parseCompletionReportOutcome({
      kind: "produced", path: ".loom/completion-reports/completion.json", digest: digest("a"), byteLength: 42,
    }));
    expect(Object.isFrozen(parsedReport)).toBe(true);
  });

  it("keeps spawn failure structurally separate from observed process facts", () => {
    expect(parseCompletionProcessOutcome({
      kind: "spawn-failed", message: "failed", exitCode: 0,
    }).ok).toBe(false);
  });
});

describe("accepted Wave completion receipt parsing", () => {
  it("round-trips arbitrary accepted rosters into canonical deeply frozen authority", () => {
    fc.assert(fc.property(uniqueCheckIds, fc.integer(), (ids, seed) => {
      const authority = authorityFor([
        lintCheck,
        ...ids.map((id, index) => projectCheck(id, index % 2 === 0 ? "required" : "not-required")),
      ]);
      const accepted = acceptedReceiptFor(authority);
      const permuted = {
        ...(JSON.parse(JSON.stringify(accepted)) as Record<string, unknown>),
        checks: permute(accepted.checks, seed),
      };
      const parsed = valueOf(parseAcceptedWaveCompletionReceipt(permuted));

      expect(parsed).toEqual(accepted);
      expect(deepFrozen(parsed)).toBe(true);
      expect(parseAcceptedWaveCompletionReceipt(JSON.parse(JSON.stringify(parsed)))).toEqual({
        ok: true,
        value: parsed,
      });
    }));
  });

  it("rejects missing, duplicate, sparse, wrong-scope, and unsuccessful accepted rosters", () => {
    const authority = authorityFor([lintCheck, projectCheck("project:receipt")]);
    const receipt = acceptedReceiptFor(authority);
    const project = receipt.checks.find((check) => check.checkId === "project:receipt")!;
    const cases = [
      [],
      receipt.checks.filter((check) => check.checkId !== FULL_TIER_LINT_CHECK_ID_TEXT),
      [...receipt.checks, project],
      Object.assign(Array(receipt.checks.length), { 0: receipt.checks[0] }),
      receipt.checks.map((check) => check.checkId === project.checkId ? { ...check, scope: "task" } : check),
      receipt.checks.map((check) => check.checkId === project.checkId
        ? { ...check, outcome: { ...check.outcome, exitCode: 1 } }
        : check),
    ];
    for (const checks of cases) {
      expect(parseAcceptedWaveCompletionReceipt(withResultDigest({ ...receipt, checks })).ok).toBe(false);
    }
  });

  it("rejects removal, surplus, malformed tags, and tampering of every digest-bound field", () => {
    const receipt = acceptedReceiptFor(authorityFor([lintCheck, projectCheck("project:tamper")]));
    for (const field of Object.keys(receipt)) {
      const without = { ...receipt } as Record<string, unknown>;
      delete without[field];
      expect(parseAcceptedWaveCompletionReceipt(without).ok, `missing ${field}`).toBe(false);
    }
    const mutations: readonly Record<string, unknown>[] = [
      { ...receipt, kind: "wave-completion-suite-result" },
      { ...receipt, runId: "run.other" },
      { ...receipt, wave: receipt.wave + 1 },
      { ...receipt, revision: receipt.revision + 1 },
      { ...receipt, authorityDigest: digest("1") },
      { ...receipt, manifestDigest: digest("2") },
      { ...receipt, suiteDigest: digest("3") },
      { ...receipt, workspaceDigest: digest("4") },
      { ...receipt, checks: receipt.checks.map((check) => ({ ...check })) },
      { ...receipt, resultDigest: digest("5") },
      { ...receipt, surplus: true },
    ];
    for (const mutation of mutations) {
      if (mutation.checks !== undefined && mutation.resultDigest === receipt.resultDigest) {
        const changed = (mutation.checks as CompletionCheckResult[]).map((check, index) =>
          index === 0 ? { ...check, checkId: "project:changed" } : check);
        expect(parseAcceptedWaveCompletionReceipt({ ...mutation, checks: changed }).ok).toBe(false);
      } else {
        expect(parseAcceptedWaveCompletionReceipt(mutation).ok).toBe(false);
      }
    }
  });
});

describe("canonical exact Wave suite authority", () => {
  it("accepts every exact roster permutation with identical ordering and digest", () => {
    fc.assert(fc.property(uniqueCheckIds, fc.integer(), (ids, seed) => {
      const checks = [lintCheck, ...ids.map((id, index) => projectCheck(id, index % 2 === 0 ? "required" : "not-required"))];
      const left = authorityFor(checks);
      const right = authorityFor(permute(checks, seed));
      expect(right.checks.map((check) => check.checkId)).toEqual(left.checks.map((check) => check.checkId));
      expect(right.suiteDigest).toBe(left.suiteDigest);
      expect(Object.isFrozen(right)).toBe(true);
      expect(Object.isFrozen(right.checks)).toBe(true);
      expect(right.checks.every(Object.isFrozen)).toBe(true);
      expect(right.checks.every((check) => Object.isFrozen(check.reportPolicy))).toBe(true);
      expect(right.checks.every((check) => check.kind === "engine-full-tier-lint" || Object.isFrozen(check.args))).toBe(true);
    }));
  });

  it("changes the suite digest when any command or report authority field changes", () => {
    const baseline = projectCheck("project:digest");
    const baselineDigest = valueOf(completionSuiteDigest([lintCheck, baseline]));
    const commandMutations = [
      { ...baseline, executable: "npm" },
      { ...baseline, args: ["test", "--changed"] },
      { ...baseline, cwd: "engine" },
      { ...baseline, timeoutMs: baseline.timeoutMs + 1 },
      { ...baseline, reportPolicy: requiredFilePolicy(".loom/completion-reports/completion.json") },
    ] as const;
    for (const mutation of commandMutations) {
      expect(valueOf(completionSuiteDigest([lintCheck, mutation]))).not.toBe(baselineDigest);
    }

    const required = projectCheck("project:digest", "required");
    const requiredDigest = valueOf(completionSuiteDigest([lintCheck, required]));
    expect(valueOf(completionSuiteDigest([
      lintCheck,
      { ...required, reportPolicy: requiredFilePolicy(".loom/completion-reports/other.json") },
    ]))).not.toBe(requiredDigest);
  });

  it("requires a non-empty exact roster and rejects duplicate authority", () => {
    expect(createAuthorizedWaveCompletionSuite({
      runId: "run.empty", wave: 1, revision: 0,
      authorityDigest: digest("a"), manifestDigest: digest("b"), workspaceDigest: digest("c"), checks: [],
    }).ok).toBe(false);
    expect(createAuthorizedWaveCompletionSuite({
      runId: "run.missing-reserved", wave: 1, revision: 0,
      authorityDigest: digest("a"), manifestDigest: digest("b"), workspaceDigest: digest("c"),
      checks: [projectCheck("project:only")],
    }).ok).toBe(false);
    expect(createAuthorizedWaveCompletionSuite({
      runId: "run.duplicate", wave: 1, revision: 0,
      authorityDigest: digest("a"), manifestDigest: digest("b"), workspaceDigest: digest("c"),
      checks: [lintCheck, lintCheck],
    }).ok).toBe(false);
  });

  it("rehydrates only when the canonical suite digest still matches", () => {
    const authority = authorityFor([lintCheck, projectCheck("project:test")]);
    expect(parseAuthorizedWaveCompletionSuite(JSON.parse(JSON.stringify(authority))).ok).toBe(true);
    expect(parseAuthorizedWaveCompletionSuite({ ...authority, suiteDigest: digest("f") }).ok).toBe(false);
  });
});

describe("pure completion-suite evaluator properties", () => {
  it("accepts exact result permutations canonically", () => {
    fc.assert(fc.property(uniqueCheckIds, fc.integer(), (ids, seed) => {
      const authority = authorityFor([
        lintCheck,
        ...ids.map((id, index) => projectCheck(id, index % 2 === 0 ? "required" : "not-required")),
      ]);
      const exact = passingResult(authority) as { checks: readonly CompletionCheckResult[] };
      const evaluated = evaluateWaveCompletionSuite(authority, passingResult(authority, permute(exact.checks, seed)));
      expect(evaluated.kind).toBe("accepted");
      if (evaluated.kind === "accepted") {
        expect(evaluated.receipt.checks.map((check) => check.checkId))
          .toEqual(authority.checks.map((check) => check.checkId));
      }
    }));
  });

  it("rejects any single removal, surplus, or duplicate check id", () => {
    fc.assert(fc.property(uniqueCheckIds, fc.integer(), (ids, seed) => {
      const authority = authorityFor([lintCheck, ...ids.map((id) => projectCheck(id))]);
      const exact = (passingResult(authority) as { checks: readonly CompletionCheckResult[] }).checks;
      const index = Math.abs(seed) % exact.length;

      expectRejectedForAuthority(
        evaluateWaveCompletionSuite(authority, passingResult(authority, exact.filter((_, candidate) => candidate !== index))),
        "missing-check-results",
      );
      expectRejectedForAuthority(
        evaluateWaveCompletionSuite(authority, passingResult(authority, [
          ...exact,
          {
            checkId: valueOf(parseCompletionCheckId("surplus:check")),
            scope: "wave",
            outcome: {
              kind: "observed", exitCode: 0, timedOut: false, signal: null,
              report: { kind: "not-required" },
            },
          },
        ])),
        "surplus-check-results",
      );
      expectRejectedForAuthority(
        evaluateWaveCompletionSuite(authority, passingResult(authority, [...exact, exact[index]!])),
        "duplicate-check-results",
      );
    }));
  });

  it("rejects every stale authority binding", () => {
    const authority = authorityFor([lintCheck, projectCheck("project:test")]);
    const base = passingResult(authority) as Record<string, unknown>;
    const staleValues: Readonly<Record<string, unknown>> = {
      runId: "run.stale",
      wave: 4,
      revision: 8,
      authorityDigest: digest("d"),
      manifestDigest: digest("e"),
      suiteDigest: digest("f"),
      workspaceDigest: digest("9"),
    };
    fc.assert(fc.property(fc.constantFrom(...Object.entries(staleValues)), ([field, value]) => {
      const evaluated = evaluateWaveCompletionSuite(authority, { ...base, [field]: value });
      expectRejectedForAuthority(evaluated, "stale-result");
      if (evaluated.kind === "rejected") {
        const stale = evaluated.authorityFailures.find((failure) => failure.kind === "stale-result");
        expect(stale?.kind === "stale-result" && stale.mismatchedFields).toContain(field);
      }
    }));
  });

  it("rejects a result in the wrong scope", () => {
    const authority = authorityFor([lintCheck]);
    const exact = (passingResult(authority) as { checks: readonly CompletionCheckResult[] }).checks;
    expectRejectedForAuthority(
      evaluateWaveCompletionSuite(authority, passingResult(authority, [{ ...exact[0]!, scope: "task" }])),
      "wrong-check-scope",
    );
  });

  it("rejects timeout even when the observed process later exits zero", () => {
    const authority = authorityFor([lintCheck]);
    const result = passingResult(authority, [{
      checkId: authority.checks[0].checkId,
      scope: "wave",
      outcome: {
        kind: "observed", exitCode: 0, timedOut: true, signal: null,
        report: { kind: "not-required" },
      },
    }]);
    const evaluated = evaluateWaveCompletionSuite(authority, result);
    expect(evaluated.kind).toBe("rejected");
    if (evaluated.kind === "rejected") {
      expect(evaluated.authorityFailures).toEqual([]);
      expect(evaluated.infrastructureFailures).toEqual([]);
      expect(evaluated.semanticFailures.map((failure) => failure.kind)).toContain("timed-out");
    }
  });

  it("classifies spawn failure only as infrastructure", () => {
    const authority = authorityFor([lintCheck]);
    const spawnFailure = valueOf(parseCompletionCheckResult({
      checkId: authority.checks[0].checkId,
      scope: "wave",
      outcome: { kind: "spawn-failed", message: "ENOENT" },
    }));
    const evaluated = evaluateWaveCompletionSuite(authority, passingResult(authority, [spawnFailure]));
    expect(evaluated.kind).toBe("rejected");
    if (evaluated.kind === "rejected") {
      expect(evaluated.authorityFailures).toEqual([]);
      expect(evaluated.infrastructureFailures.map((failure) => failure.kind)).toEqual(["spawn-failed"]);
      expect(evaluated.semanticFailures).toEqual([]);
    }
  });

  it("classifies an exactly-authorized missing report as semantic", () => {
    const authority = authorityFor([lintCheck, projectCheck("project:test", "required")]);
    const checks = (passingResult(authority) as { checks: readonly CompletionCheckResult[] }).checks.map((check) =>
      check.checkId === "project:test"
        ? {
            ...check,
            outcome: { ...check.outcome, report: { kind: "missing" as const, path: ".loom/completion-reports/completion.json" } },
          }
        : check);
    const evaluated = evaluateWaveCompletionSuite(authority, passingResult(authority, checks));
    expect(evaluated.kind).toBe("rejected");
    if (evaluated.kind === "rejected") {
      expect(evaluated.authorityFailures).toEqual([]);
      expect(evaluated.infrastructureFailures).toEqual([]);
      expect(evaluated.semanticFailures).toContainEqual({
        kind: "missing-report", checkId: "project:test", path: ".loom/completion-reports/completion.json",
      });
    }
  });

  it("classifies an unreadable authorized report only as infrastructure", () => {
    const authority = authorityFor([lintCheck, projectCheck("project:test", "required")]);
    const checks = (passingResult(authority) as { checks: readonly CompletionCheckResult[] }).checks.map((check) =>
      check.checkId === "project:test"
        ? {
            ...check,
            outcome: {
              ...check.outcome,
              report: {
                kind: "unreadable" as const,
                path: ".loom/completion-reports/completion.json",
                message: "EACCES",
              },
            },
          }
        : check);
    const evaluated = evaluateWaveCompletionSuite(authority, passingResult(authority, checks));
    expect(evaluated.kind).toBe("rejected");
    if (evaluated.kind === "rejected") {
      expect(evaluated.authorityFailures).toEqual([]);
      expect(evaluated.infrastructureFailures).toContainEqual({
        kind: "report-unreadable",
        checkId: "project:test",
        path: ".loom/completion-reports/completion.json",
        message: "EACCES",
      });
      expect(evaluated.semanticFailures).toEqual([]);
    }
  });

  it("rejects every report-policy or report-path mismatch as authority failure", () => {
    const requiredAuthority = authorityFor([lintCheck, projectCheck("project:required", "required")]);
    const requiredChecks = (passingResult(requiredAuthority) as { checks: readonly CompletionCheckResult[] }).checks;
    const requiredIndex = requiredChecks.findIndex((check) => check.checkId === "project:required");
    const requiredCheck = requiredChecks[requiredIndex]!;
    const requiredMismatches = [
      { kind: "not-required" as const },
      { kind: "missing" as const, path: ".loom/completion-reports/other.json" },
      { kind: "produced" as const, path: ".loom/completion-reports/other.json", digest: digest("d"), byteLength: 1_024 },
    ];
    for (const report of requiredMismatches) {
      const checks = requiredChecks.map((check, index) =>
        index === requiredIndex ? withRawReport(requiredCheck, report) : check);
      expectRejectedForAuthority(
        evaluateWaveCompletionSuite(requiredAuthority, passingResult(requiredAuthority, checks)),
        "report-policy-mismatch",
      );
    }

    const noReportAuthority = authorityFor([lintCheck, projectCheck("project:none")]);
    const noReportChecks = (passingResult(noReportAuthority) as { checks: readonly CompletionCheckResult[] }).checks;
    const noReportIndex = noReportChecks.findIndex((check) => check.checkId === "project:none");
    const noReportCheck = noReportChecks[noReportIndex]!;
    for (const report of [
      { kind: "missing" as const, path: ".loom/completion-reports/completion.json" },
      { kind: "produced" as const, path: ".loom/completion-reports/completion.json", digest: digest("d"), byteLength: 1_024 },
    ]) {
      const checks = noReportChecks.map((check, index) =>
        index === noReportIndex ? withRawReport(noReportCheck, report) : check);
      expectRejectedForAuthority(
        evaluateWaveCompletionSuite(noReportAuthority, passingResult(noReportAuthority, checks)),
        "report-policy-mismatch",
      );
    }
  });

  it("retains orthogonal timeout, signal, exit, and report failures", () => {
    const authority = authorityFor([lintCheck, projectCheck("project:test", "required")]);
    const checks = (passingResult(authority) as { checks: readonly CompletionCheckResult[] }).checks.map((check) =>
      check.checkId === "project:test"
        ? {
            ...check,
            outcome: {
              kind: "observed" as const,
              exitCode: 9,
              timedOut: true,
              signal: "SIGTERM" as const,
              report: { kind: "missing" as const, path: ".loom/completion-reports/completion.json" },
            },
          }
        : check);
    const evaluated = evaluateWaveCompletionSuite(authority, passingResult(authority, checks));
    expect(evaluated.kind).toBe("rejected");
    if (evaluated.kind === "rejected") {
      expect(evaluated.semanticFailures.map((failure) => failure.kind)).toEqual([
        "timed-out", "signal-termination", "non-zero-exit", "missing-report",
      ]);
    }
  });

  it("is deterministic, canonical, and does not mutate any caller input", () => {
    fc.assert(fc.property(uniqueCheckIds, fc.integer(), (ids, seed) => {
      const authority = authorityFor([lintCheck, ...ids.map((id) => projectCheck(id))]);
      const exact = passingResult(authority) as { checks: readonly CompletionCheckResult[] };
      const input = {
        ...(passingResult(authority, permute(exact.checks, seed)) as Record<string, unknown>),
      };
      const before = JSON.stringify(input);
      const first = evaluateWaveCompletionSuite(authority, input);
      const second = evaluateWaveCompletionSuite(authority, input);
      expect(second).toEqual(first);
      expect(JSON.stringify(input)).toBe(before);
      expect(first.kind).toBe("accepted");
      if (first.kind === "accepted" && second.kind === "accepted") {
        expect(second.receipt.resultDigest).toBe(first.receipt.resultDigest);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(first.receipt)).toBe(true);
        expect(Object.isFrozen(first.receipt.checks)).toBe(true);
        expect(first.receipt.checks.every((check) => Object.isFrozen(check) && Object.isFrozen(check.outcome))).toBe(true);
        expect(() => (first.receipt.checks as unknown as CompletionCheckResult[]).push(first.receipt.checks[0])).toThrow(TypeError);
      }
    }));
  });
});
