/**
 * The `helper orchestration amend-export-binding` shell (ADR-0105) on the
 * skeleton fixture repository, end to end: the real case of a binding the
 * design cannot implement. T4 leaves the engine's `quotes.ts` skeleton
 * untouched, so its completion fails `still-unimplemented` on `quote`; the
 * operator drops the binding; status and the brief keep working, the retry
 * appendix no longer demands `quote`, the retry registers, and once T4
 * replaces the stale skeleton with its own code it settles `implemented`.
 * A partial drop leaves the Task owing only the export still bound, and a
 * rebind refreshes the untouched skeleton to the new name at the retry's
 * registration. The decision itself is pinned in tests/core/export-binding-amendment.test.ts.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createAmendExportBindingOperation } from "../../../src/handlers/helpers/amend-export-binding";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import type { SubagentActivity } from "../../../src/handlers/helpers/subagent-quiescence";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";
import {
  authorityOf,
  briefOf,
  canonicalSkeletonOf,
  canonicalTsSkeleton,
  cleanupSkeletonRepos,
  contractViolations,
  orchestrationStatus,
  PATHS,
  recordedOutcomes,
  recordedSkeletons,
  registered,
  settleAttempt,
  skeletonRepo,
  spawnFor,
  statusDocument,
  statusOutcomes,
  storedTask,
  subjectAndReason,
  type SkeletonRepo,
} from "../../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

const quiet: SubagentActivity = () => false;
const REASON = "quote is per-request: a module constant cannot implement it";
const DROP_QUOTE = ["--task", "T4", "--file", PATHS.tsQuotes, "--export", "quote", "--drop", "--reason", REASON] as const;
const amend = (args: readonly string[], active: SubagentActivity = quiet) => createAmendExportBindingOperation(active)(args);

/** The prompt of the implementation spawn T4 is owed now, its retry appendix included. */
function retryPrompt(repo: SkeletonRepo): string {
  const spawn = spawnFor(repo.rawState(), "T4");
  if (spawn.kind !== "implementation") throw new Error(`fixture: T4 is owed no implementation spawn (${spawn.kind})`);
  return spawn.prompt;
}

const CONFORMING_PRICING = `import type { ParseOrderFn, PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });

export const parseOrder: ParseOrderFn = (raw) => ({ id: raw, lines: [] });
`;

const CONFORMING_LEGACY = `import type { PriceOrderFn } from "./order-contract";

export const quoteOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });
`;

/** pricing.ts once parseOrder is dropped from its binding: priceOrder alone. */
const PRICE_ORDER_ONLY = `import type { PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });
`;

const CONFORMING_QUOTES = `import type { PriceOrderFn } from "./order-contract";

export const quote: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });
`;

/** quotes.ts implementing the export rebound from quote. */
const CONFORMING_QUOTE_FOR = `import type { PriceOrderFn } from "./order-contract";

export const quoteFor: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });
`;

/** quotes.ts as T4's own code, once no binding owes it: a factory per request, no static export. */
const OWN_QUOTES = `import type { Order, Price } from "./order-contract";

export const quoteFor = (centsPerLine: number) => (order: Order): Price => ({ cents: order.lines.length * centsPerLine });
`;

/** Every T4 file but quotes.ts, written conforming; returns them all. */
function writeT4ButQuotes(repo: SkeletonRepo): readonly string[] {
  repo.write(PATHS.tsPricing, CONFORMING_PRICING);
  repo.write(PATHS.tsLegacy, CONFORMING_LEGACY);
  repo.write(PATHS.pythonRates, "def rate(order, quantity):\n    return quantity\n");
  repo.write(PATHS.tsHelpers, "export const round = (cents: number): number => Math.round(cents);\n");
  repo.write(PATHS.tsTest, "import { it } from \"vitest\";\n\nit(\"AS-101: prices an order\", () => {});\n");
  return [PATHS.tsPricing, PATHS.tsLegacy, PATHS.pythonRates, PATHS.tsHelpers, PATHS.tsTest];
}

/** T4's attempt 1, settled with quotes.ts left exactly as the engine wrote it. */
async function failOnStillUnimplementedQuote(repo: SkeletonRepo): Promise<void> {
  const attempt = authorityOf(await registered(repo, "T4"), "T4");
  expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));
  await settleAttempt(repo, attempt, writeT4ButQuotes(repo));
  const stored = repo.rawState();
  expect(storedTask(stored, "T4").status).toBe("pending");
  expect([...contractViolations(stored, "T4").entries()].map(([path, violations]) => [path, violations.map(subjectAndReason)]))
    .toEqual([[PATHS.tsQuotes, ["quote: still-unimplemented"]]]);
}

describe("amend-export-binding route traits", () => {
  it("takes only flags, requires the Pi runtime handshake and is parent-only, like every mutating operation", () => {
    expect(ORCHESTRATION_OPERATIONS["amend-export-binding"]).toEqual({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", ["amend-export-binding", ...DROP_QUOTE])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["amend-export-binding", ...DROP_QUOTE])).toBe(true);
  });
});

describe("amend-export-binding on a live run (the binding the design cannot implement)", () => {
  it("drops the binding: the retry no longer owes it, status and the brief work, and the Task completes with its own code", async () => {
    const repo = skeletonRepo();
    await failOnStillUnimplementedQuote(repo);
    const retryBefore = retryPrompt(repo);
    expect(retryBefore).toContain("  - quote: still-unimplemented");
    expect(retryBefore).toContain("fix every one before completing");

    expect(await amend(DROP_QUOTE)).toEqual({ kind: "allow" });
    const stored = repo.rawState();
    expect((stored.export_bindings as readonly Readonly<{ path: string }>[]).map(({ path }) => path)).not.toContain(PATHS.tsQuotes);
    expect(recordedSkeletons(stored).has(PATHS.tsQuotes)).toBe(false);
    expect(recordedOutcomes(stored, "T4").has(PATHS.tsQuotes)).toBe(false);
    expect(stored.wave_plan_edits).toEqual([expect.objectContaining({
      kind: "export-binding-amended", taskId: "T4", path: PATHS.tsQuotes, contract: "CT-1",
      change: { kind: "dropped", name: "quote" }, before: [{ name: "quote", alias: "PriceOrderFn" }], after: [], reason: REASON,
    })]);
    // The engine's bytes stay on disk: now the Task's own code to replace.
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));

    // Status keeps working and reports the unbound file as projected, not as a skeleton.
    expect(orchestrationStatus(repo, false).status).toBe(0);
    expect(statusOutcomes(statusDocument(repo))).toEqual(expect.arrayContaining([
      { path: PATHS.tsQuotes, outcome: { kind: "exists-not-skeletonized" } },
    ]));

    // The brief renders (the plan's bindings, with the audit replayed, agree with the stamp) and owes nothing for quote.
    const brief = briefOf(repo, "T4");
    expect(brief).not.toContain("fix every one before completing");
    expect(brief).toContain("an amended export binding no longer owes");
    const retry = retryPrompt(repo);
    expect(retry).not.toContain("fix every one before completing");

    // The spawn gate admits that retry, and T4's own code completes it.
    const attempt = authorityOf(await registered(repo, "T4"), "T4");
    expect(attempt.semanticAttempt).toBe(2);
    repo.write(PATHS.tsQuotes, OWN_QUOTES);
    await settleAttempt(repo, attempt, [PATHS.tsQuotes]);
    const settled = repo.rawState();
    expect(contractViolations(settled, "T4").size).toBe(0);
    expect(storedTask(settled, "T4").status).toBe("implemented");
  });

  it("drops one export of a binding that keeps another: the Task implements only the export still bound and settles", async () => {
    const repo = skeletonRepo();
    expect(await amend(["--task", "T4", "--file", PATHS.tsPricing, "--export", "parseOrder", "--drop", "--reason", REASON]))
      .toEqual({ kind: "allow" });
    const attempt = authorityOf(await registered(repo, "T4"), "T4");
    // Registration wrote pricing.ts from the amended stamp: priceOrder alone.
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalTsSkeleton(PATHS.tsPricing, [{ name: "priceOrder", alias: "PriceOrderFn" }]));
    const others = writeT4ButQuotes(repo);
    repo.write(PATHS.tsPricing, PRICE_ORDER_ONLY);
    repo.write(PATHS.tsQuotes, CONFORMING_QUOTES);
    await settleAttempt(repo, attempt, [...others, PATHS.tsQuotes]);
    const settled = repo.rawState();
    expect(contractViolations(settled, "T4").size).toBe(0);
    expect(storedTask(settled, "T4").status).toBe("implemented");
  });

  it("rebinds an export: the retry refreshes the skeleton to the new name, withdraws the old violation, and settles", async () => {
    const repo = skeletonRepo();
    await failOnStillUnimplementedQuote(repo);
    expect(await amend(["--task", "T4", "--file", PATHS.tsQuotes, "--export", "quote", "--rebind", "quoteFor", "--reason", REASON]))
      .toEqual({ kind: "allow" });
    const retry = retryPrompt(repo);
    expect(retry).not.toContain("fix every one before completing");
    expect(retry.split("\n").slice(-3)).toEqual([
      expect.stringContaining("an amended export binding no longer owes"),
      `${PATHS.tsQuotes}:`,
      "  - quote: still-unimplemented",
    ]);

    // Registration refreshes the untouched engine skeleton from the amended stamp.
    const attempt = authorityOf(await registered(repo, "T4"), "T4");
    expect(attempt.semanticAttempt).toBe(2);
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalTsSkeleton(PATHS.tsQuotes, [{ name: "quoteFor", alias: "PriceOrderFn" }]));

    repo.write(PATHS.tsQuotes, CONFORMING_QUOTE_FOR);
    await settleAttempt(repo, attempt, [PATHS.tsQuotes]);
    const settled = repo.rawState();
    expect(contractViolations(settled, "T4").size).toBe(0);
    expect(storedTask(settled, "T4").status).toBe("implemented");
  });

  it("is idempotent: the repeat changes no byte of the State File", async () => {
    const repo = skeletonRepo();
    expect(await amend(DROP_QUOTE)).toEqual({ kind: "allow" });
    const before = readFileSync(repo.statePath, "utf8");
    expect(await amend(DROP_QUOTE)).toEqual({ kind: "allow" });
    expect(readFileSync(repo.statePath, "utf8")).toBe(before);
  });

  it("refuses without writing: malformed arguments, a binding the Task does not hold, an active subagent before or under the lock", async () => {
    const repo = skeletonRepo();
    const before = readFileSync(repo.statePath, "utf8");
    expect(await amend(["--task", "T4", "--file", PATHS.tsQuotes, "--export", "quote", "--reason", "r"]))
      .toMatchObject({ kind: "error", message: expect.stringContaining("give --drop or --rebind <newName>") });
    expect(await amend(["--task", "T5", ...DROP_QUOTE.slice(2)]))
      .toMatchObject({ kind: "error", message: expect.stringContaining(`refused without changing state: ${PATHS.tsQuotes} is not in T5's file_list`) });
    expect(await amend(DROP_QUOTE, () => true)).toMatchObject({ kind: "error", message: expect.stringContaining("refused while a subagent is active") });
    expect(await amend(DROP_QUOTE, appearsUnderTheLock().probe)).toMatchObject({ kind: "error" });
    expect(readFileSync(repo.statePath, "utf8")).toBe(before);
  });

  it("refuses while T4's own attempt is live", async () => {
    const repo = skeletonRepo();
    await registered(repo, "T4");
    const before = readFileSync(repo.statePath, "utf8");
    expect(await amend(DROP_QUOTE)).toMatchObject({ kind: "error", message: expect.stringContaining("implementation reservations are active: T4") });
    expect(readFileSync(repo.statePath, "utf8")).toBe(before);
  });
});
