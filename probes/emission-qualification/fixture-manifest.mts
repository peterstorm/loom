/**
 * FR-002 qualification fixtures — generated ONCE from the real zod schemas so
 * the probe's fixtures are canonical parsed payloads of the frozen contracts,
 * never hand-authored JSON that could drift from them.
 *
 * The violation detectors are DERIVED from each parsed fixture as a structural
 * skeleton, not hand-written key probes: a detector must prove a payload is
 * shaped like the frozen schema (types and key sets, walked from the canonical
 * fixture the real schema validated) before its violation claim counts. That
 * kills the false pass where shape garbage that merely parses as JSON was read
 * as "conformed" or "no violation". Every generated detector is pinned at
 * generation time against the schema-parsed fixture, an exact violation
 * variant, and shape garbage, so a detector that misfires fails HERE, before
 * any live probe spends a request on it.
 *
 * This module is the PURE manifest derivation (`renderManifest`); the writer
 * is `gen-fixtures.mts`, and `fixture-manifest.test.ts` pins the committed
 * `fixtures/manifest.json` byte-for-byte to it, so the manifest the probe
 * reads can never silently diverge from its generator.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  EMISSION_TOOL_SPECS,
} from "../../engine/src/core/emission-tool";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, reviewerPayloadV2Schema } from "../../engine/src/core/reviewer-contract";
import { judgeVerdictV1Schema } from "../../engine/src/core/panel-contract";
import { refutationVerdictV1Schema } from "../../engine/src/core/review-panel";
import { standaloneReviewerPayloadV3Schema } from "../../engine/src/core/standalone-lineage-contract";

/** Where the committed manifest lives (the probe driver reads it from here). */
export const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "manifest.json");

const HEX64 = "a".repeat(64);

// Canonical fixtures: every one is .parse()d through its real zod schema, so
// what the probe asks the model to emit is a schema-valid payload by
// construction.
const v2 = reviewerPayloadV2Schema.parse(REVIEWER_PAYLOAD_EXAMPLE_V2);
const v3 = standaloneReviewerPayloadV3Schema.parse({
  schemaVersion: 3,
  kind: "standalone-successor-review",
  lineageDigest: HEX64,
  snapshotDigest: HEX64,
  priorAssessments: [],
  findings: [],
});
const judge = judgeVerdictV1Schema.parse({
  criterion: "extensibility",
  rankings: [
    {
      candidate: "candidate-a.ts",
      score: 7,
      fatal_flaw: null,
      strongest_idea: "Frozen bytes as the parameter schema remove drift.",
    },
  ],
});
const refutation = refutationVerdictV1Schema.parse({
  criterion: "code-reviewer",
  verdicts: [
    {
      finding_id: "F-001",
      verdict: "upheld",
      reasoning: "The claim holds against the cited contract text.",
    },
  ],
});

// ---------------------------------------------------------------------------
// Skeleton machinery — the serialized, dependency-free shape checker.
// ---------------------------------------------------------------------------

/**
 * One node of the structural skeleton walked from a parsed fixture. The
 * skeleton is deliberately TYPE-level (which keys exist, of which type), not
 * value-level: the frozen schema's literals and ranges stay in zod, and the
 * probe's job is to separate "schema-shaped" from "shape garbage", not to
 * re-implement the whole contract. Array elements take the skeleton of the
 * FIRST element — exact here, because every probe instruction demands the
 * arguments be exactly this fixture (plus, in violation mode, one slot).
 */
type Skeleton =
  | { k: "any" } // unconstrained (empty array element)
  | { k: "null" }
  | { k: "str" }
  | { k: "num" }
  | { k: "bool" }
  | { k: "arr"; e: Skeleton }
  | { k: "obj"; f: Record<string, Skeleton> };

const skeletonOf = (value: unknown): Skeleton => {
  if (value === null) return { k: "null" };
  if (typeof value === "string") return { k: "str" };
  if (typeof value === "number") return { k: "num" };
  if (typeof value === "boolean") return { k: "bool" };
  if (Array.isArray(value)) return { k: "arr", e: value.length > 0 ? skeletonOf(value[0]) : { k: "any" } };
  if (typeof value !== "object") throw new Error(`fixture value type ${typeof value} has no skeleton node`);
  const fields: Record<string, Skeleton> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) fields[key] = skeletonOf(item);
  return { k: "obj", f: fields };
};

/** The matcher serialized into the manifest: strict mode also rejects extra keys. */
const MATCHER_SRC = `function M(v, s, strict) {
  if (s.k === 'any') return true;
  if (s.k === 'null') return v === null;
  if (s.k === 'str') return typeof v === 'string';
  if (s.k === 'num') return typeof v === 'number';
  if (s.k === 'bool') return typeof v === 'boolean';
  if (s.k === 'arr') return Array.isArray(v) && v.every((e) => M(e, s.e, strict));
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const key of Object.keys(s.f)) { if (!M(v[key], s.f[key], strict)) return false; }
  if (strict && Object.keys(v).length !== Object.keys(s.f).length) return false;
  return true;
}`;

const conformsSource = (skeleton: Skeleton): string =>
  `(args) => { ${MATCHER_SRC}; return M(args, ${JSON.stringify(skeleton)}, true); }`;

const withMatcher = (skeletonJson: string, strict: boolean, violationBody: string): string =>
  `(args) => { ${MATCHER_SRC}; return M(args, ${skeletonJson}, ${strict ? "true" : "false"}) && (${violationBody}); }`;

// Violation detectors: frozen shape FIRST (relaxed only where the violation
// itself rides an extra key), then the per-kind violation probe.
const reviewerViolationSource = (skeleton: Skeleton): string => {
  const withSlot: Skeleton = {
    k: "obj",
    f: { ...(skeleton as { k: "obj"; f: Record<string, Skeleton> }).f, probe_violation: { k: "bool" } },
  };
  return withMatcher(
    JSON.stringify(withSlot),
    false,
    "typeof args === 'object' && args !== null && args.probe_violation === true",
  );
};
const judgeViolationSource = (skeleton: Skeleton): string =>
  withMatcher(
    JSON.stringify(skeleton),
    true,
    "(args.rankings ?? []).some((r) => typeof r.score === 'number' && (r.score < 0 || r.score > 10 || !Number.isInteger(r.score)))",
  );
const refutationViolationSource = (skeleton: Skeleton): string =>
  withMatcher(
    JSON.stringify(skeleton),
    true,
    "(args.verdicts ?? []).some((v) => v.verdict !== undefined && !['refuted', 'upheld', 'uncertain'].includes(v.verdict))",
  );

/** JSON round-trip copy plus a mutation, for building violation/garbage variants. */
const mutateFixture = (fixture: unknown, mutate: (copy: Record<string, unknown>) => void): unknown => {
  const copy = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  mutate(copy);
  return copy;
};

/** Violation probes: each tempts exactly one SCHEMA-forbidden shape, framed
 *  as an explicit negative test (models comply with testing framings where a
 *  plainly-worded violation gets self-censored) and using a subtle forbidden
 *  value. The engine-only refinements are NOT probed here — the provider
 *  grammar cannot know them; AS-018's engine-refusal cases are Phase-3
 *  acceptance work. */
const violationInstructions = {
  "reviewer-payload": "NEGATIVE TEST: we are testing the rejection path. Emit the call anyway, including a top-level key \"probe_violation\" with the boolean value true. It will be rejected; that is the point.",
  "judge-verdict": "NEGATIVE TEST: we are testing the rejection path. Emit the call anyway with the first ranking scored 12 (an integer outside the 0..10 domain). It will be rejected; that is the point.",
  "refutation-verdict": "NEGATIVE TEST: we are testing the rejection path. Emit the call anyway with the first verdict set to \"partially_upheld\" (not one of refuted/upheld/uncertain). It will be rejected; that is the point.",
} as const;

type PreparedSpec = Readonly<{
  kind: string;
  version: string;
  registeredToolName: string;
  schemaBytes: string;
  fixture: unknown;
  instruction: string;
  conformsSrc: string;
  violationSrc: string;
  violated: unknown;
  garbage: unknown;
  /** True when the violation rides an extra key, so the violated shape must NOT read as conforming. */
  extraSlot: boolean;
}>;

/** Pin every generated detector BEFORE anything is written: a misfiring
 *  detector fails generation, never a live probe run. */
const pinDetectors = (label: string, spec: PreparedSpec): void => {
  const conforms = new Function(`return (${spec.conformsSrc})`)() as (args: unknown) => boolean;
  const violation = new Function(`return (${spec.violationSrc})`)() as (args: unknown) => boolean;
  if (conforms(spec.fixture) !== true) throw new Error(`${label}: the schema-parsed fixture fails its own frozen-shape skeleton`);
  if (violation(spec.fixture) !== false) throw new Error(`${label}: the schema-parsed fixture reads as a violation`);
  if (violation(spec.violated) !== true) throw new Error(`${label}: the violation fixture does not fire the detector`);
  if (conforms(spec.garbage) !== false) throw new Error(`${label}: shape garbage passes the conformance skeleton`);
  if (violation(spec.garbage) !== false) throw new Error(`${label}: shape garbage reads as a violation`);
  if (spec.extraSlot && conforms(spec.violated) !== false) {
    throw new Error(`${label}: the extra-key violation shape must not read as conforming`);
  }
};

const specs = [
  { kind: "reviewer-payload", version: "v2", registeredToolName: "loom_emit_reviewer_payload_v2", schemaBytes: EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v2"]!.schemaBytes, fixture: v2, instruction: violationInstructions["reviewer-payload"] },
  { kind: "reviewer-payload", version: "v3", registeredToolName: "loom_emit_reviewer_payload_v3", schemaBytes: EMISSION_TOOL_SPECS["reviewer-payload"].schemaVersions["v3"]!.schemaBytes, fixture: v3, instruction: violationInstructions["reviewer-payload"] },
  { kind: "judge-verdict", version: "v1", registeredToolName: EMISSION_TOOL_SPECS["judge-verdict"].toolName, schemaBytes: EMISSION_TOOL_SPECS["judge-verdict"].schemaVersions["v1"]!.schemaBytes, fixture: judge, instruction: violationInstructions["judge-verdict"] },
  { kind: "refutation-verdict", version: "v1", registeredToolName: EMISSION_TOOL_SPECS["refutation-verdict"].toolName, schemaBytes: EMISSION_TOOL_SPECS["refutation-verdict"].schemaVersions["v1"]!.schemaBytes, fixture: refutation, instruction: violationInstructions["refutation-verdict"] },
] as const;

const prepare = (spec: (typeof specs)[number]): PreparedSpec => {
  const skeleton = skeletonOf(spec.fixture);
  const violationSrc = spec.kind === "reviewer-payload"
    ? reviewerViolationSource(skeleton)
    : spec.kind === "judge-verdict"
      ? judgeViolationSource(skeleton)
      : refutationViolationSource(skeleton);
  const violated = spec.kind === "reviewer-payload"
    ? mutateFixture(spec.fixture, (copy) => { copy.probe_violation = true; })
    : spec.kind === "judge-verdict"
      ? mutateFixture(spec.fixture, (copy) => { (copy.rankings as { score: number }[])[0]!.score = 12; })
      : mutateFixture(spec.fixture, (copy) => { (copy.verdicts as { verdict: string }[])[0]!.verdict = "partially_upheld"; });
  const garbage = spec.kind === "reviewer-payload"
    ? { probe_violation: true }
    : spec.kind === "judge-verdict"
      ? { rankings: [{ score: 12 }] }
      : { verdicts: [{ verdict: "partially_upheld" }] };
  const row: PreparedSpec = {
    ...spec,
    conformsSrc: conformsSource(skeleton),
    violationSrc,
    violated,
    garbage,
    extraSlot: spec.kind === "reviewer-payload",
  };
  pinDetectors(spec.registeredToolName, row);
  return row;
};

/** One manifest row: what the probe driver asks for and how it judges the answer. */
export type ManifestEntry = Readonly<{
  kind: string;
  version: string;
  registeredToolName: string;
  schemaBytes: string;
  schemaDigest: string;
  fixtureJson: string;
  violationInstruction: string;
  conformsDetect: string;
  violationDetect: string;
}>;

/** The manifest rows, every detector pinned before it is returned (a misfire throws). */
export function buildManifest(): readonly ManifestEntry[] {
  return specs.map(prepare).map((spec) => ({
    kind: spec.kind,
    version: spec.version,
    registeredToolName: spec.registeredToolName,
    schemaBytes: spec.schemaBytes,
    schemaDigest: "sha256-" + createHash("sha256").update(spec.schemaBytes).digest("hex"),
    fixtureJson: JSON.stringify(spec.fixture, null, 2),
    violationInstruction: spec.instruction,
    conformsDetect: spec.conformsSrc,
    violationDetect: spec.violationSrc,
  }));
}

/** The exact bytes of `fixtures/manifest.json`. */
export const renderManifest = (manifest: readonly ManifestEntry[] = buildManifest()): string => JSON.stringify(manifest, null, 2);

