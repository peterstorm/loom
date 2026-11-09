/**
 * CT-3 acceptance: skeletons materialize when an implementation Task is
 * registered (plan AD-1), through `registerTaskExecutionBatch` — the one
 * registration shell both harnesses' spawn gates call.
 *
 * Every testcase builds the skeleton fixture repository (a real temp Git
 * repository with frozen TypeScript and Java contracts and a raw-JSON State
 * File carrying the `export_bindings` stamp), registers Wave 2 Tasks through
 * the real entry point, and reads back the repository bytes and the stored
 * State File as unknown JSON narrowed by CT-1's types. Written skeletons are
 * compared byte for byte with the canonical CT-1 format the fixture renders.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  registerTaskExecutionBatch,
  rollbackTaskExecutionRegistration,
  type TaskExecutionRegistrationOutcome,
} from "../../src/handlers/task-execution";
import type { SkeletonOutcome } from "../../src/core/skeleton/types";
import {
  authorityOf,
  canonicalJavaSkeleton,
  canonicalSkeletonOf,
  canonicalTsSkeleton,
  cleanupSkeletonRepos,
  JAVA_ARITY,
  JAVA_EXISTING_TEXT,
  PATHS,
  recordedOutcomes,
  recordedSkeletons,
  registered,
  settleAttempt,
  sha256,
  SHADOWING_VIEW_TEXT,
  skeletonRepo,
  spawnFor,
  storedTask,
  TS_CONTRACT,
  TS_LEGACY_TEXT,
  TS_TYPES_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

/** Register the owed spawns of `taskIds` as one parallel batch. */
const register = (repo: SkeletonRepo, ...taskIds: readonly string[]): Promise<TaskExecutionRegistrationOutcome> =>
  registerTaskExecutionBatch(taskIds.map((taskId) => spawnFor(repo.rawState(), taskId)));

const written = (origin: "spawn" | "contract-stub" | "revision" = "spawn"): SkeletonOutcome => ({ kind: "skeleton-written", origin });

/** The CT-1 types file without `ParseOrderFn`, which `pricing.ts` binds. */
const TYPES_WITHOUT_PARSE_ORDER = TS_TYPES_TEXT.replace("export type ParseOrderFn = (raw: string) => Order;\n", "");

/** The CT-1 types file declaring `ParseOrderFn` as an object type, not a function type. */
const TYPES_WITH_NON_FUNCTION_PARSE_ORDER = TS_TYPES_TEXT.replace(
  "export type ParseOrderFn = (raw: string) => Order;",
  "export type ParseOrderFn = Readonly<{ raw: string }>;",
);

describe("skeletons at registration (CT-3)", () => {
  it("FR-005: registering an implementation Task writes a skeleton at every not-yet-existing bound TypeScript and Java path before its attempt is reserved", async () => {
    const repo = skeletonRepo();

    const authorities = await registered(repo, "T4", "T5");

    for (const path of [PATHS.tsPricing, PATHS.tsQuotes, PATHS.javaPricing]) {
      expect(repo.read(path), path).toBe(canonicalSkeletonOf(path));
    }
    // The skeleton existed when the attempt baselines were captured, so the
    // reservation that committed with it already saw the engine's bytes.
    const stored = repo.rawState();
    for (const [taskId, path] of [["T4", PATHS.tsPricing], ["T5", PATHS.javaPricing]] as const) {
      const task = storedTask(stored, taskId);
      expect(task.active_implementation_attempt).toEqual(authorityOf(authorities, taskId));
      const baseline = Array.isArray(task.attempt_artifact_baseline) ? task.attempt_artifact_baseline : [];
      const entry = baseline.find((candidate: unknown) =>
        typeof candidate === "object" && candidate !== null && (candidate as { artifact?: unknown }).artifact === path);
      expect(entry, `${taskId} baseline of ${path}`).toBeDefined();
      expect((entry as { snapshot: { kind: string } }).snapshot.kind, `${taskId} baseline of ${path}`).not.toBe("missing");
    }
  });

  it("FR-005: each written skeleton is recorded with the digest of the engine's bytes and of the frozen types file, in the same update as the reservation", async () => {
    const repo = skeletonRepo();

    await registered(repo, "T4", "T5");

    const records = recordedSkeletons(repo.rawState());
    expect([...records.keys()].sort()).toEqual([PATHS.javaPricing, PATHS.tsPricing, PATHS.tsQuotes].sort());
    for (const path of [PATHS.tsPricing, PATHS.tsQuotes]) {
      expect(records.get(path)).toEqual({
        path,
        contract: "CT-1",
        language: "typescript",
        origin: "spawn",
        engineSha256: sha256(canonicalSkeletonOf(path)),
        typesSha256: sha256(TS_TYPES_TEXT),
        stale: null,
      });
    }
    expect(records.get(PATHS.javaPricing)).toMatchObject({
      contract: "CT-2",
      language: "java",
      origin: "spawn",
      engineSha256: sha256(canonicalSkeletonOf(PATHS.javaPricing)),
      stale: null,
    });
  });

  it("AS-010: a not-yet-existing .ts file bound to `parseOrder: ParseOrderFn` exists before the implementer runs, type-importing the alias and exporting `parseOrder` annotated with it, throwing `unimplemented: parseOrder`", async () => {
    const repo = skeletonRepo();
    expect(repo.read(PATHS.tsPricing)).toBeNull();

    await registered(repo, "T4");

    const bytes = repo.read(PATHS.tsPricing);
    expect(bytes).toBe(canonicalTsSkeleton(PATHS.tsPricing, [
      { name: "priceOrder", alias: "PriceOrderFn" },
      { name: "parseOrder", alias: "ParseOrderFn" },
    ]));
    expect(bytes).toContain(`import type { ParseOrderFn, PriceOrderFn } from "./order-contract";\n`);
    expect(bytes).toContain(`export const parseOrder: ParseOrderFn = () => {\n  throw new Error("unimplemented: parseOrder");\n};\n`);
    expect(bytes?.match(/export const parseOrder\b/g)).toHaveLength(1);
  });

  it("AS-016: a not-yet-existing .java file bound to `priceOrder: PriceOrderFn` exists before the implementer runs, with one static final member of the frozen interface throwing `unimplemented: priceOrder`", async () => {
    const repo = skeletonRepo();
    expect(repo.read(PATHS.javaPricing)).toBeNull();

    await registered(repo, "T5");

    const bytes = repo.read(PATHS.javaPricing);
    expect(bytes).toBe(canonicalJavaSkeleton(PATHS.javaPricing, [
      { name: "priceOrder", alias: "PriceOrderFn" },
      { name: "parseOrder", alias: "ParseOrderFn" },
    ], JAVA_ARITY));
    expect(bytes).toContain("import com.acme.order.OrderContract.PriceOrderFn;\n");
    expect(bytes).toContain(
      "    public static final PriceOrderFn priceOrder = (p0, p1) -> {\n" +
      "        throw new UnsupportedOperationException(\"unimplemented: priceOrder\");\n" +
      "    };\n",
    );
    expect(bytes?.match(/ priceOrder = /g)).toHaveLength(1);
  });

  it("FR-030: registration records exactly one skeleton outcome per non-test file_list path of each registered Task", async () => {
    const repo = skeletonRepo();

    await registered(repo, "T4", "T5", "T6");

    const stored = repo.rawState();
    expect(Object.fromEntries(recordedOutcomes(stored, "T4"))).toEqual({
      [PATHS.tsPricing]: written(),
      [PATHS.tsQuotes]: written(),
      [PATHS.tsLegacy]: { kind: "exists-not-skeletonized" },
      [PATHS.pythonRates]: { kind: "unsupported-language", reason: "other-extension" },
      [PATHS.tsHelpers]: { kind: "no-bound-exports" },
    });
    expect(Object.fromEntries(recordedOutcomes(stored, "T5"))).toEqual({
      [PATHS.javaPricing]: written(),
      [PATHS.javaExisting]: { kind: "exists-not-skeletonized" },
      [PATHS.javaDiscounts]: { kind: "no-bound-exports" },
    });
    expect(Object.fromEntries(recordedOutcomes(stored, "T6"))).toEqual({
      [PATHS.auditLog]: { kind: "contract-has-no-types-file" },
    });
    // The test file owns no outcome, and nothing was written for the fallbacks.
    expect(recordedOutcomes(stored, "T4").has(PATHS.tsTest)).toBe(false);
    for (const path of [PATHS.pythonRates, PATHS.tsHelpers, PATHS.javaDiscounts, PATHS.auditLog, PATHS.tsTest]) {
      expect(repo.read(path), path).toBeNull();
    }
  });

  it("FR-011: a file_list path that exists when the Wave starts is never modified, bound or not", async () => {
    const repo = skeletonRepo();

    await registered(repo, "T4", "T5", "T7", "T8");

    expect(repo.read(PATHS.tsLegacy)).toBe(TS_LEGACY_TEXT);
    expect(repo.read(PATHS.javaExisting)).toBe(JAVA_EXISTING_TEXT);
    expect(repo.read(PATHS.stateView)).toBe(SHADOWING_VIEW_TEXT);
    expect(repo.read(PATHS.orderView)).toBe(SHADOWING_VIEW_TEXT);
    const records = recordedSkeletons(repo.rawState());
    for (const path of [PATHS.tsLegacy, PATHS.javaExisting, PATHS.stateView, PATHS.orderView]) {
      expect(records.has(path), path).toBe(false);
    }
    // The same registration did write the Wave's missing bound files.
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
  });

  it("AS-013: an existing bound .ts path is left byte-identical and recorded \"exists, not skeletonized\"", async () => {
    const repo = skeletonRepo();

    await registered(repo, "T4");

    expect(repo.read(PATHS.tsLegacy)).toBe(TS_LEGACY_TEXT);
    expect(recordedOutcomes(repo.rawState(), "T4").get(PATHS.tsLegacy)).toEqual({ kind: "exists-not-skeletonized" });
    expect(recordedSkeletons(repo.rawState()).has(PATHS.tsLegacy)).toBe(false);
  });

  it("AS-019: an existing bound .java path is left byte-identical and recorded \"exists, not skeletonized\"", async () => {
    const repo = skeletonRepo();

    await registered(repo, "T5");

    expect(repo.read(PATHS.javaExisting)).toBe(JAVA_EXISTING_TEXT);
    expect(recordedOutcomes(repo.rawState(), "T5").get(PATHS.javaExisting)).toEqual({ kind: "exists-not-skeletonized" });
    expect(recordedSkeletons(repo.rawState()).has(PATHS.javaExisting)).toBe(false);
  });

  it("AS-014: a not-yet-existing .ts file with no bindings gets no file and is recorded \"no bound exports, no skeleton\"", async () => {
    const repo = skeletonRepo();

    await registered(repo, "T4");

    expect(repo.read(PATHS.tsHelpers)).toBeNull();
    expect(recordedOutcomes(repo.rawState(), "T4").get(PATHS.tsHelpers)).toEqual({ kind: "no-bound-exports" });
  });

  it("AS-018: a not-yet-existing .java file with no bindings gets no file and is recorded \"no bound exports, no skeleton\"", async () => {
    const repo = skeletonRepo();

    await registered(repo, "T5");

    expect(repo.read(PATHS.javaDiscounts)).toBeNull();
    expect(recordedOutcomes(repo.rawState(), "T5").get(PATHS.javaDiscounts)).toEqual({ kind: "no-bound-exports" });
  });

  it("AS-012: registering again over an untouched skeleton changes 0 bytes and keeps its record", async () => {
    const repo = skeletonRepo();
    const first = await registered(repo, "T4");
    const bytes = repo.read(PATHS.tsPricing);
    const record = recordedSkeletons(repo.rawState()).get(PATHS.tsPricing);
    expect(bytes).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(record).toBeDefined();

    // The harness could not carry the capability: the registration is rolled
    // back exactly, and the same Task is registered again.
    expect(await rollbackTaskExecutionRegistration(first)).toEqual({ kind: "allow" });
    await registered(repo, "T4");

    expect(repo.read(PATHS.tsPricing)).toBe(bytes);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.tsPricing)).toEqual(record);
    expect(recordedOutcomes(repo.rawState(), "T4").get(PATHS.tsPricing)).toEqual(written());
  });

  it("FR-032: a retry regenerates a deleted skeleton still in file_list, keeps every other byte on disk, and a failed attempt deletes no skeleton", async () => {
    const repo = skeletonRepo();
    const [attempt] = await registered(repo, "T4");
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));

    // The first attempt implements quotes.ts, deletes pricing.ts, and fails.
    const quotes = `import type { PriceOrderFn } from "./order-contract";\n\nexport const quote: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });\n`;
    repo.write(PATHS.tsQuotes, quotes);
    repo.remove(PATHS.tsPricing);
    await settleAttempt(repo, attempt!, [PATHS.tsQuotes, PATHS.tsPricing], false);
    expect(storedTask(repo.rawState(), "T4").status).toBe("pending");
    expect(repo.read(PATHS.tsQuotes)).toBe(quotes);

    const [retry] = await registered(repo, "T4");

    expect(retry?.semanticAttempt).toBe(2);
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(repo.read(PATHS.tsQuotes)).toBe(quotes);
    expect(repo.read(PATHS.tsLegacy)).toBe(TS_LEGACY_TEXT);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.tsPricing)).toMatchObject({
      origin: "spawn",
      engineSha256: sha256(canonicalSkeletonOf(PATHS.tsPricing)),
    });
  });
});

describe("stage-two resolution at registration (CT-3)", () => {
  it("AS-007: a frozen types file declaring every alias the plan binds lets the next Wave start normally, with its skeletons", async () => {
    const repo = skeletonRepo();

    const outcome = await register(repo, "T4", "T5", "T6");

    expect(outcome.kind).toBe("registered");
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(repo.read(PATHS.javaPricing)).toBe(canonicalSkeletonOf(PATHS.javaPricing));
    expect(recordedOutcomes(repo.rawState(), "T6").get(PATHS.auditLog)).toEqual({ kind: "contract-has-no-types-file" });
  });

  it("AS-008: a frozen types file missing a bound alias refuses the start, naming the alias, the binding file and the types file, and writes nothing", async () => {
    const repo = skeletonRepo({ tsTypesText: TYPES_WITHOUT_PARSE_ORDER });
    const before = repo.read(".claude/state/active_task_graph.json");

    const outcome = await register(repo, "T4");

    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.message).toContain("ParseOrderFn");
    expect(outcome.message).toContain(PATHS.tsPricing);
    expect(outcome.message).toContain(TS_CONTRACT.types);
    expect(repo.read(PATHS.tsPricing)).toBeNull();
    expect(repo.read(PATHS.tsQuotes)).toBeNull();
    expect(repo.read(".claude/state/active_task_graph.json")).toBe(before);
  });

  it("AS-009: a bound alias the frozen types file declares as no function type refuses the start, naming the alias and saying it is not a function type", async () => {
    const repo = skeletonRepo({ tsTypesText: TYPES_WITH_NON_FUNCTION_PARSE_ORDER });

    const outcome = await register(repo, "T4");

    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.message).toContain("ParseOrderFn");
    expect(outcome.message).toMatch(/not a function type/i);
    expect(outcome.message).toContain(PATHS.tsPricing);
    expect(outcome.message).toContain(TS_CONTRACT.types);
    expect(repo.read(PATHS.tsPricing)).toBeNull();
    expect(storedTask(repo.rawState(), "T4").active_implementation_attempt).toBeUndefined();
  });
});
