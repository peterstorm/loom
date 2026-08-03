/**
 * Loom-owned model policy.
 *
 * This module is a functional core: it contains only immutable policy data and
 * total functions over caller-supplied values. In particular, resolution never
 * consults the current harness model. An absent agent, profile, or binding is a
 * typed failure rather than an instruction to inherit from the parent session.
 */

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

/** Singular alias for callers that use the domain term "catalog". */
export const MODEL_PROFILE_CATALOG = LLM_PROFILES;

export type AgentPolicy<Agent extends string = string> = Readonly<{
  agent: Agent;
  profile: LlmProfileId;
}>;

const agentPolicy = <Agent extends string>(
  agent: Agent,
  selectedProfile: LlmProfileId,
): AgentPolicy<Agent> => Object.freeze({ agent, profile: selectedProfile });

/**
 * Every Markdown agent definition owned by Loom, excluding agents/README.md.
 * Keep this catalog exhaustive; validateAgentPolicyCatalog is the pure drift
 * check used by a shell or test after it discovers the actual filenames.
 */
export const AGENT_POLICIES: readonly AgentPolicy[] = Object.freeze([
  agentPolicy("adr-writer-agent", "implementation"),
  agentPolicy("arch-designer-agent", "panel-design"),
  agentPolicy("arch-interviewer-agent", "panel-design"),
  agentPolicy("architecture-agent", "architecture-finalize"),
  agentPolicy("architecture-tech-lead", "focused-review"),
  agentPolicy("arch-judge-agent", "panel-judge"),
  agentPolicy("brainstorm-agent", "panel-design"),
  agentPolicy("clarify-agent", "panel-design"),
  agentPolicy("code-implementer-agent", "implementation"),
  agentPolicy("code-reviewer", "general-review"),
  agentPolicy("code-simplifier", "focused-review"),
  agentPolicy("comment-analyzer", "mechanical"),
  agentPolicy("decompose-agent", "focused-review"),
  agentPolicy("deepen-agent", "panel-design"),
  agentPolicy("frontend-agent", "implementation"),
  agentPolicy("grill-agent", "panel-design"),
  agentPolicy("java-test-agent", "implementation"),
  agentPolicy("plan-alignment-agent", "focused-review"),
  agentPolicy("pr-test-analyzer", "focused-review"),
  agentPolicy("review-verifier-agent", "refutation"),
  agentPolicy("security-agent", "focused-review"),
  agentPolicy("silent-failure-hunter", "focused-review"),
  agentPolicy("skill-content-reviewer", "focused-review"),
  agentPolicy("spec-check-invoker", "general-review"),
  agentPolicy("specify-agent", "panel-design"),
  agentPolicy("test-engineer", "implementation"),
  agentPolicy("ts-test-agent", "implementation"),
  agentPolicy("type-design-analyzer", "focused-review"),
]);

export type LoomAgentName = (typeof AGENT_POLICIES)[number]["agent"];

export const AGENT_POLICY_CATALOG = AGENT_POLICIES;
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
export function resolveAgentPolicy(raw: unknown): PolicyResult<AgentPolicy> {
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
  const errors: string[] = [];
  const profileIds = profiles.map(({ id }) => id);
  const policyAgents = policies.map(({ agent }) => agent);

  for (const id of LLM_PROFILE_IDS) {
    const count = profileIds.filter((candidate) => candidate === id).length;
    if (count === 0) errors.push(`missing model profile: ${id}`);
    if (count > 1) errors.push(`duplicate model profile: ${id}`);
  }
  for (const id of profileIds) {
    if (!includes(LLM_PROFILE_IDS, id)) errors.push(`unknown model profile: ${id}`);
  }

  for (const agent of expectedAgents) {
    const count = policyAgents.filter((candidate) => candidate === agent).length;
    if (count === 0) errors.push(`missing agent policy: ${agent}`);
    if (count > 1) errors.push(`duplicate agent policy: ${agent}`);
  }
  for (const agent of policyAgents) {
    if (!expectedAgents.includes(agent)) errors.push(`unexpected agent policy: ${agent}`);
  }
  for (const policy of policies) {
    if (!profileIds.includes(policy.profile)) {
      errors.push(`agent policy '${policy.agent}' references missing model profile: ${policy.profile}`);
    }
  }

  return errors.length === 0 ? valid() : invalid(errors);
}

export type PiSpawnItem = Readonly<{ agent: LoomAgentName; task: string }>;

/** Parse all Pi subagent modes before any spawn guard runs. */
export function parsePiSpawnItems(raw: unknown): PolicyResult<readonly PiSpawnItem[]> {
  if (!isRecord(raw)) {
    return failure({ kind: "unknown-agent", message: "Pi subagent input must be an object" });
  }
  const single = typeof raw.agent === "string" || typeof raw.task === "string";
  const parallel = Array.isArray(raw.tasks) && raw.tasks.length > 0;
  const chain = Array.isArray(raw.chain) && raw.chain.length > 0;
  if (Number(single) + Number(parallel) + Number(chain) !== 1) {
    return failure({
      kind: "unknown-agent",
      message: "Pi subagent input must provide exactly one non-empty single, parallel, or chain mode",
    });
  }
  const entries: unknown[] = single ? [raw] : parallel ? raw.tasks as unknown[] : raw.chain as unknown[];
  const items: PiSpawnItem[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!isRecord(entry) || typeof entry.task !== "string" || entry.task.trim() === "") {
      return failure({
        kind: "unknown-agent",
        message: `Pi subagent item ${index + 1} must contain a non-empty task`,
      });
    }
    const agent = parseAgentName(entry.agent);
    if (!agent.ok) return agent;
    items.push(Object.freeze({ agent: agent.value, task: entry.task }));
  }
  return success(Object.freeze(items));
}

export type AgentFrontmatter = Readonly<{
  name: string;
  modelProfile: LlmProfileId;
  model: ClaudeCodeModel;
}>;

/** Parse the model-bearing subset of YAML frontmatter after a shell decodes it. */
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
