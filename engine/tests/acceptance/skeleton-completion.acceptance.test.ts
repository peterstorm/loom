/**
 * CT-3 acceptance: completion is judged against the frozen contract (plan
 * AD-5, AD-11), through `settleExactImplementation` — the settlement shell
 * both harnesses' stop paths call.
 *
 * Every testcase registers Wave 2 Tasks of the skeleton fixture repository
 * through `registerTaskExecutionBatch` (so the engine wrote their skeletons),
 * writes what the implementer would, settles the attempt through the real
 * settlement shell with production ports, and reads the stored Proof back as
 * unknown JSON narrowed by CT-1's `ConformanceViolation`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { attestOperation } from "../../src/handlers/helpers/attest-implementation";
import {
  authorityOf,
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  contractViolations,
  PATHS,
  proofFailureKinds,
  registered,
  settleAttempt,
  SHADOWING_VIEW_TEXT,
  skeletonRepo,
  storedTask,
  subjectAndReason,
  TS_LEGACY_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

/** `quotes.ts` implemented as the contract requires: the bound name, its alias annotation, no marker. */
const CONFORMING_QUOTES = `import type { PriceOrderFn } from "./order-contract";

const centsPerLine = 100;

export const quote: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity * centsPerLine });

export const quoteLabel = (cents: number): string => \`\${cents} cents\`;
`;

/** `legacy.ts` after the implementer's edit: still no `quoteOrder`, still
 *  shadowing `OrderId` and re-listing two `OrderState` tags. */
const EDITED_LEGACY = `${TS_LEGACY_TEXT}
export const legacyVersion = 2;
`;

/** The rest of T4's files, written so only the contract decides its Proof. */
function writeT4Remainder(repo: SkeletonRepo): readonly string[] {
  repo.write(PATHS.pythonRates, "def rate(order, quantity):\n    return quantity\n");
  repo.write(PATHS.tsHelpers, "export const round = (cents: number): number => Math.round(cents);\n");
  repo.write(PATHS.tsTest, "import { it } from \"vitest\";\n\nit(\"AS-101: prices an order\", () => {});\n");
  return [PATHS.pythonRates, PATHS.tsHelpers, PATHS.tsTest];
}

/** Register T4, leave `pricing.ts` exactly as the engine wrote it, implement
 *  `quotes.ts`, edit `legacy.ts` without fixing it, and settle. */
async function settleT4WithUntouchedSkeleton(repo: SkeletonRepo): Promise<void> {
  const attempt = authorityOf(await registered(repo, "T4"), "T4");
  expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
  repo.write(PATHS.tsQuotes, CONFORMING_QUOTES);
  repo.write(PATHS.tsLegacy, EDITED_LEGACY);
  await settleAttempt(repo, attempt, [PATHS.tsQuotes, PATHS.tsLegacy, ...writeT4Remainder(repo)]);
}

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();

describe("completion against the frozen contract (CT-3)", () => {
  it("FR-021: completion is refused through declared-artifact-contract-violated, listing every violation per file as export or declaration and reason", async () => {
    const repo = skeletonRepo();

    await settleT4WithUntouchedSkeleton(repo);

    const stored = repo.rawState();
    expect(storedTask(stored, "T4").status).not.toBe("implemented");
    expect(proofFailureKinds(stored, "T4")).toContain("declared-artifact-contract-violated");
    const violations = contractViolations(stored, "T4");
    expect(sorted([...violations.keys()])).toEqual(sorted([PATHS.tsPricing, PATHS.tsLegacy]));
    expect(sorted((violations.get(PATHS.tsPricing) ?? []).map(subjectAndReason))).toEqual(sorted([
      "priceOrder: still-unimplemented",
      "parseOrder: still-unimplemented",
    ]));
    expect(sorted((violations.get(PATHS.tsLegacy) ?? []).map(subjectAndReason))).toEqual(sorted([
      "quoteOrder: deleted",
      "OrderId: shadows-frozen-adt",
      "OrderState: re-lists-frozen-variants",
    ]));
    // The re-listing names its remedy; the others carry none.
    for (const violation of violations.get(PATHS.tsLegacy) ?? []) {
      if (violation.reason === "re-lists-frozen-variants") expect(violation.remedy).toEqual(expect.any(String));
      else expect(violation.remedy).toBeNull();
    }
    // A conforming file with extra helpers and exports adds no violation.
    expect(violations.has(PATHS.tsQuotes)).toBe(false);
  });

  it("FR-018: a bound file that existed at Wave start (\"exists, not skeletonized\") is still judged by the signature and ADT checks", async () => {
    const repo = skeletonRepo();

    await settleT4WithUntouchedSkeleton(repo);

    const legacy = contractViolations(repo.rawState(), "T4").get(PATHS.tsLegacy) ?? [];
    expect(legacy.map(subjectAndReason)).toEqual(expect.arrayContaining([
      "quoteOrder: deleted",
      "OrderId: shadows-frozen-adt",
    ]));
  });

  it("AS-015: FR-012: an untouched engine skeleton is no implementer write: it never counts as changed and never enters the attempt-scope delta", async () => {
    const repo = skeletonRepo();

    await settleT4WithUntouchedSkeleton(repo);

    const stored = repo.rawState();
    const task = storedTask(stored, "T4");
    // The engine wrote pricing.ts before the attempt's baselines…
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    // …so the attempt's recorded writes exclude it,
    expect(task.files_modified).toEqual(expect.arrayContaining([PATHS.tsQuotes, PATHS.tsLegacy]));
    expect(task.files_modified).not.toContain(PATHS.tsPricing);
    // and its declared-artifact obligation is refused as unimplemented, never satisfied as changed.
    const proof = task.proof as { results?: readonly { state: string; obligation: { kind: string; artifact?: string } }[] };
    const pricing = (proof.results ?? []).find(({ obligation }) => obligation.artifact === PATHS.tsPricing);
    expect(pricing?.state).toBe("failed");
    expect(contractViolations(stored, "T4").get(PATHS.tsPricing)?.map(subjectAndReason)).toEqual(
      expect.arrayContaining(["priceOrder: still-unimplemented"]),
    );
  });

  it("FR-012: implementing the skeleton is the implementer's write: once every bound export conforms, the file counts as changed and passes the contract", async () => {
    const repo = skeletonRepo();
    const attempt = authorityOf(await registered(repo, "T4"), "T4");
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));

    repo.write(PATHS.tsPricing, `import type { ParseOrderFn, PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });

export const parseOrder: ParseOrderFn = (raw) => ({ id: raw, lines: [] });
`);
    repo.write(PATHS.tsQuotes, CONFORMING_QUOTES);
    repo.write(PATHS.tsLegacy, `import type { PriceOrderFn } from "./order-contract";

export const quoteOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });
`);
    await settleAttempt(repo, attempt, [PATHS.tsPricing, PATHS.tsQuotes, PATHS.tsLegacy, ...writeT4Remainder(repo)]);

    const stored = repo.rawState();
    expect(contractViolations(stored, "T4").size).toBe(0);
    expect(storedTask(stored, "T4").files_modified).toContain(PATHS.tsPricing);
    expect(storedTask(stored, "T4").status).toBe("implemented");
    // The engine's record of what it wrote survives the settlement.
    expect(proofFailureKinds(stored, "T4")).toEqual([]);
    expect(stored.skeletons).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: PATHS.tsPricing, origin: "spawn" }),
    ]));
  });
});

describe("waived and attested Tasks are not judged (CT-3)", () => {
  /** In one Wave: T4 (judged) keeps a shadowing `legacy.ts`; T7 (regression
   *  waived documentation-only) edits its shadowing `state-view.ts`; T8
   *  (attested) changes nothing in its shadowing `order-view.ts`. */
  async function settleJudgedWaivedAndAttested(repo: SkeletonRepo): Promise<void> {
    await attestOperation(["--task", "T8", "--reason", "the order view already exists"]);
    const authorities = await registered(repo, "T4", "T7", "T8");
    repo.write(PATHS.tsQuotes, CONFORMING_QUOTES);
    repo.write(PATHS.tsLegacy, EDITED_LEGACY);
    const stateView = `${SHADOWING_VIEW_TEXT}\nexport const stateViewVersion = 2;\n`;
    repo.write(PATHS.stateView, stateView);
    await settleAttempt(repo, authorityOf(authorities, "T4"), [PATHS.tsQuotes, PATHS.tsLegacy, ...writeT4Remainder(repo)]);
    await settleAttempt(repo, authorityOf(authorities, "T7"), [PATHS.stateView]);
    await settleAttempt(repo, authorityOf(authorities, "T8"), []);
  }

  it("FR-019: neither the signature nor the ADT check runs on a documentation-only waived Task or an attested Task, while a judged Task in the same Wave is refused", async () => {
    const repo = skeletonRepo();

    await settleJudgedWaivedAndAttested(repo);

    const stored = repo.rawState();
    expect(contractViolations(stored, "T4").get(PATHS.tsLegacy)?.map(subjectAndReason)).toEqual(
      expect.arrayContaining(["OrderId: shadows-frozen-adt"]),
    );
    expect(contractViolations(stored, "T7").size).toBe(0);
    expect(contractViolations(stored, "T8").size).toBe(0);
  });

  it("AS-037: a waived or attested file gets nothing reported against it, and its Task completes", async () => {
    const repo = skeletonRepo();

    await settleJudgedWaivedAndAttested(repo);

    const stored = repo.rawState();
    for (const taskId of ["T7", "T8"]) {
      expect(proofFailureKinds(stored, taskId), taskId).toEqual([]);
      expect(storedTask(stored, taskId).status, taskId).toBe("implemented");
    }
    expect(repo.read(PATHS.orderView)).toBe(SHADOWING_VIEW_TEXT);
    // The same shadowing in a judged Task is refused.
    expect(proofFailureKinds(stored, "T4")).toContain("declared-artifact-contract-violated");
  });
});
