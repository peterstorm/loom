/**
 * Standalone transcript admission: ONE semantic parse per reviewer transcript under its
 * Issued Reviewer Protocol, against the frozen scope. A rejected historical v1 transcript
 * keeps its scoped legacy diagnostics.
 */
import {
  parseReviewerEvidence as parseIssuedReviewerEvidence, resolveReviewFindings,
  type IssuedStandaloneReviewerProtocol, type ParsedFindings,
} from "./review-output";
import { renderReviewerPayloadDiagnostic } from "./reviewer-protocol";
import { findingScopeErrors } from "./standalone-review-scope";

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
  // The retry preamble is the ONLY feedback a rejected reviewer gets. The Wave
  // path renders it from the same helper; this one surfaced `error.message`
  // alone, which drops the JSON pointer, the byte offset and the size guidance
  // the parse already computed — so the next attempt re-emitted the defect.
  return Object.freeze({ ok: false, problems: Object.freeze([parsed.ok
    ? "standalone reviewer authority required"
    : renderReviewerPayloadDiagnostic(parsed.error, rawBytes.byteLength)]) });
}

/** Historical v1 diagnostics only; admitted evidence always comes from the issued protocol parse. */
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
