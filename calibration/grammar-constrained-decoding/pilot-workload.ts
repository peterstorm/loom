/**
 * The pilot's fixed workload — PURE: fixture parsing, case-input resolution
 * and matched prompt rendering (request identity and binding issuance are
 * `pilot-binding.ts`).
 *
 * Case inputs are cell-indexed: a preregistered case's `source` resolves,
 * against the corpus and the fixture file, to the one input its cell can
 * render — a corpus revision snapshot for a reviewer cell, a judge fixture for
 * the judge cell, a refutation fixture for the refutation cell. A source that
 * names a missing case or a fixture of another cell is refused at resolution,
 * before anything is dispatched, so a mismatched input is unrepresentable
 * past this seam. Each input carries the case it was resolved for, and the
 * window's inputs are keyed by a key only this module mints, so a lookup
 * (`caseInputOf`) proves the input belongs to the scheduled cell AND case.
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
import { emissionToolPrimaryInstruction } from "../../engine/src/core/issued-emission-capability";
import type { IssuedEmissionBinding } from "../../engine/src/core/emission-tool";
import type { CalibrationCase } from "../../engine/src/core/model-calibration";
import { err, ok, type Result } from "../kernel";
import type { Preregistration, WorkloadCase } from "./pilot-preregistration";
import { hex64, parserOf, PILOT_CELLS, text, type CellKey, type DeepReadonly } from "./pilot-vocabulary";

// ---------------------------------------------------------------------------
// Fixture file (content-addressed by the preregistration)
// ---------------------------------------------------------------------------

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
    v3Context: z.object({ lineageDigest: hex64, snapshotDigest: hex64 }).strict(),
  }).strict(),
  fixtures: z.record(z.string(), z.discriminatedUnion("kind", [judgeFixtureSchema, refutationFixtureSchema])),
}).strict();

export type WorkloadFixtures = DeepReadonly<z.infer<typeof fixtureFileSchema>>;
export type JudgeFixture = DeepReadonly<z.infer<typeof judgeFixtureSchema>>;
export type RefutationFixture = DeepReadonly<z.infer<typeof refutationFixtureSchema>>;

export const parseWorkloadFixtures: (raw: unknown) => Result<WorkloadFixtures, readonly string[]> = parserOf(fixtureFileSchema);

// ---------------------------------------------------------------------------
// Case inputs (cell-indexed)
// ---------------------------------------------------------------------------

export type ReviewerCell = "reviewer-payload/v2" | "reviewer-payload/v3";

/** A resolved case input, indexed by the one cell it can feed and carrying
 *  the preregistered case it was resolved for. */
export type CaseInput =
  | Readonly<{ cell: ReviewerCell; caseId: string; corpusCase: CalibrationCase; changedPaths: readonly string[] }>
  | Readonly<{ cell: "judge-verdict/v1"; caseId: string; fixture: JudgeFixture }>
  | Readonly<{ cell: "refutation-verdict/v1"; caseId: string; fixture: RefutationFixture }>;

type FixtureInput = Extract<CaseInput, { fixture: unknown }>;

declare const caseInputKeyBrand: unique symbol;

/** The key of one preregistered case's resolved input, minted only here. */
type CaseInputKey = string & Readonly<{ [caseInputKeyBrand]: true }>;

const caseInputKey = (cell: CellKey, caseId: string): CaseInputKey => `${cell}|${caseId}` as CaseInputKey;

/** Every preregistered case's resolved input, as `resolveWindowInputs` returns it. */
export type WindowInputs = ReadonlyMap<CaseInputKey, CaseInput>;

/** The resolved input of one scheduled case — only an input resolved for
 *  exactly that cell and case; `undefined` when there is none. */
export function caseInputOf(inputs: WindowInputs, cell: CellKey, caseId: string): CaseInput | undefined {
  const input = inputs.get(caseInputKey(cell, caseId));
  return input?.cell === cell && input.caseId === caseId ? input : undefined;
}

/** The revision-derived changed-path scope of a corpus snapshot (git in the shell, a constant in tests). */
export type ChangedPathsOf = (revision: string) => readonly string[];

/** Parse a case's `source` pointer: `corpus:<case id>` or `fixture:<fixture id>`. */
export function parseCaseSource(source: string): Result<Readonly<{ kind: "corpus" | "fixture"; id: string }>, string> {
  const found = /^(corpus|fixture):(.+)$/.exec(source);
  return found?.[1] !== undefined && found[2] !== undefined
    ? ok({ kind: found[1] as "corpus" | "fixture", id: found[2] })
    : err(`case source ${JSON.stringify(source)} is neither corpus:<id> nor fixture:<id>`);
}

/** A workload fixture's input: the fixture's own kind decides the one cell it can feed. */
function fixtureInput(caseId: string, fixture: WorkloadFixtures["fixtures"][string]): FixtureInput {
  return match(fixture)
    .with({ kind: "judge-verdict" }, (judge): FixtureInput => Object.freeze({ cell: "judge-verdict/v1" as const, caseId, fixture: judge }))
    .with({ kind: "refutation-verdict" }, (refutation): FixtureInput =>
      Object.freeze({ cell: "refutation-verdict/v1" as const, caseId, fixture: refutation }))
    .exhaustive();
}

/** Resolve one preregistered case's `source` to the input its cell can render, or why it cannot. */
export function resolveCaseInput(
  cell: CellKey,
  entry: Pick<WorkloadCase, "caseId" | "source">,
  corpus: ReadonlyMap<string, CalibrationCase>,
  fixtures: WorkloadFixtures,
  changedPathsOf: ChangedPathsOf,
): Result<CaseInput, string> {
  const { caseId, source } = entry;
  const parsed = parseCaseSource(source);
  if (!parsed.ok) return parsed;
  const { kind, id } = parsed.value;
  const corpusInput = (reviewerCell: ReviewerCell): Result<CaseInput, string> => {
    if (kind !== "corpus") return err(`case source ${source} is not a corpus case, which cell ${cell} needs`);
    const found = corpus.get(id);
    return found === undefined
      ? err(`corpus case ${id} is not in the corpus`)
      : ok(Object.freeze({ cell: reviewerCell, caseId, corpusCase: found, changedPaths: changedPathsOf(found.revision) }));
  };
  const workloadFixtureInput = (): Result<CaseInput, string> => {
    if (kind !== "fixture") return err(`case source ${source} is not a workload fixture, which cell ${cell} needs`);
    const found = fixtures.fixtures[id];
    if (found === undefined) return err(`workload fixture ${id} is not in the fixture file`);
    const input = fixtureInput(caseId, found);
    return input.cell === cell ? ok(input) : err(`workload fixture ${id} is a ${found.kind} fixture, which cannot feed cell ${cell}`);
  };
  return match(cell)
    .with("reviewer-payload/v2", "reviewer-payload/v3", corpusInput)
    .with("judge-verdict/v1", "refutation-verdict/v1", workloadFixtureInput)
    .exhaustive();
}

/** Every preregistered case's input, or every case that cannot be resolved —
 *  refused before any window opens. */
export function resolveWindowInputs(
  prereg: Preregistration,
  fixtures: WorkloadFixtures,
  corpusCases: readonly CalibrationCase[],
  changedPathsOf: ChangedPathsOf,
): Result<WindowInputs, readonly string[]> {
  const corpus = new Map(corpusCases.map((entry) => [entry.id, entry] as const));
  const inputs = new Map<CaseInputKey, CaseInput>();
  const problems: string[] = [];
  for (const cell of prereg.cells) {
    for (const entry of cell.workload.cases) {
      const resolved = resolveCaseInput(cell.cell, entry, corpus, fixtures, changedPathsOf);
      if (resolved.ok) inputs.set(caseInputKey(cell.cell, entry.caseId), resolved.value);
      else problems.push(`${cell.cell} case ${entry.caseId}: ${resolved.error}`);
    }
  }
  return problems.length > 0 ? err(Object.freeze(problems)) : ok(inputs);
}

// ---------------------------------------------------------------------------
// Prompt rendering (matched across arms)
// ---------------------------------------------------------------------------

export type WireRoute =
  | Readonly<{ arm: "emission-enabled"; binding: IssuedEmissionBinding }>
  | Readonly<{ arm: "extraction-only" }>;

const VERDICT_FINAL_MESSAGE_CONTRACT =
  "Emit exactly one JSON object conforming to the verdict schema above. No other final output.";

/** The task body shared byte-for-byte by both arms of a pair: the input's cell decides it. */
export function renderTaskBody(input: CaseInput, fixtures: WorkloadFixtures): string {
  const schema = PILOT_CELLS[input.cell].schemaBytes;
  return match(input)
    .with({ cell: "reviewer-payload/v2" }, (corpus) => reviewerBody(corpus, schema, null))
    .with({ cell: "reviewer-payload/v3" }, (corpus) => reviewerBody(corpus, schema, fixtures.reviewer.v3Context))
    .with({ cell: "judge-verdict/v1" }, (judge) => judgeBody(judge.fixture, schema))
    .with({ cell: "refutation-verdict/v1" }, (refutation) => refutationBody(refutation.fixture, schema))
    .exhaustive();
}

function reviewerBody(
  input: Extract<CaseInput, { cell: ReviewerCell }>,
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
  const reviewer = PILOT_CELLS[cell].kind === "reviewer-payload";
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
