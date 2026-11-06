/**
 * CT-3 acceptance: every file's skeleton outcome, every stale flag and the
 * frozen duties are shown (plan AD-13), through `helper orchestration status
 * [--json]` — spawned exactly as an operator types it — and
 * `renderTaskImplementationBrief`, the shell behind `helper orchestration
 * brief` and the spawn gate's marker expansion.
 *
 * The status document is read as unknown JSON: a skeleton report is any value
 * under a `skeletons` key, listing `{ path, outcome }` entries whose outcome
 * narrows to CT-1's `SkeletonOutcome`, and flagging a stale skeleton with
 * `{ path, stale: { revision } }`. The human status and the brief are read for
 * the exact AD-13 render strings, on the line that names the file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import type { SkeletonOutcome } from "../../src/core/skeleton/types";
import {
  briefOf,
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  OUTCOME_TEXT,
  orchestrationStatus,
  PATHS,
  recordedSkeletons,
  seededRecord,
  skeletonRepo,
  someLine,
  someParagraph,
  spawnFor,
  statusDocument,
  statusOutcomes,
  statusStaleFlags,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

const toWrite: SkeletonOutcome = { kind: "skeleton-written", origin: "spawn" };
const exists: SkeletonOutcome = { kind: "exists-not-skeletonized" };
const noBound: SkeletonOutcome = { kind: "no-bound-exports" };

/** Every non-test file_list path of Wave 2, with the one outcome it has before any spawn. */
const WAVE_2_OUTCOMES: Readonly<Record<string, SkeletonOutcome>> = {
  [PATHS.tsPricing]: toWrite,
  [PATHS.tsQuotes]: toWrite,
  [PATHS.tsLegacy]: exists,
  [PATHS.pythonRates]: { kind: "unsupported-language", reason: "other-extension" },
  [PATHS.tsHelpers]: noBound,
  [PATHS.javaPricing]: toWrite,
  [PATHS.javaExisting]: exists,
  [PATHS.javaDiscounts]: noBound,
  [PATHS.auditLog]: { kind: "contract-has-no-types-file" },
  [PATHS.stateView]: exists,
  [PATHS.orderView]: exists,
};

/** The status document's outcomes, keyed by path; a path listed twice fails. */
function outcomesByPath(document: unknown): Readonly<Record<string, SkeletonOutcome>> {
  const listed = statusOutcomes(document);
  const paths = listed.map(({ path }) => path);
  expect(paths.filter((path, index) => paths.indexOf(path) !== index), "paths listed more than once").toEqual([]);
  return Object.fromEntries(listed.map(({ path, outcome }) => [path, outcome]));
}

/** A modified `pricing.ts` whose record a revision flagged stale, and an
 *  untouched `quotes.ts` the engine wrote at spawn. */
function repoWithRecordedSkeletons(): SkeletonRepo {
  const repo = skeletonRepo({
    skeletons: [
      { ...seededRecord(PATHS.tsPricing, canonicalSkeletonOf(PATHS.tsPricing)), stale: { revision: 1 } },
      seededRecord(PATHS.tsQuotes, canonicalSkeletonOf(PATHS.tsQuotes)),
    ],
  });
  repo.write(PATHS.tsPricing, `import type { PriceOrderFn } from "./order-contract";\n\nexport const priceOrder: PriceOrderFn = () => ({ cents: 0 });\n`);
  repo.write(PATHS.tsQuotes, canonicalSkeletonOf(PATHS.tsQuotes));
  return repo;
}

describe("skeleton outcomes in helper orchestration status (CT-3)", () => {
  it("AS-042: every non-test file_list path of the Wave's implementation Tasks is listed with exactly one outcome", () => {
    const repo = skeletonRepo();

    const listed = outcomesByPath(statusDocument(repo));

    expect(listed).toEqual(WAVE_2_OUTCOMES);
    expect(Object.keys(listed)).not.toContain(PATHS.tsTest);
  });

  it("FR-040: status shows each file's skeleton outcome, recorded or projected, and every stale flag, in --json and in the human view", () => {
    const repo = repoWithRecordedSkeletons();

    const document = statusDocument(repo);

    expect(outcomesByPath(document)).toMatchObject({
      [PATHS.tsQuotes]: toWrite,
      [PATHS.tsHelpers]: noBound,
      [PATHS.auditLog]: { kind: "contract-has-no-types-file" },
    });
    expect(statusStaleFlags(document)).toEqual([{ path: PATHS.tsPricing, revision: 1 }]);
    const human = orchestrationStatus(repo, false).stdout;
    expect(someLine(human, PATHS.tsQuotes, OUTCOME_TEXT.written)).toBe(true);
    expect(someLine(human, PATHS.tsHelpers, OUTCOME_TEXT.noBoundExports)).toBe(true);
    expect(someLine(human, PATHS.tsPricing, OUTCOME_TEXT.stale)).toBe(true);
  });

  it("AS-038: a file with no bound exports is named \"no bound exports, no skeleton\" in status and in its Task's brief", () => {
    const repo = skeletonRepo();

    expect(outcomesByPath(statusDocument(repo))[PATHS.tsHelpers]).toEqual(noBound);
    expect(someLine(orchestrationStatus(repo, false).stdout, PATHS.tsHelpers, OUTCOME_TEXT.noBoundExports)).toBe(true);
    expect(someLine(briefOf(repo, "T4"), PATHS.tsHelpers, OUTCOME_TEXT.noBoundExports)).toBe(true);
    expect(someLine(briefOf(repo, "T5"), PATHS.javaDiscounts, OUTCOME_TEXT.noBoundExports)).toBe(true);
  });

  it("AS-039: a claimant of a `Types file: none` contract gets no skeleton; status and its brief say \"contract has no types file, no skeletons\"", async () => {
    const repo = skeletonRepo();

    expect(outcomesByPath(statusDocument(repo))[PATHS.auditLog]).toEqual({ kind: "contract-has-no-types-file" });
    expect(someLine(orchestrationStatus(repo, false).stdout, PATHS.auditLog, OUTCOME_TEXT.noTypesFile)).toBe(true);
    expect(someLine(briefOf(repo, "T6"), PATHS.auditLog, OUTCOME_TEXT.noTypesFile)).toBe(true);
    const outcome = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T6")]);
    expect(outcome.kind).toBe("registered");
    expect(repo.read(PATHS.auditLog)).toBeNull();
  });

  it("AS-040: a bound file in a language other than TypeScript or Java gets no file; status and the brief say \"unsupported language, no skeleton\"", async () => {
    const repo = skeletonRepo();

    expect(outcomesByPath(statusDocument(repo))[PATHS.pythonRates]).toEqual({ kind: "unsupported-language", reason: "other-extension" });
    expect(someLine(orchestrationStatus(repo, false).stdout, PATHS.pythonRates, OUTCOME_TEXT.unsupported)).toBe(true);
    expect(someLine(briefOf(repo, "T4"), PATHS.pythonRates, OUTCOME_TEXT.unsupported)).toBe(true);
    await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")]);
    expect(repo.read(PATHS.pythonRates)).toBeNull();
  });

  it("AS-041: an existing file_list path is named \"exists, not skeletonized\" in status and in its Task's brief", () => {
    const repo = skeletonRepo();

    const listed = outcomesByPath(statusDocument(repo));
    expect(listed[PATHS.tsLegacy]).toEqual(exists);
    expect(listed[PATHS.javaExisting]).toEqual(exists);
    expect(someLine(orchestrationStatus(repo, false).stdout, PATHS.tsLegacy, OUTCOME_TEXT.exists)).toBe(true);
    expect(someLine(briefOf(repo, "T4"), PATHS.tsLegacy, OUTCOME_TEXT.exists)).toBe(true);
    expect(someLine(briefOf(repo, "T5"), PATHS.javaExisting, OUTCOME_TEXT.exists)).toBe(true);
  });

  it("AS-006: a run whose plan binds nothing proceeds with no skeletons, and every new file is reported \"no bound exports, no skeleton\"", async () => {
    const repo = skeletonRepo({ bindings: "none" });
    const newFiles = [PATHS.tsPricing, PATHS.tsQuotes, PATHS.pythonRates, PATHS.tsHelpers, PATHS.javaPricing, PATHS.javaDiscounts];

    const listed = outcomesByPath(statusDocument(repo));
    for (const path of newFiles) expect(listed[path], path).toEqual(noBound);
    const human = orchestrationStatus(repo, false).stdout;
    for (const path of newFiles) expect(someLine(human, path, OUTCOME_TEXT.noBoundExports), path).toBe(true);

    const outcome = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4"), spawnFor(repo.rawState(), "T5")]);
    expect(outcome.kind).toBe("registered");
    for (const path of newFiles) expect(repo.read(path), path).toBeNull();
    expect(recordedSkeletons(repo.rawState()).size).toBe(0);
  });
});

describe("frozen duties in the implementation brief (CT-3)", () => {
  it("AS-046: the brief of a Task owning skeleton files lists each bound export with its alias, says the signatures are frozen and that the `unimplemented` marker must be gone at completion", () => {
    const repo = skeletonRepo();

    const brief = briefOf(repo, "T4");

    expect(someParagraph(brief, PATHS.tsPricing, "priceOrder", "PriceOrderFn")).toBe(true);
    expect(someLine(brief, "priceOrder", "PriceOrderFn")).toBe(true);
    expect(someLine(brief, "parseOrder", "ParseOrderFn")).toBe(true);
    expect(someParagraph(brief, PATHS.tsQuotes, "quote", "PriceOrderFn")).toBe(true);
    expect(someParagraph(brief, /signatures?/i, /frozen/i, "PriceOrderFn")).toBe(true);
    expect(someParagraph(brief, /unimplemented/, /\b(?:gone|remove|removed|no longer|must not remain)\b/i)).toBe(true);
    const java = briefOf(repo, "T5");
    expect(someParagraph(java, PATHS.javaPricing, "priceOrder", "PriceOrderFn")).toBe(true);
  });

  it("AS-047: the brief of a Task whose contract freezes ADTs names them and says they must be imported, not re-declared or re-listed", () => {
    const repo = skeletonRepo();

    const brief = briefOf(repo, "T4");
    expect(someParagraph(brief, "OrderState", "OrderId", /import/i, /re-?declare/i, /re-?list/i)).toBe(true);
    const java = briefOf(repo, "T5");
    expect(someParagraph(java, "OrderState", "Draft", "Paid", /import/i, /re-?declare/i)).toBe(true);
  });

  it("AS-048: the brief states each fallback outcome for each affected file", () => {
    const repo = skeletonRepo();

    const brief = briefOf(repo, "T4");
    expect(someLine(brief, PATHS.tsHelpers, OUTCOME_TEXT.noBoundExports)).toBe(true);
    expect(someLine(brief, PATHS.tsLegacy, OUTCOME_TEXT.exists)).toBe(true);
    expect(someLine(brief, PATHS.pythonRates, OUTCOME_TEXT.unsupported)).toBe(true);
    expect(someLine(briefOf(repo, "T6"), PATHS.auditLog, OUTCOME_TEXT.noTypesFile)).toBe(true);
    expect(someLine(briefOf(repo, "T7"), PATHS.stateView, OUTCOME_TEXT.exists)).toBe(true);
  });

  it("FR-024: per owned file the brief lists the bound exports and frozen aliases, the frozen-signature and marker rules, and the frozen ADTs to import", () => {
    const repo = skeletonRepo();

    const brief = briefOf(repo, "T4");
    for (const [path, name, alias] of [
      [PATHS.tsPricing, "priceOrder", "PriceOrderFn"],
      [PATHS.tsPricing, "parseOrder", "ParseOrderFn"],
      [PATHS.tsQuotes, "quote", "PriceOrderFn"],
      [PATHS.tsLegacy, "quoteOrder", "PriceOrderFn"],
    ] as const) {
      expect(someParagraph(brief, path, name, alias), `${path} ${name}: ${alias}`).toBe(true);
    }
    expect(someParagraph(brief, /signatures?/i, /frozen/i, "PriceOrderFn")).toBe(true);
    expect(someParagraph(brief, /unimplemented/)).toBe(true);
    expect(someParagraph(brief, "OrderState", "OrderId", /import/i)).toBe(true);
  });
});
