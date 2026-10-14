import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { contractBindingErrors, type ContractBindingTask } from "../../src/core/acceptance-contract";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import type { PlanContract } from "../../src/types";

const ACCEPTANCE = "engine/tests/acceptance/payload.acceptance.test.ts";
const TYPES = "engine/src/core/payload-contract.ts";
const ROUTE = "engine/src/handler-routes.ts";

const CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Payload ingestion",
  declaration: {
    kind: "declared",
    types: { kind: "file", path: TYPES },
    acceptance: [{ path: ACCEPTANCE, anchors: ["AS-003", "AS-004"] }],
    supportedDomain: null,
    entryPoint: ROUTE,
    statement: "One valid call wins.",
  },
};

const view = (id: string, overrides: Partial<ContractBindingTask> = {}): ContractBindingTask =>
  ({ id, file_list: [], spec_anchors: [], depends_on: [], newTestWaiver: null, ...overrides });
const contractTask = view("T1", { file_list: [TYPES, ACCEPTANCE] });

const contractsOf = (block: string): readonly PlanContract[] =>
  parsePlanModels(`# Plan\n\n## Contracts\n\n### CT-1: Payload ingestion\n\n${block}\n`).contracts;

describe("**Entry point:** parsing", () => {
  const base = [
    `**Types file:** \`${TYPES}\``,
    "**Acceptance tests:**",
    `- \`${ACCEPTANCE}\` — AS-003`,
  ];

  it("declares the normalized entry point beside the frozen surface", () => {
    const [contract] = contractsOf([...base, "**Entry point:** `./engine/src/handler-routes.ts`", "**Statement:** Wins."].join("\n"));
    expect(contract?.declaration).toMatchObject({ kind: "declared", entryPoint: ROUTE });
  });

  it("declares no entry point when the label is absent", () => {
    const [contract] = contractsOf([...base, "**Statement:** Wins."].join("\n"));
    expect(contract?.declaration).toMatchObject({ kind: "declared", entryPoint: null });
  });

  it("refuses an entry point that is a frozen path, or that leaves the repository", () => {
    const frozen = contractsOf([...base, `**Entry point:** \`${ACCEPTANCE}\``, "**Statement:** Wins."].join("\n"));
    expect(frozen[0]?.declaration).toEqual({ kind: "malformed", problems: [{ kind: "entry-point-frozen", path: ACCEPTANCE }] });
    const escaped = contractsOf([...base, "**Entry point:** `../outside.ts`", "**Statement:** Wins."].join("\n"));
    expect(escaped[0]?.declaration).toEqual({ kind: "malformed", problems: [{ kind: "unsafe-path", path: "../outside.ts" }] });
  });

  it("reports an Entry point label outside ## Contracts as a stray", () => {
    const models = parsePlanModels("# Plan\n\n**Entry point:** `src/x.ts`\n");
    expect(models.strays).toContainEqual({ kind: "misplaced-label", label: "Entry point", home: "Contracts" });
  });

  it("renders a frozen entry point as a binding error", () => {
    const frozen = contractsOf([...base, `**Entry point:** \`${ACCEPTANCE}\``, "**Statement:** Wins."].join("\n"));
    expect(contractBindingErrors(frozen, [contractTask])).toEqual([
      expect.stringContaining(`'**Entry point:** ${ACCEPTANCE}' is a frozen path`),
    ]);
  });
});

describe("contractBindingErrors — claimants wait for the entry point", () => {
  it("accepts claimants that write the entry point or wait for its writer", () => {
    const tasks = [
      contractTask,
      view("T2", { spec_anchors: ["AS-003"], depends_on: ["T1"], file_list: [ROUTE] }),
      view("T3", { spec_anchors: ["AS-004"], depends_on: ["T2"] }),
    ];
    expect(contractBindingErrors([CONTRACT], tasks)).toEqual([]);
  });

  it("accepts a directory artifact that covers the entry point", () => {
    const tasks = [contractTask, view("T2", { spec_anchors: ["AS-003", "AS-004"], depends_on: ["T1"], file_list: ["engine/src"] })];
    expect(contractBindingErrors([CONTRACT], tasks)).toEqual([]);
  });

  it("names a claimant that runs before the entry point exists — the G1 pilot's T2", () => {
    const tasks = [
      contractTask,
      view("T2", { spec_anchors: ["AS-003"], depends_on: ["T1"] }),
      view("T3", { spec_anchors: ["AS-004"], depends_on: ["T2"], file_list: [ROUTE] }),
    ];
    expect(contractBindingErrors([CONTRACT], tasks)).toEqual([
      expect.stringContaining(`T2 claims AS-003 but neither writes the entry point '${ROUTE}' nor depends on T3`),
    ]);
  });

  it("names an entry point no Task writes", () => {
    const tasks = [contractTask, view("T2", { spec_anchors: ["AS-003", "AS-004"], depends_on: ["T1"] })];
    expect(contractBindingErrors([CONTRACT], tasks)).toEqual([
      expect.stringContaining(`entry point '${ROUTE}' is in no task's file_list`),
    ]);
  });

  it("checks nothing extra when the contract names no entry point", () => {
    const withoutEntry = { ...CONTRACT, declaration: { ...CONTRACT.declaration, entryPoint: null } } as PlanContract;
    const tasks = [contractTask, view("T2", { spec_anchors: ["AS-003", "AS-004"], depends_on: ["T1"] })];
    expect(contractBindingErrors([withoutEntry], tasks)).toEqual([]);
  });

  it("errs exactly when the claimant precedes the entry point's writer on a dependency chain", () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 8 }).chain((length) => fc.tuple(
        fc.constant(length), fc.integer({ min: 2, max: length }), fc.integer({ min: 2, max: length }))),
      ([length, writerAt, claimantAt]) => {
        // T1 is the contract Task; T(n) depends on T(n-1).
        const chain = Array.from({ length }, (_, index): ContractBindingTask => {
          const n = index + 1;
          return view(`T${n}`, {
            file_list: [...(n === 1 ? [TYPES, ACCEPTANCE] : []), ...(n === writerAt ? [ROUTE] : [])],
            spec_anchors: n === claimantAt ? ["AS-003", "AS-004"] : [],
            depends_on: n === 1 ? [] : [`T${n - 1}`],
          });
        });
        const errors = contractBindingErrors([CONTRACT], chain);
        expect(errors.some((error) => error.includes("neither writes the entry point"))).toBe(claimantAt < writerAt);
      }));
  });
});
