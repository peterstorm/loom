/**
 * `amend-export-binding` (ADR-0105): the pure decision over the skeleton
 * fixture's Wave 2 graph (T4 pending, bound to CT-1). Every committed graph is
 * round-tripped through the State File parser, so an amendment that would
 * load back corrupt (a record or outcome left for an unbound path, an audit
 * the constructor refuses) fails here.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  amendExportBinding,
  parseExportBindingAmendmentArgs,
  type ExportBindingAmendmentRefusal,
  type ExportBindingAmendmentRequest,
} from "../../src/core/export-binding-amendment";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import {
  applyExportChange,
  bindingStampAgreement,
  parseIdentifier,
  replayExportBindingAmendments,
} from "../../src/core/skeleton/bindings";
import { createImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import type { BoundExport, ExportBinding } from "../../src/core/skeleton/types";
import { exportBindingAmendedEdit } from "../../src/core/wave-plan-edit";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";
import {
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  graphOf,
  PATHS,
  seededRecord,
  skeletonRepo,
  TS_CONTRACT,
} from "../fixtures/skeleton-repo";
import { identifier } from "../fixtures/skeleton-builders";
import { activeWaveGateFixture, completedWaveGateFixture, satisfiedProof, taskFixture } from "../fixtures/task-lifecycle";

afterEach(cleanupSkeletonRepos);

const REASON = "status is per-replica: a static constant cannot implement it";

/** The Wave 2 graph with T4's quotes.ts skeleton recorded and its outcome registered. */
function graph(): TaskGraph {
  const repo = skeletonRepo({ skeletons: [seededRecord(PATHS.tsQuotes, canonicalSkeletonOf(PATHS.tsQuotes))] });
  const loaded = graphOf(repo);
  return {
    ...loaded,
    tasks: loaded.tasks.map((task) => (task.id === "T4"
      ? { ...task, skeleton_outcomes: [{ path: PATHS.tsQuotes, outcome: { kind: "skeleton-written", origin: "spawn" } }] }
      : task)),
  };
}

const withTask = (state: TaskGraph, id: string, edit: (task: Task) => Task): TaskGraph =>
  ({ ...state, tasks: state.tasks.map((task) => (task.id === id ? edit(task) : task)) });

const request = (...args: readonly string[]): ExportBindingAmendmentRequest => {
  const parsed = parseExportBindingAmendmentArgs([...args, "--reason", REASON]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const DROP_QUOTE = request("--task", "T4", "--file", PATHS.tsQuotes, "--export", "quote", "--drop");
const DROP_PARSE = request("--task", "T4", "--file", PATHS.tsPricing, "--export", "parseOrder", "--drop");
const REBIND_QUOTE = request("--task", "T4", "--file", PATHS.tsQuotes, "--export", "quote", "--rebind", "quoteFor");

/** The amended graph, proven to load back through the State File parser. */
function amended(state: TaskGraph, req: ExportBindingAmendmentRequest): TaskGraph {
  const result = amendExportBinding(state, req);
  if (!result.ok || result.value.kind !== "amended") throw new Error(`expected an amendment, got ${JSON.stringify(result)}`);
  const reloaded = parseTaskGraph(JSON.parse(JSON.stringify(result.value.graph)));
  if (!reloaded.ok) throw new Error(`the amended graph does not load back: ${reloaded.error}`);
  return result.value.graph;
}

function refusal(state: TaskGraph, req: ExportBindingAmendmentRequest): ExportBindingAmendmentRefusal {
  const result = amendExportBinding(state, req);
  if (result.ok) throw new Error(`expected a refusal, got ${result.value.kind}`);
  return result.error;
}

const bindingAt = (state: TaskGraph, path: string): ExportBinding | undefined =>
  (state.export_bindings ?? []).find((binding) => binding.path === path);

describe("parseExportBindingAmendmentArgs", () => {
  const base = ["--task", "T4", "--file", PATHS.tsQuotes, "--export", "quote"] as const;
  it.each([
    ["no change", [...base, "--reason", "r"], "give --drop or --rebind <newName>"],
    ["both changes", [...base, "--drop", "--rebind", "quoteFor", "--reason", "r"], "give --drop or --rebind, not both"],
    ["a rebind to itself", [...base, "--rebind", "quote", "--reason", "r"], "--rebind names 'quote' itself"],
    ["a reserved new name", [...base, "--rebind", "class", "--reason", "r"], "--rebind 'class' is no identifier (reserved-word)"],
    ["an export that is no identifier", ["--task", "T4", "--file", PATHS.tsQuotes, "--export", "2x", "--drop", "--reason", "r"], "--export '2x' is no identifier"],
    ["no reason", [...base, "--drop"], "--reason must say why the binding changes"],
    ["a blank reason", [...base, "--drop", "--reason", "  "], "--reason must say why the plan changes"],
    ["a flag twice", [...base, "--drop", "--drop", "--reason", "r"], "--drop is given twice"],
    ["an unknown flag", [...base, "--drop", "--remove", "x", "--reason", "r"], "unknown argument '--remove'"],
    ["a path outside the repository", ["--task", "T4", "--file", "../x.ts", "--export", "quote", "--drop", "--reason", "r"], "--file"],
    ["a missing --file", ["--task", "T4", "--export", "quote", "--drop", "--reason", "r"], "--file must name the bound file"],
  ])("refuses %s, naming the usage", (_name, args, expected) => {
    const parsed = parseExportBindingAmendmentArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain(expected);
      expect(parsed.error).toContain("Usage: helper orchestration amend-export-binding");
    }
  });

  it("reads a drop and a rebind in any flag order", () => {
    expect(request("--export", "quote", "--drop", "--file", PATHS.tsQuotes, "--task", "T4"))
      .toEqual({ taskId: "T4", path: PATHS.tsQuotes, change: { kind: "dropped", name: "quote" }, reason: REASON });
    expect(REBIND_QUOTE.change).toEqual({ kind: "rebound", name: "quote", to: "quoteFor" });
  });
});

describe("amendExportBinding: what changes", () => {
  it("drops one export of a binding that keeps another, leaving its skeleton record and audit", () => {
    const before = graph();
    const after = amended(before, DROP_PARSE);
    expect(bindingAt(after, PATHS.tsPricing)?.exports).toEqual([{ name: "priceOrder", alias: "PriceOrderFn" }]);
    expect(after.skeletons).toEqual(before.skeletons);
    expect(after.wave_plan_edits).toEqual([{
      schemaVersion: 1,
      kind: "export-binding-amended",
      wave: 2,
      taskId: "T4",
      path: PATHS.tsPricing,
      contract: TS_CONTRACT.id,
      change: { kind: "dropped", name: "parseOrder" },
      before: [{ name: "priceOrder", alias: "PriceOrderFn" }, { name: "parseOrder", alias: "ParseOrderFn" }],
      after: [{ name: "priceOrder", alias: "PriceOrderFn" }],
      reason: REASON,
    }]);
    // Every other binding is untouched, in stamp order.
    expect((after.export_bindings ?? []).filter(({ path }) => path !== PATHS.tsPricing))
      .toEqual((before.export_bindings ?? []).filter(({ path }) => path !== PATHS.tsPricing));
  });

  it("drops a binding's last export: the path is unbound, its skeleton record and recorded outcomes go with it", () => {
    const before = graph();
    const after = amended(before, DROP_QUOTE);
    expect(bindingAt(after, PATHS.tsQuotes)).toBeUndefined();
    expect((after.export_bindings ?? []).map(({ path }) => path))
      .toEqual((before.export_bindings ?? []).map(({ path }) => path).filter((path) => path !== PATHS.tsQuotes));
    expect((after.skeletons ?? []).map(({ path }) => path)).not.toContain(PATHS.tsQuotes);
    expect(after.tasks.find(({ id }) => id === "T4")?.skeleton_outcomes).toEqual([]);
    expect(after.wave_plan_edits?.at(-1)).toMatchObject({ change: { kind: "dropped", name: "quote" }, after: [] });
  });

  it("rebinds an export to a new name, keeping its frozen alias and its skeleton record", () => {
    const before = graph();
    const after = amended(before, REBIND_QUOTE);
    expect(bindingAt(after, PATHS.tsQuotes)?.exports).toEqual([{ name: "quoteFor", alias: "PriceOrderFn" }]);
    expect(after.skeletons).toEqual(before.skeletons);
    expect(after.tasks.find(({ id }) => id === "T4")?.skeleton_outcomes).toEqual(before.tasks.find(({ id }) => id === "T4")?.skeleton_outcomes);
  });

  it("is idempotent: repeating an applied change returns unchanged; a different change is not a replay", () => {
    for (const req of [DROP_QUOTE, REBIND_QUOTE, DROP_PARSE]) {
      const once = amended(graph(), req);
      expect(amendExportBinding(once, req)).toEqual({ ok: true, value: { kind: "unchanged", taskId: "T4", path: req.path, change: req.change } });
    }
    const dropped = amended(graph(), DROP_QUOTE);
    expect(refusal(dropped, REBIND_QUOTE)).toMatchObject({ kind: "not-bound", message: `${PATHS.tsQuotes} carries no export binding` });
  });

  it("the plan's bindings with the audit replayed agree with the amended stamp", () => {
    const before = graph();
    const plan = before.export_bindings ?? [];
    for (const req of [DROP_QUOTE, DROP_PARSE, REBIND_QUOTE]) {
      const after = amended(before, req);
      const audits = (after.wave_plan_edits ?? []).flatMap((edit) => (edit.kind === "export-binding-amended" ? [edit] : []));
      expect(bindingStampAgreement(plan, after.export_bindings ?? []).ok).toBe(false);
      expect(bindingStampAgreement(replayExportBindingAmendments(plan, audits), after.export_bindings ?? [])).toEqual({ ok: true, value: null });
      // A plan the operator corrected by hand agrees too.
      expect(bindingStampAgreement(replayExportBindingAmendments(after.export_bindings ?? [], audits), after.export_bindings ?? []))
        .toEqual({ ok: true, value: null });
    }
  });
});

describe("amendExportBinding: refusals change nothing", () => {
  const settled = (id: string, wave: number, files: readonly string[], status: "implemented" | "completed"): Task => taskFixture({
    id, description: id, agent: "code-implementer-agent", wave, depends_on: [], file_list: [...files], spec_anchors: [], spec_contributions: [],
    status, proof: satisfiedProof([...files]), ...(status === "completed" ? { review_status: "passed" as const, review_generation: 1 } : {}),
  });

  it.each<readonly [string, () => TaskGraph, ExportBindingAmendmentRequest, ExportBindingAmendmentRefusal["kind"], string]>([
    ["outside the execute Phase", () => ({ ...graph(), current_phase: "decompose" }), DROP_QUOTE, "not-executing", "requires the execute Phase"],
    ["a live Wave Gate run", () => ({ ...graph(), active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64) }) }),
      DROP_QUOTE, "live-wave-gate", "abandon it with helper orchestration abandon"],
    ["an executing Task", () => ({ ...graph(), executing_tasks: ["T5"] }), DROP_QUOTE, "implementation-active", "implementation reservations are active: T5"],
    ["an unknown Task", graph, request("--task", "T99", "--file", PATHS.tsQuotes, "--export", "quote", "--drop"), "unknown-task", "T99 is not in the TaskGraph"],
    ["a path the Task does not list", graph, request("--task", "T5", "--file", PATHS.tsQuotes, "--export", "quote", "--drop"), "not-held",
      `${PATHS.tsQuotes} is not in T5's file_list`],
    ["an unbound path", graph, request("--task", "T4", "--file", PATHS.tsHelpers, "--export", "round", "--drop"), "not-bound",
      `${PATHS.tsHelpers} carries no export binding`],
    ["an export the binding does not hold", graph, request("--task", "T4", "--file", PATHS.tsPricing, "--export", "quote", "--drop"), "not-bound",
      "has no export 'quote' (it binds priceOrder, parseOrder)"],
    ["a graph stamped before bindings", () => { const { export_bindings: _stamp, skeletons: _records, ...rest } = graph(); return { ...rest, tasks: rest.tasks.map(({ skeleton_outcomes: _o, ...task }) => task) }; },
      DROP_QUOTE, "no-binding-stamp", "populated before export bindings were stamped"],
    ["an implemented Task", () => withTask(graph(), "T4", (task) => settled("T4", 2, task.file_list ?? [], "implemented")),
      DROP_QUOTE, "not-pending", "T4 is implemented; only a pending Task's binding is amended"],
    ["a Task of a completed Wave", () => ({ ...graph(), current_wave: 3 }), DROP_QUOTE, "completed-wave", "T4 is in completed Wave 2"],
    ["a Task holding its own reservation", () => withTask(graph(), "T4", (task) => ({ ...task, reserved_at: "2026-11-28T00:00:00.000Z" })),
      DROP_QUOTE, "live-attempt", "T4 holds an implementation reservation"],
    ["a Distill Task", () => withTask(graph(), "T4", (task) => ({ ...task, agent: DISTILL_AGENT })), DROP_QUOTE, "distill-task", "T4 is a Distill Task"],
    ["a contract still awaiting RED", () => ({ ...graph(), acceptance_contracts: (graph().acceptance_contracts ?? []).map((contract) => ({ ...contract, freeze: { state: "awaiting-red" as const } })) }),
      DROP_QUOTE, "contract-not-frozen", "CT-1 is still awaiting RED"],
    ["a path a settled Task also lists", () => ({ ...graph(), tasks: [...graph().tasks, settled("T9", 1, [PATHS.tsQuotes], "completed")] }),
      DROP_QUOTE, "shared-with-settled-task", `${PATHS.tsQuotes} is also T9's, which is completed`],
    ["a rebind to a name the binding already binds", graph, request("--task", "T4", "--file", PATHS.tsPricing, "--export", "priceOrder", "--rebind", "parseOrder"),
      "invalid-rebind", "already binds 'parseOrder'"],
    ["a TypeScript rebind to one of the binding's aliases", graph, request("--task", "T4", "--file", PATHS.tsPricing, "--export", "priceOrder", "--rebind", "ParseOrderFn"),
      "invalid-rebind", "(name-collides-with-alias)"],
  ])("refuses %s", (_name, state, req, kind, message) => {
    const before = state();
    const snapshot = JSON.stringify(before);
    const refused = refusal(before, req);
    expect(refused.kind).toBe(kind);
    expect(refused.message).toContain(message);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("exportBindingAmendedEdit: the one constructor", () => {
  const input = {
    wave: 2, taskId: "T4", path: PATHS.tsQuotes, contract: "CT-1", reason: REASON,
    change: { kind: "dropped" as const, name: "quote" }, before: [{ name: "quote", alias: "PriceOrderFn" }],
  };
  it.each([
    ["a change of a name before does not bind", { ...input, change: { kind: "dropped" as const, name: "other" } }, "change cannot apply to before: unbound-export 'other'"],
    ["an empty before", { ...input, before: [] }, "before binds no export"],
    ["a name before binds twice", { ...input, before: [input.before[0], input.before[0]] }, "before binds 'quote' twice"],
    ["a rebind to itself", { ...input, change: { kind: "rebound" as const, name: "quote", to: "quote" } }, "change rebinds 'quote' to itself"],
    ["a contract that is no contract id", { ...input, contract: "C1" }, "contract 'C1' is no contract id"],
    ["Wave 0", { ...input, wave: 0 }, "wave must be an integer >= 1"],
  ])("refuses %s", (_name, value, expected) => {
    expect(exportBindingAmendedEdit(value)).toEqual({ ok: false, error: expect.stringContaining(expected) });
  });

  it("is refused at load when its stored after is not what its change leaves", () => {
    const after = amended(graph(), DROP_PARSE);
    const raw = JSON.parse(JSON.stringify(after)) as Record<string, unknown> & { wave_plan_edits: Record<string, unknown>[] };
    raw.wave_plan_edits[0] = { ...raw.wave_plan_edits[0], after: [{ name: "parseOrder", alias: "ParseOrderFn" }] };
    expect(parseTaskGraph(raw)).toMatchObject({ ok: false, error: expect.stringContaining("wave_plan_edits[0].after is not what its change leaves of before") });
  });
});

describe("amendExportBinding: Java bindings", () => {
  const DROP_JAVA_PARSE = request("--task", "T5", "--file", PATHS.javaPricing, "--export", "parseOrder", "--drop");
  /** The Wave 2 graph with T5's Pricing.java skeleton recorded (records sorted by path, as the State File requires). */
  const javaGraph = (): TaskGraph => {
    const base = graph();
    return { ...base, skeletons: [seededRecord(PATHS.javaPricing, canonicalSkeletonOf(PATHS.javaPricing)), ...(base.skeletons ?? [])] };
  };

  it("drops a Java export: the amended graph reloads with its audit and skeleton record intact", () => {
    const before = javaGraph();
    const after = amended(before, DROP_JAVA_PARSE);
    const reloaded = parseTaskGraph(JSON.parse(JSON.stringify(after)));
    if (!reloaded.ok) throw new Error(reloaded.error);
    expect(bindingAt(reloaded.value, PATHS.javaPricing)?.exports).toEqual([{ name: "priceOrder", alias: "PriceOrderFn" }]);
    expect(reloaded.value.skeletons).toEqual(before.skeletons);
    expect(reloaded.value.wave_plan_edits).toEqual([expect.objectContaining({
      kind: "export-binding-amended", taskId: "T5", path: PATHS.javaPricing, contract: "CT-2",
      change: { kind: "dropped", name: "parseOrder" }, after: [{ name: "priceOrder", alias: "PriceOrderFn" }],
    })]);
  });

  it("accepts a Java rebind to one of the binding's aliases; the same rebind on a TypeScript file collides", () => {
    const java = amended(javaGraph(), request("--task", "T5", "--file", PATHS.javaPricing, "--export", "priceOrder", "--rebind", "ParseOrderFn"));
    expect(bindingAt(java, PATHS.javaPricing)?.exports).toEqual([
      { name: "ParseOrderFn", alias: "PriceOrderFn" }, { name: "parseOrder", alias: "ParseOrderFn" },
    ]);
    expect(refusal(graph(), request("--task", "T4", "--file", PATHS.tsPricing, "--export", "priceOrder", "--rebind", "ParseOrderFn")))
      .toMatchObject({ kind: "invalid-rebind", message: expect.stringContaining("(name-collides-with-alias)") });
  });
});

describe("amendExportBinding: successive amendments replay onto the plan", () => {
  const auditsOf = (state: TaskGraph) =>
    (state.wave_plan_edits ?? []).flatMap((edit) => (edit.kind === "export-binding-amended" ? [edit] : []));

  it.each<readonly [string, ExportBindingAmendmentRequest, ExportBindingAmendmentRequest, string]>([
    ["a drop, then a drop of the binding's last export", DROP_PARSE,
      request("--task", "T4", "--file", PATHS.tsPricing, "--export", "priceOrder", "--drop"), PATHS.tsPricing],
    ["a rebind, then a drop of the new name", REBIND_QUOTE,
      request("--task", "T4", "--file", PATHS.tsQuotes, "--export", "quoteFor", "--drop"), PATHS.tsQuotes],
  ])("%s: the binding is gone and the replayed plan agrees with the stamp", (_name, first, second, path) => {
    const before = graph();
    const after = amended(amended(before, first), second);
    expect(bindingAt(after, path)).toBeUndefined();
    expect(auditsOf(after)).toHaveLength(2);
    expect(bindingStampAgreement(replayExportBindingAmendments(before.export_bindings ?? [], auditsOf(after)), after.export_bindings ?? []))
      .toEqual({ ok: true, value: null });
  });

  it("unbinding a path removes the recorded outcome of every Task that lists it, not just the amending Task's", () => {
    const sibling = taskFixture({
      id: "T9", description: "T9", agent: "code-implementer-agent", wave: 2, depends_on: [], file_list: [PATHS.tsQuotes],
      spec_anchors: [], spec_contributions: [],
    });
    const before = { ...graph(), tasks: [...graph().tasks, {
      ...sibling, skeleton_outcomes: [{ path: PATHS.tsQuotes, outcome: { kind: "skeleton-written" as const, origin: "spawn" as const } }],
    }] };
    const after = amended(before, DROP_QUOTE);
    expect(after.tasks.find(({ id }) => id === "T9")?.skeleton_outcomes).toEqual([]);
    expect(after.tasks.find(({ id }) => id === "T4")?.skeleton_outcomes).toEqual([]);
  });
});

describe("amendExportBinding: the Task's own lifecycle", () => {
  const inWave3 = (): TaskGraph => withTask(graph(), "T4", (task) => ({ ...task, wave: 3 }));
  const liveAttempt = (task: Task): Task => {
    const authority = createImplementationAttemptAuthority({
      taskId: task.id, wave: task.wave, semanticAttempt: 1, reservationId: `fixture-${task.id}`,
      headSha: "1".repeat(40), reservedAt: "2026-11-28T00:00:00.000Z", taskScopeBaseline: [], dirtySetBaseline: [],
    });
    if (!authority.ok) throw new Error(authority.error.errors.join("; "));
    return { ...task, active_implementation_attempt: authority.value };
  };

  it("amends a pending Task of a later Wave than the current one", () => {
    expect(inWave3().current_wave).toBe(2);
    expect(bindingAt(amended(inWave3(), DROP_PARSE), PATHS.tsPricing)?.exports).toEqual([{ name: "priceOrder", alias: "PriceOrderFn" }]);
  });

  it("refuses that Task while it holds its own attempt, which the active-Wave precondition does not see", () => {
    expect(refusal(withTask(inWave3(), "T4", liveAttempt), DROP_PARSE))
      .toMatchObject({ kind: "live-attempt", message: expect.stringContaining("T4 holds an implementation reservation") });
  });

  it("refuses a Task whose Wave the gate history already completed", () => {
    const gated = { ...graph(), wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-2", wave: 2 })] };
    expect(refusal(gated, DROP_PARSE)).toMatchObject({ kind: "completed-wave", message: expect.stringContaining("T4 is in completed Wave 2") });
  });
});

describe("export-binding-amended audits are parsed, never trusted, at load", () => {
  type RawAudit = Record<string, unknown> & { before: Record<string, unknown>[]; change: Record<string, unknown> };
  const mutated = (req: ExportBindingAmendmentRequest, edit: (audit: RawAudit) => unknown): unknown => {
    const raw = JSON.parse(JSON.stringify(amended(graph(), req))) as Record<string, unknown> & { wave_plan_edits: RawAudit[] };
    return { ...raw, wave_plan_edits: [edit(raw.wave_plan_edits[0])] };
  };

  it.each<readonly [string, ExportBindingAmendmentRequest, (audit: RawAudit) => unknown]>([
    ["an extra field on a bound export", DROP_PARSE, (audit) => ({ ...audit, before: [{ ...audit.before[0], extra: true }, ...audit.before.slice(1)] })],
    ["a bound export whose name is no string", DROP_PARSE, (audit) => ({ ...audit, before: [{ ...audit.before[0], name: 7 }, ...audit.before.slice(1)] })],
    ["a bound export whose alias is no string", DROP_PARSE, (audit) => ({ ...audit, before: [{ ...audit.before[0], alias: null }, ...audit.before.slice(1)] })],
    ["an unknown change kind", DROP_PARSE, (audit) => ({ ...audit, change: { ...audit.change, kind: "renamed" } })],
    ["a drop that carries a to", DROP_PARSE, (audit) => ({ ...audit, change: { ...audit.change, to: "quoteFor" } })],
    ["a rebind with no to", REBIND_QUOTE, (audit) => { const { to: _to, ...change } = audit.change; return { ...audit, change }; }],
    ["a before that is no array", DROP_PARSE, (audit) => ({ ...audit, before: { name: "priceOrder", alias: "PriceOrderFn" } })],
  ])("refuses %s", (_name, req, edit) => {
    expect(parseTaskGraph(mutated(req, edit))).toMatchObject({ ok: false });
  });

  it("loads the unmutated audit (the refusals above are the mutation's)", () => {
    for (const req of [DROP_PARSE, REBIND_QUOTE]) expect(parseTaskGraph(mutated(req, (audit) => audit))).toMatchObject({ ok: true });
  });
});

describe("applyExportChange (property)", () => {
  const names = fc.uniqueArray(fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,6}$/u).filter((raw) => parseIdentifier(raw).ok), { minLength: 1, maxLength: 6 });
  const exportsOf = (raw: readonly string[]): readonly BoundExport[] => raw.map((name) => ({ name: identifier(name), alias: identifier("PriceOrderFn") }));

  it("a drop removes exactly the named export and keeps the rest in order; a rebind renames it in place, alias kept", () => {
    fc.assert(fc.property(names, fc.nat(), fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,6}$/u), (raw, pick, fresh) => {
      const exports = exportsOf(raw);
      const target = exports[pick % exports.length];
      const dropped = applyExportChange("src/x.ts", exports, { kind: "dropped", name: target.name });
      expect(dropped).toEqual({ ok: true, value: exports.filter(({ name }) => name !== target.name) });
      const to = parseIdentifier(fresh);
      if (!to.ok || raw.includes(fresh) || fresh === "PriceOrderFn") return;
      const rebound = applyExportChange("src/x.ts", exports, { kind: "rebound", name: target.name, to: to.value });
      expect(rebound).toEqual({ ok: true, value: exports.map((bound) => (bound.name === target.name ? { name: to.value, alias: bound.alias } : bound)) });
    }));
  });
});
