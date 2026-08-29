/**
 * Loom-owned Pi spawn model-routing policy.
 *
 * Functional core: immutable policy data and total functions over
 * caller-supplied values. This module performs no I/O and reads no
 * environment. The imperative shell — the agent renderer and the spawn
 * gate — loads `model-routing.json` and observes the parent session's model
 * ref, then calls {@link resolveEffectivePiBinding} to obtain the binding a
 * child actually runs on.
 *
 * This is the spawn-boundary override the model-profile core deliberately
 * defers to the launcher: `model-profiles.ts` owns the *declared* (pinned)
 * binding for every agent; this module decides, from an explicit config and
 * the observed parent model, whether a child inherits the parent's model
 * instead. Inheritance is never implicit: an absent config, an absent parent
 * ref, or a parent that classifies as anything other than the rule's class
 * all resolve to the declared binding.
 */

import type { PiBinding } from "./model-profiles";

/** A parsed `provider/model` reference, as a value object (not a raw string). */
export type ModelRef = Readonly<{ provider: string; model: string }>;

/** An open class label defined by the config (e.g. "local", "cloud"). */
export type ModelClass = string;

/**
 * What a matching routing rule directs the child to use.
 * - `parent`: inherit the parent session's provider/model/thinking.
 * - `declared`: explicitly keep the agent's declared (pinned) binding.
 * - `named`: use one exact target declared in the routing config.
 */
export type RoutingRuleUse =
  | Readonly<{ kind: "parent" }>
  | Readonly<{ kind: "declared" }>
  | Readonly<{ kind: "named"; target: string }>;

export type RoutingRuleSelector = Readonly<{
  parentClass: ModelClass;
  parentModel?: string;
  workload?: string;
  profile?: string;
  agent?: string;
}>;

export type RoutingRule = Readonly<{
  id: string;
  when: RoutingRuleSelector;
  use: RoutingRuleUse;
}>;

export type RoutingWorkload = Readonly<{
  workload?: string;
  profile?: string;
  agent?: string;
}>;

export type RoutedPiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type NamedPiTarget = Readonly<{
  provider: string;
  model: string;
  thinking: RoutedPiThinkingLevel;
}>;

export type ModelRoutingConfig = Readonly<{
  schemaVersion: 1;
  defaultClass: ModelClass;
  /** Class → glob patterns over `provider/model`. A ref matching any pattern
   *  takes that class; otherwise it is `defaultClass`. */
  modelClasses: Readonly<Record<ModelClass, readonly string[]>>;
  targets: Readonly<Record<string, NamedPiTarget>>;
  /** Evaluated in order; the first rule whose `when` matches decides the use. */
  rules: readonly RoutingRule[];
}>;

/**
 * The binding a child actually spawns with. Wider than `PiBinding`: when a
 * rule inherits the parent, provider/model/thinking are the active parent's,
 * not one of the pinned Codex bindings. Ref-only legacy callers retain the
 * declared thinking level because they have no parent thinking value.
 */
const isRoutedPiThinkingLevel = (value: unknown): value is RoutedPiThinkingLevel =>
  value === "off" || value === "minimal" || value === "low" || value === "medium" ||
  value === "high" || value === "xhigh" || value === "max";

export type EffectivePiBinding = Readonly<{
  provider: string;
  model: string;
  thinking: RoutedPiThinkingLevel;
}>;

export type RoutingPolicyError = Readonly<{
  kind: "invalid-model-ref" | "invalid-routing-config";
  message: string;
}>;

export type RoutingPolicyResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: RoutingPolicyError }>;

const ok = <T>(value: T): RoutingPolicyResult<T> => Object.freeze({ ok: true, value });
const err = (error: RoutingPolicyError): RoutingPolicyResult<never> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hasNoWhitespace = (value: string): boolean => !/\s/.test(value);

const unknownFields = (record: Readonly<Record<string, unknown>>, allowed: readonly string[]): readonly string[] => {
  const known = new Set(allowed);
  return Object.keys(record).filter((key) => !known.has(key));
};

/**
 * Parse an untrusted `provider/model` reference into a value object. Requires
 * exactly one `/`, non-empty parts, and no whitespace. A ref that does not
 * parse is a typed failure, never a raw string leaking downstream.
 */
export function parseModelRef(raw: unknown): RoutingPolicyResult<ModelRef> {
  if (typeof raw !== "string") {
    return err({
      kind: "invalid-model-ref",
      message: `model ref must be a string; received ${JSON.stringify(raw)}`,
    });
  }
  if (!hasNoWhitespace(raw) || raw.includes("*")) {
    return err({ kind: "invalid-model-ref", message: `model ref must be exact and contain no whitespace or wildcard: ${JSON.stringify(raw)}` });
  }
  const parts = raw.split("/");
  if (parts.length !== 2 || parts[0].trim() === "" || parts[1].trim() === "") {
    return err({
      kind: "invalid-model-ref",
      message: `model ref must be exactly 'provider/model' with non-empty parts; received ${JSON.stringify(raw)}`,
    });
  }
  return ok(Object.freeze({ provider: parts[0], model: parts[1] }));
}

/** One glob segment: a lone `*` matches any ref segment; otherwise exact. */
function segmentMatches(patternSegment: string, refSegment: string): boolean {
  return patternSegment === "*" || patternSegment === refSegment;
}

/** A `provider/model` glob matches a ref when both segments match. */
function globMatches(pattern: string, ref: ModelRef): boolean {
  const segments = pattern.split("/");
  if (segments.length !== 2) return false;
  return segmentMatches(segments[0], ref.provider) && segmentMatches(segments[1], ref.model);
}

const modelPatternsOverlap = (left: string, right: string): boolean => {
  const [leftProvider, leftModel] = left.split("/");
  const [rightProvider, rightModel] = right.split("/");
  return (leftProvider === "*" || rightProvider === "*" || leftProvider === rightProvider) &&
    (leftModel === "*" || rightModel === "*" || leftModel === rightModel);
};

/**
 * Why a pattern can NEVER match any model ref, or `null` when it can.
 *
 * A ref is exactly two non-empty, whitespace-free segments (parseModelRef
 * rejects anything else), and a pattern segment is either `*` or an exact
 * match — so a pattern that is not itself exactly two non-empty,
 * whitespace-free segments is dead: it silently classifies every intended
 * ref as `defaultClass`, which for a typo'd local class is exactly the
 * "local children inherit the local parent" policy failing with no error
 * anywhere. Rejecting it at parse time makes the typo loud.
 */
export function unmatchablePatternReason(pattern: string): string | null {
  const segments = pattern.split("/");
  if (segments.length !== 2) {
    return `pattern must be exactly 'provider/model' (two '/'-separated segments); received ${JSON.stringify(pattern)}`;
  }
  for (const segment of segments) {
    if (segment === "") {
      return `pattern must not contain an empty segment: ${JSON.stringify(pattern)}`;
    }
    if (!hasNoWhitespace(segment)) {
      return `pattern segments must not contain whitespace: ${JSON.stringify(pattern)}`;
    }
  }
  return null;
}

/**
 * Classify a model ref under a config: the first class whose patterns match
 * the ref wins; otherwise the config's `defaultClass`. Total — a ref always
 * yields exactly one class.
 */
export function classifyModelRef(ref: ModelRef, config: ModelRoutingConfig): ModelClass {
  for (const [modelClass, patterns] of Object.entries(config.modelClasses)) {
    for (const pattern of patterns) {
      if (globMatches(pattern, ref)) return modelClass;
    }
  }
  return config.defaultClass;
}

const selectorsOverlap = (left: RoutingRuleSelector, right: RoutingRuleSelector): boolean => {
  for (const field of ["parentClass", "workload", "profile", "agent"] as const) {
    if (left[field] !== undefined && right[field] !== undefined && left[field] !== right[field]) return false;
  }
  if (left.parentModel !== undefined && right.parentModel !== undefined &&
      !modelPatternsOverlap(left.parentModel, right.parentModel)) return false;
  return true;
};

const selectorSpecificity = (selector: RoutingRuleSelector): number => Object.keys(selector).length;

/**
 * Parse an untrusted routing config object. Fail-closed on any malformed
 * field: a config that cannot be parsed is a typed failure, so the shell can
 * choose to fall back to the declared binding (never a silent partial parse).
 */
export function parseModelRoutingConfig(raw: unknown): RoutingPolicyResult<ModelRoutingConfig> {
  if (!isRecord(raw)) {
    return err({ kind: "invalid-routing-config", message: "routing config must be an object" });
  }
  const unknownTopLevel = unknownFields(raw, ["schemaVersion", "defaultClass", "modelClasses", "targets", "rules"]);
  if (unknownTopLevel.length > 0) {
    return err({ kind: "invalid-routing-config", message: `routing config contains unknown field ${unknownTopLevel[0]}` });
  }
  if (raw.schemaVersion !== 1) {
    return err({
      kind: "invalid-routing-config",
      message: `routing config schemaVersion must be 1; received ${JSON.stringify(raw.schemaVersion)}`,
    });
  }
  if (!isNonEmptyString(raw.defaultClass)) {
    return err({ kind: "invalid-routing-config", message: "routing config defaultClass must be a non-empty string" });
  }
  if (!isRecord(raw.modelClasses)) {
    return err({ kind: "invalid-routing-config", message: "routing config modelClasses must be an object" });
  }
  const modelClasses: Record<ModelClass, string[]> = {};
  for (const [modelClass, patterns] of Object.entries(raw.modelClasses)) {
    if (!isNonEmptyString(modelClass)) {
      return err({ kind: "invalid-routing-config", message: "routing config modelClasses keys must be non-empty strings" });
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return err({ kind: "invalid-routing-config", message: `routing config modelClasses['${modelClass}'] must be a non-empty array` });
    }
    const copy: string[] = [];
    for (const pattern of patterns) {
      if (!isNonEmptyString(pattern)) {
        return err({ kind: "invalid-routing-config", message: `routing config modelClasses['${modelClass}'] patterns must be non-empty strings` });
      }
      const dead = unmatchablePatternReason(pattern);
      if (dead !== null) {
        return err({ kind: "invalid-routing-config", message: `routing config modelClasses['${modelClass}'] pattern can never match: ${dead}` });
      }
      copy.push(pattern);
    }
    modelClasses[modelClass] = copy;
  }
  const classEntries = Object.entries(modelClasses);
  for (let left = 0; left < classEntries.length; left++) {
    for (let right = left + 1; right < classEntries.length; right++) {
      for (const leftPattern of classEntries[left][1]) {
        for (const rightPattern of classEntries[right][1]) {
          if (modelPatternsOverlap(leftPattern, rightPattern)) {
            return err({
              kind: "invalid-routing-config",
              message: `routing model classes ${classEntries[left][0]} and ${classEntries[right][0]} overlap`,
            });
          }
        }
      }
    }
  }
  const targets: Record<string, NamedPiTarget> = {};
  if (raw.targets !== undefined && !isRecord(raw.targets)) {
    return err({ kind: "invalid-routing-config", message: "routing config targets must be an object" });
  }
  if (isRecord(raw.targets)) {
    for (const [name, target] of Object.entries(raw.targets)) {
      if (!isNonEmptyString(name) || !isRecord(target) || typeof target.model !== "string") {
        return err({ kind: "invalid-routing-config", message: `routing config target ${JSON.stringify(name)} must contain an exact model ref` });
      }
      const unknownTarget = unknownFields(target, ["model", "thinkingLevel"]);
      if (unknownTarget.length > 0) {
        return err({ kind: "invalid-routing-config", message: `routing config target ${JSON.stringify(name)} contains unknown field ${unknownTarget[0]}` });
      }
      const model = parseModelRef(target.model);
      if (!model.ok) {
        return err({ kind: "invalid-routing-config", message: `routing config target ${JSON.stringify(name)}: ${model.error.message}` });
      }
      if (!isRoutedPiThinkingLevel(target.thinkingLevel)) {
        return err({ kind: "invalid-routing-config", message: `routing config target ${JSON.stringify(name)} must have an exact thinkingLevel` });
      }
      targets[name] = Object.freeze({
        provider: model.value.provider,
        model: model.value.model,
        thinking: target.thinkingLevel,
      });
    }
  }
  if (!Array.isArray(raw.rules)) {
    return err({ kind: "invalid-routing-config", message: "routing config rules must be an array" });
  }
  const producibleClasses = new Set<ModelClass>([...Object.keys(modelClasses), raw.defaultClass]);
  const ruleIds = new Set<string>();
  const rules: RoutingRule[] = [];
  for (let index = 0; index < raw.rules.length; index++) {
    const rule = raw.rules[index];
    if (!isRecord(rule)) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} must be an object` });
    }
    const unknownRule = unknownFields(rule, ["id", "when", "use"]);
    if (unknownRule.length > 0) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} contains unknown field ${unknownRule[0]}` });
    }
    if (!isNonEmptyString(rule.id)) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} id must be a non-empty string` });
    }
    if (ruleIds.has(rule.id)) {
      return err({ kind: "invalid-routing-config", message: `duplicate routing rule id ${rule.id}` });
    }
    ruleIds.add(rule.id);
    if (!isRecord(rule.when) || !isNonEmptyString(rule.when.parentClass)) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} when.parentClass must be a non-empty string` });
    }
    const unknownWhen = unknownFields(rule.when, ["parentClass", "parentModel", "workload", "profile", "agent"]);
    if (unknownWhen.length > 0) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} when contains unknown field ${unknownWhen[0]}` });
    }
    if (!producibleClasses.has(rule.when.parentClass)) {
      return err({
        kind: "invalid-routing-config",
        message: `routing rule ${index} when.parentClass ${JSON.stringify(rule.when.parentClass)} is not produced by modelClasses or defaultClass`,
      });
    }
    const selector: Record<string, string> = { parentClass: rule.when.parentClass };
    for (const field of ["parentModel", "workload", "profile", "agent"] as const) {
      const value = rule.when[field];
      if (value === undefined) continue;
      if (!isNonEmptyString(value)) {
        return err({ kind: "invalid-routing-config", message: `routing rule ${index} when.${field} must be a non-empty string` });
      }
      if (field === "parentModel") {
        const dead = unmatchablePatternReason(value);
        if (dead !== null) {
          return err({ kind: "invalid-routing-config", message: `routing rule ${index} when.parentModel can never match: ${dead}` });
        }
      }
      selector[field] = value;
    }
    if (!isRecord(rule.use) ||
        (rule.use.kind !== "parent" && rule.use.kind !== "declared" && rule.use.kind !== "named")) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} use.kind must be 'parent', 'declared', or 'named'` });
    }
    const allowedUseFields = rule.use.kind === "named" ? ["kind", "target"] : ["kind"];
    const unknownUse = unknownFields(rule.use, allowedUseFields);
    if (unknownUse.length > 0) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} use contains unknown field ${unknownUse[0]}` });
    }
    let use: RoutingRuleUse;
    if (rule.use.kind === "named") {
      if (!isNonEmptyString(rule.use.target) || targets[rule.use.target] === undefined) {
        return err({ kind: "invalid-routing-config", message: `routing rule ${index} references an unknown named target` });
      }
      use = Object.freeze({ kind: "named", target: rule.use.target });
    } else {
      use = Object.freeze({ kind: rule.use.kind });
    }
    rules.push(Object.freeze({
      id: rule.id,
      when: Object.freeze(selector) as RoutingRuleSelector,
      use,
    }));
  }
  for (let left = 0; left < rules.length; left++) {
    for (let right = left + 1; right < rules.length; right++) {
      if (selectorSpecificity(rules[left].when) === selectorSpecificity(rules[right].when) &&
          selectorsOverlap(rules[left].when, rules[right].when)) {
        return err({
          kind: "invalid-routing-config",
          message: `equal-specificity routing rules ${rules[left].id} and ${rules[right].id} can match the same workload`,
        });
      }
    }
  }
  return ok(
    Object.freeze({
      schemaVersion: 1,
      defaultClass: raw.defaultClass,
      modelClasses: Object.freeze(modelClasses),
      targets: Object.freeze(targets),
      rules: Object.freeze(rules),
    }),
  );
}

/**
 * Resolve the binding a child spawns with. Total and pure: never throws.
 *
 * - No parent ref or no config → the declared binding (inheritance is not
 *   implicit).
 * - Otherwise classify the parent and choose the uniquely most-specific
 *   matching selector across parent model, workload, profile, and Agent.
 * - `parent` inherits the complete active binding, `named` selects an exact
 *   configured target, and `declared` keeps the pinned binding.
 * - No matching rule → the declared binding.
 */
export function resolveEffectivePiBinding(
  declared: PiBinding,
  parentRef: ModelRef | null,
  config: ModelRoutingConfig | null,
): EffectivePiBinding {
  return resolveEffectivePiBindingFromParent(
    declared,
    parentRef === null
      ? null
      : Object.freeze({ provider: parentRef.provider, model: parentRef.model, thinking: declared.thinking }),
    config,
  );
}

/** Resolve the exact launch binding, including the active parent's thinking level. */
export function resolveEffectivePiBindingFromParent(
  declared: PiBinding,
  parent: EffectivePiBinding | null,
  config: ModelRoutingConfig | null,
  workload: RoutingWorkload = Object.freeze({}),
): EffectivePiBinding {
  const declaredEffective: EffectivePiBinding = Object.freeze({
    provider: declared.provider,
    model: declared.model,
    thinking: declared.thinking,
  });
  if (parent === null || config === null) return declaredEffective;

  const parentClass = classifyModelRef(parent, config);
  const matching = config.rules.filter((rule) => {
    const selector = rule.when;
    if (selector.parentClass !== parentClass) return false;
    if (selector.parentModel !== undefined && !globMatches(selector.parentModel, parent)) return false;
    if (selector.workload !== undefined && selector.workload !== workload.workload) return false;
    if (selector.profile !== undefined && selector.profile !== workload.profile) return false;
    return selector.agent === undefined || selector.agent === workload.agent;
  });
  const maxSpecificity = matching.reduce(
    (maximum, rule) => Math.max(maximum, selectorSpecificity(rule.when)),
    -1,
  );
  const rule = matching.find((candidate) => selectorSpecificity(candidate.when) === maxSpecificity);
  if (rule !== undefined) {
    if (rule.use.kind === "parent") return Object.freeze({ ...parent });
    if (rule.use.kind === "declared") return declaredEffective;
    const target = config.targets[rule.use.target];
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      thinking: target.thinking,
    });
  }
  return declaredEffective;
}
