/**
 * The pilot's preregistration — PURE (Plan AD-11): the binding record made
 * BEFORE any window (content-addressed by the retention layer), parsed into a
 * value that already satisfies the spec's minimums, and the deterministic
 * paired schedule it commits to (matched requests, counterbalanced order).
 *
 * The preregistration also fixes the RELEASE POLICY its windows are decided
 * under, before any of them runs:
 *
 * - `capable-route-required` — AD-11 as first recorded: without a qualified
 *   capable (constrained) route the feature cannot be declared done. A
 *   schemaVersion 1 preregistration carries no policy field and parses to
 *   this, so every window retained under one re-decides exactly as before.
 * - `per-route-engine-authoritative` — the operator's per-route decision
 *   (2026-10-08): a route qualified unconstrained emission may be released as
 *   "unconstrained emission, engine-authoritative" when its window is
 *   complete and every guardrail holds. Only a schemaVersion 2
 *   preregistration can carry it, and a v2 one must state its policy: there
 *   is no default.
 */

import { z } from "zod";
import { type Result } from "../kernel";
import { shuffled } from "./pilot-statistics";
import {
  CELL_KEYS,
  hex64,
  parserOf,
  SEVERITIES,
  SPEC_MINIMUM_PAIRS_PER_CELL,
  SPEC_P95_RATIO_BOUND,
  SPEC_SEMANTIC_ATTEMPT_BUDGET,
  text,
  type CellKey,
  type DeepReadonly,
  type PilotArm,
} from "./pilot-vocabulary";

const qualificationSchema = z.discriminatedUnion("kind", [
  /** Capable route (spec glossary): accepts AND enforces the declared constraints. */
  z.object({
    kind: z.literal("constrained-emission"),
    enforcedConstraints: z.array(text).min(1),
    evidence: text,
  }).strict(),
  /** Accepts the exact tool schema but enforces nothing; engine parsing is authoritative. */
  z.object({ kind: z.literal("unconstrained-emission"), evidence: text }).strict(),
  /** The route cannot carry the exact tool schema: no emission arm exists. */
  z.object({ kind: z.literal("extraction-only"), reason: text, evidence: text }).strict(),
]);
export type RouteQualification = DeepReadonly<z.infer<typeof qualificationSchema>>;
/** A route that carries the exact tool schema, so an emission arm exists and
 *  the cell is dispatched; an extraction-only cell is never measured. */
export type EmissionRouteQualification = Exclude<RouteQualification, { kind: "extraction-only" }>;

const knownDefectSchema = z.object({ defectId: text, severity: z.enum(SEVERITIES) }).strict();

const workloadCaseSchema = z.object({
  caseId: text,
  difficulty: z.enum(["easy", "hard"]),
  /** Held-out known-defect case: quality (escaped-defect severity) is assessed on it. */
  heldOutKnownDefectCase: z.boolean(),
  knownDefects: z.array(knownDefectSchema),
  /** Pointer to the fixed input (corpus snapshot or workload fixture). */
  source: text,
}).strict().superRefine((entry, ctx) => {
  if (entry.heldOutKnownDefectCase && entry.knownDefects.length === 0) {
    ctx.addIssue({ code: "custom", message: "a held-out known-defect case must name its known defects", path: ["knownDefects"] });
  }
  const ids = entry.knownDefects.map((defect) => defect.defectId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", message: "known defect ids must be unique within a case", path: ["knownDefects"] });
  }
});

const cellSchema = z.object({
  cell: z.enum(CELL_KEYS),
  toolName: text,
  /** Registry schema digest (bare SHA-256 hex of the frozen schema bytes). */
  schemaDigest: hex64,
  qualification: qualificationSchema,
  workload: z.object({
    repeatsPerCase: z.number().int().min(1),
    cases: z.array(workloadCaseSchema).min(1),
  }).strict(),
}).strict();

const releasePolicySchema = z.discriminatedUnion("kind", [
  /** AD-11 as first recorded: done needs every measured cell on a qualified capable route. */
  z.object({ kind: z.literal("capable-route-required") }).strict(),
  /** Each route is released on its own window: a constrained cell as constrained (AS-004
   *  applies), an unconstrained cell as engine-authoritative (AS-004 not applicable). */
  z.object({ kind: z.literal("per-route-engine-authoritative") }).strict(),
]);
export type ReleasePolicy = DeepReadonly<z.infer<typeof releasePolicySchema>>;

/** The only policy a schemaVersion 1 preregistration (which predates the field) is decided under.
 *  Kept at its literal type, so the parsed v1 shape cannot carry any other policy. */
const CAPABLE_ROUTE_REQUIRED = Object.freeze({ kind: "capable-route-required" as const }) satisfies ReleasePolicy;

const preregistrationFields = {
  id: text,
  recordedAt: z.iso.datetime({ offset: true }),
  route: z.object({
    harness: z.literal("pi"),
    provider: text,
    api: text,
    baseUrl: z.url(),
    model: text,
    thinking: text,
    piVersion: text,
  }).strict(),
  /** Content address of the workload fixture file the cases' `source` pointers resolve in. */
  workloadFixturesDigest: hex64,
  minimumPairsPerCell: z.number().int().min(SPEC_MINIMUM_PAIRS_PER_CELL),
  semanticAttemptBudget: z.literal(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  perAttemptTimeoutMs: z.number().int().positive(),
  scheduleSeed: z.number().int().nonnegative(),
  guardrails: z.object({
    p95RatioBound: z.number().gt(1).max(SPEC_P95_RATIO_BOUND),
    confidenceLevel: z.number().gt(0.5).lt(1),
    bootstrapResamples: z.number().int().min(200),
    bootstrapSeed: z.number().int().nonnegative(),
    /** Escaped-defect severity points per request the emission arm may not exceed. */
    qualityNonInferiorityMargin: z.number().min(0),
    requiredIndependentAssessors: z.number().int().min(2),
  }).strict(),
  cells: z.array(cellSchema),
};

const preregistrationSchema = z.discriminatedUnion("schemaVersion", [
  /** Predates the release policy: it never carries the field. */
  z.object({ schemaVersion: z.literal(1), ...preregistrationFields }).strict(),
  /** States its release policy explicitly; there is no default. */
  z.object({ schemaVersion: z.literal(2), releasePolicy: releasePolicySchema, ...preregistrationFields }).strict(),
]).superRefine((prereg, ctx) => {
  for (const key of CELL_KEYS) {
    const count = prereg.cells.filter((cell) => cell.cell === key).length;
    if (count !== 1) ctx.addIssue({ code: "custom", message: `required cell ${key} must be preregistered exactly once (found ${count})`, path: ["cells"] });
  }
  prereg.cells.forEach((cell, index) => {
    const path = ["cells", index];
    const ids = cell.workload.cases.map((entry) => entry.caseId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: `${cell.cell}: case ids must be unique`, path });
    if (cell.qualification.kind === "extraction-only") return;
    const pairs = cell.workload.cases.length * cell.workload.repeatsPerCase;
    if (pairs < prereg.minimumPairsPerCell) {
      ctx.addIssue({ code: "custom", message: `${cell.cell}: ${pairs} paired requests < preregistered minimum ${prereg.minimumPairsPerCell}`, path });
    }
    for (const difficulty of ["easy", "hard"] as const) {
      if (!cell.workload.cases.some((entry) => entry.difficulty === difficulty)) {
        ctx.addIssue({ code: "custom", message: `${cell.cell}: workload needs at least one ${difficulty} case`, path });
      }
    }
    if (!cell.workload.cases.some((entry) => entry.heldOutKnownDefectCase)) {
      ctx.addIssue({ code: "custom", message: `${cell.cell}: workload needs at least one held-out known-defect case`, path });
    }
  });
}).transform((prereg) => (prereg.schemaVersion === 1 ? { ...prereg, releasePolicy: CAPABLE_ROUTE_REQUIRED } : prereg));

/** A parsed preregistration: schemaVersion 1 with `capable-route-required`
 *  (its implicit policy), or schemaVersion 2 with the policy it states. A v1
 *  value carrying any other policy is unrepresentable. */
export type Preregistration = DeepReadonly<z.infer<typeof preregistrationSchema>>;
export type CellPreregistration = Preregistration["cells"][number];
export type WorkloadCase = CellPreregistration["workload"]["cases"][number];

export const parsePreregistration: (raw: unknown) => Result<Preregistration, readonly string[]> = parserOf(preregistrationSchema);

/** The record a preregistration is written as — `parsePreregistration`'s
 *  inverse. A schemaVersion 1 record never carries its policy (the version
 *  implies it), so the parsed value's `releasePolicy` is left out of it. */
export function encodePreregistration(prereg: Preregistration): DeepReadonly<z.input<typeof preregistrationSchema>> {
  if (prereg.schemaVersion === 2) return prereg;
  const { releasePolicy: _implied, ...record } = prereg;
  return record;
}

// ---------------------------------------------------------------------------
// Deterministic paired schedule (matched requests, counterbalanced order)
// ---------------------------------------------------------------------------

export type ScheduledPair = Readonly<{
  pairId: string;
  cell: CellKey;
  caseId: string;
  difficulty: "easy" | "hard";
  repeat: number;
  /** ABBA counterbalancing within a cell, so warm-cache/drift effects do not
   *  systematically favour either arm. */
  armOrder: readonly [PilotArm, PilotArm];
}>;

const EMISSION_FIRST: readonly [PilotArm, PilotArm] = Object.freeze(["emission-enabled", "extraction-only"] as const);
const EXTRACTION_FIRST: readonly [PilotArm, PilotArm] = Object.freeze(["extraction-only", "emission-enabled"] as const);

/** Every paired request the preregistration commits to, in the seeded global
 *  dispatch order. Extraction-only-qualified cells schedule nothing: their
 *  outcome is the explicit qualification, never fabricated samples. */
export function buildPairSchedule(prereg: Preregistration): readonly ScheduledPair[] {
  const pairs = prereg.cells.flatMap((cell) => {
    if (cell.qualification.kind === "extraction-only") return [];
    const ordered = cell.workload.cases.flatMap((entry) =>
      Array.from({ length: cell.workload.repeatsPerCase }, (_unused, repeat) => ({ entry, repeat })));
    return ordered.map(({ entry, repeat }, index): ScheduledPair => Object.freeze({
      pairId: `${cell.cell}#${entry.caseId}#r${repeat + 1}`,
      cell: cell.cell,
      caseId: entry.caseId,
      difficulty: entry.difficulty,
      repeat: repeat + 1,
      armOrder: index % 4 === 0 || index % 4 === 3 ? EMISSION_FIRST : EXTRACTION_FIRST,
    }));
  });
  return shuffled(pairs, prereg.scheduleSeed);
}
