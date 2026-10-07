/**
 * Standalone transcript admission: ONE semantic parse per reviewer transcript under its
 * Issued Reviewer Protocol, against the frozen scope. Historical v1 diagnostics and the
 * legacy archive's canonical-transcript aggregation share the same scoped legacy parse.
 */
import { attributeFindings, type Finding } from "./findings";
import type { NonEmpty } from "./orchestration-contract";
import { fail, ok, type ParseResult } from "./panel-kernel";
import {
  parseReviewerEvidence as parseIssuedReviewerEvidence, resolveReviewFindings,
  type IssuedStandaloneReviewerProtocol, type ParsedFindings,
} from "./review-output";
import { STANDALONE_REVIEW_SUBJECT } from "./reviewer-contract";
import type { StandaloneReviewAggregate, StandaloneReviewerEvidence, StandaloneReviewState } from "./standalone-review-model";
import { findingScopeErrors, type StandaloneReviewerRole } from "./standalone-review-scope";

export type StandaloneTranscriptAdmission =
  | Readonly<{ ok: true; findings: ParsedFindings }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

/**
 * ONE parser, ONE admitted result. Per-transcript semantic admission against
 * the frozen scope, returning the parsed findings with the admission: the
 * orchestration façade and aggregation share this validator AND the findings
 * it admits, so (1) a reviewer slot the façade rejects for attempt 2 is
 * exactly the slot aggregation would have refused, and (2) aggregation never
 * re-parses an admitted transcript — a second, independent parse is the exact
 * divergence that could silently drop a reviewer's evidence with nothing to
 * notice (the parse it admitted and the parse it trusted are the same call).
 */
export function admitStandaloneTranscript(
  authority: IssuedStandaloneReviewerProtocol,
  rawBytes: Uint8Array,
): StandaloneTranscriptAdmission {
  const parsed = parseIssuedReviewerEvidence(authority, rawBytes);
  if (parsed.ok || parsed.error.code !== "authority-unavailable") {
    if (authority.protocolVersion === 1 && authority.subject.kind === "standalone-review") {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes); }
      catch { return Object.freeze({ ok: false, problems: Object.freeze([`${authority.request.role}: transcript is not valid UTF-8`]) }); }
      // Preserve historical rejection diagnostics; admitted evidence is never parsed a second time.
      if (!parsed.ok) {
        const historical = admitLegacyStandaloneTranscript(authority.subject.scope, text, authority.request.role);
        if (!historical.ok) return historical;
      }
    }
  }
  if (parsed.ok && parsed.value.kind === "standalone-review") return Object.freeze({ ok: true, findings: parsed.value.findings });
  return Object.freeze({ ok: false, problems: Object.freeze([parsed.ok ? "standalone reviewer authority required" : parsed.error.message]) });
}

/** Historical archive only; registered completion always consumes issued protocol authority. */
function admitLegacyStandaloneTranscript(
  scope: readonly string[],
  output: string,
  agent: string,
): StandaloneTranscriptAdmission {
  const resolution = resolveReviewFindings(output, agent);
  if (resolution.kind === "evidence-failed") {
    return Object.freeze({ ok: false, problems: Object.freeze([`${agent}: ${resolution.message}`]) });
  }
  const problems = findingScopeErrors(scope, resolution.findings.drafts, `${agent} findings`);
  return problems.length > 0
    ? Object.freeze({ ok: false, problems: Object.freeze(problems) })
    : Object.freeze({ ok: true, findings: resolution.findings });
}

export function aggregateCanonicalTranscripts(
  runId: string,
  scope: readonly string[],
  transcripts: readonly Readonly<{ agent: StandaloneReviewerRole; output: string; evidence: StandaloneReviewerEvidence }>[],
): ParseResult<StandaloneReviewState> {
  const errors: string[] = [];
  const findings: Finding[] = [];
  for (const transcript of transcripts) {
    const admission = admitLegacyStandaloneTranscript(scope, transcript.output, transcript.agent);
    if (!admission.ok) {
      errors.push(...admission.problems);
      continue;
    }
    findings.push(...attributeFindings(admission.findings.drafts, transcript.agent));
  }
  if (errors.length > 0) return fail(errors);
  const ids = findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) return fail(["attributed standalone finding ids must be distinct across review agents"]);
  const aggregate: StandaloneReviewAggregate = Object.freeze({
    schemaVersion: 1,
    runId,
    subjectId: STANDALONE_REVIEW_SUBJECT,
    scope: Object.freeze([...scope]),
    reviewerEvidence: Object.freeze(transcripts.map(({ evidence }) => evidence)),
    findings: Object.freeze(findings),
  });
  const criticals = findings.filter((finding) => finding.severity === "critical");
  const [head, ...tail] = criticals;
  return head === undefined
    ? ok(Object.freeze({ kind: "clean", aggregate }))
    : ok(Object.freeze({
        kind: "requires-refutation",
        aggregate,
        criticals: Object.freeze([head, ...tail]) as NonEmpty<Finding>,
      }));
}
