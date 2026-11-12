/**
 * The contract-surface lens of a Contract Task's Wave review (ADR-0069).
 *
 * Three layers:
 * - `reviewedContractSurfaces` / `renderContractSurfaceSection`, the pure
 *   selection and renderer in `core/contract-surface-section.ts`.
 * - The roster derivation (`waveTaskReviewRoster`, `waveRunRosterProblem`):
 *   writing a contract surface is a reason for the architecture lens, and a
 *   Review Run installed without it keeps its roster.
 * - Wave review issuance (`prepareWaveReviewBatch`), which appends the section
 *   to the type-design and architecture packets of that Task only and leaves
 *   every other packet byte-identical.
 */

import { rmSync } from "node:fs";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, BASE_WAVE_REVIEW_AGENTS } from "../../src/core/agent-catalog-projections";
import type { ContextPacket } from "../../src/core/context-packets";
import {
  CONTRACT_SURFACE_ROLES,
  CONTRACT_SURFACE_RULE,
  CONTRACT_SURFACE_SECTION,
  isContractSurfaceRole,
  renderContractSurfaceSection,
  reviewedContractSurfaces,
  type ReviewedContractSurface,
} from "../../src/core/contract-surface-section";
import { OWNER_MAP_SECTION } from "../../src/core/owner-verification/owner-map";
import type { ExportBinding } from "../../src/core/skeleton/types";
import {
  waveRunRosterProblem,
  waveTaskReviewRoster,
  type WaveRequestBatch,
} from "../../src/core/wave-review-authority";
import type { ReviewRun, Task, TaskGraph } from "../../src/types";
import { contract, surface } from "../fixtures/contract-status-fixtures";
import { ADMISSION_FEE_TABLE_STAMP, FEE_TABLE, someParagraph } from "../fixtures/owner-families";
import { binding } from "../fixtures/skeleton-builders";
import {
  issueWaveBatchFixture,
  packetDigests,
  packetOf,
  projectWithPlanFile,
  reviewedTaskFixture,
  reviewGraphFixture,
  sectionTextOf,
} from "../fixtures/wave-review-issuance";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const PLAN_FILE = ".claude/plans/2026-11-12-contract-surface.md";

const PRICING = surface("pricing");
const PRICING_IMPLEMENTATION = "src/pricing.ts";
const PRICING_BINDING = binding(PRICING_IMPLEMENTATION, "CT-1", ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]);

/** CT-1, written by `contractTask`, with a types file. */
const pricingContract = (contractTask = "T1"): AcceptanceContract =>
  contract({ id: "CT-1", title: "Order pricing", contractTask, surface: PRICING, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });

/** The same contract declaring `**Types file:** none`: it freezes its acceptance file only. */
const withoutTypesFile = (declared: AcceptanceContract): AcceptanceContract =>
  ({ ...declared, types: { kind: "none", reason: "the slice shares no declarations" } });

const PRICING_SURFACE: ReviewedContractSurface = {
  contract: { id: "CT-1", title: "Order pricing", statement: "Order pricing behaves as declared." },
  typesFile: PRICING.types,
  bindings: [PRICING_BINDING],
};

describe("reviewedContractSurfaces: which contract surfaces a Task writes", () => {
  it("is the surface of each contract whose Contract Task it is and whose types are a file, with that contract's bindings", () => {
    const other = binding("src/ledger.ts", "CT-2", ["post", "PostFn"]);
    expect(reviewedContractSurfaces([pricingContract()], [other, PRICING_BINDING], "T1")).toEqual([PRICING_SURFACE]);
  });

  it("is empty for every other Task, and for a contract declaring no types file", () => {
    expect(reviewedContractSurfaces([pricingContract()], [PRICING_BINDING], "T2")).toEqual([]);
    expect(reviewedContractSurfaces([withoutTypesFile(pricingContract())], [], "T1")).toEqual([]);
    expect(reviewedContractSurfaces([], [PRICING_BINDING], "T1")).toEqual([]);
  });

  const TASK_IDS = ["T1", "T2", "T3"] as const;
  const contracts = fc.array(fc.record({ contractTask: fc.constantFrom(...TASK_IDS), typed: fc.boolean() }), { maxLength: 5 })
    .map((drafts) => drafts.map(({ contractTask, typed }, index): AcceptanceContract => {
      const declared = contract({
        id: `CT-${index + 1}`, contractTask, surface: surface(`slice-${index}`), anchors: [`AS-00${index + 1}`],
        freeze: { state: "awaiting-red" },
      });
      return typed ? declared : withoutTypesFile(declared);
    }));
  const bindingsOf = (declared: readonly AcceptanceContract[]) =>
    fc.array(fc.nat({ max: 5 }), { maxLength: 6 }).map((targets) => targets.map((target, index): ExportBinding =>
      binding(`src/bound-${index}.ts`, `CT-${target + 1}`, ["run", "RunFn"])).filter(({ contract: id }) =>
      declared.some((candidate) => candidate.id === id) || id === "CT-6"));

  it("property: every contract with a types file is reviewed as a surface by exactly its Contract Task, and by no other Task", () => {
    fc.assert(fc.property(contracts.chain((declared) => fc.tuple(fc.constant(declared), bindingsOf(declared))), ([declared, bound]) => {
      const byTask = TASK_IDS.map((taskId) => ({ taskId, surfaces: reviewedContractSurfaces(declared, bound, taskId) }));
      const typed = declared.filter(({ types }) => types.kind === "file");
      expect(byTask.flatMap(({ surfaces }) => surfaces.map(({ contract: { id } }) => id)).sort())
        .toEqual(typed.map(({ id }) => id).sort());
      for (const { taskId, surfaces } of byTask) {
        expect(surfaces.map(({ contract: { id } }) => id))
          .toEqual(typed.filter(({ contractTask }) => contractTask === taskId).map(({ id }) => id));
      }
    }));
  });

  it("property: a surface lists exactly the bindings naming its contract, in plan order, and its contract's own types file", () => {
    fc.assert(fc.property(contracts.chain((declared) => fc.tuple(fc.constant(declared), bindingsOf(declared))), ([declared, bound]) => {
      for (const taskId of TASK_IDS) {
        for (const reviewed of reviewedContractSurfaces(declared, bound, taskId)) {
          const source = declared.find(({ id }) => id === reviewed.contract.id);
          expect(source?.types).toEqual({ kind: "file", path: reviewed.typesFile });
          expect(reviewed.bindings).toEqual(bound.filter((candidate) => candidate.contract === reviewed.contract.id));
        }
      }
    }));
  });
});

describe("renderContractSurfaceSection: the pure contract-surface section", () => {
  const LEDGER_SURFACE: ReviewedContractSurface = {
    contract: { id: "CT-2", title: "Ledger posting", statement: "A posting is refused when it does not balance." },
    typesFile: "src/ledger-types.ts",
    bindings: [],
  };

  it("lists every surface's contract, statement, types file, plan citation and bound exports, in order", () => {
    const text = renderContractSurfaceSection(PLAN_FILE, [PRICING_SURFACE, LEDGER_SURFACE]);
    for (const value of [
      "### CT-1: Order pricing", "Order pricing behaves as declared.", `\`${PRICING.types}\``, `\`${PLAN_FILE}#CT-1\``,
      `- \`${PRICING_IMPLEMENTATION}\`: \`priceOrder: PriceOrderFn\`, \`parseOrder: ParseOrderFn\``,
      "### CT-2: Ledger posting", "A posting is refused when it does not balance.", "`src/ledger-types.ts`", `\`${PLAN_FILE}#CT-2\``,
    ]) expect(text).toContain(value);
    expect(text.indexOf("### CT-1")).toBeLessThan(text.indexOf("### CT-2"));
    expect(text).toContain("**Bound exports:** none");
  });

  it("cites a contract by its id alone when the TaskGraph records no plan file", () => {
    const text = renderContractSurfaceSection(null, [PRICING_SURFACE]);
    expect(text).toContain("**Declared in:** the plan's `CT-1` block");
    expect(text).not.toContain("null");
  });

  it("tells the reviewer this Task is the surface dependents implement against, and carries the rule verbatim", () => {
    const text = renderContractSurfaceSection(PLAN_FILE, [PRICING_SURFACE]);
    expect(someParagraph(text, /Contract Task/, /implements against/, /wait for this one to complete/)).toBe(true);
    expect(text).toContain(CONTRACT_SURFACE_RULE);
  });

  it("the rule names the four judgments, why now, and that severity and the Refutation Panel are unchanged", () => {
    for (const judgment of [/Illegal states/, /Primitive obsession/, /Module shape and seams/, /Duplicate policy across the bound exports/]) {
      expect(CONTRACT_SURFACE_RULE).toMatch(judgment);
    }
    expect(someParagraph(CONTRACT_SURFACE_RULE, /cheapest now/, /freezes these bytes/, /Contract Revision/)).toBe(true);
    expect(someParagraph(CONTRACT_SURFACE_RULE, /severity rules/i, /Refutation Panel/, /unchanged/i)).toBe(true);
  });

  it("is deterministic: the same surfaces render the same bytes", () => {
    expect(renderContractSurfaceSection(PLAN_FILE, [PRICING_SURFACE])).toBe(renderContractSurfaceSection(PLAN_FILE, [PRICING_SURFACE]));
    expect(renderContractSurfaceSection(PLAN_FILE, [PRICING_SURFACE])).not.toBe(renderContractSurfaceSection(PLAN_FILE, [LEDGER_SURFACE]));
  });

  it("pins the wire label reviewers read and the two roles it is issued to", () => {
    expect(CONTRACT_SURFACE_SECTION).toBe("contract-surface");
    expect([...CONTRACT_SURFACE_ROLES]).toEqual(["type-design-analyzer", "architecture-tech-lead"]);
    for (const role of ["code-reviewer", "silent-failure-hunter", "pr-test-analyzer", "comment-analyzer", "spec-check-invoker"]) {
      expect(isContractSurfaceRole(role), role).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The roster derivation and Wave review issuance
// ---------------------------------------------------------------------------

const projectWithPlan = (): string => projectWithPlanFile("loom-contract-surface-", PLAN_FILE, cleanup);

const CONTRACT_TASK_FILES = [PRICING.types, PRICING.acceptance];

/** Wave 1: T1 writes the pricing contract's frozen paths (plus `extraT1Files`), T2 an unrelated file. */
function contractWave(stamps: Readonly<Record<string, unknown>>, extraT1Files: readonly string[] = [], planFile: string | null = PLAN_FILE): TaskGraph {
  return reviewGraphFixture(
    planFile,
    [reviewedTaskFixture("T1", [...CONTRACT_TASK_FILES, ...extraT1Files]), reviewedTaskFixture("T2", ["src/other.ts"])],
    stamps,
  );
}

const TYPED = { acceptance_contracts: [pricingContract()], export_bindings: [PRICING_BINDING] };
const UNTYPED = { acceptance_contracts: [withoutTypesFile(pricingContract())] };

const surfaceOf = (packet: ContextPacket): string | null => sectionTextOf(packet, CONTRACT_SURFACE_SECTION);

const rolesOf = (batch: WaveRequestBatch, taskId: string): readonly string[] =>
  batch.subjects.filter((subject) => subject.taskId === taskId).map(({ role }) => role);

/** A Review Run as the locked install records one for `agents`, slot per agent in order. */
function installedRun(agents: readonly [string, ...string[]]): ReviewRun {
  const [first, ...rest] = agents.map((agent, index) => ({ agent, slot_id: `slot-${index}`, attempted: 1 as const }));
  if (first === undefined) throw new Error("an installed run names at least one agent");
  return {
    generation: 0, packet_id: "b".repeat(64), head_sha: "c".repeat(64), expected_agents: agents,
    prior_finding_ids: [], evidence: [], slot_authority: [first, ...rest],
  };
}

const withInstalledRun = (graph: TaskGraph, taskId: string, run: ReviewRun): TaskGraph =>
  ({ ...graph, tasks: graph.tasks.map((task): Task => (task.id === taskId ? { ...task, review_run: run } : task)) });

const taskOf = (graph: TaskGraph, taskId: string): Task => {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) throw new Error(`fixture graph holds no ${taskId}`);
  return task;
};

describe("the Wave review roster of a Contract Task (ADR-0069)", () => {
  it("a schema-2 Contract Task writing a types file gets architecture-tech-lead appended to the base five", () => {
    const graph = contractWave(TYPED);
    expect(waveTaskReviewRoster(graph, 2, taskOf(graph, "T1"))).toEqual({ kind: "roster", roster: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS });
    expect(waveTaskReviewRoster(graph, 2, taskOf(graph, "T2"))).toEqual({ kind: "roster", roster: BASE_WAVE_REVIEW_AGENTS });
  });

  it.each([
    ["a contract declaring no types file", contractWave(UNTYPED), 2],
    ["a graph without contracts", contractWave({}), 2],
    ["a schema-1 registration", contractWave(TYPED), 1],
  ] as const)("%s keeps exactly the base five", (_name, graph, schemaVersion) => {
    expect(waveTaskReviewRoster(graph, schemaVersion, taskOf(graph, "T1"))).toEqual({ kind: "roster", roster: BASE_WAVE_REVIEW_AGENTS });
  });

  type TaskKind = "plain" | "typed-contract" | "untyped-contract";
  const waveOf = (kinds: readonly TaskKind[]): TaskGraph => {
    const slices = kinds.map((kind, index) => ({ kind, id: `T${index + 1}`, files: surface(`slice-${index}`) }));
    const declared = slices.flatMap(({ kind, id, files }, index): AcceptanceContract[] => {
      if (kind === "plain") return [];
      const typed = contract({
        id: `CT-${index + 1}`, contractTask: id, surface: files, anchors: [`AS-00${index + 1}`], freeze: { state: "awaiting-red" },
      });
      return [kind === "typed-contract" ? typed : withoutTypesFile(typed)];
    });
    return reviewGraphFixture(PLAN_FILE, slices.map(({ kind, id, files }) => reviewedTaskFixture(id, {
      "plain": [`src/${id.toLowerCase()}.ts`],
      "typed-contract": [files.types, files.acceptance],
      "untyped-contract": [files.acceptance],
    }[kind])), declared.length === 0 ? {} : { acceptance_contracts: declared });
  };

  it("property: in any Wave, exactly the Tasks writing a contract's types file are issued the architecture reviewer", () => {
    const kinds = fc.array(fc.constantFrom<TaskKind>("plain", "typed-contract", "untyped-contract"), { minLength: 1, maxLength: 4 });
    fc.assert(fc.property(kinds, (taskKinds) => {
      const graph = waveOf(taskKinds);
      graph.tasks.forEach((task, index) => {
        const roster = taskKinds[index] === "typed-contract" ? ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS : BASE_WAVE_REVIEW_AGENTS;
        expect(waveTaskReviewRoster(graph, 2, task)).toEqual({ kind: "roster", roster });
        expect(waveTaskReviewRoster(graph, 1, task)).toEqual({ kind: "roster", roster: BASE_WAVE_REVIEW_AGENTS });
      });
    }), { numRuns: 40 });
  });
});

describe("Wave review issuance: the contract-surface fixed section (ADR-0069)", () => {
  it("the Contract Task is issued six reviewers, and its type-design and architecture packets carry the section", () => {
    const batch = issueWaveBatchFixture(projectWithPlan(), contractWave(TYPED));
    expect(rolesOf(batch, "T1")).toEqual(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
    expect(rolesOf(batch, "T2")).toEqual(BASE_WAVE_REVIEW_AGENTS);
    const expected = renderContractSurfaceSection(PLAN_FILE, [PRICING_SURFACE]);
    for (const role of CONTRACT_SURFACE_ROLES) expect(surfaceOf(packetOf(batch, role, "T1")), role).toBe(expected);
    expect(packetOf(batch, "architecture-tech-lead", "T1").requiredSkill).toBe("deepen");
  });

  it("the section is inside the packet digest: a changed binding changes the packet identity", () => {
    const root = projectWithPlan();
    const rebound = { ...TYPED, export_bindings: [binding(PRICING_IMPLEMENTATION, "CT-1", ["priceOrder", "PriceOrderFn"])] };
    expect(packetOf(issueWaveBatchFixture(root, contractWave(rebound)), "type-design-analyzer", "T1").digest)
      .not.toBe(packetOf(issueWaveBatchFixture(root, contractWave(TYPED)), "type-design-analyzer", "T1").digest);
  });

  it("every other packet of the Wave is byte-identical to a graph without contracts", () => {
    const root = projectWithPlan();
    const typed = issueWaveBatchFixture(root, contractWave(TYPED));
    const plain = issueWaveBatchFixture(root, contractWave({}));
    expect(typed.batchEpoch).toBe(plain.batchEpoch);
    const unchanged = plain.subjects.filter(({ role, taskId }) => taskId !== "T1" || !isContractSurfaceRole(role));
    expect(unchanged).toHaveLength(1 + 4 + 5);
    for (const { role, taskId } of unchanged) {
      expect(surfaceOf(packetOf(typed, role, taskId)), `${taskId}/${role}`).toBeNull();
      expect(packetOf(typed, role, taskId).digest, `${taskId}/${role}`).toBe(packetOf(plain, role, taskId).digest);
    }
  });

  it("appending the architecture reviewer leaves every base reviewer's slot and request identity unchanged", () => {
    const root = projectWithPlan();
    const identities = (batch: WaveRequestBatch) => batch.requests
      .filter(({ authority }) => authority.role !== "architecture-tech-lead")
      .map(({ authority }) => [authority.role, authority.slotId, authority.requestId]);
    expect(identities(issueWaveBatchFixture(root, contractWave(TYPED)))).toEqual(identities(issueWaveBatchFixture(root, contractWave({}))));
  });

  it.each([
    ["a contract declaring no types file", UNTYPED, 2],
    ["a schema-1 registration", TYPED, 1],
  ] as const)("%s issues no section and a batch byte-identical to a graph without contracts", (_name, stamps, schemaVersion) => {
    const root = projectWithPlan();
    const issued = issueWaveBatchFixture(root, contractWave(stamps), schemaVersion);
    const plain = issueWaveBatchFixture(root, contractWave({}), schemaVersion);
    expect(issued.packets.every((packet) => surfaceOf(packet) === null)).toBe(true);
    expect(packetDigests(issued)).toEqual(packetDigests(plain));
    expect(JSON.stringify(issued.requests)).toBe(JSON.stringify(plain.requests));
  });

  it("a Contract Task that also touches an owned family carries both sections on its architecture packet, owner map first", () => {
    const graph = contractWave({ ...TYPED, owner_obligations: ADMISSION_FEE_TABLE_STAMP }, [FEE_TABLE.matrixTest]);
    const batch = issueWaveBatchFixture(projectWithPlan(), graph);
    expect(rolesOf(batch, "T1")).toEqual(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);
    const labels = (role: string) => packetOf(batch, role, "T1").fixedContext.map(({ label }) => label);
    expect(labels("architecture-tech-lead").filter((label) => label === OWNER_MAP_SECTION || label === CONTRACT_SURFACE_SECTION))
      .toEqual([OWNER_MAP_SECTION, CONTRACT_SURFACE_SECTION]);
    expect(labels("code-reviewer")).toContain(OWNER_MAP_SECTION);
    expect(labels("code-reviewer")).not.toContain(CONTRACT_SURFACE_SECTION);
    expect(labels("type-design-analyzer")).toContain(CONTRACT_SURFACE_SECTION);
    expect(labels("type-design-analyzer")).not.toContain(OWNER_MAP_SECTION);
  });

  it("a TaskGraph recording no plan file still issues the section, citing the contract by id", () => {
    const batch = issueWaveBatchFixture(projectWithPlan(), contractWave(TYPED, [], null));
    expect(surfaceOf(packetOf(batch, "type-design-analyzer", "T1"))).toBe(renderContractSurfaceSection(null, [PRICING_SURFACE]));
  });
});

describe("a Review Run installed without the contract surface keeps its roster (ADR-0069)", () => {
  const graph = contractWave(TYPED);
  const contractTask = taskOf(graph, "T1");
  const fiveAgentRun = installedRun(BASE_WAVE_REVIEW_AGENTS);
  const sixAgentRun = installedRun(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS);

  it("admits the installed five-agent run of a Contract Task, and the six-agent run a fresh install records", () => {
    expect(waveRunRosterProblem(graph, 2, contractTask, fiveAgentRun)).toBeNull();
    expect(waveRunRosterProblem(graph, 2, contractTask, sixAgentRun)).toBeNull();
  });

  it("derives the base five for a Contract Task carrying that run, and the six once it carries none or the six-agent run", () => {
    const rosterWith = (run: ReviewRun | undefined) => {
      const installed = run === undefined ? graph : withInstalledRun(graph, "T1", run);
      return waveTaskReviewRoster(installed, 2, taskOf(installed, "T1"));
    };
    expect(rosterWith(fiveAgentRun)).toEqual({ kind: "roster", roster: BASE_WAVE_REVIEW_AGENTS });
    expect(rosterWith(sixAgentRun)).toEqual({ kind: "roster", roster: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS });
    expect(rosterWith(undefined)).toEqual({ kind: "roster", roster: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS });
  });

  it("re-derives that run's batch byte-identical to the batch issued before the Task's review carried the surface", () => {
    const root = projectWithPlan();
    const resumed = issueWaveBatchFixture(root, withInstalledRun(graph, "T1", fiveAgentRun));
    const before = issueWaveBatchFixture(root, contractWave({}));
    expect(resumed.packets.every((packet) => surfaceOf(packet) === null)).toBe(true);
    expect(packetDigests(resumed)).toEqual(packetDigests(before));
    expect(JSON.stringify(resumed.requests)).toBe(JSON.stringify(before.requests));
  });

  it("re-derives the six-agent run's batch with the section, exactly as first issued", () => {
    const root = projectWithPlan();
    expect(packetDigests(issueWaveBatchFixture(root, withInstalledRun(graph, "T1", sixAgentRun))))
      .toEqual(packetDigests(issueWaveBatchFixture(root, graph)));
  });

  it.each([
    ["a strict subset of the base five", installedRun(["code-reviewer", "type-design-analyzer"])],
    ["the six reordered", installedRun(["architecture-tech-lead", ...BASE_WAVE_REVIEW_AGENTS])],
  ] as const)("still refuses %s, naming the six-agent roster", (_name, run) => {
    expect(waveRunRosterProblem(graph, 2, contractTask, run))
      .toEqual({ kind: "expected-agents-differ", taskId: "T1", roster: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS });
  });

  it("still refuses a six-agent run on a Task that writes no contract surface", () => {
    expect(waveRunRosterProblem(graph, 2, taskOf(graph, "T2"), sixAgentRun))
      .toEqual({ kind: "expected-agents-differ", taskId: "T2", roster: BASE_WAVE_REVIEW_AGENTS });
  });

  it("an owner-mapped Contract Task's installed six-agent roster cannot tell the two apart, so the surface is still derived", () => {
    const owned = contractWave({ ...TYPED, owner_obligations: ADMISSION_FEE_TABLE_STAMP }, [FEE_TABLE.matrixTest]);
    const batch = issueWaveBatchFixture(projectWithPlan(), withInstalledRun(owned, "T1", sixAgentRun));
    expect(surfaceOf(packetOf(batch, "type-design-analyzer", "T1"))).toBe(renderContractSurfaceSection(PLAN_FILE, [PRICING_SURFACE]));
    expect(waveRunRosterProblem(owned, 2, taskOf(owned, "T1"), fiveAgentRun))
      .toEqual({ kind: "expected-agents-differ", taskId: "T1", roster: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS });
  });
});
