/**
 * Agent Catalog projections: every agent set, phase map, classification
 * predicate, transport answer and producer-kind table the harness gates and
 * validators consume, DERIVED from `AGENT_CATALOG` (`model-profiles.ts`) and
 * never a second source.
 *
 * These projections change for dispatch and emission reasons, while the
 * catalog changes for model-policy reasons, so they live in their own pure
 * module rather than widening the catalog's interface. They are not in config
 * either: config resolves the Task Graph through filesystem and Git probes at
 * import and runs load-time assertions, so a core module that needs an agent
 * set imports this leaf and never drags that initialization in. This module is
 * the only home of these names; config does not re-export them.
 *
 * The one load-time invariant whose violation would mis-scope a projection
 * here (panel-judge profile uniqueness, consumed by `producerKindsOfAgent`)
 * is enforced at import beside the projection that needs it.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { Phase } from "./phases";
import { frozenSet } from "./frozen";
import { AGENT_CATALOG, AGENT_POLICIES, type AgentKind, type AgentPolicy, type LoomAgentName } from "./model-profiles";

/** Does this catalog Agent require same-turn user interaction in Pi? */
export function agentRequiresInteractiveTransport(agent: LoomAgentName): boolean {
  return AGENT_CATALOG[agent].transport === "interactive-rpc";
}

/** Names of every catalog Agent with the given kind, in catalog order. */
export function agentsOfKind(k: AgentKind["kind"]): readonly LoomAgentName[] {
  return Object.freeze(
    AGENT_POLICIES.filter(({ kind }) => kind.kind === k).map(({ agent }) => agent),
  );
}

function catalogKind(agent: string): AgentKind["kind"] | null {
  return Object.prototype.hasOwnProperty.call(AGENT_CATALOG, agent)
    ? AGENT_CATALOG[agent as LoomAgentName].kind.kind
    : null;
}

/** Pure Agent Catalog projection preserving the harness's omitted-suffix alias. */
export function isImplementationAgent(agent: string): boolean {
  return catalogKind(agent) === "impl" || catalogKind(`${agent}-agent`) === "impl";
}

/** Pure control-plane projection for standalone review evidence producers. */
export function isStandaloneReviewAgent(agent: string): boolean {
  const kind = catalogKind(agent);
  return kind === "reviewer" || kind === "review-verifier";
}

/**
 * The producer-kind vocabulary for structured payload emission — the
 * CONTEXT.md **Payload Producer** term as data: which structured payload an
 * Agent emits.
 * The review-verifier Agent is genuinely dual-payload — reviewer-payload for
 * standalone/wave reviews, refutation-verdict for `/review-pr` panel verdicts
 * — so a kind-keyed-only scoping cannot express it, and the `arch-panel` kind
 * spans judges (`arch-judge-agent`) and non-judge designers, so only a
 * catalog-derived projection (kind + profile) scopes the judge-verdict kind
 * correctly.
 */
export type PayloadProducerKind =
  | Readonly<{ kind: "reviewer-payload" }>
  | Readonly<{ kind: "judge-verdict" }>
  | Readonly<{ kind: "refutation-verdict" }>;

export type PayloadProducerKindName = PayloadProducerKind["kind"];

const producerKind = (name: PayloadProducerKindName): PayloadProducerKind =>
  Object.freeze({ kind: name });

/**
 * Derived projection of AGENT_CATALOG — never a second source. Reviewer and
 * review-verifier Agents produce reviewer payloads (standalone/wave reviews);
 * the review-verifier Agent additionally produces refutation verdicts; the
 * panel judge (the unique `panel-judge` profile on `arch-judge-agent`)
 * produces judge verdicts. Every other Agent — including the non-judge
 * `arch-panel` designers and utility-kind reviewers — produces none.
 *
 * The judge-verdict scoping consumes the panel-judge profile's uniqueness as
 * data: profiles are shared across Agents generally ("implementation" alone
 * binds six), so uniqueness is a catalog-level fact, not a type invariant —
 * enforced at module load by `assertPanelJudgeProfileUnique` and pinned by the
 * agent-catalog and model-profiles suites, so a second panel-judge Agent
 * fails at import instead of mis-scoping the judge-verdict kind at this
 * condition.
 *
 * Total over the catalog and deterministically ordered: every Agent name
 * answers (non-producers answer an empty list), the dual-payload Agent
 * answers [reviewer-payload, refutation-verdict] in that order, and the
 * result is frozen — the US4 capability gate and the per-kind emission-tool
 * scoping read it as data, never as a caller convention.
 */
export function producerKindsOfAgent(agent: LoomAgentName): readonly PayloadProducerKind[] {
  const entry = AGENT_CATALOG[agent];
  const kinds: PayloadProducerKind[] = [];
  if (entry.kind.kind === "reviewer" || entry.kind.kind === "review-verifier") {
    kinds.push(producerKind("reviewer-payload"));
  }
  if (entry.kind.kind === "review-verifier") {
    kinds.push(producerKind("refutation-verdict"));
  }
  if (entry.kind.kind === "arch-panel" && entry.profile === "panel-judge") {
    kinds.push(producerKind("judge-verdict"));
  }
  return Object.freeze(kinds);
}

/** The panel-judge profile's catalog uniqueness as a live predicate — the
 *  judge-verdict scoping in `producerKindsOfAgent` consumes it as data, so a
 *  second panel-judge-profiled Agent would mis-scope that kind. Exported so a
 *  test can drive the throwing branch with a synthetic roster. */
export function panelJudgeProfileCarriers(
  policies: readonly AgentPolicy<LoomAgentName>[] = AGENT_POLICIES,
): readonly LoomAgentName[] {
  return Object.freeze(
    policies.filter(({ profile }) => profile === "panel-judge").map(({ agent }) => agent),
  );
}

/** Throw if more than one Agent carries the panel-judge profile — the
 *  judge-verdict scoping invariant, enforced at load like config's panel/phase
 *  disjointness, so an invalid catalog can never execute. */
export function assertPanelJudgeProfileUnique(
  policies: readonly AgentPolicy<LoomAgentName>[] = AGENT_POLICIES,
): void {
  const carriers = panelJudgeProfileCarriers(policies);
  if (carriers.length > 1) {
    throw new Error(
      `loom model-policy invariant violated: the panel-judge profile must bind exactly one Agent, ` +
        `but ${carriers.length} bind it: ${carriers.join(", ")}. A second panel-judge Agent would ` +
        `mis-scope the judge-verdict producer kind in producerKindsOfAgent.`,
    );
  }
}

// Fail at module load — not just in CI — if the catalog ever binds the
// panel-judge profile to more than one Agent. Module init runs once at the
// first import of this module, so an invalid catalog can never execute.
assertPanelJudgeProfileUnique();

/** Ordered Wave review roster policy — a selection FROM the catalog, not a
 *  second identity source. Ordering is load-bearing: wave-gate slot authority
 *  binds reviewers by index. Lives in this pure leaf so both config and the
 *  wave-gate machine can import it cycle-free. */
export const WAVE_REVIEW_AGENTS = Object.freeze([
  "code-reviewer",
  "silent-failure-hunter",
  "pr-test-analyzer",
  "type-design-analyzer",
  "comment-analyzer",
] as const satisfies readonly LoomAgentName[]);

export const LOOM_OWNED_AGENTS: readonly LoomAgentName[] = Object.freeze(
  AGENT_POLICIES.map(({ agent }) => agent),
);

// ---------------------------------------------------------------------------
// Catalog-derived agent sets and the phase map — what every harness gate and
// validator consumes. Shell and core consumers alike import them from here.
// ---------------------------------------------------------------------------

/** Phase agents → their phase. DERIVED from the Agent Catalog (kind `phase`).
 *  The catalog's AgentKind is a union, not a record with a `role` beside a
 *  `phase` both branches carry: panel agents have no per-agent phase to
 *  declare — they all run in ARCH_PANEL_PHASE by construction — so
 *  `{ kind: "arch-panel", phase: "decompose" }` is unrepresentable rather
 *  than policed by a load-time throw. Normal phase-agent completion is handed
 *  to the phase-transition observer, while panel-agent completion is intentionally
 *  ignored by advance-phase so the architecture phase cannot advance
 *  mid-panel. Exact-name phase/panel disjointness is structural (one catalog
 *  key, one kind); the runtime guard in config (assertPanelPhaseDisjoint,
 *  called at config load) remains for suffix-variant collisions, e.g. a phase
 *  agent `arch-designer` vs a panel `arch-designer-agent`, which are distinct
 *  keys no record can rule out. Frozen so post-load mutation that could
 *  smuggle a panel agent in here — and break the "only architecture-agent
 *  advances the phase" contract that advance-phase.ts relies on — is
 *  impossible at runtime. Typed `Readonly<Record<string, Phase | undefined>>`
 *  (not the mutable `Record`) so the freeze's read-only-ness survives into
 *  the type: `PHASE_AGENT_MAP[x] = ...` is a compile-time error too, not just
 *  a runtime throw. The string index signature is kept (unlike `as const`) so
 *  detectPhase's computed `PHASE_AGENT_MAP[agent]` lookups still type-check.
 *
 *  `Phase | undefined`, not `Phase`, because the lookup key is AGENT-CONTROLLED
 *  (`tool_input.subagent_type`) and most agents are not in this map. Declaring a
 *  total lookup made every consumer's existence guard look like defensive
 *  clutter the compiler said was unnecessary.
 *
 *  Null-prototype, because `Object.fromEntries` alone returns an object that
 *  inherits `Object.prototype`: `PHASE_AGENT_MAP["constructor"]` returned the
 *  `Object` constructor typed as a `Phase`, and `"toString" in phaseMap` was
 *  true — which config's `panelPhaseOverlap` tests with `in`. Every guard
 *  downstream failed closed or loud on the resulting value, but they were
 *  catching a hazard the data structure should never have offered. */
export const PHASE_AGENT_MAP: Readonly<Record<string, Phase | undefined>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, Phase>,
    Object.fromEntries(
      // `flatMap` rather than `filter().map()`: the kind union narrows inside
      // the callback that reads `phase`, so only the branch that HAS a phase can
      // contribute one. `filter` leaves the value widened, which is what made
      // the panel branch's absent `phase` a compile error rather than a proof.
      AGENT_POLICIES.flatMap(({ agent, kind }): [string, Phase][] =>
        kind.kind === "phase" ? [[agent, kind.phase]] : [],
      ),
    ),
  ),
);

/** Architecture-panel agents (`/loom --panel`): DERIVED from the Agent Catalog
 *  (kind `arch-panel`). Recognized by phase validation as architecture-phase
 *  work, but INVISIBLE to advance-phase — never in PHASE_AGENT_MAP so only
 *  architecture-agent's SubagentStop advances the phase. If a designer/judge were
 *  a phase agent, its completion would fire a phase transition and the date-prefix
 *  plan fallback could advance the phase mid-panel. The disjointness is structural
 *  for exact names (one key, one kind) AND enforced at config load
 *  (assertPanelPhaseDisjoint) for suffix-variant collisions — belt and
 *  suspenders. Built via frozenSet so runtime mutation is blocked, symmetric
 *  with the frozen PHASE_AGENT_MAP. */
export const ARCH_PANEL_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("arch-panel"));

/** Impl agents → all map to "execute" phase. DERIVED from the Agent Catalog
 *  (kind `impl`). Note: agent identifiers are intentionally `string` (no
 *  brand). Bun runs in transpile-only mode, so a TS brand would not enforce
 *  anything at runtime; the real boundary check lives in
 *  validate-task-graph.ts via KNOWN_AGENTS.has(agent). */
export const IMPL_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("impl"));

/** Known agents for task graph validation. */
export const KNOWN_AGENTS: ReadonlySet<string> = frozenSet([...IMPL_AGENTS, ...Object.keys(PHASE_AGENT_MAP)]);

/** Review sub-agents that produce findings per task. DERIVED from the Agent
 *  Catalog (kind `reviewer`) — membership only; the ordered wave roster is
 *  WAVE_REVIEW_AGENTS above (its index-binding order lives beside the
 *  identities it selects from). */
export const REVIEW_SUB_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("reviewer"));

/**
 * Is this agent type one whose output carries review findings?
 *
 * Lives HERE, beside the set it queries, rather than in core/review-output.
 * That module declares itself pure — "no I/O, no clock, no randomness" — and
 * importing config to answer a one-line membership question made the claim
 * false: config resolves TASK_GRAPH_PATH at import, which spawns
 * `git rev-parse --show-toplevel`, and drags in three throwing load-time
 * assertions besides. Agent-name classification is a harness concern, and
 * both callers already hold the agent type before they reach the parser.
 */
export function isReviewAgent(agentType: string): boolean {
  return REVIEW_SUB_AGENTS.has(agentType);
}

/** Finding-producing review agents plus the spec-check invoker. */
export const REVIEW_AGENTS: ReadonlySet<string> = frozenSet([
  ...REVIEW_SUB_AGENTS,
  ...agentsOfKind("spec-check"),
]);

/** Refutation-panel verifiers (wave gate Step 3.5): execute-phase work like
 *  every other reviewer, but deliberately NOT in REVIEW_SUB_AGENTS and NOT in
 *  REVIEW_AGENTS.
 *
 *  A verifier emits pure JSON that the `review-panel` helper validates; it has
 *  no findings of its own to store. In REVIEW_SUB_AGENTS its transcript would
 *  route through store-reviewer-findings, which would find no CRITICAL_COUNT
 *  and mark the task `evidence_capture_failed` — a passing wave blocked by the
 *  agent that was there to unblock it. Kept as its own set for the same reason
 *  ARCH_PANEL_AGENTS is: recognized by phase validation, invisible to the
 *  SubagentStop dispatcher. Frozen, symmetric with ARCH_PANEL_AGENTS. */
export const REVIEW_PANEL_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("review-verifier"));
