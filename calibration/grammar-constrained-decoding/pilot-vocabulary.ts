/**
 * The pilot's ubiquitous vocabulary — PURE (Plan AD-11): the required
 * route/schema cells and the frozen registry entry each one reads, the two
 * arms, the defect-severity rubric weights, the spec-fixed bounds, the
 * guardrails with the acceptance scenario each evidences, and the schema
 * primitives every persisted pilot shape is parsed with.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { EMISSION_TOOL_SPECS, type EmissionPayloadParser } from "../../engine/src/core/emission-tool";
import { err, ok, type Result } from "../kernel";

// ---------------------------------------------------------------------------
// Schema primitives
// ---------------------------------------------------------------------------

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
export const text = z.string().min(1);

/** Every zod issue as `<path>: <message>`. */
export const issuesOf = (error: z.ZodError): readonly string[] =>
  Object.freeze(error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`));

/** The one parser shape of every persisted pilot record: the schema's output
 *  as its deeply read-only domain type, or every issue. */
export const parserOf = <S extends z.ZodType>(schema: S) =>
  (raw: unknown): Result<DeepReadonly<z.infer<S>>, readonly string[]> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(parsed.data as DeepReadonly<z.infer<S>>) : err(issuesOf(parsed.error));
  };

/** SHA-256 over exact bytes — the content address of a preregistration or a
 *  workload fixture file. Pure (no I/O); hashing is a function of its input. */
export function contentDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Cells: AD-11's required route/schema cells, read from the frozen registry
// ---------------------------------------------------------------------------

/** The required route/schema cells of AD-11 (reviewer v2/v3, judge v1, refutation v1). */
export const CELL_KEYS = [
  "reviewer-payload/v2",
  "reviewer-payload/v3",
  "judge-verdict/v1",
  "refutation-verdict/v1",
] as const;
export type CellKey = (typeof CELL_KEYS)[number];

type Registry = typeof EMISSION_TOOL_SPECS;
type ProducerKind = keyof Registry;
type RegistryVersion<K extends ProducerKind> = keyof Registry[K]["schemaVersions"] & string;
type RegistryEntry = Readonly<{ schemaBytes: string; parsePayload: EmissionPayloadParser }>;

/** The frozen registry seen through its exact (kind, version) pairs: an
 *  upcast, not a restatement, that lets one generic read stay typed. */
type RegistryView = { readonly [K in ProducerKind]: Readonly<{
  toolName: Registry[K]["toolName"];
  schemaVersions: { readonly [V in RegistryVersion<K>]: RegistryEntry };
}> };
const REGISTRY: RegistryView = EMISSION_TOOL_SPECS;

/** One frozen registry cell as the pilot reads it: producer kind, schema
 *  version, the kind's tool name, and the version's schema bytes and the
 *  frozen ingestion parser. */
export type RegistryCell<K extends ProducerKind = ProducerKind, V extends string = string> = Readonly<{
  kind: K;
  version: V;
  toolName: Registry[K]["toolName"];
} & RegistryEntry>;

/** A registry read, typed by the (kind, version) pair: a pair the frozen
 *  registry does not carry does not compile. */
function registryCell<K extends ProducerKind, V extends RegistryVersion<K>>(kind: K, version: V): RegistryCell<K, V> {
  const spec = REGISTRY[kind];
  const entry: RegistryEntry = spec.schemaVersions[version];
  return Object.freeze({ kind, version, toolName: spec.toolName, schemaBytes: entry.schemaBytes, parsePayload: entry.parsePayload });
}

/** The registry cell a cell key names: `<kind>/<version>`. */
type CellOf<C extends string> = C extends `${infer K extends ProducerKind}/${infer V}`
  ? V extends RegistryVersion<K> ? RegistryCell<K, V> : never
  : never;

/**
 * Every required cell's frozen registry entry — read from the registry, never
 * restated. The compiler proves the table against both sources: each key is
 * exactly one required cell (`CELL_KEYS`, no more, no fewer) and names the
 * (kind, version) its entry reads, and each pair is one the registry carries.
 */
export const PILOT_CELLS = Object.freeze({
  "reviewer-payload/v2": registryCell("reviewer-payload", "v2"),
  "reviewer-payload/v3": registryCell("reviewer-payload", "v3"),
  "judge-verdict/v1": registryCell("judge-verdict", "v1"),
  "refutation-verdict/v1": registryCell("refutation-verdict", "v1"),
} satisfies { readonly [C in CellKey]: CellOf<C> });

// ---------------------------------------------------------------------------
// Arms, severities, spec-fixed bounds
// ---------------------------------------------------------------------------

export const PILOT_ARMS = ["emission-enabled", "extraction-only"] as const;
export type PilotArm = (typeof PILOT_ARMS)[number];

export const SEVERITIES = ["minor", "major", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** The independent defect-severity rubric's ordinal weights — the same
 *  rubric for both arms (AS-016). */
export const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = Object.freeze({ minor: 1, major: 2, critical: 3 });

/** AS-015/NFR-001: the spec-fixed p95 bound. A preregistration may tighten it, never loosen it. */
export const SPEC_P95_RATIO_BOUND = 1.25;
/** AD-11: the minimum operational pilot size per required cell. */
export const SPEC_MINIMUM_PAIRS_PER_CELL = 100;
/** AD-9: the one existing request-slot budget (semantic attempts 1 and 2). */
export const SPEC_SEMANTIC_ATTEMPT_BUDGET = 2;

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export const GUARDRAIL_IDS = [
  "measurement-complete",
  "latency-p95",
  "terminal-failure-non-increase",
  "provider-structural-retries",
  "escaped-defect-severity",
] as const;
export type GuardrailId = (typeof GUARDRAIL_IDS)[number];

/** Which acceptance scenario each guardrail evidences. */
export const GUARDRAIL_REQUIREMENT: Readonly<Record<GuardrailId, string>> = Object.freeze({
  "measurement-complete": "AS-017",
  "latency-p95": "AS-015",
  "terminal-failure-non-increase": "AS-015",
  "provider-structural-retries": "AS-004",
  "escaped-defect-severity": "AS-016",
});

export type PassingVerdict = "pass" | "not-applicable";
export type GuardrailVerdict = PassingVerdict | "violated" | "inconclusive" | "not-measured";

export type GuardrailOutcome<V extends GuardrailVerdict = GuardrailVerdict, G extends GuardrailId = GuardrailId> = Readonly<{
  guardrail: G;
  verdict: V;
  detail: string;
}>;

/** One outcome per guardrail, each typed by the id it is keyed under, so a
 *  record whose key and outcome id disagree cannot be written. */
export type GuardrailRecord<V extends GuardrailVerdict = GuardrailVerdict> = Readonly<{
  [G in GuardrailId]: GuardrailOutcome<V, G>;
}>;

export const guardrailOutcome = <G extends GuardrailId, V extends GuardrailVerdict>(guardrail: G, verdict: V, detail: string): GuardrailOutcome<V, G> =>
  Object.freeze({ guardrail, verdict, detail });
