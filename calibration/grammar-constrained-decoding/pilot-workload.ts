/**
 * The pilot's fixed workload — PURE: fixture parsing, matched prompt
 * rendering, request identity and the deterministic rubric assessor.
 *
 * Matched requests (AD-11): both arms of a pair receive byte-identical task
 * bodies (same source snapshot, same schema, same rubric, same seed-free
 * input); they differ ONLY in the wire-instruction section — the frozen
 * tool-primary wording naming the issued tool on the emission-enabled arm,
 * the retained final-message contract on the extraction-only arm. Every
 * wording comes from the engine's own frozen renderers; nothing here is a
 * second contract or a provider serializer.
 */

import { z } from "zod";
import { match } from "ts-pattern";
import {
  REVIEWER_IMPACT_RUBRIC_V1,
  REVIEWER_OUTPUT_CONTRACT,
} from "../../engine/src/core/reviewer-contract";
import { renderReviewerWireInstructions } from "../../engine/src/core/reviewer-protocol";
import { emissionToolPrimaryInstruction } from "../../engine/src/core/spawn-admission";
import { EMISSION_TOOL_SPECS, type IssuedEmissionBinding } from "../../engine/src/core/emission-tool";
import {
  matchCalibrationFindings,
  type CalibrationCase,
  type CalibrationPrediction,
} from "../../engine/src/core/model-calibration";
import {
  contentDigest,
  type CellKey,
  type EscapedDefect,
  type PilotArm,
  type Result,
  type WorkloadCase,
} from "./pilot-core";

// ---------------------------------------------------------------------------
// Fixture file (content-addressed by the preregistration)
// ---------------------------------------------------------------------------

const text = z.string().min(1);

const judgeFixtureSchema = z.object({
  kind: z.literal("judge-verdict"),
  criterion: text,
  brief: text,
  candidates: z.array(z.object({ candidate: text, design: text }).strict()).min(2),
  /** The planted fatal flaw: the known defect a judge must not let through. */
  plantedFlaw: z.object({ candidate: text, defectId: text }).strict(),
}).strict().superRefine((fixture, ctx) => {
  if (!fixture.candidates.some((entry) => entry.candidate === fixture.plantedFlaw.candidate)) {
    ctx.addIssue({ code: "custom", message: "the planted flaw must name one of the candidates", path: ["plantedFlaw"] });
  }
});

const refutationFixtureSchema = z.object({
  kind: z.literal("refutation-verdict"),
  lens: text,
  finding: z.object({ findingId: text, claim: text, file: text, line: z.number().int().positive(), excerpt: text }).strict(),
  /** Ground truth: a real defect must not be refuted (that is an escape). */
  groundTruth: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("real-defect"), defectId: text }).strict(),
    z.object({ kind: z.literal("false-positive") }).strict(),
  ]),
}).strict();

const fixtureFileSchema = z.object({
  schemaVersion: z.literal(1),
  reviewer: z.object({
    corpus: text,
    /** The issued standalone-successor context the v3 cell supplies (no prior findings). */
    v3Context: z.object({ lineageDigest: z.string().regex(/^[0-9a-f]{64}$/), snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  }).strict(),
  fixtures: z.record(z.string(), z.discriminatedUnion("kind", [judgeFixtureSchema, refutationFixtureSchema])),
}).strict();

export type WorkloadFixtures = Readonly<z.infer<typeof fixtureFileSchema>>;
export type JudgeFixture = Readonly<z.infer<typeof judgeFixtureSchema>>;
export type RefutationFixture = Readonly<z.infer<typeof refutationFixtureSchema>>;

export function parseWorkloadFixtures(raw: unknown): Result<WorkloadFixtures, readonly string[]> {
  const parsed = fixtureFileSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`) };
}

// ---------------------------------------------------------------------------
// Case sources
// ---------------------------------------------------------------------------

/** A resolved case input: a corpus revision snapshot (reviewer cells) or a fixture. */
export type CaseInput =
  | Readonly<{ kind: "corpus"; corpusCase: CalibrationCase; changedPaths: readonly string[] }>
  | Readonly<{ kind: "judge"; fixture: JudgeFixture }>
  | Readonly<{ kind: "refutation"; fixture: RefutationFixture }>;

/** Parse a case's `source` pointer: `corpus:<case id>` or `fixture:<fixture id>`. */
export function parseCaseSource(source: string): Result<Readonly<{ kind: "corpus" | "fixture"; id: string }>, string> {
  const found = /^(corpus|fixture):(.+)$/.exec(source);
  return found?.[1] !== undefined && found[2] !== undefined
    ? { ok: true, value: { kind: found[1] as "corpus" | "fixture", id: found[2] } }
    : { ok: false, error: `case source ${JSON.stringify(source)} is neither corpus:<id> nor fixture:<id>` };
}

// ---------------------------------------------------------------------------
// Request identity
// ---------------------------------------------------------------------------

/** Canonical, per-attempt request id (SAFE_AUTHORITY_ID-shaped): a fresh
 *  engine-issued identity per spawn, as attempt 2 is in production. */
export function pilotRequestId(windowId: string, pairId: string, arm: PilotArm, attempt: number): string {
  const armCode = arm === "emission-enabled" ? "em" : "ex";
  return `cal-${contentDigest(`${windowId}\0${pairId}`).slice(0, 16)}-${armCode}-a${attempt}`;
}

export const CELL_PRODUCER = {
  "reviewer-payload/v2": { kind: "reviewer-payload", version: "v2" },
  "reviewer-payload/v3": { kind: "reviewer-payload", version: "v3" },
  "judge-verdict/v1": { kind: "judge-verdict", version: "v1" },
  "refutation-verdict/v1": { kind: "refutation-verdict", version: "v1" },
} as const satisfies Readonly<Record<CellKey, Readonly<{ kind: keyof typeof EMISSION_TOOL_SPECS; version: "v1" | "v2" | "v3" }>>>;

/** The frozen schema bytes of a cell — read from the registry, never restated. */
export function cellSchemaBytes(cell: CellKey): string {
  const producer = CELL_PRODUCER[cell];
  const versions: Readonly<Partial<Record<string, Readonly<{ schemaBytes: string }>>>> = EMISSION_TOOL_SPECS[producer.kind].schemaVersions;
  const entry = versions[producer.version];
  // Constructor invariant: every CELL_PRODUCER pair is a registry cell (the
  // contract suite and the preflight digest check both re-prove it).
  if (entry === undefined) throw new Error(`frozen registry carries no ${cell} cell`);
  return entry.schemaBytes;
}

// ---------------------------------------------------------------------------
// Prompt rendering (matched across arms)
// ---------------------------------------------------------------------------

export type WireRoute =
  | Readonly<{ arm: "emission-enabled"; binding: IssuedEmissionBinding }>
  | Readonly<{ arm: "extraction-only" }>;

const VERDICT_FINAL_MESSAGE_CONTRACT =
  "Emit exactly one JSON object conforming to the verdict schema above. No other final output.";

/** The task body shared byte-for-byte by both arms of a pair. */
export function renderTaskBody(cell: CellKey, input: CaseInput, fixtures: WorkloadFixtures): Result<string, string> {
  const schema = cellSchemaBytes(cell);
  const ok = (value: string): Result<string, never> => ({ ok: true, value });
  return match([cell, input] as const)
    .with(["reviewer-payload/v2", { kind: "corpus" }], ([, corpus]) => ok(reviewerBody(corpus, schema, null)))
    .with(["reviewer-payload/v3", { kind: "corpus" }], ([, corpus]) => ok(reviewerBody(corpus, schema, fixtures.reviewer.v3Context)))
    .with(["judge-verdict/v1", { kind: "judge" }], ([, judge]) => ok(judgeBody(judge.fixture, schema)))
    .with(["refutation-verdict/v1", { kind: "refutation" }], ([, refutation]) => ok(refutationBody(refutation.fixture, schema)))
    .otherwise((): Result<string, string> => ({ ok: false, error: `case input ${input.kind} cannot feed cell ${cell}` }));
}

function reviewerBody(
  input: Extract<CaseInput, { kind: "corpus" }>,
  schema: string,
  v3: WorkloadFixtures["reviewer"]["v3Context"] | null,
): string {
  const { revision } = input.corpusCase;
  return [
    `Review historical revision ${revision} for critical correctness defects.`,
    `Inspect the complete revision-derived changed-path scope: ${input.changedPaths.join(", ") || "no changed paths reported"}.`,
    `Use git show ${revision}:<path> to read that snapshot; do not judge the current worktree.`,
    "Report every real critical defect in scope as a finding; report nothing you cannot ground in the snapshot.",
    ...(v3 === null ? [] : [
      "",
      "Issued standalone-successor context:",
      `- lineageDigest: ${v3.lineageDigest}`,
      `- snapshotDigest: ${v3.snapshotDigest}`,
      "- prior findings: none — priorAssessments must be an empty array.",
    ]),
    "",
    "## reviewer-payload-schema",
    "",
    "```json",
    schema,
    "```",
    "",
    "## reviewer-impact-rubric",
    "",
    REVIEWER_IMPACT_RUBRIC_V1,
  ].join("\n");
}

function judgeBody(fixture: JudgeFixture, schema: string): string {
  return [
    `You are an architecture panel judge scoring every candidate on ONE criterion: ${fixture.criterion}.`,
    fixture.brief,
    "",
    ...fixture.candidates.flatMap((entry) => [`### ${entry.candidate}`, "", entry.design, ""]),
    `Return a judge verdict whose criterion is exactly ${JSON.stringify(fixture.criterion)}, ranking every candidate above by its filename ` +
      "with an integer score 0-10, its fatal flaw (or null) and its strongest idea.",
    "",
    "## judge-verdict-schema",
    "",
    "```json",
    schema,
    "```",
  ].join("\n");
}

function refutationBody(fixture: RefutationFixture, schema: string): string {
  const { finding } = fixture;
  return [
    `You are the ${fixture.lens} refutation verifier. Try to REFUTE the finding below; uphold it only if the code proves it.`,
    "",
    `Finding ${finding.findingId}: ${finding.claim}`,
    `Location: ${finding.file}:${finding.line}`,
    "",
    "```",
    finding.excerpt,
    "```",
    "",
    `Return a refutation verdict whose criterion is exactly ${JSON.stringify(fixture.lens)} with one entry for finding_id ${JSON.stringify(finding.findingId)}.`,
    "",
    "## refutation-verdict-schema",
    "",
    "```json",
    schema,
    "```",
  ].join("\n");
}

/** The wire section — the ONLY difference between the arms of a pair. */
function renderWireSection(cell: CellKey, route: WireRoute): string {
  const reviewer = cell === "reviewer-payload/v2" || cell === "reviewer-payload/v3";
  return match(route)
    .with({ arm: "emission-enabled" }, ({ binding }) => reviewer
      ? renderReviewerWireInstructions({ kind: "emission", toolName: binding.toolName })
      : emissionToolPrimaryInstruction(binding))
    .with({ arm: "extraction-only" }, () => reviewer
      ? renderReviewerWireInstructions({ kind: "extraction-only", reason: "calibration extraction-only arm" }, REVIEWER_OUTPUT_CONTRACT)
      : VERDICT_FINAL_MESSAGE_CONTRACT)
    .exhaustive();
}

export function renderPilotPrompt(body: string, cell: CellKey, route: WireRoute): string {
  return `${body}\n\n## Output\n\n${renderWireSection(cell, route)}\n`;
}

// ---------------------------------------------------------------------------
// The deterministic rubric assessor (one of the blinded assessors)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reviewer payload findings as calibration predictions (v2 and v3 share the finding fields). */
function reviewerPredictions(payload: unknown): readonly CalibrationPrediction[] {
  if (!isRecord(payload) || !Array.isArray(payload["findings"])) return [];
  return payload["findings"].flatMap((finding): CalibrationPrediction[] =>
    isRecord(finding) && typeof finding["claim"] === "string"
      ? [{
          claim: finding["claim"],
          file: typeof finding["file"] === "string" ? finding["file"] : null,
          line: typeof finding["line"] === "number" ? finding["line"] : null,
        }]
      : []);
}

/**
 * Escaped known defects in ONE accepted payload, each resolved to its
 * preregistered severity. Fails closed: an escaped defect id the case does
 * not declare, or a judge ranking that cannot be compared, is an error
 * naming it — never dropped, so a lookup drift or an unscorable ranking can
 * never read as fewer escapes.
 */
export function rubricEscapes(workloadCase: WorkloadCase, input: CaseInput, payload: unknown): Result<readonly EscapedDefect[], string> {
  const escaped = escapedDefectIds(input, payload);
  if (!escaped.ok) return { ok: false, error: `case ${workloadCase.caseId}: ${escaped.error}` };
  const known = new Map(workloadCase.knownDefects.map((defect) => [defect.defectId, defect] as const));
  const escapes: EscapedDefect[] = [];
  const unknown: string[] = [];
  for (const defectId of escaped.value) {
    const defect = known.get(defectId);
    if (defect === undefined) unknown.push(JSON.stringify(defectId));
    else escapes.push(Object.freeze({ defectId, severity: defect.severity }));
  }
  return unknown.length > 0
    ? { ok: false, error: `case ${workloadCase.caseId} declares no known defect ${unknown.join(", ")}` }
    : { ok: true, value: Object.freeze(escapes) };
}

/**
 * The defect ids ONE accepted payload lets escape, by the same rule for both
 * arms (the assessor never sees the arm). Reviewer cells reuse the corpus
 * match rules (`matchCalibrationFindings`); a judge escape is a planted fatal
 * flaw that is not named or that scores at least as high as every sound
 * candidate; a refutation escape is a real defect verdicted `refuted`
 * (`uncertain` counts toward neither side, as in the tally). A named planted
 * flaw whose ranking cannot be compared — its own or a sound candidate's
 * score is not a number — is an error, never read as "not escaped".
 */
function escapedDefectIds(input: CaseInput, payload: unknown): Result<readonly string[], string> {
  const escaped = (ids: readonly string[]): Result<readonly string[], never> => ({ ok: true, value: ids });
  return match(input)
    .with({ kind: "corpus" }, ({ corpusCase }) => {
      if (corpusCase.state !== "vulnerable") return escaped([]);
      const matching = matchCalibrationFindings(corpusCase.expectedCriticals, reviewerPredictions(payload));
      return escaped(matching.missedExpectations.map((expectation) => expectation.id));
    })
    .with({ kind: "judge" }, ({ fixture }): Result<readonly string[], string> => {
      const rankings = isRecord(payload) && Array.isArray(payload["rankings"]) ? payload["rankings"].filter(isRecord) : [];
      const flawed = rankings.find((ranking) => ranking["candidate"] === fixture.plantedFlaw.candidate);
      if (flawed === undefined || flawed["fatal_flaw"] === null) return escaped([fixture.plantedFlaw.defectId]);
      const unscored = rankings.filter((ranking) => typeof ranking["score"] !== "number").map((ranking) => JSON.stringify(ranking["candidate"]));
      if (unscored.length > 0) {
        return { ok: false, error: `the judge ranking of candidate(s) ${unscored.join(", ")} carries no numeric score, so the planted flaw cannot be ranked` };
      }
      const score = (ranking: Readonly<Record<string, unknown>>): number => Number(ranking["score"]);
      const others = rankings.filter((ranking) => ranking["candidate"] !== fixture.plantedFlaw.candidate);
      return escaped(others.every((other) => score(flawed) >= score(other)) ? [fixture.plantedFlaw.defectId] : []);
    })
    .with({ kind: "refutation" }, ({ fixture }) => {
      if (fixture.groundTruth.kind !== "real-defect") return escaped([]);
      const verdicts = isRecord(payload) && Array.isArray(payload["verdicts"]) ? payload["verdicts"].filter(isRecord) : [];
      const entry = verdicts.find((verdict) => verdict["finding_id"] === fixture.finding.findingId);
      return escaped(entry === undefined || entry["verdict"] === "refuted" ? [fixture.groundTruth.defectId] : []);
    })
    .exhaustive();
}
