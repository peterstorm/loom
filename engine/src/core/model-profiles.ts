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
] as const;

export type LlmProfileId = (typeof LLM_PROFILE_IDS)[number];
export type ClaudeCodeModel = "haiku" | "sonnet" | "opus";
export type PiProvider = "openai-codex";
export type PiOpenAiModel = "gpt-5.6-sol" | "gpt-5.5" | "gpt-5.4-mini";
export type PiThinkingLevel = "medium" | "high";
export type Harness = "claude-code" | "pi";

export type ClaudeCodeTarget = Readonly<{ model: ClaudeCodeModel }>;
export type PiTarget = Readonly<{
  provider: PiProvider;
  model: PiOpenAiModel;
  thinking: PiThinkingLevel;
}>;

export type LlmProfile = Readonly<{
  id: LlmProfileId;
  claudeCode: ClaudeCodeTarget;
  pi: PiTarget;
}>;

export type ClaudeCodeBinding = Readonly<{
  harness: "claude-code";
  model: ClaudeCodeModel;
}>;

export type PiBinding = Readonly<{
  harness: "pi";
  provider: PiProvider;
  model: PiOpenAiModel;
  thinking: PiThinkingLevel;
}>;

export type HarnessBinding = ClaudeCodeBinding | PiBinding;

export type PolicyError = Readonly<{
  kind: "invalid-profile" | "unknown-agent" | "invalid-harness" | "invalid-frontmatter";
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
const piTarget = (
  model: PiOpenAiModel,
  thinking: PiThinkingLevel,
): PiTarget => Object.freeze({ provider: "openai-codex", model, thinking });
const profile = (
  id: LlmProfileId,
  claudeCode: ClaudeCodeModel,
  piModel: PiOpenAiModel,
  thinking: PiThinkingLevel,
): LlmProfile => Object.freeze({
  id,
  claudeCode: claudeTarget(claudeCode),
  pi: piTarget(piModel, thinking),
});

/** Exact, calibrated-by-policy targets. None is an alias for a parent model. */
export const LLM_PROFILES: readonly LlmProfile[] = Object.freeze([
  profile("implementation", "opus", "gpt-5.6-sol", "high"),
  profile("architecture-finalize", "opus", "gpt-5.6-sol", "high"),
  profile("general-review", "sonnet", "gpt-5.6-sol", "high"),
  profile("focused-review", "sonnet", "gpt-5.5", "high"),
  profile("panel-design", "opus", "gpt-5.6-sol", "high"),
  profile("panel-judge", "opus", "gpt-5.6-sol", "high"),
  profile("refutation", "opus", "gpt-5.6-sol", "high"),
  profile("mechanical", "haiku", "gpt-5.4-mini", "medium"),
]);

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

type AgentTraits = Readonly<{
  profile: LlmProfileId;
  kind: AgentKind;
  requiredSkill: string | null;
}>;

const phaseKind = (p: Phase): AgentKind => Object.freeze({ kind: "phase", phase: p });
const plainKind = (k: Exclude<AgentKind["kind"], "phase">): AgentKind => Object.freeze({ kind: k });
const traits = (
  selectedProfile: LlmProfileId,
  agentKind: AgentKind,
  requiredSkill: string | null = null,
): AgentTraits => Object.freeze({ profile: selectedProfile, kind: agentKind, requiredSkill });

/**
 * The Agent Catalog (see CONTEXT.md): the single declarative registry defining
 * every Loom-owned Agent's identity — kind, model profile, and required Skill.
 * Keyed by name, so a duplicate or double-kinded Agent is unrepresentable.
 * Every agent set, phase map, and policy table elsewhere is a DERIVED
 * projection of this record, never a second source. Keep it exhaustive over
 * agents/*.md (excluding README.md); validateAgentPolicyCatalog is the pure
 * drift check a shell or test runs after discovering the actual filenames.
 */
export const AGENT_CATALOG = Object.freeze({
  "adr-writer-agent": traits("implementation", plainKind("impl")),
  "arch-designer-agent": traits("panel-design", plainKind("arch-panel"), "architecture-tech-lead"),
  "arch-interviewer-agent": traits("panel-design", plainKind("arch-panel")),
  "architecture-agent": traits("architecture-finalize", phaseKind("architecture"), "architecture-tech-lead"),
  "architecture-tech-lead": traits("focused-review", plainKind("reviewer"), "deepen"),
  "arch-judge-agent": traits("panel-judge", plainKind("arch-panel")),
  "brainstorm-agent": traits("panel-design", phaseKind("brainstorm"), "brainstorming"),
  "clarify-agent": traits("panel-design", phaseKind("clarify"), "clarify"),
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
  "spec-check-invoker": traits("general-review", plainKind("spec-check"), "spec-check"),
  "specify-agent": traits("panel-design", phaseKind("specify"), "specify"),
  "test-engineer": traits("implementation", plainKind("impl")),
  "ts-test-agent": traits("implementation", plainKind("impl"), "ts-test-engineer"),
  "type-design-analyzer": traits("focused-review", plainKind("reviewer")),
} satisfies Record<string, AgentTraits>);

export type LoomAgentName = keyof typeof AGENT_CATALOG;

/** Row view of the catalog, in catalog order. */
export const AGENT_POLICIES: readonly AgentPolicy<LoomAgentName>[] = Object.freeze(
  (Object.entries(AGENT_CATALOG) as readonly [LoomAgentName, AgentTraits][]).map(
    ([agent, agentTraits]) => Object.freeze({ agent, ...agentTraits }),
  ),
);

/** Names of every catalog Agent with the given kind, in catalog order. */
export function agentsOfKind(k: AgentKind["kind"]): readonly LoomAgentName[] {
  return Object.freeze(
    AGENT_POLICIES.filter(({ kind }) => kind.kind === k).map(({ agent }) => agent),
  );
}

/** Ordered Wave review roster policy — a selection FROM the catalog, not a
 *  second identity source. Ordering is load-bearing: wave-gate slot authority
 *  binds reviewers by index. Lives beside the catalog (this module is a pure
 *  leaf) so both config and the wave-gate machine can import it cycle-free. */
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
  return harness === "claude-code"
    ? Object.freeze({ harness, model: profileValue.claudeCode.model })
    : Object.freeze({
        harness,
        provider: profileValue.pi.provider,
        model: profileValue.pi.model,
        thinking: profileValue.pi.thinking,
      });
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

export type PiSpawnItem = Readonly<{ agent: LoomAgentName; task: string }>;
export type ExternalPiSpawnItem = Readonly<{ agent: string; task: string }>;
export type ClassifiedPiSpawnBatch =
  | Readonly<{ kind: "loom-owned"; items: readonly PiSpawnItem[] }>
  | Readonly<{ kind: "external"; items: readonly ExternalPiSpawnItem[] }>;

type PiSpawnInputMode =
  | Readonly<{ kind: "single"; entries: readonly unknown[] }>
  | Readonly<{ kind: "parallel"; entries: readonly unknown[] }>
  | Readonly<{ kind: "chain"; entries: readonly unknown[] }>;

function parseRawPiSpawnItems(raw: unknown): PolicyResult<readonly ExternalPiSpawnItem[]> {
  if (!isRecord(raw)) {
    return failure({ kind: "unknown-agent", message: "Pi subagent input must be an object" });
  }
  const modes: PiSpawnInputMode[] = [];
  if (typeof raw.agent === "string" || typeof raw.task === "string") {
    modes.push(Object.freeze({ kind: "single", entries: Object.freeze([raw]) }));
  }
  if (Array.isArray(raw.tasks) && raw.tasks.length > 0) {
    modes.push(Object.freeze({ kind: "parallel", entries: Object.freeze([...raw.tasks]) }));
  }
  if (Array.isArray(raw.chain) && raw.chain.length > 0) {
    modes.push(Object.freeze({ kind: "chain", entries: Object.freeze([...raw.chain]) }));
  }
  if (modes.length !== 1) {
    return failure({
      kind: "unknown-agent",
      message: "Pi subagent input must provide exactly one non-empty single, parallel, or chain mode",
    });
  }
  const entries = modes[0]!.entries;
  const items: ExternalPiSpawnItem[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (
      !isRecord(entry) || typeof entry.agent !== "string" || entry.agent.trim() === "" ||
      typeof entry.task !== "string" || entry.task.trim() === ""
    ) {
      return failure({
        kind: "unknown-agent",
        message: `Pi subagent item ${index + 1} must contain a non-empty agent and task`,
      });
    }
    items.push(Object.freeze({ agent: entry.agent, task: entry.task }));
  }
  return success(Object.freeze(items));
}

/**
 * Classify a structurally valid Pi batch before Loom applies its own policy.
 * Mixed ownership is rejected: passing only the external siblings through
 * would let one malformed/unknown item bypass an otherwise Loom-owned batch.
 */
export function classifyPiSpawnItems(raw: unknown): PolicyResult<ClassifiedPiSpawnBatch> {
  const parsed = parseRawPiSpawnItems(raw);
  if (!parsed.ok) return parsed;
  const resolved = parsed.value.map((item) => parseAgentName(item.agent));
  const unknownOwned = parsed.value.find((item, index) =>
    !resolved[index]!.ok && isLoomNamespacedAgent(item.agent)
  );
  if (unknownOwned !== undefined) {
    return failure({
      kind: "unknown-agent",
      message: `no Loom model policy for agent '${unknownOwned.agent}'`,
    });
  }
  const knownCount = resolved.filter((agent) => agent.ok).length;
  if (knownCount === 0) return success(Object.freeze({ kind: "external", items: parsed.value }));
  if (knownCount !== parsed.value.length) {
    return failure({
      kind: "unknown-agent",
      message: "Pi subagent batches must not mix Loom-owned and external agents",
    });
  }
  const items = parsed.value.map((item, index) => {
    const agent = resolved[index]!;
    if (!agent.ok) throw new Error("Pi spawn classification invariant: known batch contains an unknown agent");
    return Object.freeze({ agent: agent.value, task: item.task });
  });
  return success(Object.freeze({ kind: "loom-owned", items: Object.freeze(items) }));
}

/** Parse an all-Loom Pi batch for callers that require Loom ownership. */
export function parsePiSpawnItems(raw: unknown): PolicyResult<readonly PiSpawnItem[]> {
  const classified = classifyPiSpawnItems(raw);
  if (!classified.ok) return classified;
  if (classified.value.kind === "external") {
    return failure({
      kind: "unknown-agent",
      message: `no Loom model policy for agent '${classified.value.items[0]?.agent ?? "<empty>"}'`,
    });
  }
  return success(classified.value.items);
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
