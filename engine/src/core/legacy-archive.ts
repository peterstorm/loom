/**
 * ═══════════ LEGACY ARCHIVE — deprecation horizon ═══════════
 *
 * The run-directory orchestration façade (RunDirHandle + orchestration-contract)
 * is the ONE state authority for standalone reviews, panels, and wave gates.
 * Everything in this module is a COMPATIBILITY READER for bytes produced by
 * older generations of the system — the legacy state-manager/panel-journal
 * model that the façade replaced additively. These readers exist so historical
 * runs remain consumable and auditable; they are NOT domain logic.
 *
 * Deprecation horizon (A11, round-42): freeze every legacy reader behind this
 * single documented archive module, out of the active core files. Delete these
 * functions — and the re-export facades in their former homes — once the
 * oldest historical run directories have been consumed or migrated; the
 * horizon is tracked by the archive sections below. Until then the rule is:
 *   - New code NEVER calls into this module. The façade reads the same
 *     evidence through standalone-review's canonical request-bound parsers.
 *   - No legacy reader may be extended to accept new shapes; a new on-disk
 *     form is a new canonical parser, not a new compatibility branch here.
 *   - The canonical modules (standalone-review, state-manager) re-export the
 *     moved functions with @deprecated markers so existing import sites and
 *     the test suite keep working while the migration completes.
 *
 * Pure module: no I/O, no clock, no randomness. (The façade's shell supplies
 * all bytes; these parsers only interpret them.)
 */

import { createHash } from "node:crypto";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import {
  aggregateCanonicalTranscripts,
  canonicalDigest,
  canonicalStandalonePanelFindingAuthority,
  canonicalStandalonePanelFindings,
  capturedReviewerResultFromText,
  decodeCapturedReviewerText,
  exactKeys,
  findingScopeErrors,
  isFrozenStandalonePanelAuthority,
  parseReviewerEvidence,
  parseStandalonePanelOutcomes,
  parseStandaloneReviewScope,
  uniqueNonEmpty,
  STANDALONE_REVIEW_SUBJECT,
  type AdjudicatedStandaloneReview,
  type FrozenStandalonePanelAuthority,
  type PanelRefutation,
  type ParsedPanelOutcomes,
  type StandaloneReviewerEvidence,
  type StandaloneReviewerRole,
  type StandaloneReviewState,
} from "./standalone-review";
import { parseArtifactDigest, parseArtifactRef, parseOrchestrationRunId, parseRequestId, parseSlotId, type ArtifactDigest, type ArtifactRef, type DomainResult, type NonEmpty, type OrchestrationRunId } from "./orchestration-contract";
import { findingsUnionError, parseStoredFindings } from "./findings";
import type { CompletedWaveGateRegistration, Finding, RefutedFinding, TaskGraph } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// Archive Section A — legacy standalone review aggregation.
// Former home: core/standalone-review.ts ("Historical CLI adapter only").
// Used by: helpers/standalone-review (the manual init/aggregate/finalize
// helper for historical runs). Deprecation horizon: the manual helper is
// replaced by `helper orchestration start standalone-review`; retire when no
// historical run directory still needs the legacy helper path.
// ─────────────────────────────────────────────────────────────────────────

/** Historical CLI adapter only. New orchestration must use aggregateStandaloneReview. */
export function aggregateLegacyStandaloneReview(input: {
  readonly runId: string;
  readonly scope: readonly string[];
  readonly transcripts: readonly Readonly<{
    agent: StandaloneReviewerRole;
    output: string;
    artifact?: ArtifactRef;
  }>[];
}): ParseResult<StandaloneReviewState> {
  const runId = input.runId.trim();
  const scope = parseStandaloneReviewScope(input.scope);
  const errors = [
    ...(runId === "" ? ["run id must be non-empty"] : []),
    ...(scope.ok ? [] : scope.errors),
    ...uniqueNonEmpty(input.transcripts.map(({ agent }) => agent), "review agents"),
  ];
  const parsedRun = parseOrchestrationRunId(runId);
  if (!parsedRun.ok) errors.push(parsedRun.error.message);
  const transcripts = input.transcripts.flatMap((transcript, index) => {
    const bytes = Buffer.from(transcript.output, "utf-8");
    const fallbackArtifact = parseArtifactRef({
      runId,
      slot: `reviewers/${index + 1}-${transcript.agent}.md`,
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    });
    if (!fallbackArtifact.ok) {
      errors.push(`${transcript.agent}: ${fallbackArtifact.error.message}`);
      return [];
    }
    const captured = capturedReviewerResultFromText(transcript.artifact ?? fallbackArtifact.value, transcript.output);
    if (!captured.ok) {
      errors.push(`${transcript.agent}: ${captured.error.message}`);
      return [];
    }
    // Minted through the same parsers the load boundary uses, so this archived
    // producer cannot introduce an identity the reader would refuse.
    const slotId = parseSlotId(`legacy-slot:${index + 1}`);
    const requestId = parseRequestId(`legacy-request:${index + 1}`);
    if (!slotId.ok || !requestId.ok) {
      errors.push(`${transcript.agent}: internal legacy slot identity is invalid`);
      return [];
    }
    const evidence: StandaloneReviewerEvidence = Object.freeze({
      authorityKind: "legacy-slot-bound",
      agent: transcript.agent,
      slotId: slotId.value,
      requestId: requestId.value,
      attempt: 1,
      modelProfile: null,
      contextDigest: null,
      artifact: captured.value.artifact,
    });
    const output = decodeCapturedReviewerText(captured.value);
    if (!output.ok) {
      errors.push(`${transcript.agent}: ${output.error.message}`);
      return [];
    }
    return [{ agent: transcript.agent, output: output.value, evidence }];
  });
  if (errors.length > 0 || !scope.ok) return fail(errors);
  return aggregateCanonicalTranscripts(runId, scope.value, transcripts);
}

// ─────────────────────────────────────────────────────────────────────────
// Archive Section B — unversioned historical result parser.
// Former home: core/standalone-review.ts ("unauthenticated-historical").
// Used by: handlers that read older run result.json files that predate the
// schema-v1 LC-2 publication proof. Deprecation horizon: retire once every
// run directory in the wild carries a schema-v1 result with its frozen panel
// authority; schema-v1 is and remains canonical-only.
// ─────────────────────────────────────────────────────────────────────────

function historicalPanelOutcomeValue(entry: Record<string, unknown>, snake: string, camel: string): unknown {
  return Object.hasOwn(entry, snake) ? entry[snake] : entry[camel];
}

function normalizeHistoricalPanel(
  rawPanel: Record<string, unknown>,
  criticals: readonly Finding[],
): Record<string, unknown> {
  const rawOutcomes = Array.isArray(rawPanel.outcomes) ? rawPanel.outcomes : [];
  const localIds = new Set(criticals.map(({ id }) => id));
  const outcomes = rawOutcomes.map((rawOutcome) => {
    if (!isRecord(rawOutcome)) return rawOutcome;
    const rawId = historicalPanelOutcomeValue(rawOutcome, "finding_id", "findingId");
    const findingId = typeof rawId === "string" && localIds.has(rawId)
      ? `${STANDALONE_REVIEW_SUBJECT}:${rawId}`
      : rawId;
    const historicalTask = historicalPanelOutcomeValue(rawOutcome, "task_id", "taskId");
    const taskId = historicalTask === undefined || historicalTask === "standalone" || historicalTask === STANDALONE_REVIEW_SUBJECT
      ? STANDALONE_REVIEW_SUBJECT
      : historicalTask;
    return {
      finding_id: findingId,
      task_id: taskId,
      claim: rawOutcome.claim,
      survives: rawOutcome.survives,
      refuted_by: historicalPanelOutcomeValue(rawOutcome, "refuted_by", "refutedBy"),
      reasoning: rawOutcome.reasoning,
      upheld_by: historicalPanelOutcomeValue(rawOutcome, "upheld_by", "upheldBy"),
      uncertain_from: historicalPanelOutcomeValue(rawOutcome, "uncertain_from", "uncertainFrom"),
    };
  });
  return {
    lenses: rawPanel.lenses,
    threshold: rawPanel.threshold,
    surviving: outcomes.filter((outcome) => isRecord(outcome) && outcome.survives === true).length,
    refuted: outcomes.filter((outcome) => isRecord(outcome) && outcome.survives === false).length,
    outcomes,
  };
}

export type HistoricalStandaloneReviewResult = AdjudicatedStandaloneReview & Readonly<{
  authorityKind: "unauthenticated-historical";
}>;

/**
 * Compatibility parser for explicitly unversioned historical bytes only.
 * Schema-v1 results are accepted solely by the LC-2 authoritative publication
 * parser, which requires frozen run/roster/finalization intent and its receipt.
 */
export function parseAdjudicatedStandaloneReview(
  raw: unknown,
  panelAuthority?: FrozenStandalonePanelAuthority,
): ParseResult<HistoricalStandaloneReviewResult> {
  if (!isRecord(raw)) return fail(["standalone review result must be an object"]);
  const versioned = Object.hasOwn(raw, "schema_version");
  if (versioned) return fail(["schema-v1 standalone results require authoritative LC-2 publication parsing"]);
  const v1Fields = [
    "schema_version", "run_id", "subject_id", "scope", "reviewer_evidence",
    "surviving_critical_findings", "advisory_findings", "refuted_critical_findings", "panel",
  ] as const;
  const historicalFields = [
    "run_id", "scope", "surviving_critical_findings", "advisory_findings", "refuted_critical_findings", "panel",
  ] as const;
  const errors = exactKeys(raw, versioned ? v1Fields : historicalFields, "result");
  if (versioned && raw.schema_version !== 1) errors.push("result.schema_version must be 1");
  if (versioned && raw.subject_id !== STANDALONE_REVIEW_SUBJECT) {
    errors.push(`result.subject_id must be '${STANDALONE_REVIEW_SUBJECT}'`);
  }
  const runId = typeof raw.run_id === "string" ? raw.run_id.trim() : "";
  if (runId === "") errors.push("result.run_id must be non-empty");
  const scope = parseStandaloneReviewScope(raw.scope, "result.scope");
  if (!scope.ok) errors.push(...scope.errors);

  if (!Array.isArray(raw.surviving_critical_findings)) errors.push("result.surviving_critical_findings must be an array");
  if (!Array.isArray(raw.advisory_findings)) errors.push("result.advisory_findings must be an array");
  const activeError = findingsUnionError(raw.surviving_critical_findings, "result.surviving_critical_findings");
  const advisoryError = findingsUnionError(raw.advisory_findings, "result.advisory_findings");
  if (activeError !== null) errors.push(activeError);
  if (advisoryError !== null) errors.push(advisoryError);
  const survivingCriticals = parseStoredFindings(raw.surviving_critical_findings);
  const advisories = parseStoredFindings(raw.advisory_findings);
  if (survivingCriticals.some(({ severity }) => severity !== "critical")) errors.push("result surviving findings must all be critical");
  if (advisories.some(({ severity }) => severity !== "advisory")) errors.push("result advisory findings must all be advisory");

  if (!Array.isArray(raw.refuted_critical_findings)) errors.push("result.refuted_critical_findings must be an array");
  const refutedCriticals: RefutedFinding[] = [];
  if (Array.isArray(raw.refuted_critical_findings)) {
    raw.refuted_critical_findings.forEach((entry, index) => {
      if (!isRecord(entry) || !isRecord(entry.finding) || !Array.isArray(entry.refutations)) {
        errors.push(`result.refuted_critical_findings[${index}] is malformed`);
        return;
      }
      const parsedFinding = parseStoredFindings([entry.finding]);
      if (parsedFinding.length !== 1 || parsedFinding[0]!.severity !== "critical") {
        errors.push(`result.refuted_critical_findings[${index}].finding must be critical`);
        return;
      }
      const refs = entry.refutations.flatMap((refutation, refutationIndex) => {
        if (!isRecord(refutation) || typeof refutation.lens !== "string" || refutation.lens.trim() === "" ||
            typeof refutation.reason !== "string" || refutation.reason.trim() === "") {
          errors.push(`result.refuted_critical_findings[${index}].refutations[${refutationIndex}] is malformed`);
          return [];
        }
        return [{ lens: refutation.lens.trim(), reason: refutation.reason.trim() }];
      });
      const [head, ...tail] = refs;
      if (head === undefined) errors.push(`result.refuted_critical_findings[${index}].refutations must be non-empty`);
      else refutedCriticals.push({ finding: parsedFinding[0]!, refutations: [head, ...tail] });
    });
  }

  const allDispositionIds = [
    ...survivingCriticals.map(({ id }) => id),
    ...advisories.map(({ id }) => id),
    ...refutedCriticals.map(({ finding }) => finding.id),
  ];
  if (new Set(allDispositionIds).size !== allDispositionIds.length) errors.push("result finding ids must be distinct across all dispositions");
  if (scope.ok) {
    errors.push(...findingScopeErrors(scope.value, survivingCriticals, "result.surviving_critical_findings"));
    errors.push(...findingScopeErrors(scope.value, advisories, "result.advisory_findings"));
    errors.push(...findingScopeErrors(scope.value, refutedCriticals.map(({ finding }) => finding), "result.refuted_critical_findings"));
  }

  const evidence = parseReviewerEvidence(versioned ? raw.reviewer_evidence : undefined, runId, "result.reviewer_evidence");
  if (!evidence.ok) errors.push(...evidence.errors);
  if (raw.panel !== null && !isRecord(raw.panel)) errors.push("result.panel must be null or an object");
  let panel: ParsedPanelOutcomes | null = null;
  const criticals = [...survivingCriticals, ...refutedCriticals.map(({ finding }) => finding)];
  if (isRecord(raw.panel)) {
    // Genuine unversioned compatibility is intentionally isolated here. Only
    // that historical reader may derive an expectation from serialized lenses.
    // Schema-v1 must receive independently frozen standalone panel authority.
    const panelInput = versioned ? raw.panel : normalizeHistoricalPanel(raw.panel, criticals);
    const historicalSerializedLenses = !versioned && Array.isArray(panelInput.lenses)
      ? panelInput.lenses.filter((lens): lens is string => typeof lens === "string")
      : [];
    const trustedAuthority = versioned && panelAuthority !== undefined &&
      isFrozenStandalonePanelAuthority(panelAuthority) && panelAuthority.standaloneRunId === runId
      ? panelAuthority
      : null;
    if (versioned && trustedAuthority === null) {
      errors.push("critical-bearing schema-v1 result requires independently frozen standalone panel authority");
    }
    const expectedLenses = trustedAuthority?.lenses ?? historicalSerializedLenses;
    if (trustedAuthority !== null && panelInput.threshold !== trustedAuthority.threshold) {
      errors.push("result.panel.threshold does not match independently frozen standalone panel authority");
    }
    const authorityCriticals = trustedAuthority === null
      ? criticals
      : trustedAuthority.findings.flatMap((expected) => {
          const localId = expected.id.startsWith(`${STANDALONE_REVIEW_SUBJECT}:`)
            ? expected.id.slice(STANDALONE_REVIEW_SUBJECT.length + 1)
            : "";
          const finding = criticals.find(({ id }) => id === localId);
          return finding === undefined ? [] : [finding];
        });
    if (trustedAuthority !== null && (
      authorityCriticals.length !== trustedAuthority.findings.length ||
      canonicalDigest(canonicalStandalonePanelFindingAuthority(authorityCriticals)) !== trustedAuthority.findingBriefDigest
    )) {
      errors.push("result critical dispositions do not match independently frozen panel finding-brief authority");
    }
    const parsedPanel = parseStandalonePanelOutcomes(
      panelInput,
      authorityCriticals,
      trustedAuthority?.findings.map(({ id, claim }) => ({ id, claim })) ?? canonicalStandalonePanelFindings(criticals),
      expectedLenses,
    );
    if (!parsedPanel.ok) errors.push(...parsedPanel.errors.map((error) => `result.panel: ${error}`));
    else {
      const survivingIds = new Set<string>(survivingCriticals.map(({ id }) => `${STANDALONE_REVIEW_SUBJECT}:${id}`));
      const refutedById = new Map<string, RefutedFinding>(refutedCriticals.map((record) =>
        [`${STANDALONE_REVIEW_SUBJECT}:${record.finding.id}`, record] as const));
      for (const outcome of parsedPanel.value.outcomes) {
        if (outcome.survives !== survivingIds.has(outcome.findingId)) {
          errors.push(`result.panel outcome ${outcome.findingId} disagrees with the final disposition`);
        }
        const refuted = refutedById.get(outcome.findingId);
        if (!outcome.survives && (refuted === undefined ||
            JSON.stringify(refuted.refutations) !== JSON.stringify(outcome.refutations))) {
          errors.push(`result.panel refutation evidence for ${outcome.findingId} disagrees with the final disposition`);
        }
      }
      panel = parsedPanel.value;
    }
  }
  if (criticals.length === 0 && panel !== null) errors.push("clean result must not contain panel outcomes");
  // Old serializers are read-only compatibility authority. Schema-v1 remains
  // strict: every critical disposition requires its canonical panel evidence.
  if (versioned && criticals.length > 0 && panel === null) {
    errors.push("critical-bearing schema-v1 result must contain canonical panel outcomes");
  }
  return errors.length > 0 || !scope.ok || !evidence.ok
    ? fail(errors)
    : ok(Object.freeze({
        authorityKind: "unauthenticated-historical" as const,
        schemaVersion: 1,
        runId,
        scope: Object.freeze([...scope.value]),
        reviewerEvidence: Object.freeze([...evidence.value]),
        survivingCriticals: Object.freeze([...survivingCriticals]),
        advisories: Object.freeze([...advisories]),
        refutedCriticals: Object.freeze(refutedCriticals.map(({ finding, refutations }) => Object.freeze({
          finding,
          refutations: Object.freeze(refutations.map(({ lens, reason }) => Object.freeze({ lens, reason }))) as NonEmpty<PanelRefutation>,
        }))),
        panel,
      }));
}

// ─────────────────────────────────────────────────────────────────────────
// Archive Section C — legacy wave-gate compatibility migration.
// Former home: state-manager.ts. Used by: complete-wave-gate (the migration
// path that registered a Wave Gate authority for a graph that predates
// active_wave_gate). Deprecation horizon: retire once no pre-registration
// graph can still be completed; the registered-wave-gate paths
// (ActiveWaveGateRegistration / findRegisteredWaveGateCompletionReplay) are
// canonical and stay in state-manager.
// ─────────────────────────────────────────────────────────────────────────

export type LegacyWaveGateCompatibilityAuthority = Readonly<{
  schemaVersion: 1;
  kind: "legacy-wave-gate-compatibility";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
}>;

/** Format-detected legacy anti-corruption parser. It never defaults a Wave:
 * protected current_wave (and an explicit --wave when supplied) must agree. */
export function deriveLegacyWaveGateCompatibilityAuthority(
  graph: TaskGraph,
  requestedWave: number | null,
): DomainResult<LegacyWaveGateCompatibilityAuthority, Readonly<{ kind: "legacy-wave-gate-migration-rejected"; message: string }>> {
  const reject = (message: string): DomainResult<never, Readonly<{ kind: "legacy-wave-gate-migration-rejected"; message: string }>> =>
    Object.freeze({ ok: false, error: Object.freeze({ kind: "legacy-wave-gate-migration-rejected", message }) });
  if (graph.active_wave_gate !== undefined) return reject("active Wave Gate authority already exists");
  if (graph.current_phase !== "execute" || graph.current_wave === undefined) {
    return reject("legacy Wave Gate migration requires explicit protected execute/current_wave authority");
  }
  if (requestedWave !== null && requestedWave !== graph.current_wave) {
    return reject(`requested wave ${requestedWave} does not match protected current_wave ${graph.current_wave}`);
  }
  const wave = graph.current_wave;
  if (graph.tasks.every((task) => task.wave !== wave)) return reject(`legacy Wave ${wave} has no protected Tasks`);
  if (graph.wave_gates[String(wave)] === undefined) return reject(`legacy Wave ${wave} has no wave_gates registration`);
  const serialized = JSON.stringify({
    schemaVersion: 1,
    kind: "legacy-wave-gate-compatibility-source",
    wave,
    // Completion mutates the gate booleans and Task statuses. Compatibility
    // identity is therefore derived only from immutable Wave membership and
    // plan authority so final-Wave replay resolves the original run exactly.
    taskIds: graph.tasks.filter((task) => task.wave === wave).map(({ id }) => id),
    planFile: graph.plan_file ?? graph.phase_artifacts.architecture ?? null,
  });
  const rawDigest = createHash("sha256").update(serialized).digest("hex");
  const runId = parseOrchestrationRunId(`legacy-wave:${rawDigest.slice(0, 32)}`);
  const digest = parseArtifactDigest(rawDigest);
  if (!runId.ok || !digest.ok) return reject("derived legacy Wave Gate compatibility identity is invalid");
  return Object.freeze({ ok: true, value: Object.freeze({
    schemaVersion: 1,
    kind: "legacy-wave-gate-compatibility",
    runId: runId.value,
    wave,
    authorityDigest: digest.value,
  }) });
}

export type LegacyWaveGateCompletionReplayError = Readonly<{
  kind: "legacy-wave-gate-completion-replay-rejected";
  message: string;
}>;

/** Pure terminal-history lookup used before compatibility migration and again
 * after lock races. Only the exact deterministic run/wave/digest plus the
 * completed protected graph shape is an idempotent replay. */
export function findLegacyWaveGateCompletionReplay(
  graph: TaskGraph,
  authority: LegacyWaveGateCompatibilityAuthority,
): DomainResult<CompletedWaveGateRegistration | null, LegacyWaveGateCompletionReplayError> {
  const reject = (message: string): DomainResult<never, LegacyWaveGateCompletionReplayError> =>
    Object.freeze({
      ok: false,
      error: Object.freeze({ kind: "legacy-wave-gate-completion-replay-rejected", message }),
    });
  const history = graph.wave_gate_history ?? [];
  const sameWave = history.find((entry) => entry.wave === authority.wave);
  const sameRun = history.find((entry) => entry.runId === authority.runId);
  if (sameWave !== undefined) {
    if (sameWave.runId !== authority.runId || sameWave.authorityDigest !== authority.authorityDigest) {
      return reject(`Wave ${authority.wave} terminal history conflicts with compatibility replay ${authority.runId}`);
    }
    const gate = graph.wave_gates[String(authority.wave)];
    const waveTasks = graph.tasks.filter((task) => task.wave === authority.wave);
    const exactTerminalGraph = graph.current_phase === "execute" && graph.current_wave === authority.wave &&
      !graph.tasks.some((task) => task.wave > authority.wave) && waveTasks.length > 0 &&
      waveTasks.every((task) => task.status === "completed") && gate !== undefined &&
      gate.impl_complete && gate.tests_passed === true && gate.reviews_complete && !gate.blocked;
    if (!exactTerminalGraph) {
      return reject(`Wave ${authority.wave} history matches run identity but protected terminal graph outcome is contradictory`);
    }
    return Object.freeze({ ok: true, value: sameWave });
  }
  if (sameRun !== undefined) {
    return reject(`Compatibility run ${authority.runId} is terminal for conflicting Wave ${sameRun.wave}`);
  }
  const newer = history.find((entry) => entry.wave > authority.wave);
  if (newer !== undefined) {
    return reject(`Legacy Wave ${authority.wave} is older than completed terminal Wave ${newer.wave}`);
  }
  return Object.freeze({ ok: true, value: null });
}

// ─────────────────────────────────────────────────────────────────────────
// Archive Section D — legacy v1 panel program journal translation.
// Former home: handlers/helpers/panel-program.ts. Used by: the panel-program
// helper and the orchestration façade's registration translation when a run
// carries a pre-facade journal. Deprecation horizon: retire once no run
// directory carries a v1 journal; new publications use the canonical
// panel-program journal shapes.
// ─────────────────────────────────────────────────────────────────────────

import type {
  ArchitectureEngineOperation,
  ArchitectureProgramEvent,
  RefutationEngineOperation,
  RefutationProgramEvent,
} from "./panel-program";
import { PANEL_LENSES, type PanelLens } from "./panel-contract";
import { parseReviewLens, parseWaveFindingId, type ReviewLens } from "./review-panel";

export const LEGACY_PANEL_PROGRAM_SCHEMA_VERSION = 1 as const;
export const PANELS = ["architecture", "refutation"] as const;
export type LegacyPanelKind = (typeof PANELS)[number];
const ARCHITECTURE_OPERATIONS: readonly ArchitectureEngineOperation[] = [
  "architecture-prepare-candidates",
  "architecture-prepare-judges",
  "architecture-aggregate",
];
const REFUTATION_OPERATIONS: readonly RefutationEngineOperation[] = [
  "refutation-prepare-verifiers",
  "refutation-tally",
];

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parseArchitectureLenses(value: unknown): readonly PanelLens[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: PanelLens[] = [];
  for (const entry of value) {
    const lens = PANEL_LENSES.find((candidate) => candidate === entry);
    if (lens === undefined) return null;
    parsed.push(lens);
  }
  return Object.freeze(parsed);
}

function parseRefutationLenses(value: unknown): readonly ReviewLens[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: ReviewLens[] = [];
  for (const entry of value) {
    const lens = parseReviewLens(entry);
    if (lens === null) return null;
    parsed.push(lens);
  }
  return Object.freeze(parsed);
}

function parseEvent(panel: "architecture", raw: unknown, index: number): ArchitectureProgramEvent | string;
function parseEvent(panel: "refutation", raw: unknown, index: number): RefutationProgramEvent | string;
function parseEvent(panel: LegacyPanelKind, raw: unknown, index: number): ArchitectureProgramEvent | RefutationProgramEvent | string {
  if (!record(raw)) return `events[${index}] must be an object`;
  if (raw.type === "spawn-outcome") {
    if (typeof raw.requestId !== "string" || (raw.attempt !== 1 && raw.attempt !== 2)
      || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return `events[${index}] is not a valid spawn-outcome`;
    }
    if (raw.error !== undefined && typeof raw.error !== "string") return `events[${index}].error must be a string`;
    return Object.freeze({
      type: "spawn-outcome" as const,
      requestId: raw.requestId,
      attempt: raw.attempt,
      outcome: raw.outcome,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    });
  }
  if (raw.type === "engine-outcome") {
    const allowedOperations: readonly string[] = panel === "architecture"
      ? ARCHITECTURE_OPERATIONS
      : REFUTATION_OPERATIONS;
    if (typeof raw.operationId !== "string"
      || !allowedOperations.includes(raw.operationId)
      || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return `events[${index}] is not a valid ${panel} engine-outcome`;
    }
    if (raw.error !== undefined && typeof raw.error !== "string") return `events[${index}].error must be a string`;
    const event = Object.freeze({
      type: "engine-outcome" as const,
      operationId: raw.operationId,
      outcome: raw.outcome,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    });
    return panel === "architecture"
      ? event as ArchitectureProgramEvent
      : event as RefutationProgramEvent;
  }
  return `events[${index}].type must be spawn-outcome or engine-outcome`;
}

export type LegacyArchitecturePanelJournal = Readonly<{
  format: "legacy-panel-program";
  schemaVersion: 1;
  panel: "architecture";
  input: Readonly<{ candidateLenses: readonly PanelLens[]; judgeCriteria: readonly string[] }>;
  events: readonly ArchitectureProgramEvent[];
}>;

export type LegacyRefutationPanelJournal = Readonly<{
  format: "legacy-panel-program";
  schemaVersion: 1;
  panel: "refutation";
  input: Readonly<{ criticalFindingIds: readonly NonNullable<ReturnType<typeof parseWaveFindingId>>[]; lenses: readonly ReviewLens[] }>;
  events: readonly RefutationProgramEvent[];
}>;

export type LegacyPanelJournal = LegacyArchitecturePanelJournal | LegacyRefutationPanelJournal;

export type LegacyJournalTranslation =
  | Readonly<{ ok: true; value: LegacyPanelJournal }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Format-detect and translate a historical/in-flight v1 journal in memory.
 * The caller-owned document and its event prefix are never rewritten. A
 * schemaVersion of 1 is accepted for forward-written compatibility copies;
 * absence is the original on-disk spelling.
 */
export function translateLegacyPanelJournal(
  panel: LegacyPanelKind,
  raw: unknown,
): LegacyJournalTranslation {
  try {
    if (!record(raw) || !record(raw.input) || !Array.isArray(raw.events)) {
      return { ok: false, error: "Panel program requires {input, events: []}" };
    }
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== LEGACY_PANEL_PROGRAM_SCHEMA_VERSION) {
      return { ok: false, error: `Unsupported legacy panel journal schemaVersion: ${String(raw.schemaVersion)}` };
    }
    if (raw.format !== undefined && raw.format !== "legacy-panel-program") {
      return { ok: false, error: `Unsupported panel journal format: ${String(raw.format)}` };
    }
    if (raw.panel !== undefined && raw.panel !== panel) {
      return { ok: false, error: `Panel journal declares '${String(raw.panel)}' but was opened as '${panel}'` };
    }
    if (panel === "architecture") {
      const candidateLenses = parseArchitectureLenses(raw.input.candidateLenses);
      if (candidateLenses === null || !strings(raw.input.judgeCriteria)) {
        const unknownLens = strings(raw.input.candidateLenses)
          ? raw.input.candidateLenses.find((lens) => !(PANEL_LENSES as readonly string[]).includes(lens))
          : undefined;
        return unknownLens === undefined
          ? { ok: false, error: "architecture input requires exact PanelLens candidateLenses[] and judgeCriteria[]" }
          : { ok: false, error: `unknown architecture design lens: ${unknownLens}` };
      }
      const events: ArchitectureProgramEvent[] = [];
      for (let index = 0; index < raw.events.length; index++) {
        const parsed = parseEvent("architecture", raw.events[index], index);
        if (typeof parsed === "string") return { ok: false, error: parsed };
        events.push(parsed);
      }
      return {
        ok: true,
        value: Object.freeze({
          format: "legacy-panel-program" as const,
          schemaVersion: 1 as const,
          panel,
          input: Object.freeze({
            candidateLenses,
            judgeCriteria: Object.freeze([...raw.input.judgeCriteria]),
          }),
          events: Object.freeze([...events]) as readonly ArchitectureProgramEvent[],
        }),
      };
    }

    const lenses = parseRefutationLenses(raw.input.lenses);
    if (!strings(raw.input.criticalFindingIds) || lenses === null) {
      const unknownLens = strings(raw.input.lenses)
        ? raw.input.lenses.find((lens) => parseReviewLens(lens) === null)
        : undefined;
      return unknownLens === undefined
        ? { ok: false, error: "refutation input requires criticalFindingIds[] and exact ReviewLens lenses[]" }
        : { ok: false, error: `unknown refutation lens: ${unknownLens}` };
    }
    const events: RefutationProgramEvent[] = [];
    for (let index = 0; index < raw.events.length; index++) {
      const parsed = parseEvent("refutation", raw.events[index], index);
      if (typeof parsed === "string") return { ok: false, error: parsed };
      events.push(parsed);
    }
    const criticalFindingIds = raw.input.criticalFindingIds.map(parseWaveFindingId);
    const malformedId = criticalFindingIds.findIndex((id) => id === null);
    if (malformedId >= 0) {
      return { ok: false, error: `criticalFindingIds[${malformedId}] must be a wave-scoped task-id:finding-id` };
    }
    return {
      ok: true,
      value: Object.freeze({
        format: "legacy-panel-program" as const,
        schemaVersion: 1 as const,
        panel,
        input: Object.freeze({
          criticalFindingIds: Object.freeze(criticalFindingIds.filter(
            (id): id is NonNullable<typeof id> => id !== null,
          )),
          lenses,
        }),
        events: Object.freeze([...events]) as readonly RefutationProgramEvent[],
      }),
    };
  } catch (error) {
    // Bind the thrown cause: a shape TypeError (raw.events.length on undefined,
    // raw.input.judgeCriteria on undefined, .map on a non-array) is a real
    // journal defect the operator must be able to diagnose. A static message
    // with no cause made a typo'd journal indistinguishable from a parser
    // drift, six months later.
    return { ok: false, error: `Panel program journal could not be safely inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
}