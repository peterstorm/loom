import { isNoFindingSentinel } from "../utils/no-finding-sentinel";
import {
  parseSpecCheckVerdict,
  type CapturedSpecCheck,
  type EvidenceFailedSpecCheck,
  type SpecCheck,
  type SpecCheckVerdict,
} from "../types";

export interface ParsedSpecCheckOutput {
  readonly critical: readonly string[];
  readonly high: readonly string[];
  readonly medium: readonly string[];
  readonly criticalCount: number | null;
  readonly highCount: number | null;
  readonly verdict: SpecCheckVerdict | null;
  readonly wave: number | null;
}

export type SpecCheckResolution =
  | Readonly<{ kind: "captured"; specCheck: CapturedSpecCheck }>
  | Readonly<{ kind: "evidence-failed"; specCheck: EvidenceFailedSpecCheck }>;

export type SpecCheckParseResult =
  | Readonly<{ ok: true; value: SpecCheck }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

/** Parse the last concrete spec-check block from an agent transcript. */
export function parseSpecCheckOutput(output: string): ParsedSpecCheckOutput {
  const lastCritCountIdx = output.lastIndexOf("SPEC_CHECK_CRITICAL_COUNT:");
  let blockStart = 0;
  if (lastCritCountIdx >= 0) {
    const lastWaveIdx = output.slice(0, lastCritCountIdx).lastIndexOf("SPEC_CHECK_WAVE:");
    blockStart = lastWaveIdx >= 0 ? lastWaveIdx : 0;
  }
  const searchBlock = lastCritCountIdx >= 0 ? output.slice(blockStart) : output;

  const critical: string[] = [];
  const high: string[] = [];
  const medium: string[] = [];
  for (const line of searchBlock.split("\n")) {
    const criticalMatch = line.match(/^CRITICAL:\s*(.*)/);
    if (criticalMatch) {
      const claim = criticalMatch[1].trim();
      if (claim !== "" && !isNoFindingSentinel(claim)) critical.push(claim);
      continue;
    }
    const highMatch = line.match(/^HIGH:\s*(.*)/);
    if (highMatch) {
      const claim = highMatch[1].trim();
      if (claim !== "" && !isNoFindingSentinel(claim)) high.push(claim);
      continue;
    }
    const mediumMatch = line.match(/^MEDIUM:\s*(.*)/);
    if (mediumMatch) {
      const claim = mediumMatch[1].trim();
      if (claim !== "" && !isNoFindingSentinel(claim)) medium.push(claim);
    }
  }

  const criticalCount = searchBlock.match(/SPEC_CHECK_CRITICAL_COUNT:\s*(\d+)/);
  const highCount = searchBlock.match(/SPEC_CHECK_HIGH_COUNT:\s*(\d+)/);
  const verdict = searchBlock.match(/SPEC_CHECK_VERDICT:\s*(PASSED|BLOCKED)/);
  const wave = searchBlock.match(/SPEC_CHECK_WAVE:\s*(\d+)/);
  return {
    critical,
    high,
    medium,
    criticalCount: criticalCount ? Number(criticalCount[1]) : null,
    highCount: highCount ? Number(highCount[1]) : null,
    verdict: verdict ? parseSpecCheckVerdict(verdict[1]) : null,
    wave: wave ? Number(wave[1]) : null,
  };
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
  if (parsed.criticalCount !== parsed.critical.length) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_CRITICAL_COUNT (${parsed.criticalCount}) does not match CRITICAL: findings (${parsed.critical.length}); counts must match the findings - re-run /wave-gate`,
    );
  }
  const highCount = parsed.highCount ?? 0;
  if (highCount !== parsed.high.length) {
    return evidenceFailure(
      wave,
      runAt,
      `SPEC_CHECK_HIGH_COUNT (${highCount}) does not match HIGH: findings (${parsed.high.length}); counts must match the findings - re-run /wave-gate`,
    );
  }
  const verdict = parsed.verdict === null || parsed.verdict === "EVIDENCE_CAPTURE_FAILED"
    ? "UNKNOWN"
    : parsed.verdict;
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
      : { ok: true, value: spec as unknown as EvidenceFailedSpecCheck };
  }

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
    : { ok: true, value: spec as unknown as CapturedSpecCheck };
}
