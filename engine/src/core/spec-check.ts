import type {
  ManualOverrideFloor,
  SettledFloor,
  SpecCheckFloorAuthority,
} from "./requirement-coverage";
import { isNoFindingSentinel } from "../utils/no-finding-sentinel";
import { reconcileWaveBlock } from "./wave-gate-model";
import type { AgentRequestAuthority } from "./orchestration-contract";
import {
  parseSpecCheckVerdict,
  type CapturedSpecCheck,
  type CapturedSpecCheckVerdict,
  type EvidenceFailedSpecCheck,
  type SpecCheck,
  type SpecCheckEvidenceFailureCause,
  type SpecCheckVerdict,
  type TaskGraph,
  type WaveSpecCheckDocumentsAuthority,
} from "../types";
import { waveSpecCheckDocumentsMatch } from "./wave-review-authority";

export interface ParsedSpecCheckOutput {
  readonly critical: readonly string[];
  readonly high: readonly string[];
  readonly medium: readonly string[];
  readonly criticalCount: number | null;
  readonly highCount: number | null;
  readonly verdict: SpecCheckVerdict | null;
  readonly wave: number | null;
  readonly duplicateMarkers: readonly string[];
  /**
   * Why an operator is overriding captured evidence by hand. `null` is a
   * different answer from an empty string: an override is either deliberate and
   * attributable, or it did not happen.
   */
  readonly overrideReason: string | null;
}

export type SpecCheckResolution =
  | Readonly<{ kind: "captured"; specCheck: CapturedSpecCheck }>
  | Readonly<{ kind: "evidence-failed"; specCheck: EvidenceFailedSpecCheck }>;

export type SpecCheckParseResult =
  | Readonly<{ ok: true; value: SpecCheck }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const SPEC_FINDING_MARKERS = Object.freeze([
  Object.freeze({ prefix: "CRITICAL:", target: "critical" as const }),
  Object.freeze({ prefix: "HIGH:", target: "high" as const }),
  Object.freeze({ prefix: "MEDIUM:", target: "medium" as const }),
]);

function allMatches(input: string, regex: RegExp): readonly RegExpMatchArray[] {
  return [...input.matchAll(regex)];
}

function lastMatch(input: string, regex: RegExp): RegExpMatchArray | null {
  return allMatches(input, regex).at(-1) ?? null;
}

type ScalarMarker = Readonly<{
  name: string;
  matches: readonly RegExpMatchArray[];
}>;

function scalarMarker(input: string, name: string, regex: RegExp): ScalarMarker {
  return Object.freeze({ name, matches: Object.freeze(allMatches(input, regex)) });
}

/** Collect the itemized finding lines from the authoritative footer block. */
function footerFindings(searchBlock: string): Readonly<{
  critical: readonly string[];
  high: readonly string[];
  medium: readonly string[];
}> {
  const findings = { critical: [] as string[], high: [] as string[], medium: [] as string[] };
  for (const line of searchBlock.split("\n")) {
    const marker = SPEC_FINDING_MARKERS.find(({ prefix }) => line.startsWith(prefix));
    if (marker === undefined) continue;
    const claim = line.slice(marker.prefix.length).trim();
    if (claim !== "" && !isNoFindingSentinel(claim)) findings[marker.target].push(claim);
  }
  return findings;
}

/**
 * Parse the final concrete spec-check footer, bounded by its verdict when one
 * landed. A final incomplete footer remains authoritative and reconciles to
 * evidence failure; it never lends an earlier footer's counts or verdict.
 */
export function parseSpecCheckOutput(output: string): ParsedSpecCheckOutput {
  const finalWaveMarker = lastMatch(output, /^SPEC_CHECK_WAVE:\s*.*$/gm);
  const blockStart = finalWaveMarker?.index ?? 0;
  const footer = output.slice(blockStart);
  const verdictMarker = /^SPEC_CHECK_VERDICT:\s*(?:PASSED|BLOCKED)\s*$/m.exec(footer);
  const blockEnd = verdictMarker?.index === undefined
    ? footer.length
    : verdictMarker.index + verdictMarker[0].length;
  const searchBlock = footer.slice(0, blockEnd);

  const { critical, high, medium } = footerFindings(searchBlock);

  const criticalCount = scalarMarker(searchBlock, "SPEC_CHECK_CRITICAL_COUNT", /^SPEC_CHECK_CRITICAL_COUNT:\s*(\d+)\s*$/gm);
  const highCount = scalarMarker(searchBlock, "SPEC_CHECK_HIGH_COUNT", /^SPEC_CHECK_HIGH_COUNT:\s*(\d+)\s*$/gm);
  // Verdicts are terminal but contradiction-sensitive: counts/findings after
  // the first verdict remain trailing prose, while another complete verdict
  // anywhere in this final Wave footer invalidates the whole footer.
  const verdict = scalarMarker(footer, "SPEC_CHECK_VERDICT", /^SPEC_CHECK_VERDICT:\s*(PASSED|BLOCKED)\s*$/gm);
  const wave = scalarMarker(searchBlock, "SPEC_CHECK_WAVE", /^SPEC_CHECK_WAVE:\s*(\d+)\s*$/gm);
  const override = scalarMarker(searchBlock, "SPEC_CHECK_OVERRIDE", /^SPEC_CHECK_OVERRIDE:\s*(.*)$/gm);
  const uniqueValue = (marker: ScalarMarker): string | null =>
    marker.matches.length === 1 ? (marker.matches[0]?.[1] ?? null) : null;
  const criticalCountValue = uniqueValue(criticalCount);
  const highCountValue = uniqueValue(highCount);
  const verdictValue = uniqueValue(verdict);
  const waveValue = uniqueValue(wave);
  const overrideText = uniqueValue(override)?.trim() ?? "";
  return {
    critical,
    high,
    medium,
    criticalCount: criticalCountValue === null ? null : Number(criticalCountValue),
    highCount: highCountValue === null ? null : Number(highCountValue),
    verdict: verdictValue === null ? null : parseSpecCheckVerdict(verdictValue),
    wave: waveValue === null ? null : Number(waveValue),
    duplicateMarkers: Object.freeze(
      [criticalCount, highCount, verdict, wave, override]
        .filter((marker) => marker.matches.length > 1)
        .map(({ name }) => name),
    ),
    overrideReason: overrideText === "" ? null : overrideText,
  };
}

export type SpecCheckRequestAuthority = Pick<
  AgentRequestAuthority,
  "runId" | "slotId" | "attempt" | "role"
>;

/**
 * One owner of the question "is this the current spec-check capability?"
 *
 * The same invariant was decided independently by the Wave Gate façade, the
 * Claude SubagentStop hook, the Pi shell, and the manual `store-spec-check`
 * helper, and the copies demanded different conjuncts — which is how a
 * stdin-only helper call could flip a Wave's spec gate from
 * `EVIDENCE_CAPTURE_FAILED` to `PASSED`. `null` means the evidence may be
 * written; a string names the exact mismatch.
 */
export function specCheckAuthorityProblem(
  state: TaskGraph,
  authority: SpecCheckRequestAuthority | undefined,
  documents?: WaveSpecCheckDocumentsAuthority,
): string | null {
  const epoch = state.wave_review_epoch;
  const active = state.active_wave_gate;
  if (epoch === undefined && active === undefined) {
    const modernAuthorityHistory = state.spec_trace_version === 2 ||
      state.verification_manifest !== undefined ||
      state.active_wave_completion_suite !== undefined ||
      (state.wave_gate_history?.length ?? 0) > 0 ||
      (state.wave_reopening_history?.length ?? 0) > 0 ||
      (state.task_reopening_history?.length ?? 0) > 0 ||
      (state.orphaned_wave_gate_history?.length ?? 0) > 0 ||
      (state.spec_trace_wave_gate_retirements?.length ?? 0) > 0;
    if (authority !== undefined) {
      return `captured spec-check request ${authority.runId}/${authority.slotId}/${authority.attempt} has no current Wave authority`;
    }
    return modernAuthorityHistory
      ? "modern Wave spec-check has no current capture-correlated request authority"
      : null;
  }
  if (authority === undefined) return "modern Wave spec-check has no capture-correlated request authority";
  if (authority.role !== "spec-check-invoker") return `captured request belongs to ${authority.role}`;
  if (documents === undefined || !waveSpecCheckDocumentsMatch(epoch?.specCheckDocuments, documents) ||
      state.spec_file !== documents.spec.path || state.plan_file !== documents.plan.path) {
    return "current spec/plan bytes do not match the exact Wave spec-check authority";
  }
  const slot = epoch?.specCheckSlotAuthority;
  return state.current_phase === "execute" && epoch !== undefined && active !== undefined &&
      state.current_wave === epoch.wave && active.runId === authority.runId && active.wave === epoch.wave &&
      epoch.runId === authority.runId && slot?.slot_id === authority.slotId && slot.attempted === authority.attempt
    ? null
    : `captured spec-check request ${authority.runId}/${authority.slotId}/${authority.attempt} does not match the exact current Wave epoch`;
}

export type SpecCheckManualOverride =
  /** Legacy graph: the documented manual route is available as before. */
  | Readonly<{ kind: "allowed"; reason: string | null }>
  /** A registered Wave Gate owns this Wave; only its capture route may write. */
  | Readonly<{ kind: "refused-active"; problem: string }>
  /** Modern graph with no active run: allowed only as an attributable override. */
  | Readonly<{ kind: "requires-reason"; problem: string }>;

/**
 * May `helper store-spec-check` write protected spec-check state at all?
 *
 * The helper is the documented, user-approved override for false positives, so
 * it is not deleted — but it carries no capture-correlated request authority.
 * While a registered run owns the Wave it must not write at all: doing so could
 * flip a failed spec gate, clear the derived Wave block, and suppress that run's
 * real spec-check spawn.
 */
export function decideSpecCheckManualOverride(
  state: TaskGraph,
  overrideReason: string | null,
): SpecCheckManualOverride {
  const problem = specCheckAuthorityProblem(state, undefined);
  if (problem === null) return Object.freeze({ kind: "allowed", reason: overrideReason });
  if (state.wave_review_epoch !== undefined || state.active_wave_gate !== undefined) {
    return Object.freeze({ kind: "refused-active", problem });
  }
  return overrideReason === null
    ? Object.freeze({ kind: "requires-reason", problem })
    : Object.freeze({ kind: "allowed", reason: overrideReason });
}

/**
 * Whether a durably captured spec-check transcript still needs semantic
 * re-application after a crash window.
 *
 * The Wave Gate resume loop writes transcript bytes to disk before applying
 * them, so it must re-apply anything whose durable capture is not reflected in
 * protected state. Only a `transcript` failure is re-applyable: settled-floor
 * and projection-unavailable failures are deterministic decisions under the
 * epoch authority, so the same bytes cannot repair them. Preserving those
 * answers stops the resume loop from replacing a decided refusal.
 */
export function specCheckNeedsReapplication(specCheck: SpecCheck | undefined, wave: number): boolean {
  if (specCheck === undefined || specCheck.wave !== wave) return true;
  if (specCheck.verdict !== "EVIDENCE_CAPTURE_FAILED") return false;
  return specCheck.cause === "transcript";
}

function frozenEvidenceFailure(
  wave: number,
  runAt: string,
  error: string,
  cause: SpecCheckEvidenceFailureCause,
): EvidenceFailedSpecCheck {
  return Object.freeze({ wave, run_at: runAt, verdict: "EVIDENCE_CAPTURE_FAILED", error, cause });
}

function frozenCapturedSpecCheck(
  wave: number,
  runAt: string,
  verdict: CapturedSpecCheckVerdict,
  criticalFindings: readonly string[],
  highFindings: readonly string[],
  mediumFindings: readonly string[],
  evidenceSource?: CapturedSpecCheck["evidence_source"],
): CapturedSpecCheck {
  const critical = Object.freeze([...criticalFindings]);
  const high = Object.freeze([...highFindings]);
  return Object.freeze({
    wave,
    run_at: runAt,
    verdict,
    critical_count: critical.length,
    high_count: high.length,
    critical_findings: critical,
    high_findings: high,
    medium_findings: Object.freeze([...mediumFindings]),
    ...(evidenceSource === undefined
      ? {}
      : { evidence_source: Object.freeze({ ...evidenceSource }) }),
  }) as CapturedSpecCheck;
}

export type CapturedSpecCheckInput = Readonly<{
  wave: number;
  runAt: string;
  criticalFindings: readonly string[];
  highFindings?: readonly string[];
  mediumFindings?: readonly string[];
  evidenceSource?: CapturedSpecCheck["evidence_source"];
}>;

/** Semantic mint for trusted in-memory callers; verdict and counts are derived. */
export function capturedSpecCheck(input: CapturedSpecCheckInput): CapturedSpecCheck {
  return frozenCapturedSpecCheck(
    input.wave,
    input.runAt,
    input.criticalFindings.length === 0 ? "PASSED" : "BLOCKED",
    input.criticalFindings,
    input.highFindings ?? [],
    input.mediumFindings ?? [],
    input.evidenceSource,
  );
}

const evidenceFailure = (
  wave: number,
  runAt: string,
  error: string,
  cause: SpecCheckEvidenceFailureCause,
): SpecCheckResolution => Object.freeze({
  kind: "evidence-failed",
  specCheck: frozenEvidenceFailure(wave, runAt, error, cause),
});

/**
 * Reconcile marker counts with their itemized views before constructing gate
 * state. Every harness calls this function, so a transcript cannot be clean on
 * one harness and evidence-failed on another.
 *
 * `settledFloor` is that same promise applied to the Requirement Coverage
 * Projection. It lives HERE, not beside one harness's call, for exactly the
 * reason this contract already states: a floor enforced outside
 * `reconcileSpecCheck` existed on the Claude SubagentStop hook alone. The Pi
 * transport and the Wave Gate façade both committed the Agent's own count
 * unchecked — and the façade's resume loop re-applied the transcript through
 * its unfloored path precisely BECAUSE the floor had written
 * `EVIDENCE_CAPTURE_FAILED`, erasing the refusal it had just recorded.
 *
 * The parameter is REQUIRED and is an ADT, not a nullable number, so an
 * unfloored settlement cannot be reached by omission. `unprojected` states WHY
 * registered evidence lacks projection authority and fails closed; the distinct
 * `manual-override` arm is minted only after the operator-override authority
 * check and therefore cannot be persisted on a Wave epoch.
 */
export function reconcileSpecCheck(
  parsed: ParsedSpecCheckOutput,
  wave: number,
  runAt: string,
  floorAuthority: SpecCheckFloorAuthority,
): SpecCheckResolution {
  if (parsed.duplicateMarkers.length > 0) {
    return evidenceFailure(
      wave,
      runAt,
      `${parsed.duplicateMarkers.join(", ")} marker appears more than once in the authoritative footer - re-run /wave-gate`,
      "transcript",
    );
  }
  if (parsed.wave === null) {
    return evidenceFailure(wave, runAt, "SPEC_CHECK_WAVE marker not found - re-run /wave-gate", "transcript");
  }
  if (!Number.isSafeInteger(parsed.wave) || parsed.wave !== wave) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_WAVE (${parsed.wave}) does not match protected Wave ${wave} - re-run /wave-gate`,
      "transcript",
    );
  }
  if (parsed.criticalCount === null) {
    return evidenceFailure(wave, runAt, "SPEC_CHECK_CRITICAL_COUNT marker not found - re-run /wave-gate", "transcript");
  }
  if (parsed.highCount === null) {
    return evidenceFailure(wave, runAt, "SPEC_CHECK_HIGH_COUNT marker not found - re-run /wave-gate", "transcript");
  }
  if (parsed.verdict === null) {
    return evidenceFailure(wave, runAt, "SPEC_CHECK_VERDICT marker not found - re-run /wave-gate", "transcript");
  }
  if (parsed.criticalCount !== parsed.critical.length) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_CRITICAL_COUNT (${parsed.criticalCount}) does not match CRITICAL: findings (${parsed.critical.length}); counts must match the findings - re-run /wave-gate`,
      "transcript",
    );
  }
  const highCount = parsed.highCount;
  if (highCount !== parsed.high.length) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_HIGH_COUNT (${highCount}) does not match HIGH: findings (${parsed.high.length}); counts must match the findings - re-run /wave-gate`,
      "transcript",
    );
  }
  const expectedVerdict: CapturedSpecCheckVerdict = parsed.criticalCount === 0 ? "PASSED" : "BLOCKED";
  if (parsed.verdict !== expectedVerdict) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_VERDICT must be ${expectedVerdict} when SPEC_CHECK_CRITICAL_COUNT is ${parsed.criticalCount} - re-run /wave-gate`,
      "transcript",
    );
  }
  // Last, so malformed evidence reports its concrete transcript defect first.
  // An unavailable projection is an absence of evidence, never a pass. Manual
  // operator authority is a separate arm and deliberately skips this refusal.
  if (floorAuthority.kind === "unprojected") {
    return evidenceFailure(
      wave,
      runAt,
      `Requirement Coverage Projection unavailable: ${floorAuthority.reason}; ` +
      "absence of projection evidence cannot pass a Wave Gate - restore projection authority and re-run /wave-gate",
      "projection-unavailable",
    );
  }
  // A floor, never an equality: the Agent is expected to ADD findings its own
  // reading turns up; it may never subtract the engine's.
  if ((floorAuthority.kind === "settled" || floorAuthority.kind === "legacy-settled") &&
      parsed.criticalCount < floorAuthority.count) {
    return evidenceFailure(
      wave,
      runAt,
      `spec-check reported ${parsed.criticalCount} CRITICAL but the Requirement Coverage Projection settled ${floorAuthority.count}` +
      `; settled rows are decided by structure and are not the Agent's to drop - re-run /wave-gate`,
      "settled-floor",
    );
  }
  if (floorAuthority.kind === "settled") {
    // Multiset subtraction keeps this correct even for a forged typed floor;
    // the persisted parser additionally rejects duplicate identities outright.
    const remaining = [...parsed.critical];
    const omitted = floorAuthority.criticalFindings.filter((finding) => {
      const index = remaining.indexOf(finding);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
    if (omitted.length > 0) {
      return evidenceFailure(
        wave,
        runAt,
        `spec-check omitted ${omitted.length} engine-settled CRITICAL finding(s): ${omitted.join("; ")} - re-run /wave-gate`,
        "settled-floor",
      );
    }
  }
  return Object.freeze({
    kind: "captured",
    specCheck: frozenCapturedSpecCheck(
      wave,
      runAt,
      expectedVerdict,
      parsed.critical,
      parsed.high,
      parsed.medium,
      floorAuthority.kind === "manual-override"
        ? Object.freeze({ kind: "manual-override" as const, reason: floorAuthority.reason })
        : undefined,
    ),
  });
}

export type SpecCheckSettlementCommand =
  | Readonly<{
      kind: "registered-transcript";
      parsed: ParsedSpecCheckOutput;
      wave: number;
      runAt: string;
      floor: SettledFloor;
    }>
  | Readonly<{
      kind: "manual-transcript";
      parsed: ParsedSpecCheckOutput;
      wave: number;
      runAt: string;
      authority: ManualOverrideFloor;
    }>
  | Readonly<{
      kind: "capture-failure";
      wave: number;
      runAt: string;
      error: string;
    }>;

export type SpecCheckSettlement =
  | Readonly<{ kind: "applied"; state: TaskGraph; specCheck: SpecCheck }>
  | Readonly<{ kind: "manual-evidence-refused"; state: TaskGraph; specCheck: EvidenceFailedSpecCheck }>;

/**
 * Pure aggregate command for every spec-check transport. It owns both evidence
 * construction and Wave-block reconciliation so a shell cannot persist one
 * without the other. Manual malformed evidence is the sole non-applying arm.
 */
export function settleSpecCheck(
  state: TaskGraph,
  command: Exclude<SpecCheckSettlementCommand, { kind: "manual-transcript" }>,
): Extract<SpecCheckSettlement, { kind: "applied" }>;
export function settleSpecCheck(
  state: TaskGraph,
  command: Extract<SpecCheckSettlementCommand, { kind: "manual-transcript" }>,
): SpecCheckSettlement;
export function settleSpecCheck(
  state: TaskGraph,
  command: SpecCheckSettlementCommand,
): SpecCheckSettlement {
  const resolution = command.kind === "capture-failure"
    ? evidenceFailure(command.wave, command.runAt, command.error, "transcript")
    : reconcileSpecCheck(
        command.parsed,
        command.wave,
        command.runAt,
        command.kind === "manual-transcript" ? command.authority : command.floor,
      );
  if (command.kind === "manual-transcript" && resolution.kind === "evidence-failed") {
    return Object.freeze({ kind: "manual-evidence-refused", state, specCheck: resolution.specCheck });
  }
  const specCheck = resolution.specCheck;
  return Object.freeze({
    kind: "applied",
    state: Object.freeze({
      ...state,
      spec_check: specCheck,
      wave_gates: reconcileWaveBlock(state.wave_gates, state.tasks, specCheck, command.wave),
    }),
    specCheck,
  });
}

const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Parse persisted spec-check state into its captured/evidence-failed ADT. */
export function parseStoredSpecCheck(raw: unknown): SpecCheckParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["spec_check must be an object when present"] };
  }
  const spec = raw as Record<string, unknown>;
  const verdict = typeof spec.verdict === "string" ? parseSpecCheckVerdict(spec.verdict) : null;
  const errors: string[] = [];
  if (!Number.isSafeInteger(spec.wave) || (spec.wave as number) < 1) {
    errors.push(`spec_check.wave must be a safe integer >= 1, got ${JSON.stringify(spec.wave)}`);
  }
  if (typeof spec.run_at !== "string") {
    errors.push(`spec_check.run_at must be a string, got ${JSON.stringify(spec.run_at)}`);
  }
  if (verdict === null) {
    errors.push(`spec_check.verdict ${JSON.stringify(spec.verdict)} is not recognized`);
  }
  if (errors.length > 0 || verdict === null) return { ok: false, errors };

  return verdict === "EVIDENCE_CAPTURE_FAILED"
    ? parseFailedSpecCheck(spec)
    : parseCapturedSpecCheck(spec, verdict);
}

/** The evidence-failed arm: a cause and an operator message, and no counts. */
function parseFailedSpecCheck(spec: Record<string, unknown>): SpecCheckParseResult {
  const errors: string[] = [];
  if (typeof spec.error !== "string" || spec.error.trim() === "") {
    errors.push("spec_check.error must be a non-empty string when evidence capture failed");
  }
  if (spec.cause !== undefined && spec.cause !== "transcript" &&
      spec.cause !== "settled-floor" && spec.cause !== "projection-unavailable") {
    errors.push(`spec_check.cause ${JSON.stringify(spec.cause)} is not recognized`);
  }
  for (const field of [
    "critical_count", "high_count", "critical_findings", "high_findings", "medium_findings", "evidence_source",
  ] as const) {
    if (spec[field] !== undefined) errors.push(`spec_check.${field} must be absent when evidence capture failed`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: freshEvidenceFailed(spec) };
}

/** The captured arm: counts that must agree with the findings they summarize. */
function parseCapturedSpecCheck(
  spec: Record<string, unknown>,
  verdict: Exclude<SpecCheckVerdict, "EVIDENCE_CAPTURE_FAILED">,
): SpecCheckParseResult {
  const errors: string[] = [];
  if (spec.error !== undefined) errors.push("spec_check.error must be absent when evidence capture succeeded");
  if (spec.cause !== undefined) errors.push("spec_check.cause must be absent when evidence capture succeeded");
  const evidenceSource = parseManualEvidenceSource(spec.evidence_source);
  if (evidenceSource === null) {
    errors.push("spec_check.evidence_source must be absent or a manual-override with a non-empty reason");
  }
  if (!count(spec.critical_count)) errors.push("spec_check.critical_count must be a non-negative safe integer");
  if (!count(spec.high_count)) errors.push("spec_check.high_count must be a non-negative safe integer");
  if (!stringArray(spec.critical_findings)) errors.push("spec_check.critical_findings must be an array of strings");
  if (!stringArray(spec.high_findings)) errors.push("spec_check.high_findings must be an array of strings");
  if (!stringArray(spec.medium_findings)) errors.push("spec_check.medium_findings must be an array of strings");
  if (errors.length > 0 || evidenceSource === null) return { ok: false, errors };

  const criticalFindings = spec.critical_findings as readonly string[];
  const highFindings = spec.high_findings as readonly string[];
  if (spec.critical_count !== criticalFindings.length) {
    errors.push(
      `spec_check.critical_count (${spec.critical_count}) must equal critical_findings.length (${criticalFindings.length})`,
    );
  }
  if (spec.high_count !== highFindings.length) {
    errors.push(`spec_check.high_count (${spec.high_count}) must equal high_findings.length (${highFindings.length})`);
  }
  if (verdict === "PASSED" && spec.critical_count !== 0) {
    errors.push("spec_check.verdict PASSED requires critical_count 0");
  }
  if (verdict === "BLOCKED" && spec.critical_count === 0) {
    errors.push("spec_check.verdict BLOCKED requires critical_count greater than 0");
  }
  if (errors.length > 0) return { ok: false, errors };
  if (verdict === "UNKNOWN") {
    return {
      ok: true,
      value: frozenEvidenceFailure(
        spec.wave as number,
        spec.run_at as string,
        "persisted spec_check verdict UNKNOWN is not usable captured evidence - re-run /wave-gate",
        "transcript",
      ),
    };
  }
  return { ok: true, value: freshCaptured(spec, verdict, evidenceSource) };
}

/** Parse and freeze only the optional nested manual-override evidence source. */
function parseManualEvidenceSource(raw: unknown): CapturedSpecCheck["evidence_source"] | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.kind === "manual-override" &&
      typeof record.reason === "string" && record.reason.trim() !== ""
    ? Object.freeze({ kind: "manual-override", reason: record.reason })
    : null;
}

function freshCaptured(
  spec: Record<string, unknown>,
  verdict: CapturedSpecCheckVerdict,
  evidenceSource: CapturedSpecCheck["evidence_source"],
): CapturedSpecCheck {
  return frozenCapturedSpecCheck(
    spec.wave as number,
    spec.run_at as string,
    verdict,
    spec.critical_findings as readonly string[],
    spec.high_findings as readonly string[],
    spec.medium_findings as readonly string[],
    evidenceSource,
  );
}

function freshEvidenceFailed(spec: Record<string, unknown>): EvidenceFailedSpecCheck {
  // Absent is not unknown: every failure written before the floor existed was
  // a transcript failure, so the historical shape has exactly one meaning and
  // the parse boundary is where it becomes total.
  const cause = spec.cause === "settled-floor" || spec.cause === "projection-unavailable"
    ? spec.cause
    : "transcript";
  return frozenEvidenceFailure(
    spec.wave as number,
    spec.run_at as string,
    spec.error as string,
    cause,
  );
}
