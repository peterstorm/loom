import fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as acceptanceContract from "../../src/core/acceptance-contract";
import { dueWaves as ownedDueWaves } from "../../src/core/acceptance-contract/tasks";
import type { AcceptanceContract, AcceptanceTestcase, FrozenPathDigest } from "../../src/core/acceptance-contract";
import { contractStatusView, renderContractStatus } from "../../src/core/contract-status";
import { NO_ACCEPTANCE_CONTRACTS } from "../../src/core/contract-status-types";
import {
  DEFAULT_PURE_MODULES,
  handler as noIoHandler,
} from "../../src/linter/programmatic/no-io-in-pure-modules";
import type { Task, TaskGraph } from "../../src/types";
import { digest } from "../fixtures/acceptance-fixtures";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const REPO_ROOT = resolve(__dirname, "../../..");

const task = (id: string, wave: number, anchors: readonly string[] = []): Task =>
  taskFixture({
    id,
    description: id,
    agent: "code-implementer-agent",
    wave,
    depends_on: [],
    file_list: [`src/${id}.ts`],
    spec_anchors: [...anchors],
    spec_contributions: [],
  });

const graph = (tasks: readonly Task[], contracts?: readonly AcceptanceContract[]): TaskGraph => ({
  ...graphFixture(tasks),
  ...(contracts === undefined ? {} : { acceptance_contracts: contracts }),
});

const TYPES = "src/payload-types.ts";
const ACCEPTANCE = "tests/payload.acceptance.test.ts";
const PATHS: readonly [FrozenPathDigest, FrozenPathDigest] = [
  { path: TYPES, sha256: digest("a") },
  { path: ACCEPTANCE, sha256: digest("b") },
];

const contract = (
  overrides: Partial<AcceptanceContract> & Pick<AcceptanceContract, "id" | "freeze">,
  anchors: readonly [string, ...string[]] = ["AS-001"],
): AcceptanceContract => ({
  schemaVersion: 1,
  title: `${overrides.id} title`,
  statement: "behaves as declared",
  contractTask: "T1",
  types: { kind: "file", path: TYPES },
  acceptance: [{ path: ACCEPTANCE, anchors }],
  supportedDomain: null,
  revisions: [],
  ...overrides,
});

const revision = (n: number): AcceptanceContract["revisions"][number] => ({
  revision: n,
  reason: `revision ${n}`,
  previous: PATHS,
  paths: PATHS,
  revalidatedTaskIds: ["T2"],
});

describe("contractStatusView", () => {
  it("projects id, title, contract Task, freeze and covered anchors in TaskGraph order", () => {
    const views = contractStatusView(graph([task("T1", 1), task("T2", 2, ["AS-001"])], [
      contract({ id: "CT-2", title: "Second", freeze: { state: "awaiting-red" } }),
      contract({ id: "CT-1", title: "First", freeze: { state: "awaiting-red" } }),
    ]));

    expect(views.map(({ id, title, contractTask }) => ({ id, title, contractTask }))).toEqual([
      { id: "CT-2", title: "Second", contractTask: "T1" },
      { id: "CT-1", title: "First", contractTask: "T1" },
    ]);
    expect(views[0]!.covered).toEqual([{ anchor: "AS-001", due: { kind: "wave", wave: 2 } }]);
    expect(views[0]!.freeze).toEqual({ state: "awaiting-red" });
    expect(views[0]!.revisions).toBe(0);
  });

  it("a frozen contract carries its Wave and roster", () => {
    const roster: [AcceptanceTestcase] = [{ file: ACCEPTANCE, name: "AS-001: wins", anchors: ["AS-001"] }];
    const [view] = contractStatusView(graph([task("T1", 1)], [
      contract({ id: "CT-1", freeze: { state: "frozen", wave: 3, paths: PATHS, roster } }),
    ]));

    expect(view!.freeze).toEqual({ state: "frozen", wave: 3, roster });
  });

  it("a revised contract carries its revision count and re-stamped paths, no roster", () => {
    const [view] = contractStatusView(graph([task("T1", 1)], [
      contract({ id: "CT-1", freeze: { state: "revised", paths: PATHS }, revisions: [revision(1), revision(2), revision(3)] }),
    ]));

    expect(view!.freeze).toEqual({ state: "revised", revisions: 3, paths: PATHS });
    expect(view!.revisions).toBe(3);
  });

  it("due is the latest Wave of a claiming Task; the contract Task never claims; nobody claiming is unclaimed", () => {
    const [view] = contractStatusView(graph(
      [task("T1", 1, ["AS-001", "AS-002"]), task("T2", 2, ["AS-001"]), task("T3", 4, ["AS-001"]), task("T4", 3, ["FR-009"])],
      [contract({ id: "CT-1", freeze: { state: "awaiting-red" } }, ["AS-001", "AS-002"])],
    ));

    expect(view!.covered).toEqual([
      { anchor: "AS-001", due: { kind: "wave", wave: 4 } },
      { anchor: "AS-002", due: { kind: "unclaimed" } },
    ]);
  });

  it("covered follows coveredAnchors() order across acceptance files, each anchor once", () => {
    const [view] = contractStatusView(graph([task("T1", 1)], [
      contract({
        id: "CT-1",
        freeze: { state: "awaiting-red" },
        acceptance: [
          { path: ACCEPTANCE, anchors: ["AS-003", "AS-001"] },
          { path: "tests/other.acceptance.test.ts", anchors: ["AS-001", "FR-002"] },
        ],
      }),
    ]));

    expect(view!.covered.map(({ anchor }) => anchor)).toEqual(["AS-003", "AS-001", "FR-002"]);
  });

  it("returns frozen views", () => {
    const views = contractStatusView(graph([task("T1", 1)], [contract({ id: "CT-1", freeze: { state: "awaiting-red" } })]));

    expect(Object.isFrozen(views)).toBe(true);
    expect(Object.isFrozen(views[0])).toBe(true);
    expect(Object.isFrozen(views[0]!.covered)).toBe(true);
  });
});

describe("renderContractStatus", () => {
  it("an empty graph renders exactly the single no-contracts line", () => {
    expect(renderContractStatus(graph([task("T1", 1)]))).toEqual([NO_ACCEPTANCE_CONTRACTS]);
    expect(renderContractStatus(graph([task("T1", 1)], []))).toEqual(["no Acceptance Contracts"]);
  });

  it("awaiting RED renders header, freeze line and covered anchors", () => {
    expect(renderContractStatus(graph([task("T1", 1), task("T2", 2, ["AS-001"])], [
      contract({ id: "CT-1", title: "Ledger balance", freeze: { state: "awaiting-red" } }, ["AS-001", "AS-002"]),
    ]))).toEqual([
      "CT-1  Ledger balance  (contract Task T1)",
      "awaiting RED",
      "AS-001 due Wave 2",
      "AS-002 unclaimed",
    ]);
  });

  it("frozen renders its Wave and one line per roster testcase with its anchors", () => {
    expect(renderContractStatus(graph([task("T1", 1), task("T3", 3, ["AS-001"])], [
      contract({
        id: "CT-1",
        title: "Payload shape",
        freeze: {
          state: "frozen",
          wave: 1,
          paths: PATHS,
          roster: [
            { file: ACCEPTANCE, name: "payload > AS-001: AS-002: one call wins", anchors: ["AS-001", "AS-002"] },
            { file: ACCEPTANCE, name: "payload > AS-003: names the field", anchors: ["AS-003"] },
          ],
        },
      }, ["AS-001", "AS-002", "AS-003"]),
    ]))).toEqual([
      "CT-1  Payload shape  (contract Task T1)",
      "frozen at Wave 1",
      `${ACCEPTANCE} › payload > AS-001: AS-002: one call wins — AS-001, AS-002`,
      `${ACCEPTANCE} › payload > AS-003: names the field — AS-003`,
      "AS-001 due Wave 3",
      "AS-002 unclaimed",
      "AS-003 unclaimed",
    ]);
  });

  it("revised renders the revision count, its frozen paths and the revisions line", () => {
    expect(renderContractStatus(graph([task("T1", 1), task("T2", 2, ["AS-001"])], [
      contract({ id: "CT-1", title: "Payload shape", freeze: { state: "revised", paths: PATHS }, revisions: [revision(1), revision(2)] }),
    ]))).toEqual([
      "CT-1  Payload shape  (contract Task T1)",
      "revised (2 revisions); roster cleared until the next Wave Gate re-records it",
      TYPES,
      ACCEPTANCE,
      "AS-001 due Wave 2",
      "revisions: 2",
    ]);
  });

  it("a single revision reads in the singular", () => {
    const out = renderContractStatus(graph([task("T1", 1)], [
      contract({ id: "CT-1", freeze: { state: "revised", paths: PATHS }, revisions: [revision(1)] }),
    ]));

    expect(out).toContain("revised (1 revision); roster cleared until the next Wave Gate re-records it");
    expect(out).toContain("revisions: 1");
  });

  it("a contract re-frozen after a revision still shows its revision count", () => {
    const out = renderContractStatus(graph([task("T1", 1)], [
      contract({
        id: "CT-1",
        freeze: { state: "frozen", wave: 2, paths: PATHS, roster: [{ file: ACCEPTANCE, name: "AS-001: x", anchors: ["AS-001"] }] },
        revisions: [revision(1)],
      }),
    ]));

    expect(out).toContain("frozen at Wave 2");
    expect(out.at(-1)).toBe("revisions: 1");
  });

  it("contracts render in TaskGraph order", () => {
    const out = renderContractStatus(graph([task("T1", 1)], [
      contract({ id: "CT-3", title: "C", freeze: { state: "awaiting-red" } }),
      contract({ id: "CT-1", title: "A", freeze: { state: "awaiting-red" } }),
    ]));

    expect(out.filter((line) => line.startsWith("CT-"))).toEqual([
      "CT-3  C  (contract Task T1)",
      "CT-1  A  (contract Task T1)",
    ]);
  });
});

describe("contract-status module boundary", () => {
  it("dueWaves is re-exported from the curated acceptance-contract surface, not re-derived", () => {
    expect(acceptanceContract.dueWaves).toBe(ownedDueWaves);
  });

  it.each(["engine/src/core/contract-status.ts", "engine/src/core/contract-status-types.ts"])(
    "%s is enrolled as a pure module and passes the purity rule",
    (mod) => {
      expect(DEFAULT_PURE_MODULES).toContain(mod);
      expect(noIoHandler(readFileSync(resolve(REPO_ROOT, mod), "utf-8"), mod)).toEqual([]);
    },
  );
});

// --- Properties ---------------------------------------------------------------

const ANCHORS = ["AS-001", "AS-002", "AS-003", "FR-001", "FR-002"] as const;
const anchorArb = fc.constantFrom(...ANCHORS);
const anchorsArb = fc.uniqueArray(anchorArb, { minLength: 1, maxLength: ANCHORS.length })
  .map((anchors) => anchors as unknown as readonly [string, ...string[]]);
const pathsArb: fc.Arbitrary<readonly [FrozenPathDigest, ...FrozenPathDigest[]]> = fc.constantFrom(
  PATHS,
  [PATHS[1]] as const,
);
const taskIdArb = fc.constantFrom("T1", "T2", "T3", "T4", "T5");

const rosterArb = (anchors: readonly [string, ...string[]]): fc.Arbitrary<readonly [AcceptanceTestcase, ...AcceptanceTestcase[]]> =>
  fc.array(
    fc.record({
      file: fc.constant(ACCEPTANCE),
      name: fc.string({ maxLength: 20 }),
      anchors: fc.uniqueArray(fc.constantFrom(...anchors), { minLength: 1 })
        .map((picked) => picked as unknown as readonly [string, ...string[]]),
    }),
    { minLength: 1, maxLength: 4 },
  ).map((roster) => roster as unknown as readonly [AcceptanceTestcase, ...AcceptanceTestcase[]]);

const contractArb = (index: number): fc.Arbitrary<AcceptanceContract> =>
  fc.tuple(anchorsArb, taskIdArb, fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,11}$/), fc.nat({ max: 3 })).chain(([anchors, contractTask, title, revisions]) =>
    fc.oneof(
      fc.constant<AcceptanceContract["freeze"]>({ state: "awaiting-red" }),
      fc.tuple(fc.integer({ min: 1, max: 9 }), rosterArb(anchors), pathsArb)
        .map(([wave, roster, paths]): AcceptanceContract["freeze"] => ({ state: "frozen", wave, paths, roster })),
      pathsArb.map((paths): AcceptanceContract["freeze"] => ({ state: "revised", paths })),
    ).map((freeze) => contract({
      id: `CT-${index + 1}`,
      title,
      contractTask,
      freeze,
      revisions: Array.from({ length: revisions }, (_, n) => revision(n + 1)),
    }, anchors)));

const contractsArb: fc.Arbitrary<readonly AcceptanceContract[]> = fc.nat({ max: 4 })
  .chain((count) => fc.tuple(...Array.from({ length: count }, (_, i) => contractArb(i))));

const tasksArb: fc.Arbitrary<readonly Task[]> = fc.uniqueArray(
  fc.record({ id: taskIdArb, wave: fc.integer({ min: 1, max: 9 }), anchors: fc.uniqueArray(anchorArb) }),
  { selector: ({ id }) => id, maxLength: 5 },
).map((tasks) => tasks.map(({ id, wave, anchors }) => task(id, wave, anchors)));

const HEADER = /^CT-\d+  .*  \(contract Task T\d\)$/;

/** Split rendered lines into one block per contract, at each header line. */
function blocks(lines: readonly string[]): readonly (readonly string[])[] {
  return lines.reduce<string[][]>((acc, line) => {
    if (HEADER.test(line)) acc.push([line]);
    else acc.at(-1)?.push(line);
    return acc;
  }, []);
}

describe("renderContractStatus properties", () => {
  it("is total, non-empty, renders one header per contract and every covered anchor exactly once per contract", () => {
    fc.assert(fc.property(contractsArb, tasksArb, (contracts, tasks) => {
      const g = graph(tasks, contracts);
      const out = renderContractStatus(g);

      expect(out.length).toBeGreaterThan(0);
      if (contracts.length === 0) {
        expect(out).toEqual([NO_ACCEPTANCE_CONTRACTS]);
        return;
      }
      const perContract = blocks(out);
      expect(out.filter((line) => HEADER.test(line))).toHaveLength(contracts.length);
      expect(perContract).toHaveLength(contracts.length);
      contracts.forEach((c, i) => {
        const block = perContract[i]!;
        expect(block[0]).toBe(`${c.id}  ${c.title}  (contract Task ${c.contractTask})`);
        for (const anchor of acceptanceContract.coveredAnchors(c)) {
          const due = new RegExp(`^${anchor} (due Wave \\d+|unclaimed)$`);
          expect(block.filter((line) => due.test(line))).toHaveLength(1);
        }
      });
    }));
  });

  it("a covered anchor's due Wave is the dueWaves rule, unclaimed exactly when it is absent", () => {
    fc.assert(fc.property(contractsArb, tasksArb, (contracts, tasks) => {
      contractStatusView(graph(tasks, contracts)).forEach((view, i) => {
        const owned = acceptanceContract.dueWaves(contracts[i]!, tasks);
        for (const { anchor, due } of view.covered) {
          expect(due).toEqual(anchor in owned ? { kind: "wave", wave: owned[anchor] } : { kind: "unclaimed" });
        }
      });
    }));
  });

  it("does not mutate its input and is deterministic", () => {
    fc.assert(fc.property(contractsArb, tasksArb, (contracts, tasks) => {
      const g = graph(tasks, contracts);
      const before = JSON.stringify(g);
      const first = renderContractStatus(g);
      expect(renderContractStatus(g)).toEqual(first);
      expect(JSON.stringify(g)).toBe(before);
    }));
  });
});
