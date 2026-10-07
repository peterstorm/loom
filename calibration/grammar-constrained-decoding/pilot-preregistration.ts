/**
 * The pilot's preregistration — PURE (Plan AD-11): the binding record made
 * BEFORE any window (content-addressed by the retention layer), parsed into a
 * value that already satisfies the spec's minimums, and the deterministic
 * paired schedule it commits to (matched requests, counterbalanced order).
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

const preregistrationSchema = z.object({
  schemaVersion: z.literal(1),
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
}).strict().superRefine((prereg, ctx) => {
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
});

export type Preregistration = DeepReadonly<z.infer<typeof preregistrationSchema>>;
export type CellPreregistration = Preregistration["cells"][number];
export type WorkloadCase = CellPreregistration["workload"]["cases"][number];

export const parsePreregistration: (raw: unknown) => Result<Preregistration, readonly string[]> = parserOf(preregistrationSchema);

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
