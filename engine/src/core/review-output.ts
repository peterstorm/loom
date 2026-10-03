/**
 * Reviewer evidence → findings. The pure half of storing a review.
 * Issued admission joins publication, Context Packet and registration authority
 * before selecting the decoder. Current JSON has only engine-derived counts;
 * the historical text contract and reconciliation below remain v1-only.
 *
 * A historical reviewer emits three overlapping descriptions of what it found:
 * `CRITICAL_COUNT` / `ADVISORY_COUNT` markers (its own tallies),
 * `CRITICAL:` / `ADVISORY:` marker lines (the claims as text), and —
 * optionally — a fenced ```findings block
 * (the same claims with file/line). They can disagree; arbitration chooses
 * the primary location-bearing representation, while unmatched claims from
 * the other source are preserved and critical-count shortfalls fail closed.
 *
 * The rule, in one sentence: **marker lines settle the severity of claims they
 * name, then the block wins only when it accounts for at least as many findings
 * of each severity as the marker lines name — and, for criticals only, as the
 * reviewer's own `CRITICAL_COUNT` — and any marker claim it does not NAME is
 * carried over beside it.** The asymmetry is deliberate and
 * `chooseSource` states why: `advisoryCount` is not part of the BLOCK-WINNER
 * bar, because an advisory shortfall against a self-reported tally degrades
 * triage while a critical shortfall opens a gate. A short block is a truncated
 * or mislabeled emission, and its locations are not
 * worth the claims it would discard; a block that is long enough but names
 * different claims is the same loss wearing a passing count. Whatever wins,
 * `reconcileFindings` then backstops remaining shortfalls against BOTH count
 * markers with self-describing entries at their original severity. Lost
 * criticals therefore block instead of reading green, while lost advisories
 * remain visible for triage.
 *
 * `resolveReviewFindings` + `applyReviewResolution` are the SINGLE path from a
 * review transcript to a task update. Claude Code reaches them through the
 * `store-reviewer-findings` SubagentStop handler; Pi reaches them through
 * `pi/extension.ts`'s subagent-result interception. The two harnesses used to
 * re-run the same parse → reconcile → merge sequence independently, which is how
 * the review findings on one harness could drift from the other's. There is now
 * one decision function and one state transform; the harnesses supply only the
 * transcript, the task id, and the write.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import {
  FINDING_SEVERITIES,
  PRIOR_FINDING_VERDICTS,
  type CurrentDraftFinding,
  type LegacyDraftFinding,
  type LegacyReviewRun,
  type CurrentReviewRunEvidence,
  type LegacyReviewRunEvidence,
  type FindingSeverity,
  type PriorFindingAssessment,
  type ReviewRun,
  type ReviewRunSlotAuthority,
  type Task,
} from "../types";
import {
  claimsOfSeverity,
  draftsFromClaims,
  mergeFindings,
  parseFindingsBlockResult,
  recordReviewRunEvidence,
  reviewFindingCounts,
} from "./findings";
import { parseReviewPath } from "./review-packet";
import { parseContextPacket, type ContextPacket, type LegacyContextPacket, type ReviewerContextPacketV2 } from "./context-packets";
import { parseReviewerPayloadV2 } from "./reviewer-protocol";
import { parseReviewerProtocolDescriptor, REVIEWER_PAYLOAD_LIMITS, type ReviewerProtocolDescriptor, type ReviewerProtocolFailure } from "./reviewer-contract";
import { acceptedAgentResult, canonicalStructuralEquals, type AgentRequestAuthority, type DomainResult, type OrchestrationRunId, type SpawnRequest } from "./orchestration-contract";
import { readWaveReviewContext } from "./wave-review-authority";
import { readExactDataRecord } from "./orchestration-contract/bytes";
import { isStandaloneReviewAgent } from "./model-profiles";

export type ReviewerSubjectBinding =
  | Readonly<{ kind: "standalone-review"; runId: OrchestrationRunId; scope: readonly string[] }>
  | Readonly<{ kind: "wave-review"; runId: OrchestrationRunId; taskId: string; packetId: string;
      generation: number; priorFindingIds: readonly string[]; scope: readonly string[] }>;

export type ReviewerProtocolRegistration =
  | Readonly<{ schemaVersion: 1; runId: OrchestrationRunId; program: "standalone-review" | "wave-gate"; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2; runId: OrchestrationRunId; program: "standalone-review" | "wave-gate"; reviewerProtocol: ReviewerProtocolDescriptor }>;

declare const issuedReviewerProtocolBrand: unique symbol;
type IssuedProtocolMembership = Readonly<{ [issuedReviewerProtocolBrand]: true }>;
type IssuedProtocolVersion =
  | Readonly<{ protocolVersion: 1; packet: LegacyContextPacket; reviewerProtocol?: never }>
  | Readonly<{ protocolVersion: 2; packet: ReviewerContextPacketV2; reviewerProtocol: ReviewerProtocolDescriptor }>;
export type IssuedStandaloneReviewerProtocol = IssuedProtocolMembership & IssuedProtocolVersion & Readonly<{
  request: AgentRequestAuthority; subject: Extract<ReviewerSubjectBinding, { kind: "standalone-review" }>;
}>;
export type IssuedWaveReviewerProtocol = IssuedProtocolMembership & IssuedProtocolVersion & Readonly<{
  request: AgentRequestAuthority; subject: Extract<ReviewerSubjectBinding, { kind: "wave-review" }>;
}>;
export type IssuedReviewerProtocol = IssuedStandaloneReviewerProtocol | IssuedWaveReviewerProtocol;
export type ReviewerProtocolAuthorityResolver = (request: AgentRequestAuthority) => DomainResult<IssuedReviewerProtocol, ReviewerProtocolFailure>;
const issuedReviewerProtocols = new WeakSet<object>();

function protocolFailure(code: ReviewerProtocolFailure["code"], path: string, message: string): DomainResult<never, ReviewerProtocolFailure> {
  const encoder = new TextEncoder();
  let safe = "";
  let length = 0;
  for (const character of message) {
    const rendered = /[\p{Cc}\p{Cf}\p{Cs}]/u.test(character)
      ? `\\u{${character.codePointAt(0)!.toString(16)}}` : character;
    const bytes = encoder.encode(rendered).length;
    if (length + bytes > 2048) break;
    length += bytes;
    safe += rendered;
  }
  return Object.freeze({ ok: false, error: Object.freeze({ kind: "reviewer-protocol-failed", code, path, message: safe }) });
}

function packetReviewerSubject(packet: ContextPacket, request: AgentRequestAuthority): ReviewerSubjectBinding | null {
  if (request.program === "standalone-review") {
    const section = packet.fixedContext.find(({ label }) => label === "standalone-review-authority");
    if (section === undefined) return null;
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(section.bytes)));
    const parsed = readExactDataRecord(raw, ["runId", "scope", "role", "attempt"], "standalone reviewer subject");
    if (!parsed.ok) return null;
    const subject = parsed.value;
    if (subject.runId !== request.runId || subject.role !== request.role || subject.attempt !== request.attempt ||
        !Array.isArray(subject.scope) || subject.scope.some((path) => typeof path !== "string")) return null;
    return Object.freeze({ kind: "standalone-review", runId: request.runId, scope: Object.freeze([...subject.scope]) });
  }
  if (request.program !== "wave-gate") return null;
  const context = readWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.task === null || context.value.taskRun === null ||
      context.value.runId !== request.runId || context.value.subject.role !== request.role) return null;
  const { task, taskRun } = context.value;
  return Object.freeze({
    kind: "wave-review", runId: request.runId, taskId: task.id, packetId: taskRun.packetId,
    generation: taskRun.generation, priorFindingIds: Object.freeze(task.priorFindings.map(({ id }) => id)),
    scope: Object.freeze([...new Set([...task.declaredFiles, ...task.modifiedFiles])].sort()),
  });
}

function currentPriorRosterIsRepresentable(subject: Extract<ReviewerSubjectBinding, { kind: "wave-review" }>): boolean {
  const encoder = new TextEncoder();
  if (subject.priorFindingIds.length > REVIEWER_PAYLOAD_LIMITS.priorFindings || subject.priorFindingIds.some((id) =>
    id.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(id) ||
    encoder.encode(id).length > REVIEWER_PAYLOAD_LIMITS.reference)) return false;
  // A byte-size lower bound, not an assessment or an admitted evidence value.
  const minimum = JSON.stringify({ schemaVersion: 2, kind: "wave-review", packetId: subject.packetId, generation: subject.generation,
    prior_findings: subject.priorFindingIds.map((finding_id) => ({ finding_id, verdict: "still_present", reason: "x" })), findings: [],
  });
  return encoder.encode(minimum).length <= REVIEWER_PAYLOAD_LIMITS.bytes;
}

/** Joins a real publication-issued request to independently parsed registration and exact packet bytes. */
export function parseIssuedReviewerProtocol(input: Readonly<{
  request: SpawnRequest; packet: ContextPacket; registration: ReviewerProtocolRegistration; subject: ReviewerSubjectBinding;
}>): DomainResult<IssuedReviewerProtocol, ReviewerProtocolFailure> {
  try {
    const accepted = acceptedAgentResult(input.request, null);
    if (!accepted.ok) return protocolFailure("authority-unavailable", "/request", "reviewer authority requires a runtime-issued request");
    const request = accepted.value.authority;
    const parsed = parseContextPacket(input.packet);
    if (!parsed.ok) return protocolFailure("authority-mismatch", "/packet", "reviewer Context Packet integrity failed");
    const packet = parsed.value;
    if (!isStandaloneReviewAgent(request.role) || packet.requestId !== request.requestId ||
        packet.role !== request.role || packet.requiredSkill !== (request.requiredSkill ?? "none") ||
        packet.digest !== request.contextDigest || input.request.context.digest !== packet.digest ||
        input.request.context.slot.path !== `contexts/${packet.digest}.json`) {
      return protocolFailure("authority-mismatch", "/request", "issued request does not match reviewer Context Packet");
    }
    const registered = readExactDataRecord(input.registration, ["schemaVersion", "runId", "program", "reviewerProtocol"], "reviewer registration");
    if (!registered.ok) return protocolFailure("authority-mismatch", "/registration", "reviewer registration requires exact own data fields");
    const registration = registered.value;
    const fieldCount = registration.schemaVersion === 2 ? 4 : 3;
    if (Object.keys(registration).length !== fieldCount || registration.runId !== request.runId ||
        registration.program !== request.program || registration.schemaVersion !== packet.schemaVersion) {
      return protocolFailure("authority-mismatch", "/registration", "registration and issued request protocol must agree");
    }
    if (registration.schemaVersion === 2 && (!parseReviewerProtocolDescriptor(registration.reviewerProtocol).ok ||
        packet.schemaVersion !== 2 || !canonicalStructuralEquals(registration.reviewerProtocol, packet.reviewerProtocol))) {
      return protocolFailure("authority-mismatch", "/registration/reviewerProtocol", "current registration requires the exact supported descriptor");
    }
    const subject = packetReviewerSubject(packet, request);
    if (subject === null || !canonicalStructuralEquals(subject, input.subject) || subject.scope.length === 0 ||
        new Set(subject.scope).size !== subject.scope.length || subject.scope.some((path) => {
          const parsedPath = parseReviewPath(path, "review scope");
          return !parsedPath.ok || parsedPath.value !== path;
        }) || (subject.kind === "wave-review" && (new Set(subject.priorFindingIds).size !== subject.priorFindingIds.length ||
          (packet.schemaVersion === 2 && !currentPriorRosterIsRepresentable(subject))))) {
      return protocolFailure("authority-mismatch", "/subject", "published subject must match full scope and ordered prior roster");
    }
    const version: IssuedProtocolVersion = packet.schemaVersion === 2
      ? { protocolVersion: 2, packet, reviewerProtocol: packet.reviewerProtocol }
      : { protocolVersion: 1, packet };
    // The private membership is minted only after the full publication/context/registration join.
    const authority = Object.freeze({ request, subject, ...version }) as IssuedReviewerProtocol;
    issuedReviewerProtocols.add(authority);
    return Object.freeze({ ok: true, value: authority });
  } catch {
    return protocolFailure("authority-unavailable", "/", "reviewer authority could not be inspected");
  }
}

export type LegacyStandaloneReviewerEvidence = Readonly<{ kind: "standalone-review"; protocolVersion: 1; findings: LegacyParsedFindings }>;
export type CurrentStandaloneReviewerEvidence = Readonly<{ kind: "standalone-review"; protocolVersion: 2; findings: CurrentParsedFindings }>;
export type LegacyWaveReviewerEvidence = Readonly<{ kind: "wave-review"; protocolVersion: 1; findings: LegacyParsedFindings; bound: BoundReviewEvidence }>;
export type CurrentWaveReviewerEvidence = Readonly<{ kind: "wave-review"; protocolVersion: 2; findings: CurrentParsedFindings; bound: BoundReviewEvidence }>;
export type ParsedReviewerEvidence = LegacyStandaloneReviewerEvidence | CurrentStandaloneReviewerEvidence | LegacyWaveReviewerEvidence | CurrentWaveReviewerEvidence;

function parseCurrentReviewerEvidence(
  authority: Extract<IssuedReviewerProtocol, { protocolVersion: 2 }>,
  rawBytes: Uint8Array,
): DomainResult<CurrentStandaloneReviewerEvidence | CurrentWaveReviewerEvidence, ReviewerProtocolFailure> {
  const parsed = parseReviewerPayloadV2(rawBytes);
  if (!parsed.ok) return parsed;
  const payload = parsed.value;
  const subject = authority.subject;
  if (payload.kind !== subject.kind) return protocolFailure("binding-mismatch", "/kind", "payload kind must match issued subject");
  if (payload.findings.some(({ file }) => file !== null && !subject.scope.includes(file))) {
    return protocolFailure("out-of-scope", "/findings", "finding location is outside the frozen scope");
  }
  const drafts = Object.freeze(payload.findings.map((draft): CurrentDraftFinding => Object.freeze({ protocolVersion: 2, ...draft })));
  const counts = reviewFindingCounts(drafts);
  const findings: CurrentParsedFindings = Object.freeze({
    protocolVersion: 2, drafts, critical: Object.freeze(claimsOfSeverity(drafts, "critical")),
    advisory: Object.freeze(claimsOfSeverity(drafts, "advisory")), criticalCount: counts.critical,
    advisoryCount: counts.advisory, blockStatus: Object.freeze({ kind: "json" }),
  });
  if (payload.kind === "wave-review" && subject.kind === "wave-review") {
    if (payload.packetId !== subject.packetId || payload.generation !== subject.generation) {
      return protocolFailure("binding-mismatch", "/packetId", "payload packet and generation must match issuance");
    }
    if (payload.prior_findings.length !== subject.priorFindingIds.length ||
        payload.prior_findings.some(({ finding_id }, index) => finding_id !== subject.priorFindingIds[index])) {
      return protocolFailure("invalid-prior-assessments", "/prior_findings", "every issued prior ID must be assessed exactly once in order");
    }
    return Object.freeze({ ok: true, value: Object.freeze({ kind: "wave-review", protocolVersion: 2, findings,
      bound: Object.freeze({ packetId: subject.packetId, generation: subject.generation, priorAssessments: payload.prior_findings }),
    }) });
  }
  return Object.freeze({ ok: true, value: Object.freeze({ kind: "standalone-review", protocolVersion: 2, findings }) });
}

/** Authority selects the decoder. A current failure never invokes legacy reconciliation. */
export function parseReviewerEvidence(authority: IssuedReviewerProtocol, rawBytes: Uint8Array): DomainResult<ParsedReviewerEvidence, ReviewerProtocolFailure> {
  if (!issuedReviewerProtocols.has(authority)) return protocolFailure("authority-unavailable", "/authority", "reviewer evidence requires minted protocol authority");
  try {
    if (authority.protocolVersion === 1) {
      const transcript = new TextDecoder().decode(rawBytes);
      const subject = authority.subject;
      const resolution = subject.kind === "standalone-review"
        ? resolveReviewFindings(transcript, authority.request.role)
        : resolveBoundReviewFindings(transcript, authority.request.role, {
            packet_id: subject.packetId, generation: subject.generation, prior_finding_ids: subject.priorFindingIds,
          });
      const scoped = constrainReviewResolutionToScope(resolution, subject.scope);
      if (scoped.kind !== "findings" && scoped.kind !== "bound-findings") {
        const message = scoped.message.startsWith("review_lifecycle block is not valid JSON:")
          ? "review_lifecycle block is not valid JSON" : scoped.message;
        return protocolFailure("legacy-evidence-failed", "/", message);
      }
      if (scoped.findings.protocolVersion !== undefined) return protocolFailure("legacy-evidence-failed", "/", "historical decoder returned current evidence");
      const value: ParsedReviewerEvidence = scoped.kind === "bound-findings"
        ? Object.freeze({ kind: "wave-review", protocolVersion: 1, findings: scoped.findings, bound: Object.freeze(scoped.bound) })
        : Object.freeze({ kind: "standalone-review", protocolVersion: 1, findings: scoped.findings });
      return Object.freeze({ ok: true, value });
    }
    return parseCurrentReviewerEvidence(authority, rawBytes);
  } catch {
    return protocolFailure("invalid-payload", "/", "reviewer evidence could not be inspected");
  }
}

export function resolveIssuedTaskReviewFindings(authority: IssuedWaveReviewerProtocol, rawBytes: Uint8Array): ReviewResolution {
  const admitted = parseReviewerEvidence(authority, rawBytes);
  if (!issuedReviewerProtocols.has(authority)) return { kind: "evidence-failed", agent: "unissued-reviewer", message: "reviewer evidence requires minted authority" };
  const agent = authority.request.role;
  if (!admitted.ok) return { kind: "evidence-failed", agent, message: admitted.error.message };
  if (admitted.value.kind !== "wave-review") return { kind: "evidence-failed", agent, message: "Task evidence requires issued Wave authority" };
  return admitted.value.protocolVersion === 2
    ? { kind: "bound-findings", agent, findings: admitted.value.findings, bound: admitted.value.bound, issuedSlot: {
        slot_id: authority.request.slotId, attempted: authority.request.attempt,
        request_id: authority.request.requestId, context_digest: authority.request.contextDigest,
      } }
    : { kind: "bound-findings", agent, findings: admitted.value.findings, bound: admitted.value.bound };
}

/** Marker placed in standalone reviewer prompts so harness lifecycle hooks know
 * the transcript belongs to a run artifact, not to an orchestration Task. */
export const STANDALONE_REVIEW_CONTEXT_MARKER = "LOOM_REVIEW_CONTEXT: standalone";

export function hasStandaloneReviewContext(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === STANDALONE_REVIEW_CONTEXT_MARKER);
}

/**
 * What became of the optional structured block.
 *
 * `absent` and `used` are the two silent arms — the block is absent by the
 * reviewer's own choice, or it is present and authoritative, and neither is a
 * degradation to report. Every OTHER arm means the findings lost file/line
 * fidelity, and `blockStatusNote` reports each to the operator; that difference
 * was previously invisible.
 *
 * A discriminated union, not a string beside an independent `carriedOver`
 * count. The count is meaningful for exactly the two arms that carry claims
 * across, and the flat pair made `{ blockStatus: "absent", carriedOver: 5 }`
 * representable — a state whose own doc comment ("non-zero only for `partial`")
 * was already contradicted by the `superseded` arm that sets it. Attaching the
 * number to the arms that own it removes both the illegal state and the
 * question of which comment to believe.
 */
export type FindingsBlockStatus =
  /** The reviewer emitted no block. The marker lines are the whole contract. */
  | { readonly kind: "absent" }
  /** The block parsed and named every claim the markers made. It is the source. */
  | { readonly kind: "used" }
  /** A block was present but malformed. The marker lines were parsed instead. */
  | { readonly kind: "rejected"; readonly reason: string }
  /** The block parsed but under-reported findings. The marker lines won, and the
   *  block's unnamed entries came across beside them with file/line intact. */
  | { readonly kind: "superseded"; readonly carriedOver: number }
  /**
   * The block was long enough to win but did not NAME every marker claim. It
   * is the source, with the unnamed marker claims carried over beside it —
   * so the block's file/line survives and no claim is lost.
   */
  | { readonly kind: "partial"; readonly carriedOver: number };

/** How many claims an arbitration carried across. Zero for the arms that carry
 *  none, which is now a fact about the union rather than a convention. */
export function carriedOverCount(status: FindingsBlockStatus): number {
  return status.kind === "superseded" || status.kind === "partial" ? status.carriedOver : 0;
}

/**
 * One reviewer's output, parsed. `drafts` is authoritative; `critical` and
 * `advisory` are DERIVED views over it, materialized here so the ~10 existing
 * consumers of the two `string[]` task fields keep working unchanged.
 */
export interface LegacyParsedFindings {
  readonly protocolVersion?: never;
  readonly drafts: readonly LegacyDraftFinding[];
  readonly critical: readonly string[];
  readonly advisory: readonly string[];
  readonly criticalCount: number | null;
  /**
   * The reviewer's own advisory tally, or null when it emitted none.
   *
   * Parsed for the same reason `criticalCount` is. `ADVISORY_COUNT` is required
   * by every reviewer agent contract and was read by nothing, so a reviewer that
   * declared four advisories whose `ADVISORY:` lines failed to scrape — wrapped,
   * re-indented, reformatted — recorded zero with nothing reporting the
   * shortfall, and the wave gate's advisory-disposition step (the `await-user`
   * action in `commands/wave-gate.md`, a MUST-level constraint) had nothing to
   * triage. Both count markers are mandatory evidence: omitting either means the
   * transcript may be truncated and must fail closed.
   */
  readonly advisoryCount: number | null;
  /** What became of the block, and — on the two arms that carry claims across —
   *  how many. Reported so the operator can see the duplication that arbitration
   *  deliberately prefers over a lost finding. */
  readonly blockStatus: FindingsBlockStatus;
}

export type CurrentParsedFindings = Readonly<{
  protocolVersion: 2;
  drafts: readonly CurrentDraftFinding[];
  critical: readonly string[];
  advisory: readonly string[];
  criticalCount: number;
  advisoryCount: number;
  blockStatus: Readonly<{ kind: "json" }>;
}>;
export type ParsedFindings = LegacyParsedFindings | CurrentParsedFindings;

/**
 * Smart constructor. Accepts either the authoritative drafts (structured
 * block) or the legacy severity-grouped claim strings, and always derives the
 * two views from the drafts — so the views cannot disagree with the record
 * they summarize, whichever input built it.
 */
export function makeParsedFindings(input: {
  critical?: readonly string[];
  advisory?: readonly string[];
  drafts?: readonly LegacyDraftFinding[];
  criticalCount?: number | null;
  advisoryCount?: number | null;
  blockStatus?: FindingsBlockStatus;
}): LegacyParsedFindings {
  const drafts = input.drafts ?? draftsFromClaims(input.critical ?? [], input.advisory ?? []);
  const parsed: LegacyParsedFindings = {
    drafts: Object.freeze([...drafts]),
    critical: Object.freeze([...claimsOfSeverity(drafts, "critical")]),
    advisory: Object.freeze([...claimsOfSeverity(drafts, "advisory")]),
    criticalCount: input.criticalCount ?? null,
    advisoryCount: input.advisoryCount ?? null,
    blockStatus: input.blockStatus ?? { kind: "absent" },
  };
  return Object.freeze(parsed);
}

/** Pure: Build evidence_capture_failed error message, surfacing partial findings if any. */
export function buildEvidenceFailureMessage(findings: LegacyParsedFindings): string {
  const missing = [
    ...(findings.criticalCount === null ? ["CRITICAL_COUNT marker not found"] : []),
    ...(findings.advisoryCount === null ? ["ADVISORY_COUNT marker not found"] : []),
  ].join("; ");
  const reason = missing === "" ? "review count markers are inconsistent" : missing;
  const partial = findings.critical.length + findings.advisory.length;
  return partial > 0
    ? `${reason} — partial findings extracted (${findings.critical.length} critical, ${findings.advisory.length} advisory)`
    : `${reason} in agent output`;
}

/** The self-describing claim a broken parse leaves behind. */
function parseFailureClaim(severity: FindingSeverity, missing: number, total: number): string {
  return missing === total
    ? `Review output parsing failed - ${total} ${severity} findings not captured`
    : `Review output parsing failed - ${missing} of ${total} ${severity} findings not captured`;
}

/**
 * Pure: reconcile a declared count the captured claims fall short of into a
 * self-describing entry, so a broken parse cannot pass the wave gate silently.
 *
 * The shortfall case, not just the total-loss case: the count is the reviewer's
 * own tally and the contract names it the authority, so capturing 1 of 3 is the
 * same class of failure as capturing 0 of 3 — and strictly more dangerous,
 * because the survivor makes the gate look like it saw everything.
 *
 * BOTH severities. `ADVISORY_COUNT` is mandated by every reviewer agent file and
 * used to be parsed by nothing, so advisory marker lines that failed to scrape
 * vanished with no backstop — the mirror image of the critical loss this
 * function was written for, on the severity the wave gate must triage item by
 * item (its `await-user` advisory-disposition action in `commands/wave-gate.md`). The synthetic entry keeps its own severity, so a lost advisory
 * does not fabricate a blocker.
 */
export function reconcileFindings(findings: LegacyParsedFindings): LegacyParsedFindings {
  const shortfalls = FINDING_SEVERITIES.flatMap((severity) => {
    const count = severity === "critical" ? findings.criticalCount : findings.advisoryCount;
    const captured = severity === "critical" ? findings.critical : findings.advisory;
    if (count === null || count <= 0 || captured.length >= count) return [];
    // An authored claim, not agent output — a plain literal rather than
    // makeDraftFinding, whose sentinel/empty filter exists to reject UNTRUSTED
    // text and must never be able to silently drop this reconciliation.
    const synthetic: LegacyDraftFinding = {
      severity,
      file: null,
      line: null,
      claim: parseFailureClaim(severity, count - captured.length, count),
    };
    return [synthetic];
  });

  return shortfalls.length === 0
    ? findings
    : makeParsedFindings({
        drafts: [...shortfalls, ...findings.drafts],
        criticalCount: findings.criticalCount,
        advisoryCount: findings.advisoryCount,
        blockStatus: findings.blockStatus,
      });
}

/** Extract CRITICAL/ADVISORY claim lines plus BOTH declared counts
 *  (CRITICAL_COUNT and ADVISORY_COUNT) from a text block.
 *  Strips code fences and handles bold/starred markers. */
function extractFindings(block: string): LegacyParsedFindings {
  const cleaned = block.replace(/^\`\`\`\w*$/gm, "");

  const critical: string[] = [];
  const advisory: string[] = [];

  // The marker must END at the keyword — `(?![A-Z0-9_])` — not merely "not be
  // followed by _COUNT". The old `(?!_COUNT)` lookahead excluded exactly one
  // continuation, so any line opening with a LONGER word on the same stem
  // (`CRITICALITY: high`, `ADVISORYNOTES: …`) matched as a genuine finding
  // marker and pushed a garbled claim (`ITY: high`) straight into adjudication.
  // A reviewer's prose becomes a critical finding that nothing wrote.
  for (const line of cleaned.split("\n")) {
    const critMatch = line.match(/^[\s\-*]*\*{0,2}CRITICAL(?![A-Z0-9_]):?\*{0,2}\s*(.*)/);
    if (critMatch) critical.push(critMatch[1].trim());
    const advMatch = line.match(/^[\s\-*]*\*{0,2}ADVISORY(?![A-Z0-9_]):?\*{0,2}\s*(.*)/);
    if (advMatch) advisory.push(advMatch[1].trim());
  }

  return makeParsedFindings({
    critical,
    advisory,
    criticalCount: declaredCount(cleaned, "CRITICAL"),
    advisoryCount: declaredCount(cleaned, "ADVISORY"),
  });
}

/** The `<SEVERITY>_COUNT` marker a reviewer declared, or null when absent.
 *  Tolerates the same list-marker and bold decoration the claim scraper does.
 *
 *  Takes the LAST match, for the same reason `parseMachineSummary` and
 *  `lastMarker` do: agents echo the skill template before their real output, so
 *  a first-match read lets a templated `CRITICAL_COUNT: 0` outrank the
 *  reviewer's real later count. The legacy scraper applies this to a WHOLE
 *  transcript, where that echo is most likely, and `reconcileFindings`'s
 *  shortfall backstop is gated on `count > 0` — so a first-match zero would
 *  erase real criticals with nothing left to notice it. */
function declaredCount(text: string, severity: "CRITICAL" | "ADVISORY"): number | null {
  const pattern = new RegExp(String.raw`^[ \t\-*]*\*{0,2}${severity}_COUNT:?\*{0,2}\s*(\d+)`, "gm");
  let declared: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) declared = match[1]!;
  return declared === null ? null : Number(declared);
}

/** Parse Machine Summary block for structured findings.
 *  Matches heading variants: ## / ### / #### (with optional bold), MACHINE_SUMMARY, etc.
 *  Uses the LAST match to skip skill-template echoes that precede real output. */
export function parseMachineSummary(output: string): LegacyParsedFindings | null {
  // Match various heading formats agents produce
  const headingPattern = /^(?:#{2,4}\s*\*{0,2}Machine Summary\*{0,2}|MACHINE[_ ]SUMMARY)/gim;

  // Find the last match (agents often echo the template before their real summary)
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = headingPattern.exec(output)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;

  let block = output.slice(lastMatch.index);
  // Trim at the next level-2..4 heading, whatever its level relative to the
  // Machine Summary's own — the pattern does not compare depths. Any \n##..####
  // heading ends the block, which is the conservative reading: a deeper
  // subsection under the summary would end it early rather than swallow a
  // sibling section's prose into the findings.
  const nextHeading = block.match(/\n#{2,4}\s+[^#]/);
  if (nextHeading && nextHeading.index! > 0) block = block.slice(0, nextHeading.index!);

  return chooseSource(extractFindings(block), block);
}

/**
 * Take one occurrence of `claim` out of `pool`, reporting whether it was there.
 * Mutates, because the pool is a multiset being drawn down across a whole
 * arbitration: a claim the block names twice must consume two marker slots, not
 * match the same one twice.
 */
function consumeClaim(pool: string[], claim: string): boolean {
  const at = pool.indexOf(claim);
  if (at < 0) return false;
  pool.splice(at, 1);
  return true;
}

/** Severity-aware multiset subtraction for structured/marker arbitration. */
function draftsUnaccountedFor(
  candidates: readonly LegacyDraftFinding[],
  accountedFor: readonly LegacyDraftFinding[],
): readonly LegacyDraftFinding[] {
  const criticalPool = accountedFor
    .filter(({ severity }) => severity === "critical")
    .map(({ claim }) => claim);
  const advisoryPool = accountedFor
    .filter(({ severity }) => severity === "advisory")
    .map(({ claim }) => claim);
  return candidates.filter((draft) => !consumeClaim(
    draft.severity === "critical" ? criticalPool : advisoryPool,
    draft.claim,
  ));
}

/**
 * Enrich marker claims with structured locations without letting the optional
 * block change their severity. Claim text remains the cross-source identity,
 * but each occurrence consumes exactly one marker slot, preferring a
 * same-severity slot when duplicate wording appears at both severities.
 */
function alignStructuredSeverity(
  structured: readonly LegacyDraftFinding[],
  markers: readonly LegacyDraftFinding[],
): readonly LegacyDraftFinding[] {
  const remaining = [...markers];
  return structured.map((draft) => {
    const sameSeverity = remaining.findIndex(
      (marker) => marker.claim === draft.claim && marker.severity === draft.severity,
    );
    const match = sameSeverity >= 0
      ? sameSeverity
      : remaining.findIndex((marker) => marker.claim === draft.claim);
    if (match < 0) return draft;
    const [marker] = remaining.splice(match, 1);
    return marker!.severity === draft.severity
      ? draft
      : Object.freeze({ ...draft, severity: marker!.severity });
  });
}

/**
 * Decide between the structured block and the scraped marker lines.
 *
 * The block carries file/line the scraper cannot recover, so it is preferred —
 * but only when it accounts for at least as many findings OF EACH SEVERITY as
 * the marker lines do (and, for criticals, as the reviewer's own
 * `CRITICAL_COUNT`). Below that bar the block is discarding claims the reviewer
 * demonstrably made, and no amount of location metadata is worth a lost finding.
 *
 * The advisory half of that bar is not decoration. Gating on criticals alone
 * let a criticals-only block win outright and delete every `ADVISORY:` marker
 * line, while `blockStatus` still reported `used` so no degradation note was
 * printed. The wave gate's advisory-disposition step (the `await-user` action
 * in `commands/wave-gate.md`) must triage every advisory to fixed/deferred/
 * dismissed; it cannot triage what it never sees. Archived v1 reviewer files
 * include Machine Summary markers and a fenced findings block; the contract
 * tests pin that historical surface. This v1-only arbitration must defend
 * against blocks that omit advisory entries. Current v2 emits JSON only and
 * never enters this marker/block arbitration.
 *
 * Counting is necessary and NOT sufficient. Arbitration stays cardinal on
 * purpose — demanding that the block reproduce marker text verbatim would
 * reject every reworded block and permanently cost the file/line the block
 * exists to carry — so a block that names two claims can clear a bar of two
 * while naming neither of the reviewer's actual claims. That is the one path
 * here that DESTROYED a finding rather than degrading it: the count matched, so
 * `reconcileFindings` stayed quiet; `blockStatus` said `used`, so no note was
 * printed; and the views were internally consistent, so the lockstep check
 * passed. The winner is therefore reconciled by VALUE as well: any marker claim
 * the block does not name is carried over beside it as a location-less draft,
 * and the operator is told through `partial`. Nothing is lost, and nothing the
 * reviewer did not say is invented.
 *
 * `CRITICAL_COUNT` always comes from the markers: the count is the reviewer's
 * own tally and is what distinguishes "zero findings" from "the parse failed".
 */
function markerClaimsUnnamedByBlock(
  scraped: LegacyParsedFindings,
  structured: readonly LegacyDraftFinding[],
): readonly LegacyDraftFinding[] {
  return draftsUnaccountedFor(scraped.drafts, structured);
}

function supersededBlockFindings(
  scraped: LegacyParsedFindings,
  structured: readonly LegacyDraftFinding[],
  counts: Pick<LegacyParsedFindings, "criticalCount" | "advisoryCount">,
): LegacyParsedFindings {
  // The block lost the cardinal comparison, but claims found only there remain
  // evidence. Consume marker claims as multisets, separately by severity.
  const recovered = draftsUnaccountedFor(structured, scraped.drafts);
  return makeParsedFindings({
    drafts: [...scraped.drafts, ...recovered],
    ...counts,
    blockStatus: { kind: "superseded", carriedOver: recovered.length },
  });
}

function chooseSource(scraped: LegacyParsedFindings, block: string): LegacyParsedFindings {
  const counts = { criticalCount: scraped.criticalCount, advisoryCount: scraped.advisoryCount };
  const parsedBlock = parseFindingsBlockResult(block);
  if (parsedBlock.kind !== "parsed") {
    return makeParsedFindings({
      drafts: scraped.drafts,
      ...counts,
      blockStatus: parsedBlock,
    });
  }
  const structured = alignStructuredSeverity(parsedBlock.drafts, scraped.drafts);
  const fromBlock = makeParsedFindings({ drafts: structured, ...counts, blockStatus: { kind: "used" } });
  const claimedCritical = Math.max(scraped.criticalCount ?? 0, scraped.critical.length);
  const accountsForAll =
    fromBlock.critical.length >= claimedCritical &&
    fromBlock.advisory.length >= scraped.advisory.length;

  // Compare by normalized claim as a severity-partitioned multiset: duplicate
  // wording and same-text cross-severity findings remain distinct evidence.
  const unnamedByBlock = markerClaimsUnnamedByBlock(scraped, structured);
  if (!accountsForAll) return supersededBlockFindings(scraped, structured, counts);

  return unnamedByBlock.length === 0
    ? fromBlock
    : makeParsedFindings({
        // The block's entries first, so its file/line-bearing findings keep
        // their order; the recovered marker claims follow, location-less.
        drafts: [...structured, ...unnamedByBlock],
        ...counts,
        blockStatus: { kind: "partial", carriedOver: unnamedByBlock.length },
      });
}

/**
 * Legacy fallback: section-headed Critical/Advisory blocks first; fall back to a
 * whole-output line scan when those sections yield NO claims — which covers both
 * "no section matched" and "a section matched but its only entry was the literal
 * `None` placeholder".
 *
 * Arbitrated through `chooseSource` exactly like the Machine Summary path. It
 * used to return the scraped claims directly, so a reviewer that emitted a
 * perfectly good ```findings block under a heading `parseMachineSummary` does
 * not match (`**Machine Summary**`, bold with no hashes) had its file/line
 * silently discarded AND was reported as `blockStatus: "absent"` — the one value
 * documented to mean "the reviewer emitted no block", so `blockStatusNote`
 * printed nothing about a real degradation.
 */
export function parseLegacyFindings(output: string): LegacyParsedFindings {
  return chooseSource(scrapeLegacyFindings(output), output);
}

function legacySectionClaims(output: string, heading: "Critical" | "Advisory"): readonly string[] {
  const section = output.match(new RegExp(`###?\\s*${heading}(?:\\s+Findings)?[\\s\\S]*?(?=###? |$)`));
  return section === null
    ? []
    : [...section[0].matchAll(/^- (?:\*\*)?(.+?)(?:\*\*)?$/gm)]
        .map((match) => match[1]!)
        .filter((claim) => claim !== "None");
}

function scrapeLegacyFindings(output: string): LegacyParsedFindings {
  const critical = legacySectionClaims(output, "Critical");
  const advisory = legacySectionClaims(output, "Advisory");

  if (critical.length === 0 && advisory.length === 0) {
    return extractFindings(output);
  }

  return makeParsedFindings({
    critical,
    advisory,
    criticalCount: declaredCount(output, "CRITICAL"),
    advisoryCount: declaredCount(output, "ADVISORY"),
  });
}

// ---------------------------------------------------------------------------
// The one path both harnesses take
// ---------------------------------------------------------------------------

/** A finding set proven to belong to a specific Review Packet generation. */
export interface BoundReviewEvidence {
  readonly packetId: string;
  readonly generation: number;
  readonly priorAssessments: readonly PriorFindingAssessment[];
}

/**
 * What a review transcript resolves to. Closed union of FOUR outcomes, and no
 * "maybe" shape a caller could forget to handle:
 *
 * - `evidence-failed` — the reviewer emitted no usable evidence marker, so the
 *   wave must not silently pass;
 * - `ignored-stale` — the output is bound to a packet generation that is no
 *   longer current, so it is discarded rather than merged;
 * - `findings` — a reconciled finding set with no packet binding (legacy merge);
 * - `bound-findings` — a reconciled finding set WITH its `BoundReviewEvidence`.
 *
 * The last two were one variant with an optional `bound` field, and every
 * consumer re-derived the distinction by hand: `applyReviewResolution` and
 * `reviewResolutionLog` between them tested `bound === undefined` six times to
 * choose between two genuinely different behaviours. Splitting the arm makes
 * `ts-pattern`'s `.exhaustive()` prove each branch handled instead.
 */
export type ReviewResolution =
  | { readonly kind: "evidence-failed"; readonly agent: string; readonly message: string }
  | { readonly kind: "ignored-stale"; readonly agent: string; readonly message: string }
  | {
      readonly kind: "findings";
      readonly agent: string;
      readonly findings: LegacyParsedFindings;
    }
  | {
      readonly kind: "bound-findings";
      readonly agent: string;
      readonly findings: LegacyParsedFindings;
      readonly bound: BoundReviewEvidence;
      readonly issuedSlot?: never;
    }
  | {
      readonly kind: "bound-findings";
      readonly agent: string;
      readonly findings: CurrentParsedFindings;
      readonly bound: BoundReviewEvidence;
      readonly issuedSlot: Readonly<{ request_id: string; context_digest: string; slot_id: string; attempted: 1 | 2 }>;
    };

/** Either finding-carrying arm — the two that own a `ParsedFindings`. */
export type FindingsResolution = Extract<
  ReviewResolution,
  { readonly kind: "findings" | "bound-findings" }
>;

export type UnboundReviewResolution = Exclude<
  ReviewResolution,
  { readonly kind: "ignored-stale" | "bound-findings" }
>;

/** Pure: parse → reconcile, in one place, for every harness. */
export function resolveReviewFindings(transcript: string, agent: string): UnboundReviewResolution {
  const findings = parseMachineSummary(transcript) ?? parseLegacyFindings(transcript);
  return findings.criticalCount === null || findings.advisoryCount === null
    ? { kind: "evidence-failed", agent, message: buildEvidenceFailureMessage(findings) }
    : { kind: "findings", agent, findings: reconcileFindings(findings) };
}

const REVIEW_LIFECYCLE_BLOCK =
  /^[ \t]*```[ \t]*review_lifecycle[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

function lastMarker(text: string, name: string): string | null {
  const pattern = new RegExp(`^[ \\t\\-*]*\\*{0,2}${name}:?\\*{0,2}\\s*(\\S+)`, "gim");
  let value: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) value = match[1]!;
  return value;
}

function unexpectedFields(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): string | null {
  const expected = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !expected.has(key)).sort();
  return unexpected.length === 0
    ? null
    : `${path} contains unexpected field(s): ${unexpected.join(", ")}`;
}

function parsePriorAssessments(
  transcript: string,
  priorIds: readonly string[],
): { readonly ok: true; readonly value: readonly PriorFindingAssessment[] } |
   { readonly ok: false; readonly error: string } {
  REVIEW_LIFECYCLE_BLOCK.lastIndex = 0;
  const bodies: string[] = [];
  for (let match = REVIEW_LIFECYCLE_BLOCK.exec(transcript); match !== null;
       match = REVIEW_LIFECYCLE_BLOCK.exec(transcript)) bodies.push(match[1]!);
  if (bodies.length === 0) {
    return { ok: false, error: "review_lifecycle block missing for packet-bound review" };
  }
  if (bodies.length > 1) {
    return { ok: false, error: "packet-bound review must contain exactly one review_lifecycle block" };
  }
  const body = bodies[0]!;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `review_lifecycle block is not valid JSON: ${cause}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "review_lifecycle block must be a JSON object" };
  }
  const root = raw as Record<string, unknown>;
  const rootFieldsError = unexpectedFields(root, ["prior_findings"], "review_lifecycle");
  if (rootFieldsError !== null) return { ok: false, error: rootFieldsError };
  const entries = root.prior_findings;
  if (!Array.isArray(entries)) return { ok: false, error: "review_lifecycle.prior_findings must be an array" };
  const assessments: PriorFindingAssessment[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `review_lifecycle.prior_findings[${index}] must be an object` };
    }
    const record = entry as Record<string, unknown>;
    const fieldsError = unexpectedFields(
      record,
      ["finding_id", "verdict", "reason"],
      `review_lifecycle.prior_findings[${index}]`,
    );
    if (fieldsError !== null) return { ok: false, error: fieldsError };
    const findingId = typeof record.finding_id === "string" ? record.finding_id.trim() : "";
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (findingId === "" || reason === "" ||
        !(PRIOR_FINDING_VERDICTS as readonly unknown[]).includes(record.verdict)) {
      return { ok: false, error: `review_lifecycle.prior_findings[${index}] is malformed` };
    }
    assessments.push({
      finding_id: findingId,
      verdict: record.verdict as PriorFindingAssessment["verdict"],
      reason,
    });
  }
  const ids = assessments.map((assessment) => assessment.finding_id);
  if (ids.length !== priorIds.length || ids.some((id, index) => id !== priorIds[index])) {
    return { ok: false, error: "review_lifecycle must assess every prior finding exactly once in packet order" };
  }
  return { ok: true, value: assessments };
}

/** Parse a reviewer result against the immutable run that authorized it. */
export function resolveBoundReviewFindings(
  transcript: string,
  agent: string,
  run: Pick<LegacyReviewRun, "packet_id" | "generation" | "prior_finding_ids">,
): ReviewResolution {
  const packetId = lastMarker(transcript, "REVIEW_PACKET_ID");
  const generationRaw = lastMarker(transcript, "REVIEW_GENERATION");
  if (packetId === null || generationRaw === null) {
    return {
      kind: "evidence-failed",
      agent,
      message: "review output omitted REVIEW_PACKET_ID or REVIEW_GENERATION",
    };
  }
  if (packetId !== run.packet_id || generationRaw !== String(run.generation)) {
    return {
      kind: "ignored-stale",
      agent,
      message: `review output is not bound to current packet ${run.packet_id} generation ${run.generation}`,
    };
  }
  const base = resolveReviewFindings(transcript, agent);
  if (base.kind !== "findings") return base;
  const assessments = parsePriorAssessments(transcript, run.prior_finding_ids);
  if (!assessments.ok) {
    return { kind: "evidence-failed", agent, message: assessments.error };
  }
  return {
    kind: "bound-findings",
    agent: base.agent,
    findings: base.findings,
    bound: {
      packetId: run.packet_id,
      generation: run.generation,
      priorAssessments: assessments.value,
    },
  };
}

/**
 * Select the bound or legacy parser from current task authority. A transcript
 * carrying packet markers can never fall back to legacy merge merely because
 * implementation invalidation or an override cleared its now-stale run first.
 */
export function resolveTaskReviewFindings(
  transcript: string,
  agent: string,
  run: ReviewRun | undefined,
  reviewGeneration: number | undefined,
): ReviewResolution {
  if (run?.reviewer_protocol !== undefined) return {
    kind: "evidence-failed", agent, message: "current review requires issued reviewer protocol authority",
  };
  if (run !== undefined) return resolveBoundReviewFindings(transcript, agent, run);
  if (reviewGeneration !== undefined ||
      lastMarker(transcript, "REVIEW_PACKET_ID") !== null ||
      lastMarker(transcript, "REVIEW_GENERATION") !== null) {
    return {
      kind: "ignored-stale",
      agent,
      message: "review output has no matching active review run for this generation-aware task",
    };
  }
  return resolveReviewFindings(transcript, agent);
}

/**
 * Bind located wave findings to the task's Review Packet scope. A null location
 * is honest for cross-cutting claims and remains valid; a supplied path must be
 * one of the task's declared or observed files.
 */
export function constrainReviewResolutionToScope(
  resolution: ReviewResolution,
  scope: readonly string[],
): ReviewResolution {
  if (resolution.kind !== "findings" && resolution.kind !== "bound-findings") return resolution;
  const allowed = new Set(scope.flatMap((path) => {
    const parsed = parseReviewPath(path, "review scope path");
    return parsed.ok ? [parsed.value] : [];
  }));
  const outside = resolution.findings.drafts
    .map((finding) => finding.file)
    .filter((file): file is string => {
      if (file === null) return false;
      const parsed = parseReviewPath(file, "review finding path");
      return !parsed.ok || !allowed.has(parsed.value);
    });
  if (outside.length === 0) return resolution;
  return {
    kind: "evidence-failed",
    agent: resolution.agent,
    message: `review finding location(s) outside Review Packet scope: ${[...new Set(outside)].join(", ")}`,
  };
}

/**
 * Pure review invalidation for any transition that records implementation writes.
 * A pending review cannot simultaneously carry outstanding evidence-capture
 * failures: that pairing is reserved for `evidence_capture_failed` and is enforced
 * at the task-graph load boundary.
 */
export function invalidateTaskReview(task: Task): Task {
  return {
    ...task,
    review_status: "pending",
    review_generation: (task.review_generation ?? 0) + 1,
    review_run: undefined,
    accepted_review_authority: undefined,
    review_error: undefined,
    review_evidence_failures: undefined,
  };
}

function markReviewEvidenceFailed(task: Task, agent: string, message: string): Task {
  return {
    ...task,
    review_status: "evidence_capture_failed",
    review_error: message,
    review_evidence_failures: [
      ...(task.review_evidence_failures ?? []).filter((failed) => failed !== agent),
      agent,
    ],
  };
}

/** Pure: the complete task transform a resolution implies. */
export function applyReviewResolution(
  task: Task,
  resolution: ReviewResolution,
  slotAuthority?: ReviewRunSlotAuthority,
): Task {
  return match(resolution)
    .with({ kind: "ignored-stale" }, (): Task => task)
    .with({ kind: "evidence-failed" }, (r): Task => {
      // One immutable slot per expected reviewer. A duplicate process failure
      // arriving after that slot succeeded is stale noise, not grounds to poison
      // an otherwise completeable run.
      if (task.review_run !== undefined && !task.review_run.expected_agents.includes(r.agent)) return task;
      if (task.review_run?.evidence.some((evidence) => evidence.agent === r.agent)) return task;
      // Named, not just counted. The status is per-task and the failure is
      // per-agent, so recording WHICH reviewer could not be parsed is what lets
      // a clean retry clear exactly its own failed evidence.
      return markReviewEvidenceFailed(task, r.agent, r.message);
    })
    .with({ kind: "findings" }, (r): Task => mergeFindings(task, r.findings, r.agent))
    .with({ kind: "bound-findings" }, (r): Task => {
      let evidence: CurrentReviewRunEvidence | LegacyReviewRunEvidence;
      if (r.findings.protocolVersion === 2) {
        if (r.issuedSlot === undefined) return markReviewEvidenceFailed(task, r.agent, "current findings require issued request/context authority");
        evidence = {
          protocolVersion: 2, agent: r.agent, prior_assessments: r.bound.priorAssessments,
          new_findings: r.findings.drafts, ...r.issuedSlot,
        };
      } else {
        const baseEvidence = { agent: r.agent, prior_assessments: r.bound.priorAssessments, new_findings: r.findings.drafts };
        evidence = slotAuthority === undefined ? baseEvidence : {
          ...baseEvidence, slot_id: slotAuthority.slot_id, attempted: slotAuthority.attempted,
        };
      }
      const transition = recordReviewRunEvidence(
        task,
        r.bound.packetId,
        r.bound.generation,
        evidence,
      );
      if (transition.ok) return transition.task;

      // A result resolved against an older snapshot must not poison the current
      // packet. For the still-active matching packet, however, losing the
      // transition error would let the shell report evidence as staged when no
      // state was written. Preserve that failure in the same typed review
      // record used for transcript parse failures.
      const currentRun = task.review_run;
      if (currentRun === undefined ||
          currentRun.packet_id !== r.bound.packetId ||
          currentRun.generation !== r.bound.generation ||
          currentRun.evidence.some((evidence) => evidence.agent === r.agent)) return task;
      return markReviewEvidenceFailed(task, r.agent, transition.error);
    })
    .exhaustive();
}

/**
 * The larger of the reviewer's tally and what was actually captured — the same
 * disjunction `mergeFindings` blocks on. Reporting the tally alone logged
 * "passed (0 critical)" for a task the very next line recorded as blocked with a
 * real critical in it.
 */
function criticalTally(resolution: FindingsResolution): number {
  return Math.max(resolution.findings.criticalCount ?? 0, resolution.findings.critical.length);
}

/**
 * The operator-facing note a degraded structured block earns. Empty when the
 * block was used or never offered — only a LOSS is worth a line of output.
 *
 * `carriedOver` is reported because arbitration deliberately prefers a
 * DUPLICATED finding to a lost one: a block that rewords the marker claims
 * clears the cardinal bar and then names none of them, so every marker claim
 * comes across beside it and the same defect is adjudicated twice. That is the
 * right trade — the alternative, capping the carry-over, deletes real claims
 * whenever the block names different ones — but it costs a verifier vote per
 * duplicate, and an operator who cannot see the count cannot tell an inflated
 * finding set from a genuinely large one.
 */
function blockStatusNote(status: FindingsBlockStatus | CurrentParsedFindings["blockStatus"]): string {
  const carried = (count: number) => `${count} claim(s) carried over`;
  return match(status)
    .with({ kind: "absent" }, () => "")
    .with({ kind: "used" }, () => "")
    .with({ kind: "json" }, () => "")
    .with(
      { kind: "rejected" },
      (s) => ` [findings block was malformed (${s.reason}) — fell back to marker lines, ` +
        "findings carry no file/line]",
    )
    .with(
      { kind: "superseded" },
      (s) =>
        ` [findings block under-reported findings — used marker lines, ${carried(s.carriedOver)} ` +
        `from the block; the rest carry no file/line]`,
    )
    .with(
      { kind: "partial" },
      (s) =>
        ` [findings block did not name every marker claim — ${carried(s.carriedOver)} without ` +
        `file/line, so a reworded claim is adjudicated twice]`,
    )
    .exhaustive();
}

/** Pure: the operator-facing line a harness writes to stderr for a resolution. */
export function reviewResolutionLog(
  taskId: string,
  resolution: ReviewResolution,
  appliedTask?: Task,
  applicationChanged?: boolean,
): string {
  return match(resolution)
    .with(
      { kind: "evidence-failed" },
      (r) => `WARNING: ${r.message} for ${taskId} — ` +
        (applicationChanged === true && appliedTask?.review_evidence_failures?.includes(r.agent)
          ? "marking evidence_capture_failed"
          : "review evidence rejected (evidence_capture_failed diagnostic; no mutation asserted)"),
    )
    .with(
      { kind: "ignored-stale" },
      (r) => `WARNING: ${r.message} for ${taskId} — evidence ignored`,
    )
    .with({ kind: "findings" }, (r) =>
      `Task ${taskId} review: ${criticalTally(r) > 0 ? "blocked" : "passed"} (${criticalTally(r)} critical)` +
      blockStatusNote(r.findings.blockStatus))
    .with({ kind: "bound-findings" }, (r) => {
      if (appliedTask?.review_evidence_failures?.includes(r.agent)) {
        return `WARNING: ${appliedTask.review_error ?? "review evidence was rejected"} for ${taskId} — marking evidence_capture_failed`;
      }
      if (applicationChanged === false) {
        return `WARNING: review evidence did not apply to current task state for ${taskId} — evidence ignored`;
      }
      if (appliedTask !== undefined && appliedTask.review_generation !== r.bound.generation) {
        return `WARNING: review output is stale for ${taskId} — evidence ignored`;
      }
      return `Task ${taskId} review evidence staged for packet ${r.bound.packetId} (${criticalTally(r)} new critical)` +
        blockStatusNote(r.findings.blockStatus);
    })
    .exhaustive();
}
