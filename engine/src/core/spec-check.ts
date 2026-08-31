import { isNoFindingSentinel } from "../utils/no-finding-sentinel";
import type { AgentRequestAuthority } from "./orchestration-contract";
import {
  parseSpecCheckVerdict,
  type CapturedSpecCheck,
  type EvidenceFailedSpecCheck,
  type SpecCheck,
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

function lastMatch(input: string, regex: RegExp): RegExpMatchArray | null {
  const matches = [...input.matchAll(regex)];
  return matches.at(-1) ?? null;
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

  const findings = {
    critical: [] as string[],
    high: [] as string[],
    medium: [] as string[],
  };
  for (const line of searchBlock.split("\n")) {
    const marker = SPEC_FINDING_MARKERS.find(({ prefix }) => line.startsWith(prefix));
    if (marker === undefined) continue;
    const claim = line.slice(marker.prefix.length).trim();
    if (claim !== "" && !isNoFindingSentinel(claim)) findings[marker.target].push(claim);
  }
  const { critical, high, medium } = findings;

  const criticalCount = searchBlock.match(/^SPEC_CHECK_CRITICAL_COUNT:\s*(\d+)\s*$/m);
  const highCount = searchBlock.match(/^SPEC_CHECK_HIGH_COUNT:\s*(\d+)\s*$/m);
  const verdict = searchBlock.match(/^SPEC_CHECK_VERDICT:\s*(PASSED|BLOCKED)\s*$/m);
  const wave = searchBlock.match(/^SPEC_CHECK_WAVE:\s*(\d+)\s*$/m);
  const overrideText = searchBlock.match(/^SPEC_CHECK_OVERRIDE:\s*(.*)$/m)?.[1]?.trim() ?? "";
  return {
    critical,
    high,
    medium,
    criticalCount: criticalCount ? Number(criticalCount[1]) : null,
    highCount: highCount ? Number(highCount[1]) : null,
    verdict: verdict ? parseSpecCheckVerdict(verdict[1]) : null,
    wave: wave ? Number(wave[1]) : null,
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

const evidenceFailure = (wave: number, runAt: string, error: string): SpecCheckResolution => ({
  kind: "evidence-failed",
  specCheck: { wave, run_at: runAt, verdict: "EVIDENCE_CAPTURE_FAILED", error },
});

/**
 * Reconcile marker counts with their itemized views before constructing gate
 * state. Every harness calls this function, so a transcript cannot be clean on
 * one harness and evidence-failed on another.
 */
export function reconcileSpecCheck(
  parsed: ParsedSpecCheckOutput,
  wave: number,
  runAt: string,
): SpecCheckResolution {
  if (parsed.criticalCount === null) {
    return evidenceFailure(wave, runAt, "SPEC_CHECK_CRITICAL_COUNT marker not found - re-run /wave-gate");
  }
  if (parsed.highCount === null) {
    return evidenceFailure(wave, runAt, "SPEC_CHECK_HIGH_COUNT marker not found - re-run /wave-gate");
  }
  if (parsed.verdict === null) {
    return evidenceFailure(wave, runAt, "SPEC_CHECK_VERDICT marker not found - re-run /wave-gate");
  }
  if (parsed.criticalCount !== parsed.critical.length) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_CRITICAL_COUNT (${parsed.criticalCount}) does not match CRITICAL: findings (${parsed.critical.length}); counts must match the findings - re-run /wave-gate`,
    );
  }
  const highCount = parsed.highCount;
  if (highCount !== parsed.high.length) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_HIGH_COUNT (${highCount}) does not match HIGH: findings (${parsed.high.length}); counts must match the findings - re-run /wave-gate`,
    );
  }
  const verdict = parsed.verdict === "EVIDENCE_CAPTURE_FAILED" ? "UNKNOWN" : parsed.verdict;
  return {
    kind: "captured",
    specCheck: {
      wave,
      run_at: runAt,
      critical_count: parsed.criticalCount,
      high_count: highCount,
      critical_findings: [...parsed.critical],
      high_findings: [...parsed.high],
      medium_findings: [...parsed.medium],
      verdict,
    },
  };
}

const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Parse persisted spec-check state into its captured/evidence-failed ADT. */
export function parseStoredSpecCheck(raw: unknown): SpecCheckParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["spec_check must be an object when present"] };
  }
  const spec = raw as Record<string, unknown>;
  const verdict = typeof spec.verdict === "string" ? parseSpecCheckVerdict(spec.verdict) : null;
  const errors: string[] = [];
  if (!Number.isInteger(spec.wave) || (spec.wave as number) < 1) {
    errors.push(`spec_check.wave must be an integer >= 1, got ${JSON.stringify(spec.wave)}`);
  }
  if (typeof spec.run_at !== "string") {
    errors.push(`spec_check.run_at must be a string, got ${JSON.stringify(spec.run_at)}`);
  }
  if (verdict === null) {
    errors.push(`spec_check.verdict ${JSON.stringify(spec.verdict)} is not recognized`);
  }
  if (errors.length > 0 || verdict === null) return { ok: false, errors };

  if (verdict === "EVIDENCE_CAPTURE_FAILED") {
    if (typeof spec.error !== "string" || spec.error.trim() === "") {
      errors.push("spec_check.error must be a non-empty string when evidence capture failed");
    }
    for (const field of ["critical_count", "high_count", "critical_findings", "high_findings", "medium_findings"] as const) {
      if (spec[field] !== undefined) errors.push(`spec_check.${field} must be absent when evidence capture failed`);
    }
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, value: freshEvidenceFailed(spec, verdict) };
  }

  if (spec.error !== undefined) errors.push("spec_check.error must be absent when evidence capture succeeded");
  if (!count(spec.critical_count)) errors.push("spec_check.critical_count must be a non-negative integer");
  if (!count(spec.high_count)) errors.push("spec_check.high_count must be a non-negative integer");
  if (!stringArray(spec.critical_findings)) errors.push("spec_check.critical_findings must be an array of strings");
  if (!stringArray(spec.high_findings)) errors.push("spec_check.high_findings must be an array of strings");
  if (!stringArray(spec.medium_findings)) errors.push("spec_check.medium_findings must be an array of strings");
  if (errors.length > 0) return { ok: false, errors };

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
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: freshCaptured(spec, verdict) };
}

/**
 * Rebuild the parsed value instead of casting the caller's own object.
 *
 * Returning `raw` under a proven type aliases it: the caller still holds a
 * mutable reference, so a later `raw.critical_count = 99` silently invalidates
 * the count/findings-length equality proven immediately above — and the type
 * says nothing happened. `types.ts` documents this exact bug class beside
 * `CapturedSpecCheck`'s `readonly` findings. Freezing a freshly built record
 * makes the proof survive its own return, as every sibling parser here does.
 */
function freshCaptured(
  spec: Record<string, unknown>,
  verdict: Exclude<SpecCheckVerdict, "EVIDENCE_CAPTURE_FAILED">,
): CapturedSpecCheck {
  return Object.freeze({
    wave: spec.wave as number,
    run_at: spec.run_at as string,
    verdict,
    critical_count: spec.critical_count as number,
    high_count: spec.high_count as number,
    critical_findings: Object.freeze([...(spec.critical_findings as readonly string[])]),
    high_findings: Object.freeze([...(spec.high_findings as readonly string[])]),
    medium_findings: Object.freeze([...(spec.medium_findings as readonly string[])]),
  });
}

function freshEvidenceFailed(
  spec: Record<string, unknown>,
  verdict: "EVIDENCE_CAPTURE_FAILED",
): EvidenceFailedSpecCheck {
  return Object.freeze({
    wave: spec.wave as number,
    run_at: spec.run_at as string,
    verdict,
    error: spec.error as string,
  });
}
