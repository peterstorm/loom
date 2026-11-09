/**
 * CT-3 acceptance: a Contract Revision refreshes untouched skeletons and flags
 * modified ones stale (plan AD-10), through the `revise-contract` handler.
 *
 * Each fixture is the skeleton repository at Wave 2 with skeleton records
 * seeded into the raw State File, as a registration would have left them, and
 * their files on disk: either the canonical bytes the engine wrote (untouched)
 * or an implementer's edit (modified). The operator edits a frozen types file
 * and runs the handler exactly as `helper revise-contract` does; the tests
 * read back the bytes, the stored records, the next registration and
 * `helper orchestration status`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import reviseContract from "../../src/handlers/helpers/revise-contract";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import {
  canonicalJavaSkeleton,
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  JAVA_CONTRACT,
  JAVA_TYPES_WITH_CURRENCY,
  OUTCOME_TEXT,
  orchestrationStatus,
  PATHS,
  recordedSkeletons,
  seededRecord,
  sha256,
  skeletonRepo,
  someLine,
  spawnFor,
  statusAliasProblems,
  statusDocument,
  statusStaleFlags,
  TS_CONTRACT,
  TS_TYPES_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupSkeletonRepos();
});

/** `pricing.ts` after the implementer's work: no longer the engine's bytes. */
const IMPLEMENTED_PRICING = `import type { ParseOrderFn, PriceOrderFn } from "./order-contract";

export const priceOrder: PriceOrderFn = (order, quantity) => ({ cents: order.lines.length * quantity });

export const parseOrder: ParseOrderFn = (raw) => ({ id: raw, lines: [] });
`;

/** CT-1 revised: a new alias, every bound alias still declared. */
const TS_TYPES_WITH_REFUND = `${TS_TYPES_TEXT}export type RefundFn = (order: Order) => Price;\n`;

/** CT-1 revised: `ParseOrderFn`, which `pricing.ts` binds, is gone. */
const TS_TYPES_WITHOUT_PARSE_ORDER = TS_TYPES_TEXT.replace("export type ParseOrderFn = (raw: string) => Order;\n", "");

/** A Wave 2 repository whose engine-written skeletons are seeded: `untouched`
 *  paths hold the canonical bytes, `modified` paths the implementer's edit;
 *  every record digests the canonical bytes the engine wrote. */
function seededRepo(untouched: readonly string[], modified: Readonly<Record<string, string>> = {}): SkeletonRepo {
  const paths = [...untouched, ...Object.keys(modified)];
  const repo = skeletonRepo({ skeletons: paths.map((path) => seededRecord(path, canonicalSkeletonOf(path))) });
  for (const path of untouched) repo.write(path, canonicalSkeletonOf(path));
  for (const [path, text] of Object.entries(modified)) repo.write(path, text);
  repo.commit("Wave 2 work so far");
  return repo;
}

type Revision = Readonly<{ kind: string; message: string; stderr: string }>;

/** The operator's `helper revise-contract --contract <id> --reason <why>`. */
async function revise(contract: string): Promise<Revision> {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const result = await reviseContract("", ["--contract", contract, "--reason", "the frozen signature changed"]);
  vi.restoreAllMocks();
  return { kind: result.kind, message: result.kind === "error" ? result.message : "", stderr: written.join("") };
}

describe("skeletons across a Contract Revision (CT-3)", () => {
  it("AS-049: an untouched Java skeleton is regenerated from the revised types, with a refreshed record", async () => {
    const repo = seededRepo([PATHS.javaPricing]);
    repo.write(JAVA_CONTRACT.types, JAVA_TYPES_WITH_CURRENCY);

    const revision = await revise("CT-2");

    expect(revision.kind, revision.message).toBe("passthrough");
    const refreshed = canonicalJavaSkeleton(
      PATHS.javaPricing,
      [{ name: "priceOrder", alias: "PriceOrderFn" }, { name: "parseOrder", alias: "ParseOrderFn" }],
      { PriceOrderFn: 3, ParseOrderFn: 1 },
    );
    expect(repo.read(PATHS.javaPricing)).toBe(refreshed);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.javaPricing)).toEqual({
      path: PATHS.javaPricing,
      contract: "CT-2",
      language: "java",
      origin: "revision",
      engineSha256: sha256(refreshed),
      typesSha256: sha256(JAVA_TYPES_WITH_CURRENCY),
      stale: null,
    });
  });

  it("AS-050: a skeleton the implementer modified is left untouched, and status flags it `stale against revised contract`, naming the file", async () => {
    const repo = seededRepo([], { [PATHS.tsPricing]: IMPLEMENTED_PRICING });
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);

    const revision = await revise("CT-1");

    expect(revision.kind, revision.message).toBe("passthrough");
    expect(repo.read(PATHS.tsPricing)).toBe(IMPLEMENTED_PRICING);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.tsPricing)).toMatchObject({
      engineSha256: sha256(canonicalSkeletonOf(PATHS.tsPricing)),
      stale: { revision: 1 },
    });
    expect(statusStaleFlags(statusDocument(repo))).toContainEqual({ path: PATHS.tsPricing, revision: 1 });
    expect(someLine(orchestrationStatus(repo, false).stdout, PATHS.tsPricing, OUTCOME_TEXT.stale)).toBe(true);
  });

  it("FR-033: a revision regenerates every skeleton still byte-identical to the engine's bytes, leaves modified ones on disk, and flags each of those stale", async () => {
    const repo = seededRepo([PATHS.tsQuotes], { [PATHS.tsPricing]: IMPLEMENTED_PRICING });
    const legacyBefore = repo.read(PATHS.tsLegacy);
    repo.write(TS_CONTRACT.types, TS_TYPES_WITH_REFUND);

    const revision = await revise("CT-1");

    expect(revision.kind, revision.message).toBe("passthrough");
    const records = recordedSkeletons(repo.rawState());
    // Untouched: regenerated from the revised surface (its bytes name no
    // changed signature, so they are the same canonical bytes).
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));
    expect(records.get(PATHS.tsQuotes)).toEqual({
      path: PATHS.tsQuotes,
      contract: "CT-1",
      language: "typescript",
      origin: "revision",
      engineSha256: sha256(canonicalSkeletonOf(PATHS.tsQuotes)),
      typesSha256: sha256(TS_TYPES_WITH_REFUND),
      stale: null,
    });
    // Modified: never touched, flagged stale.
    expect(repo.read(PATHS.tsPricing)).toBe(IMPLEMENTED_PRICING);
    expect(records.get(PATHS.tsPricing)).toMatchObject({ origin: "spawn", stale: { revision: 1 } });
    // A file the engine never wrote is no skeleton of the revision.
    expect(repo.read(PATHS.tsLegacy)).toBe(legacyBefore);
    expect(records.has(PATHS.tsLegacy)).toBe(false);
    // Revision semantics are otherwise unchanged.
    const contracts = repo.rawState().acceptance_contracts as readonly { id: string; freeze: { state: string } }[];
    expect(contracts.find(({ id }) => id === "CT-1")?.freeze.state).toBe("revised");
  });

  it("AS-051: a revision whose types no longer declare a bound alias names it, and the next Wave start is refused naming the alias", async () => {
    const repo = seededRepo([]);
    repo.write(TS_CONTRACT.types, TS_TYPES_WITHOUT_PARSE_ORDER);

    const revision = await revise("CT-1");

    expect(revision.kind, revision.message).toBe("passthrough");
    expect(revision.stderr).toContain("ParseOrderFn");

    const outcome = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.message).toContain("ParseOrderFn");
      expect(outcome.message).toContain(PATHS.tsPricing);
      expect(outcome.message).toContain(TS_CONTRACT.types);
    }
    expect(repo.read(PATHS.tsPricing)).toBeNull();

    const status = statusDocument(repo);
    expect(statusAliasProblems(status)).toContainEqual({
      kind: "missing-alias",
      alias: "ParseOrderFn",
      path: PATHS.tsPricing,
      typesFile: TS_CONTRACT.types,
    });
    expect(JSON.stringify(status)).toContain("skeleton-bindings-unresolved");
  });
});
