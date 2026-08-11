import { describe, expect, it } from "vitest";
import { DAG_INPUT, createTransformNode, defineDag, ok, runDag, type NodeContext } from "@fuguejs/framework";
import { z } from "zod";
import { createStandaloneResultPublicationAuthorityResolver } from "../../src/core/remediation-machine";
import type { OrchestrationRunId } from "../../src/core/orchestration-contract";
import { createOperationContext, lowerRunId } from "../../src/orchestration/dags/run-context";
import {
  createRemediationAuditDag,
  createRemediationStagedSetDag,
  REMEDIATION_DAG_NODE_IDS,
  type InstallationDecision,
  type RemediationAuditOutcome,
} from "../../src/orchestration/dags/remediation-operations";
import { ORCHESTRATION_CAPABILITIES } from "../../src/orchestration/dags/capabilities";
import {
  createWavePreparationDag,
  parseWaveNumber,
  waveAdvisoryDag,
  WAVE_GATE_DAG_NODE_IDS,
  type DerivedPart,
  type PreparationInput,
  type PreparedBatch,
} from "../../src/orchestration/dags/wave-gate-operations";
import {
  createArchitecturePanelDag,
  createPanelOperationDag,
  createRefutationPanelDag,
  PANEL_DAG_NODE_IDS,
  type PanelOperationSpec,
  type PanelOutcome,
} from "../../src/orchestration/dags/panel-operations";
import { createPublicationAuthorityResolver } from "../../src/core/orchestration-contract";
import {
  standaloneCriticalRouteDag,
  standaloneScopeDag,
  type AggregateSummary,
  type CriticalRoute,
  type ResolvedScope,
  type ScopeInput,
} from "../../src/orchestration/dags/standalone-review-operations";

/** Never consulted by these paths; the parsers reject before authority resolves. */
const resolver = createStandaloneResultPublicationAuthorityResolver(() => ({
  ok: false,
  error: { kind: "publication-authority-unresolved", message: "no publication registered" },
} as never));

/**
 * `FrameworkError` is a union and not every variant carries `message`, so the
 * text is read through a narrowing helper rather than asserted onto the union.
 */
function errorText(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : JSON.stringify(error);
}

/** Never consulted: the roster proof fails before publication authority resolves. */
const panelResolver = createPublicationAuthorityResolver(() => ({
  ok: false,
  error: { kind: "publication-authority-unresolved", message: "no publication registered" },
} as never));

const auditDag = createRemediationAuditDag(resolver);
const stagedDag = createRemediationStagedSetDag(resolver);

const RUN_ID = "run.dag-test" as OrchestrationRunId;

function context(dagId: string): NodeContext {
  const built = createOperationContext({ runId: RUN_ID, dagId });
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

// --- Topology ---------------------------------------------------------------

describe("remediation DAG topology", () => {
  it("builds both graphs at module load, so an unsound topology fails at boot", () => {
    expect(auditDag.id).toBe("remediation-path-audit");
    expect(stagedDag.id).toBe("remediation-staged-set");
  });

  it("routes the staged set through a conditional edge with a default fallback", () => {
    const fromVerify = stagedDag.edges.filter((edge) => edge.from === REMEDIATION_DAG_NODE_IDS.verifyStaged);

    expect(fromVerify).toHaveLength(2);
    expect(fromVerify.filter((edge) => edge.kind === "conditional")).toHaveLength(1);
    expect(fromVerify.filter((edge) => edge.kind === "default")).toHaveLength(1);
  });

  it("reaches the installation intent only from the verified branch", () => {
    const intoIntent = stagedDag.edges.filter((edge) => edge.to === REMEDIATION_DAG_NODE_IDS.emitIntent);

    expect(intoIntent).toHaveLength(1);
    expect(intoIntent[0]?.kind).toBe("conditional");
    expect(intoIntent[0]?.from).toBe(REMEDIATION_DAG_NODE_IDS.verifyStaged);
  });

  it("feeds the request over an explicit $input edge rather than implicitly", () => {
    expect(auditDag.edges.some((edge) => edge.from === DAG_INPUT)).toBe(true);
    expect(stagedDag.edges.some((edge) => edge.from === DAG_INPUT)).toBe(true);
  });

  it("keeps every validation, set, and routing node pure", () => {
    for (const dag of [auditDag, stagedDag]) {
      for (const node of Object.values(dag.nodes)) {
        expect(node.requires).toEqual([]);
        expect(node.sideEffects).toEqual({ kind: "none" });
      }
    }
  });

  it("declares only the three narrow orchestration capabilities", () => {
    expect([...ORCHESTRATION_CAPABILITIES]).toEqual(["runArtifacts", "protectedStateCommit", "gitIndex"]);
  });
});

// --- Routing behaviour ------------------------------------------------------

describe("remediation audit routing", () => {
  it("blocks rather than throwing when the authority does not parse", async () => {
    const result = await runDag<unknown, RemediationAuditOutcome>(auditDag, {
      authority: { not: "an authority" },
      expectedDirtyPaths: [],
      actualDirtyPaths: [],
      preexistingStagedPaths: [],
      repositoryWitness: {},
    }, context(auditDag.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("blocked");
  });

  it("blocks when the repository witness does not parse", async () => {
    const result = await runDag<unknown, RemediationAuditOutcome>(auditDag, {
      authority: {},
      expectedDirtyPaths: [],
      actualDirtyPaths: [],
      preexistingStagedPaths: [],
      repositoryWitness: { indexDigest: "not-a-digest" },
    }, context(auditDag.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("blocked");
  });
});

describe("staged-set routing", () => {
  it("takes the default edge to blocked when the audited set does not parse", async () => {
    const result = await runDag<unknown, InstallationDecision>(stagedDag, {
      auditedPathSet: { forged: true },
      stagedPaths: ["engine/src/a.ts"],
    }, context(stagedDag.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("blocked");
  });

  it("never emits an installation intent from an unparsed audit", async () => {
    const result = await runDag<unknown, InstallationDecision>(stagedDag, {
      auditedPathSet: null,
      stagedPaths: [],
    }, context(stagedDag.id));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: "blocked" });
  });
});

// --- Panel operations -------------------------------------------------------

describe("panel operation DAGs", () => {
  /**
   * The graph shape is what is under test here; the ranking and tally logic
   * have their own suites in the core. The spec is stubbed so the routing can
   * be driven into every branch without standing up a full panel authority.
   */
  const spec = (overrides: Partial<PanelOperationSpec<{ id: string }>> = {}): PanelOperationSpec<{ id: string }> => ({
    dagId: "test-panel-operations",
    parseAuthority: (raw) =>
      typeof raw === "object" && raw !== null && "id" in raw
        ? { ok: true, value: raw as { id: string } }
        : { ok: false, message: "authority is not a panel authority" },
    rosterOf: () => ({}) as never,
    parsePayload: (() => ({ ok: true, value: {} })) as never,
    aggregate: () => ({ ok: true, value: { ranked: ["a", "b"] } }),
    ...overrides,
  });

  const runPanel = async (dag: ReturnType<typeof createPanelOperationDag>, input: unknown) =>
    runDag<unknown, PanelOutcome>(dag, input, context(dag.id));

  /** `defineDag` normalizes the node map into an ordered array, so nodes are
   *  located by their own `id` rather than by an object key. */
  const panelNode = (dag: ReturnType<typeof createPanelOperationDag>, id: string) => {
    const nodes = dag.nodes as unknown as readonly { readonly id: string }[];
    const node = nodes.find((candidate) => candidate.id === id);
    expect(node, `${id} must exist in the DAG`).toBeDefined();
    return node as unknown as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } };
      run: (input: unknown, ctx: unknown) => Promise<{ ok: boolean; value: PanelOutcome }>;
    };
  };

  /** Drive one node directly, so a branch reachable only from a proved roster
   *  can be exercised without standing up a complete panel roster. */
  const runNodeOf = async (
    dag: ReturnType<typeof createPanelOperationDag>,
    id: string,
    envelope: Record<string, unknown>,
  ): Promise<PanelOutcome> => {
    const result = await panelNode(dag, id).run(envelope, context(dag.id));
    expect(result.ok).toBe(true);
    return result.value;
  };

  it("rejects rather than aggregating when the authority does not parse", async () => {
    const dag = createPanelOperationDag(spec(), panelResolver);

    const result = await runPanel(dag, { authority: "nonsense", results: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: "rejected" });
  });

  it("rejects when the roster is not complete, so a partial panel cannot aggregate", async () => {
    const dag = createPanelOperationDag(spec(), panelResolver);

    const result = await runPanel(dag, { authority: { id: "panel-1" }, results: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: "rejected" });
    if (result.value.kind !== "rejected") return;
    expect(result.value.reason.length).toBeGreaterThan(0);
  });

  // The aggregate contract is `DomainResult`, so a success arm always carries
  // `value`. Under the old `Readonly<{ ok: boolean }> & Record<string, unknown>`
  // signature, `{ ok: true }` alone type-checked and published
  // `{ kind: "aggregated", value: undefined }` as a successful panel result.
  it("carries the aggregate's value onto the aggregated outcome", async () => {
    const dag = createPanelOperationDag(
      spec({ aggregate: () => ({ ok: true, value: { ranked: ["winner"] } }) }),
      panelResolver,
    );
    const outcome = await runNodeOf(dag, PANEL_DAG_NODE_IDS.aggregate, {
      [PANEL_DAG_NODE_IDS.proveRoster]: {
        kind: "proved",
        complete: { authority: { id: "panel-1" }, roster: {} },
        slotCount: 1,
      },
    });

    expect(outcome).toEqual({ kind: "aggregated", value: { ranked: ["winner"] } });
  });

  it("renders an aggregate refusal from its error channel", async () => {
    const dag = createPanelOperationDag(
      spec({ aggregate: () => ({ ok: false, error: { message: "tally is not unanimous" } }) }),
      panelResolver,
    );
    const outcome = await runNodeOf(dag, PANEL_DAG_NODE_IDS.aggregate, {
      [PANEL_DAG_NODE_IDS.proveRoster]: {
        kind: "proved",
        complete: { authority: { id: "panel-1" }, roster: {} },
        slotCount: 1,
      },
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "tally is not unanimous" });
  });

  // The envelope schemas validate their wrapped member with the real schema, so
  // the node refuses a malformed proof instead of reading `.kind` off whatever
  // arrived. Previously the member was `z.unknown().optional()` behind a cast.
  it("refuses an envelope whose roster proof is not a roster proof", async () => {
    const dag = createPanelOperationDag(spec(), panelResolver);

    const parsed = panelNode(dag, PANEL_DAG_NODE_IDS.aggregate).inputSchema.safeParse({
      [PANEL_DAG_NODE_IDS.proveRoster]: { kind: "not-a-proof" },
    });

    expect(parsed.success).toBe(false);
  });

  it("reaches aggregation only along the conditional proved edge", () => {
    const dag = createPanelOperationDag(spec(), panelResolver);
    const intoAggregate = dag.edges.filter((edge) => edge.to === PANEL_DAG_NODE_IDS.aggregate);

    expect(intoAggregate).toHaveLength(1);
    expect(intoAggregate[0]?.kind).toBe("conditional");
    expect(intoAggregate[0]?.from).toBe(PANEL_DAG_NODE_IDS.proveRoster);
  });

  it("builds both real panel graphs, so an unsound topology fails at construction", () => {
    const architecture = createArchitecturePanelDag({
      parseAuthority: () => ({ ok: false, message: "unused" }),
      parsePayload: (() => ({ ok: true, value: {} })) as never,
      resolver: panelResolver,
    });
    const refutation = createRefutationPanelDag({
      parseAuthority: () => ({ ok: false, message: "unused" }),
      parsePayload: (() => ({ ok: true, value: {} })) as never,
      resolver: panelResolver,
    });

    expect(architecture.id).toBe("architecture-panel-operations");
    expect(refutation.id).toBe("refutation-panel-operations");
    for (const dag of [architecture, refutation]) {
      for (const node of dag.nodes) expect(node.requires).toEqual([]);
    }
  });
});

// --- Standalone review routing ---------------------------------------------

describe("standalone review scope resolution", () => {
  const run = (input: ScopeInput) =>
    runDag<ScopeInput, ResolvedScope>(standaloneScopeDag, input, context(standaloneScopeDag.id));

  it("uses an explicit scope as given", async () => {
    const result = await run({ explicitScope: ["engine/src/b.ts", "engine/src/a.ts"], changedPaths: ["other.ts"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "resolved", origin: "explicit", paths: ["engine/src/a.ts", "engine/src/b.ts"] });
  });

  it("derives the canonical changed-path union when no scope was supplied", async () => {
    const result = await run({ explicitScope: null, changedPaths: ["b.ts", "a.ts", "b.ts"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "resolved", origin: "derived", paths: ["a.ts", "b.ts"] });
  });

  it("blocks an empty explicit scope rather than reviewing nothing", async () => {
    const result = await run({ explicitScope: [], changedPaths: ["a.ts"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: "blocked" });
  });

  it("blocks when there is no scope and nothing to derive one from", async () => {
    const result = await run({ explicitScope: null, changedPaths: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: "blocked" });
  });

  it.each([
    ["escaping", "../outside.ts"],
    ["absolute", "/etc/passwd"],
    ["empty", ""],
  ])("blocks an %s path in the explicit scope", async (_label, path) => {
    const result = await run({ explicitScope: ["engine/src/a.ts", path], changedPaths: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: "blocked" });
  });
});

describe("standalone review critical routing", () => {
  const run = (summary: AggregateSummary) =>
    runDag<AggregateSummary, CriticalRoute>(
      standaloneCriticalRouteDag,
      summary,
      context(standaloneCriticalRouteDag.id),
    );

  it("routes a critical-bearing aggregate to the refutation panel", async () => {
    const result = await run({ criticalCount: 2, advisoryCount: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "refutation-required", criticalCount: 2 });
  });

  it("skips the panel when there is nothing to adjudicate", async () => {
    const result = await run({ criticalCount: 0, advisoryCount: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "finalize", advisoryCount: 3 });
  });

  it("routes advisories alone to finalisation without convening a panel", async () => {
    const result = await run({ criticalCount: 0, advisoryCount: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("finalize");
  });

  describe("a reconciliation failure blocks rather than finalising", () => {
    // Every sibling join in these DAGs — the scope join here, `panel-operations`,
    // `remediation-operations` — fails closed when neither predecessor produced
    // a result. This one defaulted to a clean `finalize` with zero advisories,
    // which is indistinguishable from a genuinely clean review.
    // `defineDag` normalizes the node map into an ordered array, so nodes are
    // located by their own `id` rather than by an object key.
    const nodeById = (id: string) => {
      const nodes = standaloneCriticalRouteDag.nodes as unknown as readonly { readonly id: string }[];
      const node = nodes.find((candidate) => candidate.id === id);
      expect(node, `${id} must exist in the DAG`).toBeDefined();
      return node as unknown as {
        run: (input: unknown, ctx: unknown) => Promise<{ ok: boolean; value: CriticalRoute }>;
      };
    };

    const runNode = (id: string, envelope: Record<string, unknown>) =>
      nodeById(id).run(envelope, context(standaloneCriticalRouteDag.id));

    it("blocks when neither routing branch produced a result", async () => {
      const routed = await runNode("route-result", {});
      expect(routed.ok).toBe(true);
      expect(routed.value).toEqual({
        kind: "blocked",
        reason: "neither routing branch produced a result",
      });
    });

    it("passes a branch result through unchanged when one did produce a result", async () => {
      const finalized = await runNode("route-result", {
        "route-to-finalization": { kind: "finalize", advisoryCount: 4 },
      });
      expect(finalized.value).toEqual({ kind: "finalize", advisoryCount: 4 });

      const refuting = await runNode("route-result", {
        "route-to-refutation": { kind: "refutation-required", criticalCount: 1 },
      });
      expect(refuting.value).toEqual({ kind: "refutation-required", criticalCount: 1 });
    });

    it.each(["route-to-refutation", "route-to-finalization"])(
      "blocks when the %s branch fires without its aggregate summary",
      async (id) => {
        const routed = await runNode(id, {});
        expect(routed.ok).toBe(true);
        expect(routed.value.kind).toBe("blocked");
      },
    );

    it("still finalises a zero-critical summary, which is a routing decision and not a failure", async () => {
      const routed = await runNode("route-to-refutation", {
        "route-criticals": { criticalCount: 0, advisoryCount: 2 },
      });
      expect(routed.value).toEqual({ kind: "finalize", advisoryCount: 2 });
    });
  });
});

// --- Wave gate preparation fan-in -------------------------------------------

describe("wave gate preparation", () => {
  const part = (id: string, reason: string | null = null) => ({
    id,
    derive: (input: PreparationInput): DerivedPart => reason === null
      ? { kind: "derived", part: id, value: { wave: input.wave } }
      : { kind: "undeliverable", part: id, reason },
  });

  const allGood = createWavePreparationDag({
    readiness: part("readiness"),
    packets: part("packets"),
    models: part("models"),
    contexts: part("contexts"),
  });

  it("rejects wave zero at the DAG boundary", async () => {
    expect(parseWaveNumber(0)).toBeNull();
    expect(parseWaveNumber(-1)).toBeNull();
    expect(parseWaveNumber(1.5)).toBeNull();
    expect(parseWaveNumber(1)).toBe(1);

    const result = await runDag<PreparationInput, PreparedBatch>(
      allGood,
      { wave: 0, graph: {}, tasks: ["T2"] } as unknown as PreparationInput,
      context(allGood.id),
    );
    expect(result.ok).toBe(false);
  });

  it("joins every derived part before anything can be published", async () => {
    const result = await runDag<PreparationInput, PreparedBatch>(
      allGood,
      { wave: parseWaveNumber(2)!, graph: {}, tasks: ["T2", "T3"] },
      context(allGood.id),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("prepared");
    if (result.value.kind !== "prepared") return;
    expect(result.value.parts.map((entry) => entry.part)).toEqual(["readiness", "packets", "models", "contexts"]);
  });

  it("blocks the whole batch when any single part cannot be derived", async () => {
    const dag = createWavePreparationDag({
      readiness: part("readiness"),
      packets: part("packets", "task T3 has an empty review scope"),
      models: part("models"),
      contexts: part("contexts"),
    });

    const result = await runDag<PreparationInput, PreparedBatch>(
      dag,
      { wave: parseWaveNumber(2)!, graph: {}, tasks: ["T2", "T3"] },
      context(dag.id),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "blocked", reasons: ["task T3 has an empty review scope"] });
  });

  it("fans out four derivations from the request and fans them into one join", () => {
    const fromInput = allGood.edges.filter((edge) => edge.from === DAG_INPUT);
    const intoJoin = allGood.edges.filter((edge) => edge.to === WAVE_GATE_DAG_NODE_IDS.joinPreparation);

    expect(fromInput).toHaveLength(4);
    expect(intoJoin).toHaveLength(4);
    expect(intoJoin.every((edge) => edge.kind === "unconditional")).toBe(true);
  });
});

describe("wave gate advisory decision", () => {
  const triage = {
    wave: 2,
    advisories: [{ id: "F1", task: "T2", text: "prefer a narrower type" }],
  };

  it("refuses to run at all when no decision hook is supplied", async () => {
    const result = await runDag(waveAdvisoryDag, triage, context(waveAdvisoryDag.id));

    // The gate cannot be silently skipped: a run with nowhere to send the
    // decision fails up front rather than proceeding as if approved.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(errorText(result.error)).toContain("no `onHumanReview` hook supplied");
    expect(errorText(result.error)).toContain(WAVE_GATE_DAG_NODE_IDS.advisoryGate);
  });

  it("suspends rather than deciding when the operator has not answered yet", async () => {
    const result = await runDag(waveAdvisoryDag, triage, context(waveAdvisoryDag.id), {
      onHumanReview: async () => ({ kind: "pending" }),
    });

    // A synchronous runDag cannot pause: the suspend surfaces as an invariant
    // error naming the gate, which is exactly why the façade must drive this
    // DAG with runResumableDagJob and a durable job.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(errorText(result.error)).toContain("suspended at human gate");
    expect(errorText(result.error)).toContain(WAVE_GATE_DAG_NODE_IDS.advisoryGate);
  });

  it("applies the operator's decision when one is given", async () => {
    const result = await runDag(waveAdvisoryDag, triage, context(waveAdvisoryDag.id), {
      onHumanReview: async () => ({ kind: "approve", actor: "operator" }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "advisory-decision-accepted", wave: 2, advisoryCount: 1 });
  });

  it("honours an edited decision rather than the value that entered the gate", async () => {
    const result = await runDag(waveAdvisoryDag, triage, context(waveAdvisoryDag.id), {
      onHumanReview: async () => ({
        kind: "approve-with-edit",
        newOutput: { wave: 2, advisories: [] },
        actor: "operator",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: "advisory-decision-accepted", wave: 2, advisoryCount: 0 });
  });

  it("carries a human-review gate on the advisory node", () => {
    const gate = waveAdvisoryDag.nodes.find((node) => node.id === WAVE_GATE_DAG_NODE_IDS.advisoryGate);

    expect(gate?.humanReview?.prompt).toContain("Triage");
  });

  it("keeps the gate pure — a decision is not an effect the node performs", () => {
    for (const node of waveAdvisoryDag.nodes) {
      expect(node.requires).toEqual([]);
    }
  });
});

// --- Run id lowering --------------------------------------------------------

describe("lowering Loom run ids into Fugue's id space", () => {
  it("maps the separator Fugue rejects onto one it accepts", () => {
    const lowered = lowerRunId("run.RIzvYedN0m" as OrchestrationRunId);

    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.value).toBe("run:RIzvYedN0m");
  });

  it("stays injective by refusing a source id that already contains the target separator", () => {
    // Were ':' accepted in a Loom run id, this and "run.a.b" would both lower
    // to "run:a:b" and two distinct runs would share one Fugue identity.
    const colliding = lowerRunId("run.a:b" as OrchestrationRunId);

    expect(colliding.ok).toBe(false);
    if (colliding.ok) return;
    expect(colliding.error.message).toContain("cannot represent");
  });

  it("maps distinct run ids to distinct Fugue ids", () => {
    const ids = ["run.a.b", "run.a-b", "run.ab", "run.b.a"] as unknown as readonly OrchestrationRunId[];

    const lowered = ids.map((id) => {
      const result = lowerRunId(id);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });

    expect(new Set(lowered).size).toBe(ids.length);
  });

  it("rejects a run id carrying characters Fugue cannot represent", () => {
    const lowered = lowerRunId("run/../escape" as OrchestrationRunId);

    expect(lowered.ok).toBe(false);
    if (lowered.ok) return;
    expect(lowered.error.message).toContain("cannot represent");
  });

  it("rejects a dag id that is not a valid Fugue id", () => {
    const built = createOperationContext({ runId: RUN_ID, dagId: "not a valid id" });

    expect(built.ok).toBe(false);
  });
});

// --- Structural guarantees defineDag enforces -------------------------------

describe("defineDag soundness", () => {
  const passthrough = (id: string) =>
    createTransformNode<{ v: number }, { v: number }>({
      id,
      inputSchema: z.object({ v: z.number() }),
      outputSchema: z.object({ v: z.number() }),
      transform: (input) => ok(input),
    });

  it("rejects an edge pointing at a node the graph does not define", () => {
    expect(() => defineDag({
      id: "unsound-missing-node",
      nodes: { a: passthrough("a") },
      edges: [{ from: DAG_INPUT, to: "a" }, { from: "a", to: "ghost" as "a" }],
      outputNodeId: "a",
    })).toThrow(/unsound/);
  });

  it("rejects a conditional branch with no default edge to fall back on", () => {
    expect(() => defineDag({
      id: "unsound-no-default",
      nodes: { a: passthrough("a"), b: passthrough("b") },
      edges: [
        { from: DAG_INPUT, to: "a" },
        {
          from: "a",
          to: "b",
          when: { label: "sometimes", version: 1, check: (): boolean => true },
        },
      ],
      outputNodeId: "b",
    })).toThrow(/unsound/);
  });
});
