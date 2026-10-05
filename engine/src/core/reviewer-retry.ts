/**
 * What a rejected review attempt becomes: the attempt-2 task text every review
 * program renders (standalone reviewers, Wave reviewers, Wave spec-check,
 * Refutation Panel verifiers), the byte-exact parse of a persisted Wave retry
 * diagnostic, and the classification of a refutation transcript read. Pure —
 * the program volume reads the bytes and renders the spawn; this module only
 * decides the words and the route.
 */
import { canonicalRecord, type DomainResult } from "./orchestration-contract";
import type { PersistentRefutationPanelEvent } from "./persistent-panel";
import { emissionToolPrimaryInstruction, parseEmissionDescriptor } from "./spawn-admission";
import type { FrozenStandaloneReviewAuthority } from "./standalone-review-model";

/**
 * The extraction-only final-action wording for a reviewer retry whose task
 * carries no issued emission descriptor: archived schema-1 and protocol-v1
 * routes, and any non-emission retry route, close attempt 2 with exactly this
 * instruction so their required final message stays byte-identical to
 * attempt 1's contract.
 */
export const REVIEWER_EXTRACTION_RETRY_INSTRUCTION =
  "Emit exactly one JSON object conforming to the unchanged reviewer-payload-schema and reviewer-impact-rubric sections.";

/** Render retry final-action wording from the descriptor that records the
 *  actual route. Attempt 2 is a fresh spawn, so its one-call budget is fresh. */
export function reviewerRetryInstruction(task: string): string {
  const descriptor = parseEmissionDescriptor(task);
  if (descriptor.kind === "malformed") {
    throw new Error(`retry task carries an unusable emission descriptor: ${descriptor.reason}`);
  }
  return descriptor.kind === "issued"
    ? `This is a fresh spawn with a fresh one-call budget. ${emissionToolPrimaryInstruction(descriptor.binding)}`
    : REVIEWER_EXTRACTION_RETRY_INSTRUCTION;
}

/**
 * The admission diagnostic, surfaced on the retry spawn task.
 *
 * The text must NOT presume which admission rule failed. It used to name the
 * frozen-scope validator unconditionally, so a transcript refused for a missing
 * `### Machine Summary` block told the reviewer to fix its scope — the retried
 * agent then re-emitted the same unparseable shape and exhausted the slot. Both
 * failure classes are now stated, with the engine's own diagnostic first
 * whenever one survived to here.
 */
export function standaloneRetryTask(
  task: string,
  diagnostic: string | null,
  authority: Pick<FrozenStandaloneReviewAuthority, "schemaVersion">,
): string {
  if (authority.schemaVersion !== 1) {
    return [task, "", "Your previous attempt was rejected by the engine's admission check.",
      ...(diagnostic === null ? [] : [JSON.stringify(diagnostic)]), "",
      `This is your final attempt. ${reviewerRetryInstruction(task)}`].join("\n");
  }
  const marker = diagnostic === null
    ? ["Your previous attempt was rejected by the engine's admission check."]
    : ["Your previous attempt was rejected by the engine's admission check:", "", diagnostic];
  return [
    task,
    "",
    ...marker,
    "",
    "Re-emit the exact required reviewer result. It must satisfy BOTH admission rules:",
    "1. End with a `### Machine Summary` block carrying literal `CRITICAL_COUNT:` and",
    "   `ADVISORY_COUNT:` lines and a fenced ```findings``` block — even when both counts are 0.",
    "2. Every structured finding must name a path strictly inside the frozen scope.",
  ].join("\n");
}

/**
 * The verdict-parse diagnostic, surfaced on a Refutation Panel retry task.
 *
 * A verifier's attempt-2 prompt used to be BYTE-IDENTICAL to attempt 1 — no
 * notice that anything was refused, no reason. The engine re-asked the identical
 * question and got the identical malformed shape back, exhausting the slot and
 * terminal-blocking whole runs. Naming the defect is what makes the retry worth
 * spending.
 */
export function refutationRetryTask(task: string, diagnostic: string | null): string {
  return [
    task,
    "",
    ...(diagnostic === null
      ? ["Your previous attempt was rejected: its verdict payload could not be parsed."]
      : ["Your previous attempt was rejected:", "", diagnostic]),
    "",
    "Your FINAL message must be exactly one JSON object and nothing else — no preamble,",
    "no postscript, no code fences, no second object. Re-emit the verdict for the same",
    "criterion covering every finding id you were given.",
  ].join("\n");
}

/** Deterministic rejection detail recovered from the Refutation Panel event prefix. */
export function refutationRejectionDiagnostic(event: PersistentRefutationPanelEvent | undefined): string | null {
  return event !== undefined && event.type === "refutation-verdict-rejected" ? event.message : null;
}

export type RefutationTranscriptReadDecision =
  | Readonly<{ kind: "verdict"; transcript: string }>
  | Readonly<{ kind: "capture-rejection"; diagnostic: string }>
  | Readonly<{ kind: "infrastructure-failure"; message: string }>;

/**
 * Classify one refutation transcript read without conflating storage failure
 * with semantic evidence. Only a durable capture-rejection tombstone may
 * advance the panel through its rejection transition; an unreadable captured
 * transcript remains infrastructure failure and blocks resume.
 */
export function decideRefutationTranscriptRead(
  bytes: DomainResult<Uint8Array, Readonly<{ message: string }>>,
  tombstone: string | undefined,
): RefutationTranscriptReadDecision {
  if (bytes.ok) {
    return canonicalRecord({
      kind: "verdict" as const,
      transcript: Buffer.from(bytes.value).toString("utf8"),
    });
  }
  return tombstone === undefined
    ? canonicalRecord({ kind: "infrastructure-failure" as const, message: bytes.error.message })
    : canonicalRecord({ kind: "capture-rejection" as const, diagnostic: tombstone });
}

/**
 * The attempt-2 diagnostic a rejected Wave reviewer sees. It names the parser's
 * exact complaint AND restates the exact wire schema, because the failure this
 * exists to break is a model inferring `{id, status}` from prose and repeating
 * it on retry. Concrete keys, not description.
 *
 * The template is split into a FIXED preamble (through the reason separator)
 * and a FIXED schema tail; only the parser rejection reason is variable, so
 * persisted attempt-2 contexts can be re-validated byte-exactly instead of
 * trusting a section label (see parseWaveRetryDiagnosticSection).
 */
export const WAVE_RETRY_PREAMBLE = [
  "YOUR PREVIOUS ATTEMPT WAS REJECTED. This is your final attempt.",
  "",
  "Parser rejection reason: ",
].join("\n");

export const WAVE_RETRY_FIXED_TAIL = [
  "Emit the review_lifecycle block with these EXACT keys — the parser accepts",
  "`finding_id` (NOT `id`), `verdict` (NOT `status`), and `reason`. The only",
  "legal verdict values are `resolved_by_remediation` and `still_present`:",
  "",
  "```review_lifecycle",
  "{",
  '  "prior_findings": [',
  '    { "finding_id": "<exact id from task.priorFindings>", "verdict": "still_present", "reason": "<concrete non-empty reason>" }',
  "  ]",
  "}",
  "```",
  "",
  "Also emit the REVIEW_GENERATION and REVIEW_PACKET_ID marker lines copied",
  "verbatim from the packet, and assess every task.priorFindings id exactly",
  "once in packet order. Use an empty array when there are no prior findings.",
].join("\n");

const CURRENT_WAVE_RETRY_TAIL = REVIEWER_EXTRACTION_RETRY_INSTRUCTION;

function boundedRetryReason(reason: string): string {
  const escaped = JSON.stringify(reason);
  let bounded = "";
  let length = 0;
  for (const character of escaped) {
    const size = new TextEncoder().encode(character).length;
    if (length + size > 2048) break;
    bounded += character;
    length += size;
  }
  return bounded;
}

/** The fixed footer contract a rejected spec-check must follow on retry: the
 *  parser reads finding lines only inside the WAVE…VERDICT block, so findings
 *  written above `SPEC_CHECK_WAVE` never count and the totals cannot match. */
export const SPEC_CHECK_RETRY_TAIL = [
  "Emit the spec-check footer in exactly this order:",
  "SPEC_CHECK_WAVE: <wave>",
  "then every CRITICAL:, HIGH: and MEDIUM: finding line,",
  "then SPEC_CHECK_CRITICAL_COUNT, SPEC_CHECK_HIGH_COUNT and SPEC_CHECK_VERDICT last.",
  "Finding lines above SPEC_CHECK_WAVE are not read, and each count must equal its finding lines.",
].join("\n");

/** The attempt-2 instruction a rejected spec-check sees. Like the reviewer
 *  retry, it names the exact complaint: without it the final attempt is a
 *  blind repeat that reproduces the same defect. */
export function specCheckRetryDiagnostic(reason: string): string {
  return `${WAVE_RETRY_PREAMBLE}${boundedRetryReason(reason)}\n\n${SPEC_CHECK_RETRY_TAIL}`;
}

/** The persisted Wave reviewer retry diagnostic for an issued protocol version:
 *  archived v1 restates the review_lifecycle schema verbatim; current v2 bounds
 *  the reason and closes with the unchanged extraction instruction. */
export function waveRetryDiagnostic(reason: string, protocolVersion: 1 | 2): string {
  return protocolVersion === 2
    ? `${WAVE_RETRY_PREAMBLE}${boundedRetryReason(reason)}\n\n${CURRENT_WAVE_RETRY_TAIL}`
    : `${WAVE_RETRY_PREAMBLE}${reason}\n\n${WAVE_RETRY_FIXED_TAIL}`;
}

/** Compose attempt-2 task text from the actual rendered route. Persisted
 *  extraction diagnostics retain their canonical bytes; an emission render
 *  replaces only the route-blind final action with the fresh-spawn tool rule. */
export function renderCurrentWaveRetryTask(task: string, retryDiagnostic: string): string {
  const instruction = reviewerRetryInstruction(task);
  if (instruction === CURRENT_WAVE_RETRY_TAIL) return [task, retryDiagnostic].join("\n");
  const diagnostic = retryDiagnostic.endsWith(CURRENT_WAVE_RETRY_TAIL)
    ? `${retryDiagnostic.slice(0, -CURRENT_WAVE_RETRY_TAIL.length)}${instruction}`
    : `${retryDiagnostic}\n\n${instruction}`;
  return [task, diagnostic].join("\n");
}

/**
 * Parse the persisted `wave-review-attempt-1-rejection` section back into its
 * canonical shape. The label alone is not authority — an attacker who can write
 * to the run directory could reuse it — so compatibility with a persisted
 * attempt-2 context requires the section bytes to be exactly
 * `<fixed preamble><non-empty reason>\n\n<fixed schema tail>`.
 */
export function parseWaveRetryDiagnosticSection(
  bytes: Iterable<number>,
  protocolVersion: 1 | 2,
): Readonly<{ ok: true; reason: string }> | Readonly<{ ok: false; message: string }> {
  let text: string;
  try {
    text = new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return { ok: false, message: "wave attempt-1 rejection section is not valid UTF-8" };
  }
  if (!text.startsWith(WAVE_RETRY_PREAMBLE)) {
    return { ok: false, message: "wave attempt-1 rejection section lacks the canonical retry preamble" };
  }
  const remainder = text.slice(WAVE_RETRY_PREAMBLE.length);
  const tailMarker = `\n\n${protocolVersion === 1 ? WAVE_RETRY_FIXED_TAIL : CURRENT_WAVE_RETRY_TAIL}`;
  const markerIndex = remainder.indexOf(tailMarker);
  if (markerIndex < 0 || remainder.slice(markerIndex + tailMarker.length) !== "") {
    return { ok: false, message: "wave attempt-1 rejection section is not one canonical diagnostic-rich retry" };
  }
  const reason = remainder.slice(0, markerIndex);
  if (protocolVersion === 2 && new TextEncoder().encode(reason).length > 2048) {
    return { ok: false, message: "current Wave retry diagnostic exceeds its byte bound" };
  }
  if (reason.trim().length === 0) {
    return { ok: false, message: "wave attempt-1 rejection section carries an empty parser rejection reason" };
  }
  return { ok: true, reason };
}
