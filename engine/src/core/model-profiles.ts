/**
 * Loom-owned model policy.
 *
 * This module is a functional core: it contains only immutable policy data and
 * total functions over caller-supplied values. In particular, resolution never
 * consults the current harness model. An absent agent, profile, or binding is a
 * typed failure rather than an implicit instruction to inherit from the parent
 * session.
 *
 * The pure core owns declarations only. Effective Pi spawn bindings are
 * delegated to the machine's launcher routing policy (dotfiles
 * `pi/model-routing.json`), which may explicitly inherit a local parent's
 * model for every child. That override is a policy decision at the spawn
 * boundary — this module never infers one.
 *
 * Scope: the profile catalog and the bindings each profile has recorded, the
 * Agent Catalog record, catalog resolution, harness lowering, and frontmatter
 * validation. Projections DERIVED from the catalog (agent
 * sets, the phase map, classification predicates, producer kinds) live in
 * `agent-catalog-projections.ts`; parsing the Pi `subagent` tool input
 * lives in `pi-spawn-input.ts`. Each changes for its own reason.
 */

import type { Phase } from "./phases";

export const LLM_PROFILE_IDS = [
  "implementation",
  "architecture-finalize",
  "general-review",
  "focused-review",
  "panel-design",
  "panel-judge",
  "refutation",
  "mechanical",
  "spec-check-review",
] as const;

export type LlmProfileId = (typeof LLM_PROFILE_IDS)[number];

/**
 * Profile ids the catalog no longer issues. A stored request authority is
 * history ("issued under profile X"), so the ids it may carry outlive their
 * catalog entry: `qualified-local-review` was the local reviewer election,
 * retired when every Pi profile moved to the local route (2026-10-08).
 */
export const RETIRED_LLM_PROFILE_IDS = ["qualified-local-review"] as const;
export type RetiredLlmProfileId = (typeof RETIRED_LLM_PROFILE_IDS)[number];
/** Every profile id a stored request authority may record. */
export type RecordedLlmProfileId = LlmProfileId | RetiredLlmProfileId;

export type ClaudeCodeModel = "haiku" | "sonnet" | "opus";
export type Harness = "claude-code" | "pi";

/**
 * The one local vLLM deployment the catalog targets: the single owner of its
 * provider/served-model literal. Emission route qualification
 * (`issued-emission-capability.ts`) is separate policy that names this route rather than
 * re-spelling it, so a catalog rename cannot desynchronize the two.
 */
export const DESKTOP_VLLM_ROUTE = Object.freeze({
  provider: "desktop-vllm",
  model: "glm-5.3-flash-spark-tp2-v14",
} as const);

export type ClaudeCodeTarget = Readonly<{ model: ClaudeCodeModel }>;

/** The Pi target every catalog profile lowers to: Pi runs local models only. */
export type LocalPiTarget = Readonly<typeof DESKTOP_VLLM_ROUTE & { thinking: "high" }>;

/**
 * Cloud targets the catalog bound before 2026-10-08. They are never issued
 * again; they stay in the vocabulary only so a stored request authority
 * issued under one still parses as the history it is.
 */
export type RetiredPiTarget =
  | Readonly<{ provider: "openai-codex"; model: "gpt-5.6-sol" | "gpt-5.5"; thinking: "high" }>
  | Readonly<{ provider: "openai-codex"; model: "gpt-5.4-mini"; thinking: "medium" }>
  | Readonly<{ provider: "github-copilot"; model: "gpt-5.6-terra"; thinking: "high" }>;

/** Every Pi target a request authority may record: the catalog's, or a retired one. */
export type PiTarget = LocalPiTarget | RetiredPiTarget;
export type PiProvider = PiTarget["provider"];

export type LlmProfile = Readonly<{
  id: LlmProfileId;
  claudeCode: ClaudeCodeTarget;
  pi: LocalPiTarget;
}>;

export type ClaudeCodeBinding = Readonly<{
  harness: "claude-code";
  model: ClaudeCodeModel;
}>;

export type PiBinding = Readonly<{ harness: "pi" } & PiTarget>;

export type HarnessBinding = ClaudeCodeBinding | PiBinding;

/**
 * Why a model-policy parse refused. `malformed-spawn-input` is a boundary
 * shape failure of the Pi `subagent` tool input (not an object, no single
 * unambiguous mode, an item without a non-empty agent and task), distinct
 * from `unknown-agent`, a well-formed request naming an Agent Loom has no
 * policy for — so a caller branching on `kind` can tell the two apart.
 */
export type PolicyError = Readonly<{
  kind: "invalid-profile" | "unknown-agent" | "invalid-harness" | "invalid-frontmatter" | "malformed-spawn-input";
  message: string;
}>;

export type PolicyResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: PolicyError }>;

export type PolicyValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const success = <T>(value: T): PolicyResult<T> => Object.freeze({ ok: true, value });
const failure = <T>(error: PolicyError): PolicyResult<T> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

const valid = (): PolicyValidation => Object.freeze({ ok: true });
const invalid = (errors: readonly string[]): PolicyValidation =>
  Object.freeze({ ok: false, errors: Object.freeze([...errors]) });

const claudeTarget = (model: ClaudeCodeModel): ClaudeCodeTarget => Object.freeze({ model });
const LOCAL_PI_TARGET: LocalPiTarget = Object.freeze({ ...DESKTOP_VLLM_ROUTE, thinking: "high" });
const profile = (id: LlmProfileId, claudeCode: ClaudeCodeModel): LlmProfile => Object.freeze({
  id,
  claudeCode: claudeTarget(claudeCode),
  pi: LOCAL_PI_TARGET,
});

/** Each catalog profile's Claude Code model — total over `LlmProfileId` by construction. */
const CLAUDE_MODEL_BY_PROFILE = Object.freeze({
  "implementation": "opus",
  "architecture-finalize": "opus",
  "general-review": "sonnet",
  "focused-review": "sonnet",
  "panel-design": "opus",
  "panel-judge": "opus",
  "refutation": "opus",
  "mechanical": "haiku",
  "spec-check-review": "sonnet",
} satisfies Record<LlmProfileId, ClaudeCodeModel>);

/**
 * Exact targets per harness; none is an alias for a parent model. Claude
 * Code runs Claude models. Pi runs the one local route, so every profile
 * shares it and the profiles differ only in their Claude model. One entry per
 * id, in `LLM_PROFILE_IDS` order.
 */
export const LLM_PROFILES: readonly LlmProfile[] = Object.freeze(
  LLM_PROFILE_IDS.map((id) => profile(id, CLAUDE_MODEL_BY_PROFILE[id])),
);

/** Each Pi target the catalog has retired, named once; the history below refers to these. */
const RETIRED_GPT_5_6_SOL: RetiredPiTarget = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" });
const RETIRED_GPT_5_5: RetiredPiTarget = Object.freeze({ provider: "openai-codex", model: "gpt-5.5", thinking: "high" });
const RETIRED_GPT_5_4_MINI: RetiredPiTarget = Object.freeze({ provider: "openai-codex", model: "gpt-5.4-mini", thinking: "medium" });
const RETIRED_GPT_5_6_TERRA: RetiredPiTarget = Object.freeze({ provider: "github-copilot", model: "gpt-5.6-terra", thinking: "high" });

/**
 * The Pi targets each catalog profile lowered to BEFORE its current one,
 * newest first. Only history is written here: a profile's current binding is
 * its catalog lowering (`currentProfileBindings`), never a second copy, so
 * retargeting a profile cannot leave issuance and the catalog disagreeing.
 * Retargeting moves the outgoing target onto the front of its row. Reconstructed
 * from the catalog's Git history; a target absent from a row was never that
 * profile's binding.
 */
const RETIRED_PI_HISTORY: Readonly<Record<LlmProfileId, readonly RetiredPiTarget[]>> = Object.freeze({
  "implementation": Object.freeze([RETIRED_GPT_5_6_SOL]),
  "architecture-finalize": Object.freeze([RETIRED_GPT_5_6_SOL]),
  "general-review": Object.freeze([RETIRED_GPT_5_6_SOL]),
  "focused-review": Object.freeze([RETIRED_GPT_5_5]),
  "panel-design": Object.freeze([RETIRED_GPT_5_6_SOL]),
  "panel-judge": Object.freeze([RETIRED_GPT_5_6_SOL]),
  "refutation": Object.freeze([RETIRED_GPT_5_6_SOL]),
  "mechanical": Object.freeze([RETIRED_GPT_5_4_MINI]),
  "spec-check-review": Object.freeze([RETIRED_GPT_5_6_TERRA]),
});

/**
 * Profiles the catalog no longer carries, so there is no current lowering to
 * derive from: each row is wholly history — the Claude model and every Pi
 * target the profile issued, newest first. `qualified-local-review` issued
 * only the local route it was retired on.
 */
const RETIRED_PROFILE_BINDINGS: Readonly<Record<RetiredLlmProfileId, Readonly<{
  claudeCode: ClaudeCodeModel;
  pi: readonly [PiTarget, ...PiTarget[]];
}>>> = Object.freeze({
  "qualified-local-review": Object.freeze({ claudeCode: "sonnet", pi: Object.freeze([LOCAL_PI_TARGET] as const) }),
});

/** The exact bindings a request issued under one catalog profile carries today. */
export type CurrentProfileBindings = Readonly<{
  claude: ClaudeCodeBinding;
  pi: PiBinding;
}>;

/** The exact bindings a request issued under one recorded profile may carry. */
export type RecordedProfileBindings = Readonly<{
  claude: ClaudeCodeBinding;
  pi: readonly [PiBinding, ...PiBinding[]];
}>;

/** `LLM_PROFILES` keyed by id; total because `LLM_PROFILES` maps every `LLM_PROFILE_IDS` entry. */
const CATALOG_PROFILES: Readonly<Record<LlmProfileId, LlmProfile>> = Object.freeze(
  Object.fromEntries(LLM_PROFILES.map((entry) => [entry.id, entry])) as Record<LlmProfileId, LlmProfile>,
);

const lowerPiTarget = (target: PiTarget): PiBinding => Object.freeze({ harness: "pi", ...target });

/** The bindings `profileId` issues today: exactly its catalog lowering on both harnesses. */
export function currentProfileBindings(profileId: LlmProfileId): CurrentProfileBindings {
  const entry = CATALOG_PROFILES[profileId];
  return Object.freeze({ claude: lowerModelProfile(entry, "claude-code"), pi: lowerModelProfile(entry, "pi") });
}

/**
 * The Claude binding and every Pi binding `profileId` has issued, current
 * first. A catalog profile's current binding is its catalog lowering; only
 * what came before is recorded data.
 */
export function recordedProfileBindings(profileId: RecordedLlmProfileId): RecordedProfileBindings {
  if (includes(RETIRED_LLM_PROFILE_IDS, profileId)) {
    const row = RETIRED_PROFILE_BINDINGS[profileId];
    return Object.freeze({
      claude: Object.freeze({ harness: "claude-code", model: row.claudeCode }),
      pi: Object.freeze(row.pi.map(lowerPiTarget) as [PiBinding, ...PiBinding[]]),
    });
  }
  const current = currentProfileBindings(profileId);
  return Object.freeze({
    claude: current.claude,
    pi: Object.freeze([current.pi, ...RETIRED_PI_HISTORY[profileId].map(lowerPiTarget)] as const),
  });
}

/**
 * One Agent's dispatch classification — an ADT, so exactly one kind per Agent
 * is expressible. Kinds map one-to-one onto how the engine routes the Agent:
 * `phase` completion advances that phase; `arch-panel` and `review-verifier`
 * are invisible to phase advancement; `impl` executes Tasks; `reviewer`
 * transcripts route through the findings parser; `spec-check` produces the
 * Wave-level alignment verdict; `utility` is user-invoked outside orchestration.
 */
export type AgentKind =
  | Readonly<{ kind: "phase"; phase: Phase }>
  | Readonly<{ kind: "arch-panel" }>
  | Readonly<{ kind: "impl" }>
  | Readonly<{ kind: "reviewer" }>
  | Readonly<{ kind: "spec-check" }>
  | Readonly<{ kind: "review-verifier" }>
  | Readonly<{ kind: "utility" }>;

export type AgentPolicy<Agent extends string = string> = Readonly<{
  agent: Agent;
  profile: LlmProfileId;
  kind: AgentKind;
  requiredSkill: string | null;
}>;

type AgentTransport = "headless" | "interactive-rpc";

type AgentTraits = Readonly<{
  profile: LlmProfileId;
  kind: AgentKind;
  requiredSkill: string | null;
  transport: AgentTransport;
}>;

const phaseKind = (p: Phase): AgentKind => Object.freeze({ kind: "phase", phase: p });
const plainKind = (k: Exclude<AgentKind["kind"], "phase">): AgentKind => Object.freeze({ kind: k });
const traits = (
  selectedProfile: LlmProfileId,
  agentKind: AgentKind,
  requiredSkill: string | null = null,
  transport: AgentTransport = "headless",
): AgentTraits => Object.freeze({ profile: selectedProfile, kind: agentKind, requiredSkill, transport });

/**
 * The Agent Catalog (see CONTEXT.md): the single declarative registry defining
 * every Loom-owned Agent's identity — kind, model profile, and required Skill.
 * Keyed by name, so a duplicate or double-kinded Agent is unrepresentable.
 * Every agent set, phase map, and policy table elsewhere is a DERIVED
 * projection of this record (`agent-catalog-projections.ts`), never a second
 * source. Keep it exhaustive over
 * agents/*.md (excluding README.md); validateAgentPolicyCatalog is the pure
 * drift check a shell or test runs after discovering the actual filenames.
 */
export const AGENT_CATALOG = Object.freeze({
  "adr-writer-agent": traits("implementation", plainKind("impl")),
  "arch-designer-agent": traits("panel-design", plainKind("arch-panel"), "architecture-tech-lead"),
  "arch-interviewer-agent": traits("panel-design", plainKind("arch-panel"), null, "interactive-rpc"),
  "architecture-agent": traits("architecture-finalize", phaseKind("architecture"), "architecture-tech-lead", "interactive-rpc"),
  "architecture-tech-lead": traits("focused-review", plainKind("reviewer"), "deepen"),
  "arch-judge-agent": traits("panel-judge", plainKind("arch-panel")),
  "brainstorm-agent": traits("panel-design", phaseKind("brainstorm"), "brainstorming"),
  "clarify-agent": traits("panel-design", phaseKind("clarify"), "clarify", "interactive-rpc"),
  "code-implementer-agent": traits("implementation", plainKind("impl"), "code-implementer"),
  "code-reviewer": traits("general-review", plainKind("reviewer")),
  "code-simplifier": traits("focused-review", plainKind("reviewer"), "distill"),
  "comment-analyzer": traits("focused-review", plainKind("reviewer")),
  "decompose-agent": traits("focused-review", phaseKind("decompose")),
  "deepen-agent": traits("panel-design", plainKind("utility"), "deepen"),
  "frontend-agent": traits("implementation", plainKind("impl"), "nextjs-frontend-design"),
  "grill-agent": traits("panel-design", plainKind("utility"), "grill"),
  "java-test-agent": traits("implementation", plainKind("impl"), "java-test-engineer"),
  "plan-alignment-agent": traits("focused-review", phaseKind("plan-alignment")),
  "pr-test-analyzer": traits("focused-review", plainKind("reviewer")),
  "review-verifier-agent": traits("refutation", plainKind("review-verifier")),
  "security-agent": traits("focused-review", plainKind("impl"), "security-expert"),
  "silent-failure-hunter": traits("focused-review", plainKind("reviewer")),
  "skill-content-reviewer": traits("focused-review", plainKind("utility")),
  "spec-check-invoker": traits("spec-check-review", plainKind("spec-check"), "spec-check"),
  "specify-agent": traits("panel-design", phaseKind("specify"), "specify", "interactive-rpc"),
  "test-engineer": traits("implementation", plainKind("impl")),
  "ts-test-agent": traits("implementation", plainKind("impl"), "ts-test-engineer"),
  "type-design-analyzer": traits("focused-review", plainKind("reviewer")),
} satisfies Record<string, AgentTraits>);

export type LoomAgentName = keyof typeof AGENT_CATALOG;

/** The Agent that writes Architecture Decision Records for work that already
 *  shipped. Its Tasks trace to the plan's decisions rather than to a
 *  Requirement, and they form the plan's final Wave. */
export const DECISION_RECORD_AGENT = "adr-writer-agent" satisfies LoomAgentName;

/** Row view of the catalog, in catalog order. */
const CATALOG_ENTRIES = Object.entries(AGENT_CATALOG) as readonly [LoomAgentName, AgentTraits][];

export const AGENT_POLICIES: readonly AgentPolicy<LoomAgentName>[] = Object.freeze(
  CATALOG_ENTRIES.map(([agent, { profile, kind, requiredSkill }]) =>
    Object.freeze({ agent, profile, kind, requiredSkill }),
  ),
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const includes = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

/** Parse an untrusted semantic profile id without normalization or aliases. */
export function parseLlmProfileId(raw: unknown): PolicyResult<LlmProfileId> {
  return typeof raw === "string" && includes(LLM_PROFILE_IDS, raw)
    ? success(raw)
    : failure({
        kind: "invalid-profile",
        message: `model profile must be one of: ${LLM_PROFILE_IDS.join(", ")}; received ${JSON.stringify(raw)}`,
      });
}

/** Parse the profile id a stored request authority recorded: current or retired. */
export function parseRecordedLlmProfileId(raw: unknown): PolicyResult<RecordedLlmProfileId> {
  if (typeof raw === "string" && includes(RETIRED_LLM_PROFILE_IDS, raw)) return success(raw);
  return typeof raw === "string" && includes(LLM_PROFILE_IDS, raw)
    ? success(raw)
    : failure({
        kind: "invalid-profile",
        message: `recorded model profile must be one of: ${[...LLM_PROFILE_IDS, ...RETIRED_LLM_PROFILE_IDS].join(", ")}; received ${JSON.stringify(raw)}`,
      });
}

/** Parse a complete profile object and prove all exact harness fields. */
export function parseLlmProfile(raw: unknown): PolicyResult<LlmProfile> {
  if (!isRecord(raw)) {
    return failure({ kind: "invalid-profile", message: "model profile must be an object" });
  }

  const parsedId = parseLlmProfileId(raw.id);
  if (!parsedId.ok) return parsedId;
  const canonical = LLM_PROFILES.find(({ id }) => id === parsedId.value);
  if (canonical === undefined) {
    return failure({
      kind: "invalid-profile",
      message: `model profile '${parsedId.value}' has no catalog entry`,
    });
  }

  const claudeCode = raw.claudeCode;
  const pi = raw.pi;
  if (
    !isRecord(claudeCode) || claudeCode.model !== canonical.claudeCode.model ||
    !isRecord(pi) || pi.provider !== canonical.pi.provider ||
    pi.model !== canonical.pi.model || pi.thinking !== canonical.pi.thinking
  ) {
    return failure({
      kind: "invalid-profile",
      message: `model profile '${parsedId.value}' does not match its exact harness bindings`,
    });
  }
  return success(canonical);
}

/** Resolve an untrusted id against the catalog; there is deliberately no fallback parameter. */
export function resolveModelProfile(raw: unknown): PolicyResult<LlmProfile> {
  const parsed = parseLlmProfileId(raw);
  if (!parsed.ok) return parsed;
  const resolved = LLM_PROFILES.find(({ id }) => id === parsed.value);
  return resolved === undefined
    ? failure({ kind: "invalid-profile", message: `model profile '${parsed.value}' has no catalog entry` })
    : success(resolved);
}

/** Reserved harness namespace ownership is independent of catalog membership. */
export function isLoomNamespacedAgent(raw: unknown): raw is string {
  return typeof raw === "string" && raw.startsWith("loom:");
}

/** Parse a Loom agent name. The harness namespace is accepted, arbitrary namespaces are not. */
export function parseAgentName(raw: unknown): PolicyResult<LoomAgentName> {
  if (typeof raw !== "string") {
    return failure({ kind: "unknown-agent", message: `agent name must be a string; received ${JSON.stringify(raw)}` });
  }
  const bare = raw.startsWith("loom:") ? raw.slice("loom:".length) : raw;
  const policy = AGENT_POLICIES.find(({ agent }) => agent === bare);
  return policy === undefined
    ? failure({ kind: "unknown-agent", message: `no Loom model policy for agent '${raw}'` })
    : success(policy.agent);
}

/** Resolve an untrusted agent name to its explicit policy. */
export function resolveAgentPolicy(raw: unknown): PolicyResult<AgentPolicy<LoomAgentName>> {
  const parsed = parseAgentName(raw);
  if (!parsed.ok) return parsed;
  const resolved = AGENT_POLICIES.find(({ agent }) => agent === parsed.value);
  return resolved === undefined
    ? failure({ kind: "unknown-agent", message: `no Loom model policy for agent '${parsed.value}'` })
    : success(resolved);
}

/** Resolve both catalog links. A missing link fails; the caller's model is never consulted. */
export function resolveAgentProfile(raw: unknown): PolicyResult<LlmProfile> {
  const policy = resolveAgentPolicy(raw);
  return policy.ok ? resolveModelProfile(policy.value.profile) : policy;
}

export function parseHarness(raw: unknown): PolicyResult<Harness> {
  return raw === "claude-code" || raw === "pi"
    ? success(raw)
    : failure({
        kind: "invalid-harness",
        message: `harness must be 'claude-code' or 'pi'; received ${JSON.stringify(raw)}`,
      });
}

/** Lower a validated profile to a harness-specific binding with no inherited fields. */
export function lowerModelProfile(profileValue: LlmProfile, harness: "claude-code"): ClaudeCodeBinding;
export function lowerModelProfile(profileValue: LlmProfile, harness: "pi"): PiBinding;
export function lowerModelProfile(profileValue: LlmProfile, harness: Harness): HarnessBinding;
export function lowerModelProfile(profileValue: LlmProfile, harness: Harness): HarnessBinding {
  if (harness === "claude-code") return Object.freeze({ harness, model: profileValue.claudeCode.model });
  return Object.freeze({ harness, ...profileValue.pi });
}

export function piModelPattern(target: PiTarget | PiBinding): string {
  return `${target.provider}/${target.model}:${target.thinking}`;
}

export function expectedSpawnModel(agent: unknown, harness: Harness): PolicyResult<string> {
  const profile = resolveAgentProfile(agent);
  if (!profile.ok) return profile;
  const binding = lowerModelProfile(profile.value, harness);
  return success(binding.harness === "claude-code" ? binding.model : piModelPattern(binding));
}

/** A spawn is explicit only when its requested model exactly matches policy. */
export function validateExplicitSpawnModel(
  agent: unknown,
  harness: Harness,
  requestedModel: unknown,
): PolicyValidation {
  const expected = expectedSpawnModel(agent, harness);
  if (!expected.ok) return invalid([expected.error.message]);
  if (typeof requestedModel !== "string" || requestedModel.trim() === "") {
    return invalid([
      `agent '${String(agent)}' is missing an explicit ${harness} model; expected '${expected.value}' (parent-model inheritance is forbidden)`,
    ]);
  }
  return requestedModel === expected.value
    ? valid()
    : invalid([
        `agent '${String(agent)}' model mismatch: requested=${requestedModel}, expected=${expected.value}`,
      ]);
}

/** Parse agent + harness from unknown and return only an exact explicit binding. */
export function resolveHarnessBinding(agent: unknown, harness: unknown): PolicyResult<HarnessBinding> {
  const parsedHarness = parseHarness(harness);
  if (!parsedHarness.ok) return parsedHarness;
  const selectedProfile = resolveAgentProfile(agent);
  return selectedProfile.ok
    ? success(lowerModelProfile(selectedProfile.value, parsedHarness.value))
    : selectedProfile;
}

/**
 * Validate discovered policy data against required agents and profile ids.
 * The shell owns discovery; this function only compares immutable values.
 */
export function validateAgentPolicyCatalog(
  expectedAgents: readonly string[],
  policies: readonly AgentPolicy[] = AGENT_POLICIES,
  profiles: readonly LlmProfile[] = LLM_PROFILES,
): PolicyValidation {
  const profileIds = profiles.map(({ id }) => id);
  const policyAgents = policies.map(({ agent }) => agent);

  // One multiset reconciliation for both columns; only the message vocabulary
  // differs ("unknown" model profile vs "unexpected" agent policy).
  const reconcile = (
    expected: readonly string[],
    actual: readonly string[],
    label: string,
    extraWord: string,
  ): string[] => [
    ...expected.flatMap((id) => {
      const count = actual.filter((candidate) => candidate === id).length;
      return [
        ...(count === 0 ? [`missing ${label}: ${id}`] : []),
        ...(count > 1 ? [`duplicate ${label}: ${id}`] : []),
      ];
    }),
    ...actual.filter((id) => !expected.includes(id)).map((id) => `${extraWord} ${label}: ${id}`),
  ];

  const errors: string[] = [
    ...reconcile(LLM_PROFILE_IDS, profileIds, "model profile", "unknown"),
    ...reconcile(expectedAgents, policyAgents, "agent policy", "unexpected"),
  ];
  for (const policy of policies) {
    if (!profileIds.includes(policy.profile)) {
      errors.push(`agent policy '${policy.agent}' references missing model profile: ${policy.profile}`);
    }
  }

  return errors.length === 0 ? valid() : invalid(errors);
}

/**
 * The model-bearing frontmatter of one Agent, parsed into a SELF-CONSISTENT
 * value: `model` is always the Claude Code model of `modelProfile`. The two
 * fields name the same catalog entry from two directions, so a value where
 * they disagree describes no real Agent — `parseAgentFrontmatter` refuses it
 * rather than returning it for a later caller to notice.
 */
export type AgentFrontmatter = Readonly<{
  name: string;
  modelProfile: LlmProfileId;
  model: ClaudeCodeModel;
}>;

/**
 * Parse the model-bearing subset of YAML frontmatter after a shell decodes it.
 *
 * The internal `modelProfile` ⇄ `model` agreement is enforced HERE, not by the
 * caller: this is the only producer of `AgentFrontmatter`, so folding the
 * check in is what makes the type's invariant true by construction. It answers
 * a different question from `validateAgentPolicyFrontmatter`, which compares
 * the frontmatter against the policy assigned to that agent NAME — a document
 * can be internally coherent and still name the wrong profile for its agent.
 */
export function parseAgentFrontmatter(raw: unknown): PolicyResult<AgentFrontmatter> {
  if (!isRecord(raw)) {
    return failure({ kind: "invalid-frontmatter", message: "agent frontmatter must be an object" });
  }
  if (typeof raw.name !== "string") {
    return failure({ kind: "invalid-frontmatter", message: "agent frontmatter.name must be a string" });
  }
  const selectedProfile = parseLlmProfileId(raw["model-profile"]);
  if (!selectedProfile.ok) {
    return failure({
      kind: "invalid-frontmatter",
      message: `agent '${raw.name}' has invalid model-profile: ${selectedProfile.error.message}`,
    });
  }
  if (raw.model !== "haiku" && raw.model !== "sonnet" && raw.model !== "opus") {
    return failure({
      kind: "invalid-frontmatter",
      message: `agent '${raw.name}' model must be haiku, sonnet, or opus`,
    });
  }
  const profile = resolveModelProfile(selectedProfile.value);
  if (!profile.ok) return profile;
  if (raw.model !== profile.value.claudeCode.model) {
    return failure({
      kind: "invalid-frontmatter",
      message:
        `agent '${raw.name}' frontmatter is self-contradictory: model-profile ` +
        `'${selectedProfile.value}' binds Claude model '${profile.value.claudeCode.model}', not '${raw.model}'`,
    });
  }
  return success(Object.freeze({
    name: raw.name,
    modelProfile: selectedProfile.value,
    model: raw.model,
  }));
}

/** Fail closed when frontmatter disagrees with either link in the policy catalog. */
export function validateAgentPolicyFrontmatter(raw: unknown): PolicyValidation {
  const parsed = parseAgentFrontmatter(raw);
  if (!parsed.ok) return invalid([parsed.error.message]);

  const policy = resolveAgentPolicy(parsed.value.name);
  if (!policy.ok) return invalid([policy.error.message]);
  const selectedProfile = resolveModelProfile(policy.value.profile);
  if (!selectedProfile.ok) return invalid([selectedProfile.error.message]);

  const errors: string[] = [];
  if (parsed.value.modelProfile !== policy.value.profile) {
    errors.push(
      `agent '${parsed.value.name}' model-profile mismatch: frontmatter=${parsed.value.modelProfile}, policy=${policy.value.profile}`,
    );
  }
  if (parsed.value.model !== selectedProfile.value.claudeCode.model) {
    errors.push(
      `agent '${parsed.value.name}' Claude model mismatch: frontmatter=${parsed.value.model}, policy=${selectedProfile.value.claudeCode.model}`,
    );
  }
  return errors.length === 0 ? valid() : invalid(errors);
}
