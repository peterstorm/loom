/**
 * Skeletons, export bindings and a Distill Task (ADR-0068 §9), in the
 * skeleton fixture repository with its frozen contracts: registration writes,
 * adopts and refreshes no Skeleton on a Distill Task's behalf, records only
 * outcomes that are true, and is not blocked by a binding it does not hold;
 * and a distill move that breaks a bound export is restored (§5).
 */
import { afterEach, describe, expect, it } from "vitest";
import { distillSnapshotRef } from "../../src/core/distill-task";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import { evaluateProofObligations } from "../../src/core/proof-obligations";
import {
  productionExactSettlementPorts,
  settleAndPersistExactImplementation,
} from "../../src/handlers/helpers/exact-implementation-settlement";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { observeSkeletons } from "../../src/orchestration/skeleton-observation";
import type { Task } from "../../src/types";
import { behaviourPreservedBasis, distillSnapshotRefs, settlementFacts } from "../fixtures/distill-settlement";
import {
  authorityOf,
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  graphOf,
  managerOf,
  PATHS,
  recordedOutcomes,
  recordedSkeletons,
  registered,
  seededRecord,
  settleAttempt,
  skeletonRepo,
  spawnFor,
  storedTask,
  TS_CONTRACT,
  TS_TYPES_TEXT,
  type SkeletonRepo,
  type SkeletonRepoOptions,
} from "../fixtures/skeleton-repo";
import { taskFixture, trustedPassEvidence } from "../fixtures/task-lifecycle";

afterEach(cleanupSkeletonRepos);

const IMPLEMENTED_PRICING = `import type { ParseOrderFn, PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });

export const parseOrder: ParseOrderFn = (raw) => ({ id: raw, lines: [] });
`;

/** `pricing.ts` after a "distill move" that deleted a bound export. */
const PRICING_WITHOUT_PARSE_ORDER = `import type { PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });
`;

/** T4's implementation files: bound and missing, bound and present, bound to an unsupported language, unbound. */
const SCOPE = [PATHS.tsPricing, PATHS.tsQuotes, PATHS.tsLegacy, PATHS.pythonRates, PATHS.tsHelpers] as const;

/** `task` as it stands once its attempt settled: implemented, every obligation satisfied. */
function implemented(task: Task): Task {
  if (task.proof === undefined) throw new Error(`fixture: ${task.id} has no Proof`);
  const proof = evaluateProofObligations(task.proof.obligations, trustedPassEvidence(task.file_list ?? []));
  if (proof.state !== "satisfied") throw new Error(`fixture: ${task.id} is not satisfiable by a trusted pass`);
  return taskFixture({ ...task, status: "implemented", proof });
}

/**
 * The fixture's implementation Wave with every authored Task implemented and
 * its Distill Task `T9` over T4's implementation files. `pricing.ts` holds a
 * conforming implementation; `quotes.ts` (bound, supported) is missing, as if
 * a sibling deleted it.
 */
function distillWave(options: SkeletonRepoOptions = {}, pricing = IMPLEMENTED_PRICING): SkeletonRepo {
  const repo = skeletonRepo(options);
  repo.write(PATHS.tsPricing, pricing);
  repo.commit("wave 2 implemented");
  const graph = graphOf(repo);
  const distill = taskFixture({
    id: "T9", description: "Distill pass for Wave 2", agent: DISTILL_AGENT, wave: 2, depends_on: [],
    file_list: [...SCOPE], spec_anchors: [], spec_contributions: [],
  });
  const tasks = [...graph.tasks.map((task) => (task.wave === 2 ? implemented(task) : task)), distill];
  repo.rewriteState((raw) => ({ ...raw, tasks: JSON.parse(JSON.stringify(tasks)) }));
  // The rewritten State File must load before anything is asserted about it.
  graphOf(repo);
  return repo;
}

const distillRefs = (repo: SkeletonRepo): readonly string[] => distillSnapshotRefs(repo.root);

describe("registering a Distill Task over bound files", () => {
  it("writes no skeleton at a bound path a sibling left missing, and records only outcomes that are true", async () => {
    const repo = distillWave();
    const skeletonsBefore = [...recordedSkeletons(repo.rawState()).keys()];

    const authorities = await registered(repo, "T9");

    expect(repo.read(PATHS.tsQuotes)).toBeNull();
    expect(repo.read(PATHS.pythonRates)).toBeNull();
    expect(repo.read(PATHS.tsHelpers)).toBeNull();
    expect(repo.read(PATHS.tsPricing)).toBe(IMPLEMENTED_PRICING);
    expect([...recordedSkeletons(repo.rawState()).keys()]).toEqual(skeletonsBefore);
    expect(Object.fromEntries(recordedOutcomes(repo.rawState(), "T9"))).toEqual({
      [PATHS.tsPricing]: { kind: "exists-not-skeletonized" },
      [PATHS.tsLegacy]: { kind: "exists-not-skeletonized" },
      [PATHS.pythonRates]: { kind: "unsupported-language", reason: "other-extension" },
      [PATHS.tsHelpers]: { kind: "no-bound-exports" },
      // Bound, supported and missing: nothing is written, and the outcome says so.
      [PATHS.tsQuotes]: { kind: "absent-no-skeleton-owed" },
    });
    // The State File with those outcomes loads, and the attempt is live with its snapshot.
    expect(graphOf(repo).tasks.find(({ id }) => id === "T9")?.active_implementation_attempt).toBeDefined();
    expect(distillRefs(repo)).toEqual([distillSnapshotRef(authorityOf(authorities, "T9").authorityDigest)]);
  });

  it("neither adopts nor refreshes an untouched engine skeleton: that Skeleton is its holder's", async () => {
    // `quotes.ts` holds the engine's canonical bytes with NO record (a holder would adopt it),
    // and `pricing.ts` holds recorded engine bytes of an older surface (a holder would refresh it).
    const staleEngineBytes = "// Skeleton written by Loom from an older surface.\n";
    const repo = distillWave({ skeletons: [seededRecord(PATHS.tsPricing, staleEngineBytes)] }, staleEngineBytes);
    repo.write(PATHS.tsQuotes, canonicalSkeletonOf(PATHS.tsQuotes));
    repo.commit("engine bytes on disk");
    const recordsBefore = JSON.stringify([...recordedSkeletons(repo.rawState())]);

    await registered(repo, "T9");

    expect(repo.read(PATHS.tsPricing)).toBe(staleEngineBytes);
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));
    expect(JSON.stringify([...recordedSkeletons(repo.rawState())])).toBe(recordsBefore);
    expect(recordedOutcomes(repo.rawState(), "T9").get(PATHS.tsPricing)).toEqual({ kind: "exists-not-skeletonized" });
    expect(recordedOutcomes(repo.rawState(), "T9").get(PATHS.tsQuotes)).toEqual({ kind: "exists-not-skeletonized" });
  });

  it("is not blocked by a stage-two problem of a binding it does not hold, which blocks the holder", async () => {
    const repo = distillWave();
    repo.write(TS_CONTRACT.types, `${TS_TYPES_TEXT}// drifted\n`);
    // The same graph with T4 owed again: its registration resolves the bindings it holds, and is refused.
    const holderGraph = graphOf(repo);
    const holder = holderGraph.tasks.find(({ id }) => id === "T4");
    const pass = holderGraph.tasks.find(({ id }) => id === "T9");
    if (holder === undefined || pass === undefined) throw new Error("fixture tasks");
    expect(observeSkeletons(repo.root, holderGraph, [holder], [holder]))
      .toMatchObject({ ok: true, value: { unresolved: [expect.objectContaining({ message: expect.stringContaining("no longer matches its Acceptance Freeze stamp") })] } });
    // What status reports for the Wave's one outstanding Task, the Distill Task: nothing unresolved.
    expect(observeSkeletons(repo.root, holderGraph, [pass], [pass])).toMatchObject({ ok: true, value: { unresolved: [] } });

    const outcome = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T9")]);

    expect(outcome.kind).toBe("registered");
    expect(storedTask(repo.rawState(), "T9").active_implementation_attempt).toBeDefined();
  });

  it("still observes the frozen surface of every contract its files bind, for its brief", () => {
    const repo = distillWave();
    const graph = graphOf(repo);
    const pass = graph.tasks.find(({ id }) => id === "T9");
    if (pass === undefined) throw new Error("fixture task");

    const observed = observeSkeletons(repo.root, graph, [pass], [pass]);

    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(observed.value.surfaces.get(TS_CONTRACT.id)).toMatchObject({ ok: true });
  });
});

describe("a distill move that breaks a bound export", () => {
  it("is restored though its tests pass: the changed file violates its contract", async () => {
    const repo = distillWave();
    const authority = authorityOf(await registered(repo, "T9"), "T9");
    repo.write(PATHS.tsPricing, PRICING_WITHOUT_PARSE_ORDER);

    // Settled and persisted as a transport does it, so the snapshot's release is the settlement's own.
    const settled = await settleAndPersistExactImplementation(
      managerOf(repo),
      settlementFacts(authority, { verdict: "trusted-pass" }, [PATHS.tsPricing]),
      productionExactSettlementPorts(repo.root, repo.statePath),
    );

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(repo.read(PATHS.tsPricing)).toBe(IMPLEMENTED_PRICING);
    const task = graphOf(repo).tasks.find(({ id }) => id === "T9");
    const basis = task === undefined ? undefined : behaviourPreservedBasis(task);
    expect(basis).toMatchObject({ kind: "restored" });
    expect(basis?.kind === "restored" ? basis.after.join(" ") : "").toContain("declared-artifact-contract-violated");
    expect(distillRefs(repo)).toEqual([]);
  });

  it("is kept when it keeps every bound export and its tests pass", async () => {
    const repo = distillWave();
    const authority = authorityOf(await registered(repo, "T9"), "T9");
    const distilled = IMPLEMENTED_PRICING.replace("order.lines.length * quantity", "quantity * order.lines.length");
    repo.write(PATHS.tsPricing, distilled);

    const settled = await settleAttempt(repo, authority, [PATHS.tsPricing]);

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(repo.read(PATHS.tsPricing)).toBe(distilled);
  });
});
