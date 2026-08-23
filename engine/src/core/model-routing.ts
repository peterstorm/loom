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

import type { PiBinding, PiThinkingLevel } from "./model-profiles";

/** A parsed `provider/model` reference, as a value object (not a raw string). */
export type ModelRef = Readonly<{ provider: string; model: string }>;

/** An open class label defined by the config (e.g. "local", "cloud"). */
export type ModelClass = string;

/**
 * What a matching routing rule directs the child to use.
 * - `parent`: inherit the parent session's provider/model.
 * - `declared`: explicitly keep the agent's declared (pinned) binding.
 */
export type RoutingRuleUse =
  | Readonly<{ kind: "parent" }>
  | Readonly<{ kind: "declared" }>;

export type RoutingRule = Readonly<{
  id: string;
  when: Readonly<{ parentClass: ModelClass }>;
  use: RoutingRuleUse;
}>;

export type ModelRoutingConfig = Readonly<{
  schemaVersion: 1;
  defaultClass: ModelClass;
  /** Class → glob patterns over `provider/model`. A ref matching any pattern
   *  takes that class; otherwise it is `defaultClass`. */
  modelClasses: Readonly<Record<ModelClass, readonly string[]>>;
  /** Evaluated in order; the first rule whose `when` matches decides the use. */
  rules: readonly RoutingRule[];
}>;

/**
 * The binding a child actually spawns with. Wider than `PiBinding`: when a
 * rule inherits the parent, the provider/model are the parent's, not one of
 * the pinned Codex models. `thinking` is always the declared profile's.
 */
export type EffectivePiBinding = Readonly<{
  provider: string;
  model: string;
  thinking: PiThinkingLevel;
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
  if (!hasNoWhitespace(raw)) {
    return err({ kind: "invalid-model-ref", message: `model ref must not contain whitespace: ${JSON.stringify(raw)}` });
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

/**
 * Parse an untrusted routing config object. Fail-closed on any malformed
 * field: a config that cannot be parsed is a typed failure, so the shell can
 * choose to fall back to the declared binding (never a silent partial parse).
 */
export function parseModelRoutingConfig(raw: unknown): RoutingPolicyResult<ModelRoutingConfig> {
  if (!isRecord(raw)) {
    return err({ kind: "invalid-routing-config", message: "routing config must be an object" });
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
    if (!Array.isArray(patterns)) {
      return err({ kind: "invalid-routing-config", message: `routing config modelClasses['${modelClass}'] must be an array` });
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
  if (!Array.isArray(raw.rules)) {
    return err({ kind: "invalid-routing-config", message: "routing config rules must be an array" });
  }
  const producibleClasses = new Set<ModelClass>([...Object.keys(modelClasses), raw.defaultClass]);
  const rules: RoutingRule[] = [];
  for (let index = 0; index < raw.rules.length; index++) {
    const rule = raw.rules[index];
    if (!isRecord(rule)) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} must be an object` });
    }
    if (!isNonEmptyString(rule.id)) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} id must be a non-empty string` });
    }
    if (!isRecord(rule.when) || !isNonEmptyString(rule.when.parentClass)) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} when.parentClass must be a non-empty string` });
    }
    if (!producibleClasses.has(rule.when.parentClass)) {
      return err({
        kind: "invalid-routing-config",
        message: `routing rule ${index} when.parentClass ${JSON.stringify(rule.when.parentClass)} is not produced by modelClasses or defaultClass`,
      });
    }
    if (!isRecord(rule.use) || (rule.use.kind !== "parent" && rule.use.kind !== "declared")) {
      return err({ kind: "invalid-routing-config", message: `routing rule ${index} use.kind must be 'parent' or 'declared'` });
    }
    rules.push(
      Object.freeze({
        id: rule.id,
        when: Object.freeze({ parentClass: rule.when.parentClass }),
        use: Object.freeze({ kind: rule.use.kind }) as RoutingRuleUse,
      }),
    );
  }
  return ok(
    Object.freeze({
      schemaVersion: 1,
      defaultClass: raw.defaultClass,
      modelClasses: Object.freeze(modelClasses),
      rules: Object.freeze(rules),
    }),
  );
}

/**
 * Resolve the binding a child spawns with. Total and pure: never throws.
 *
 * - No parent ref or no config → the declared binding (inheritance is not
 *   implicit).
 * - Otherwise classify the parent; the first rule whose `when.parentClass`
 *   matches decides: `parent` inherits the parent's provider/model (keeping
 *   the declared thinking level), `declared` keeps the pinned binding.
 * - No matching rule → the declared binding.
 */
export function resolveEffectivePiBinding(
  declared: PiBinding,
  parentRef: ModelRef | null,
  config: ModelRoutingConfig | null,
): EffectivePiBinding {
  const declaredEffective: EffectivePiBinding = Object.freeze({
    provider: declared.provider,
    model: declared.model,
    thinking: declared.thinking,
  });
  if (parentRef === null || config === null) return declaredEffective;

  const parentClass = classifyModelRef(parentRef, config);
  for (const rule of config.rules) {
    if (rule.when.parentClass !== parentClass) continue;
    if (rule.use.kind === "parent") {
      return Object.freeze({ provider: parentRef.provider, model: parentRef.model, thinking: declared.thinking });
    }
    return declaredEffective;
  }
  return declaredEffective;
}
