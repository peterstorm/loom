/**
 * Contract Revision refreshes untouched skeletons and flags modified ones
 * stale (plan AD-10, FR-033, ADR-0057), through the `revise-contract`
 * handler, its refresh step `refreshRevisedSkeletons`, and the pure
 * `reviseAcceptanceContract` that commits the result. The record-driven
 * planner itself is matrixed in `tests/core/skeleton-outcomes.matrix.test.ts`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_SKELETON_REVISION,
  reviseAcceptanceContract,
  revisionOutcomeMessage,
  skeletonRevisionOf,
} from "../../src/core/contract-revision";
import { frozenPathsToObserve } from "../../src/core/acceptance-contract";
import reviseContract from "../../src/handlers/helpers/revise-contract";
import { observeFrozenDigests } from "../../src/orchestration/frozen-path-observation";
import { refreshRevisedSkeletons } from "../../src/orchestration/skeleton-revision";
import type { SkeletonRecord } from "../../src/core/skeleton/types";
import type { TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import {
  canonicalJavaSkeleton,
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  graphOf,
  JAVA_CONTRACT,
  JAVA_TYPES_WITH_CURRENCY,
  PATHS,
  recordedSkeletons,
  seededRecord,
  sha256,
  skeletonRepo,
  TS_CONTRACT,
  TS_TYPES_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";
import { duringPreparedName } from "../fixtures/skeleton-write-race";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupSkeletonRepos();
});

const IMPLEMENTED_PRICING = `import type { ParseOrderFn, PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });

export const parseOrder: ParseOrderFn = (raw) => ({ id: raw, lines: [] });
`;

const TS_TYPES_WITH_REFUND = `${TS_TYPES_TEXT}export type RefundFn = (order: Order) => Price;\n`;
const TS_TYPES_WITHOUT_PARSE_ORDER = TS_TYPES_TEXT.replace("export type ParseOrderFn = (raw: string) => Order;\n", "");
const JAVA_PRICING_REVISED = canonicalJavaSkeleton(
  PATHS.javaPricing,
  [{ name: "priceOrder", alias: "PriceOrderFn" }, { name: "parseOrder", alias: "ParseOrderFn" }],
  { PriceOrderFn: 3, ParseOrderFn: 1 },
);

function seededRepo(untouched: readonly string[], modified: Readonly<Record<string, string>> = {}): SkeletonRepo {
  const paths = [...untouched, ...Object.keys(modified)];
  const repo = skeletonRepo({ skeletons: paths.map((path) => seededRecord(path, canonicalSkeletonOf(path))) });
  for (const path of untouched) repo.write(path, canonicalSkeletonOf(path));
  for (const [path, text] of Object.entries(modified)) repo.write(path, text);
  repo.commit("Wave 2 work so far");
  return repo;
}

const frozenObservations = (repo: SkeletonRepo, graph: TaskGraph) => {
  const root = parseCanonicalRepositoryRoot(repo.root);
  if (!root.ok) throw new Error("fixture root is not canonical");
  return observeFrozenDigests(root.value, frozenPathsToObserve(graph.acceptance_contracts ?? []));
};

async function revise(contract: string): Promise<{ kind: string; message: string; stderr: string }> {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const result = await reviseContract("", ["--contract", contract, "--reason", "the frozen signature changed"]);
  vi.restoreAllMocks();
  return { kind: result.kind, message: result.kind === "error" ? result.message : "", stderr: written.join("") };
}

describe("the revise-contract handler", () => {
  it("AS-049: regenerates an untouched Java skeleton from the revised holder and records it as origin `revision`", async () => {
    const repo = seededRepo([PATHS.javaPricing]);
    repo.write(JAVA_CONTRACT.types, JAVA_TYPES_WITH_CURRENCY);

    const revision = await revise("CT-2");

    expect(revision.kind, revision.message).toBe("passthrough");
    expect(repo.read(PATHS.javaPricing)).toBe(JAVA_PRICING_REVISED);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.javaPricing)).toEqual({
      path: PATHS.javaPricing,
      contract: "CT-2",
      language: "java",
      origin: "revision",
      engineSha256: sha256(JAVA_PRICING_REVISED),
      typesSha256: sha256(JAVA_TYPES_WITH_CURRENCY),
      stale: null,
    });
    expect(revision.stderr).toContain(`refreshed ${PATHS.javaPricing}`);
  });

  it("AS-050: leaves a modified skeleton's bytes, flags its record stale with the revision, and names it in the outcome", async () => {
    const repo = seededRepo([], { [PATHS.tsPricing]: IMPLEMENTED_PRICING });
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);

    const revision = await revise("CT-1");

    expect(revision.kind, revision.message).toBe("passthrough");
    expect(repo.read(PATHS.tsPricing)).toBe(IMPLEMENTED_PRICING);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.tsPricing)).toEqual({
      ...seededRecord(PATHS.tsPricing, canonicalSkeletonOf(PATHS.tsPricing)),
      stale: { revision: 1 },
    });
    expect(revision.stderr).toContain(`${PATHS.tsPricing}: stale against revised contract`);
  });

  it("FR-033: refreshes every untouched skeleton, flags every modified one, and leaves records of other contracts alone", async () => {
    const repo = seededRepo([PATHS.tsQuotes, PATHS.javaPricing], { [PATHS.tsPricing]: IMPLEMENTED_PRICING });
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);

    const revision = await revise("CT-1");

    expect(revision.kind, revision.message).toBe("passthrough");
    const records = recordedSkeletons(repo.rawState());
    expect(records.get(PATHS.tsQuotes)).toMatchObject({ origin: "revision", typesSha256: sha256(TS_TYPES_WITH_REFUND), stale: null });
    expect(records.get(PATHS.tsPricing)).toMatchObject({ origin: "spawn", stale: { revision: 1 } });
    expect(records.get(PATHS.javaPricing)).toEqual(seededRecord(PATHS.javaPricing, canonicalSkeletonOf(PATHS.javaPricing)));
    expect(repo.read(PATHS.javaPricing)).toBe(canonicalSkeletonOf(PATHS.javaPricing));
  });

  it("AS-051: names a vanished bound alias in the outcome, refreshes the bindings that still resolve, and keeps the rest as they were", async () => {
    const repo = seededRepo([PATHS.tsPricing, PATHS.tsQuotes]);
    repo.write(TS_CONTRACT.types, TS_TYPES_WITHOUT_PARSE_ORDER);

    const revision = await revise("CT-1");

    expect(revision.kind, revision.message).toBe("passthrough");
    expect(revision.stderr).toContain(
      `${PATHS.tsPricing} binds ParseOrderFn, but the frozen types file ${TS_CONTRACT.types} declares no ParseOrderFn`,
    );
    expect(revision.stderr).toContain("the next spawn's stage two blocks on it");
    const records = recordedSkeletons(repo.rawState());
    // Unresolvable: never rewritten, never flagged (it is untouched), its record kept.
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(records.get(PATHS.tsPricing)).toEqual(seededRecord(PATHS.tsPricing, canonicalSkeletonOf(PATHS.tsPricing)));
    expect(records.get(PATHS.tsQuotes)).toMatchObject({ origin: "revision", typesSha256: sha256(TS_TYPES_WITHOUT_PARSE_ORDER) });
  });

  it("keeps the record of a skeleton the implementer deleted, writing nothing", async () => {
    const repo = seededRepo([PATHS.javaPricing]);
    repo.remove(PATHS.javaPricing);
    repo.write(JAVA_CONTRACT.types, JAVA_TYPES_WITH_CURRENCY);

    const revision = await revise("CT-2");

    expect(revision.kind, revision.message).toBe("passthrough");
    expect(repo.read(PATHS.javaPricing)).toBeNull();
    expect(recordedSkeletons(repo.rawState()).get(PATHS.javaPricing)).toEqual(
      seededRecord(PATHS.javaPricing, canonicalSkeletonOf(PATHS.javaPricing)),
    );
  });

  it("refuses a revision with no changed bytes before it touches any skeleton", async () => {
    const repo = seededRepo([PATHS.javaPricing]);
    const before = repo.rawState();

    const revision = await revise("CT-2");

    expect(revision.kind).toBe("error");
    expect(revision.message).toContain("unchanged");
    expect(repo.read(PATHS.javaPricing)).toBe(canonicalSkeletonOf(PATHS.javaPricing));
    expect(repo.rawState()).toEqual(before);
  });
});

describe("a skeleton modified after the revision observed it (ADR-0057)", () => {
  it("is refused by the writer as `modified`, keeps the implementer's bytes, and its record is flagged stale in the same commit", async () => {
    const repo = seededRepo([PATHS.javaPricing]);
    repo.write(JAVA_CONTRACT.types, JAVA_TYPES_WITH_CURRENCY);
    const implemented = "package com.acme.order.pricing;\n\nfinal class Pricing {}\n";
    const race = duringPreparedName(() => writeFileSync(join(repo.root, PATHS.javaPricing), implemented));

    const revision = await revise("CT-2");

    expect(race.fired()).toBe(true);
    expect(revision.kind, revision.message).toBe("passthrough");
    expect(repo.read(PATHS.javaPricing)).toBe(implemented);
    const state = repo.rawState();
    expect(recordedSkeletons(state).get(PATHS.javaPricing)).toEqual({
      ...seededRecord(PATHS.javaPricing, canonicalSkeletonOf(PATHS.javaPricing)),
      stale: { revision: 1 },
    });
    expect(revision.stderr).toContain(`skeleton ${PATHS.javaPricing}: stale against revised contract (modified, left as it is)`);
    expect(revision.stderr).not.toContain("skeleton binding problem");
  });

  it("settles that path stale, never refreshed, in what the refresh hands the commit", () => {
    const repo = seededRepo([PATHS.javaPricing]);
    repo.write(JAVA_CONTRACT.types, JAVA_TYPES_WITH_CURRENCY);
    const race = duringPreparedName(() => writeFileSync(join(repo.root, PATHS.javaPricing), "edited\n"));

    const refreshed = refreshRevisedSkeletons(repo.root, graphOf(repo), "CT-2");

    expect(race.fired()).toBe(true);
    expect(refreshed).toEqual({ ok: true, value: skeletonRevisionOf([[PATHS.javaPricing, { kind: "stale" }]], []) });
  });
});

describe("refreshRevisedSkeletons", () => {
  it("writes the refreshed bytes before any record is committed, and settles each path once", () => {
    const repo = seededRepo([PATHS.javaPricing, PATHS.javaExisting]);
    repo.write(PATHS.javaExisting, "package com.acme.order.pricing;\n\nfinal class Existing {}\n");
    repo.write(JAVA_CONTRACT.types, JAVA_TYPES_WITH_CURRENCY);

    const refreshed = refreshRevisedSkeletons(repo.root, graphOf(repo), "CT-2");

    expect(refreshed).toEqual({
      ok: true,
      value: skeletonRevisionOf([
        [PATHS.javaPricing, {
          kind: "refreshed",
          skeleton: { contract: "CT-2", language: "java", engineSha256: sha256(JAVA_PRICING_REVISED), typesSha256: sha256(JAVA_TYPES_WITH_CURRENCY) },
        }],
        [PATHS.javaExisting, { kind: "stale" }],
      ], []),
    });
    expect(repo.read(PATHS.javaPricing)).toBe(JAVA_PRICING_REVISED);
    // Nothing is committed yet: the handler's locked update does that.
    expect(recordedSkeletons(repo.rawState()).get(PATHS.javaPricing)?.origin).toBe("spawn");
  });

  it("is nothing for a contract with no types file or an unknown contract", () => {
    const repo = seededRepo([PATHS.tsQuotes]);
    expect(refreshRevisedSkeletons(repo.root, graphOf(repo), "CT-3")).toEqual({ ok: true, value: NO_SKELETON_REVISION });
    expect(refreshRevisedSkeletons(repo.root, graphOf(repo), "CT-9")).toEqual({ ok: true, value: NO_SKELETON_REVISION });
  });

  it("names an unreadable revised types file as a binding problem and refreshes nothing", () => {
    const repo = seededRepo([PATHS.tsQuotes]);
    repo.remove(TS_CONTRACT.types);

    const refreshed = refreshRevisedSkeletons(repo.root, graphOf(repo), "CT-1");

    expect(refreshed.ok && refreshed.value.settlements.size).toBe(0);
    expect(refreshed.ok && refreshed.value.bindingProblems).toEqual([
      expect.objectContaining({ kind: "types-unparseable", typesFile: TS_CONTRACT.types }),
    ]);
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));
  });
});

describe("skeletonRevisionOf", () => {
  it("keeps one settlement per normalized path, so no path is both refreshed and stale", () => {
    const refreshed = { kind: "refreshed", skeleton: { contract: "CT-1", language: "typescript", engineSha256: "e", typesSha256: "t" } } as const;
    const revision = skeletonRevisionOf([["./src/a.ts", refreshed], ["src/a.ts", { kind: "stale" }]], []);
    expect([...revision.settlements]).toEqual([["src/a.ts", { kind: "stale" }]]);
  });
});

describe("reviseAcceptanceContract commits the skeleton revision (pure)", () => {
  const revisedRecord = (path: string): SkeletonRecord => ({
    ...seededRecord(path, canonicalSkeletonOf(path)), origin: "revision", typesSha256: sha256(TS_TYPES_WITH_REFUND),
  });

  it("FR-033: installs refreshed records, flags stale ones with the revision number, and reports both", () => {
    const repo = seededRepo([PATHS.tsQuotes], { [PATHS.tsPricing]: IMPLEMENTED_PRICING });
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);
    const graph = graphOf(repo);
    const observations = frozenObservations(repo, graph);
    const { contract, language, engineSha256, typesSha256 } = revisedRecord(PATHS.tsQuotes);
    const skeletons = skeletonRevisionOf(
      [
        [PATHS.tsQuotes, { kind: "refreshed", skeleton: { contract, language, engineSha256, typesSha256 } }],
        [PATHS.tsPricing, { kind: "stale" }],
      ],
      [{ kind: "missing-alias", alias: "RefundFn", path: PATHS.tsQuotes, typesFile: TS_CONTRACT.types }],
    );

    const revised = reviseAcceptanceContract(graph, { contract: "CT-1", reason: "why" }, observations, skeletons);

    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const records = revised.value.graph.skeletons ?? [];
    expect(records).toEqual([
      { ...seededRecord(PATHS.tsPricing, canonicalSkeletonOf(PATHS.tsPricing)), stale: { revision: 1 } },
      revisedRecord(PATHS.tsQuotes),
    ]);
    expect(revised.value.refreshed).toEqual([PATHS.tsQuotes]);
    expect(revised.value.staleSkeletons).toEqual([PATHS.tsPricing]);
    expect(revised.value.bindingProblems).toEqual(skeletons.bindingProblems);
    expect(revised.value.leftovers).toEqual([]);
  });

  it("reports the prepared names the refresh left behind, committing nothing for them", () => {
    const repo = seededRepo([PATHS.tsQuotes]);
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);
    const graph = graphOf(repo);
    const leftovers = [{ path: PATHS.tsQuotes, name: ".quotes.ts.loom-skeleton-1", message: "EBUSY" }];

    const revised = reviseAcceptanceContract(graph, { contract: "CT-1", reason: "why" }, frozenObservations(repo, graph),
      skeletonRevisionOf([], [], leftovers));

    expect(revised.ok && revised.value.leftovers).toEqual(leftovers);
    expect(revised.ok && revised.value.graph.skeletons).toEqual(graph.skeletons);
  });

  it("reports as stale only the paths whose record it flags: a stale settlement with no record is neither flagged nor named", () => {
    const repo = seededRepo([PATHS.tsQuotes], { [PATHS.tsPricing]: IMPLEMENTED_PRICING });
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);
    const graph = graphOf(repo);
    const skeletons = skeletonRevisionOf([["src/never-recorded.ts", { kind: "stale" }], [PATHS.tsPricing, { kind: "stale" }]], []);

    const revised = reviseAcceptanceContract(graph, { contract: "CT-1", reason: "why" }, frozenObservations(repo, graph), skeletons);

    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    const flagged = (revised.value.graph.skeletons ?? []).filter(({ stale }) => stale !== null).map(({ path }) => path);
    expect(flagged).toEqual([PATHS.tsPricing]);
    expect(revised.value.staleSkeletons).toEqual(flagged);
    expect(revisionOutcomeMessage(revised.value)).not.toContain("never-recorded");
  });

  it("leaves the skeletons untouched with no skeleton revision", () => {
    const repo = seededRepo([PATHS.tsQuotes]);
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);
    const graph = graphOf(repo);
    const observations = frozenObservations(repo, graph);

    const revised = reviseAcceptanceContract(graph, { contract: "CT-1", reason: "why" }, observations);

    expect(revised.ok && revised.value.graph.skeletons).toEqual(graph.skeletons);
    expect(revised.ok && revised.value.staleSkeletons).toEqual([]);
    expect(revised.ok && revised.value.bindingProblems).toEqual([]);
  });
});

describe("revisionOutcomeMessage", () => {
  it("says nothing more than the revision when no skeleton changed", () => {
    expect(revisionOutcomeMessage({
      contract: "CT-1",
      revision: { revision: 2, reason: "r", previous: [], paths: [], revalidatedTaskIds: [] } as never,
      refreshed: [],
      staleSkeletons: [],
      bindingProblems: [],
      leftovers: [],
    })).toBe("CT-1 revision 2 recorded; no implemented claimant needed revalidation. The next Wave Gate re-records its acceptance roster green.\n");
  });

  it("adds one line per refreshed and stale skeleton, per binding problem and per prepared name left behind", () => {
    const message = revisionOutcomeMessage({
      contract: "CT-1",
      revision: { revision: 1, reason: "r", previous: [], paths: [], revalidatedTaskIds: ["T4"] } as never,
      refreshed: [PATHS.tsQuotes],
      staleSkeletons: [PATHS.tsPricing],
      bindingProblems: [{ kind: "missing-alias", alias: "ParseOrderFn", path: PATHS.tsPricing, typesFile: TS_CONTRACT.types }],
      leftovers: [{ path: PATHS.tsPricing, name: ".pricing.ts.loom-skeleton-1", message: "EBUSY" }],
    });
    expect(message.split("\n")).toEqual([
      "CT-1 revision 1 recorded; T4 returned to revalidation. The next Wave Gate re-records its acceptance roster green.",
      `skeleton refreshed ${PATHS.tsQuotes} from the revised types`,
      `skeleton ${PATHS.tsPricing}: stale against revised contract (modified, left as it is)`,
      `skeleton binding problem: ${PATHS.tsPricing} binds ParseOrderFn, but the frozen types file ${TS_CONTRACT.types} declares no ParseOrderFn; the next spawn's stage two blocks on it`,
      `skeleton note: ${PATHS.tsPricing}: the prepared name .pricing.ts.loom-skeleton-1 beside it could not be removed (EBUSY); delete it`,
      "",
    ]);
  });
});
