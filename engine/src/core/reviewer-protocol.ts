/** Bounded current wire codec. Version/issuance/scope joins belong to review-output. */
import { printParseErrorCode, visit } from "jsonc-parser";
import {
  REVIEWER_PAYLOAD_LIMITS, REVIEWER_PAYLOAD_SCHEMA_V2, REVIEWER_IMPACT_RUBRIC_V1,
  REVIEWER_OUTPUT_CONTRACT, REVIEWER_PAYLOAD_EXAMPLE_V2, reviewerPayloadV2Schema,
  type ReviewerPayloadV2, type ReviewerProtocolFailure,
} from "./reviewer-contract";
import { standaloneReviewerPayloadV3Schema, type StandaloneReviewerPayloadV3 } from "./standalone-lineage-contract";
import { canonicalRecord, failure, success, type DomainResult } from "./orchestration-contract/identity";

const encoder = new TextEncoder();
const pointer = (path: readonly PropertyKey[]): string =>
  path.map((key) => `/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
const rejected = (
  code: ReviewerProtocolFailure["code"], message: string, path = "", byteOffset?: number,
): DomainResult<never, ReviewerProtocolFailure> => failure(canonicalRecord({
  kind: "reviewer-protocol-failed", code, path, message,
  ...(byteOffset === undefined ? {} : { byteOffset }),
}));

/** Only a resource precheck, not another JSON grammar. Local state never escapes. */
function excessiveDepthOffset(text: string): number | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      depth++;
      if (depth > REVIEWER_PAYLOAD_LIMITS.depth) return index;
    } else if (char === "}" || char === "]") depth--;
  }
  return null;
}

/**
 * Deterministic extraction for prose-wrapped payloads: the outermost balanced
 * JSON object when exactly one candidate parses as strict JSON. A reviewer's
 * final message that wraps its payload in prose or a code fence still carries
 * the reviewer's own work; the engine extracts it without the orchestrator
 * hand-editing bytes, and the original transcript stays immutable audit
 * evidence. Zero candidates (no JSON) and ambiguity (two or more balanced,
 * parseable objects) fail closed to the bounded retry — only genuinely
 * ambiguous output burns a retry.
 *
 * The scan records spans only from a depth-0 `{` to its matching `}`, so
 * nested payload objects never create additional candidates, and braces
 * inside JSON string values or quoted prose never affect candidate
 * selection. Each candidate must itself JSON.parse — a prose brace pair that
 * forms no valid object is excluded. Local state never escapes: the scan
 * reads its argument and returns the extracted payload bytes.
 */
function extractStrictObject(text: string): { value: unknown; text: string } | null {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let objectStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{") {
      if (objectStart === -1) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        spans.push([objectStart, index + 1]);
        objectStart = -1;
      }
    }
  }
  // Parse each candidate exactly once: a candidate that survives is the
  // reviewer's own payload bytes, already decoded.
  const candidates = spans.flatMap(([start, end]): Array<{ value: unknown; text: string }> => {
    try { return [{ value: JSON.parse(text.slice(start, end)), text: text.slice(start, end) }]; }
    catch { return []; }
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function uniqueMembers(text: string): DomainResult<true, ReviewerProtocolFailure> {
  const objects: Set<string>[] = [];
  let problem: DomainResult<never, ReviewerProtocolFailure> | undefined;
  const visited = visit(text, {
    onObjectBegin: () => { objects.push(new Set()); },
    onObjectEnd: () => { objects.pop(); },
    onObjectProperty: (name, offset, _length, _line, _character, getPath) => {
      const names = objects.at(-1);
      if (names === undefined) {
        problem ??= rejected("invalid-json", "Object member has no enclosing object.");
      } else if (names.has(name)) {
        problem ??= rejected("duplicate-key", "Duplicate decoded object member name.", pointer([...getPath(), name]), encoder.encode(text.slice(0, offset)).byteLength);
      } else names.add(name);
    },
    onError: (_error, offset) => {
      problem ??= rejected("invalid-json", "JSON visitor rejected the payload.", "", encoder.encode(text.slice(0, offset)).byteLength);
    },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (problem !== undefined) return problem;
  return visited && objects.length === 0
    ? success(true)
    : rejected("invalid-json", "JSON visitor did not complete.");
}

/**
 * First strict-grammar error reported by the same scanner the companion
 * duplicate check uses, or `null` for text the scanner accepts (JSONC-legal
 * single quotes are the only gap; they fall back to the legacy message).
 * Runtime-independent: it never depends on the host engine's JSON.parse
 * error wording (the CLI runs under bun/JSC, whose messages carry no
 * position at all), so the retry diagnostic is identical on every host.
 * Local state never escapes: the scan reads its argument and returns data.
 */
function firstStrictJsonGrammarError(text: string): Readonly<{ code: number; offset: number }> | null {
  let first: Readonly<{ code: number; offset: number }> | null = null;
  visit(text, {
    onError: (code, offset) => {
      first ??= Object.freeze({ code, offset });
    },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  return first;
}

/** Shared strict byte grammar; callers select a schema explicitly after this parse. */
export function parseBoundedReviewerJson(rawBytes: Uint8Array, maximumBytes: number): DomainResult<unknown, ReviewerProtocolFailure> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || rawBytes.byteLength > maximumBytes) {
    return rejected("payload-too-large", `Reviewer payload exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
    return rejected("invalid-utf8", "Reviewer payload must not start with a UTF-8 BOM.", "", 0);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    return rejected("invalid-utf8", "Reviewer payload must contain valid UTF-8.");
  }
  const depthOffset = excessiveDepthOffset(text);
  if (depthOffset !== null) {
    return rejected("depth-exceeded", "Reviewer payload exceeds 32 nested containers.", "", encoder.encode(text.slice(0, depthOffset)).byteLength);
  }
  let payloadText = text;
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(text);
  } catch {
    // A prose-wrapped payload still carries the reviewer's own final message;
    // deterministic extraction admits it without hand-editing the original
    // transcript bytes, which stay immutable audit evidence. Zero candidates
    // and ambiguity fail closed to the bounded retry. The retry preamble names
    // the underlying grammar failure so the next attempt can self-correct: the
    // strict scanner reports the exact offending position, which is exactly
    // what an agent needs to find the unescaped quote or unbalanced bracket.
    const extracted = extractStrictObject(text);
    if (extracted === null) {
      const grammar = firstStrictJsonGrammarError(text);
      if (grammar === null) {
        return rejected("invalid-json", "Reviewer payload must be exactly one strict JSON object.");
      }
      const prefix = text.slice(0, grammar.offset);
      const line = (prefix.match(/\n/g)?.length ?? 0) + 1;
      const column = grammar.offset - prefix.lastIndexOf("\n");
      return rejected(
        "invalid-json",
        `Reviewer payload must be exactly one strict JSON object. Parse error: ${printParseErrorCode(grammar.code)} at position ${grammar.offset} (line ${line}, column ${column})`,
        "",
        encoder.encode(prefix).byteLength,
      );
    }
    parsedValue = extracted.value;
    payloadText = extracted.text;
  }
  try {
    const unique = uniqueMembers(payloadText);
    if (!unique.ok) return unique;
    return success(parsedValue);
  } catch {
    return rejected("invalid-payload", "Reviewer payload could not be inspected safely.");
  }
}

/**
 * The retry-facing diagnostic for a rejected reviewer payload. The strict
 * parse already knows WHY (code/message/path/byteOffset) and the caller knows
 * HOW BIG the captured bytes were; the attempt-2 preamble must name both so
 * the next emission can self-correct instead of re-emitting the same shape.
 * Above the model-reliability ceiling the guidance tells the agent to compress
 * (long re-verification reasons are the usual size driver); below it, to
 * validate before finalizing. Pure; the caller hands it the failure and the
 * captured byte length.
 */
export function renderReviewerPayloadDiagnostic(
  failure: ReviewerProtocolFailure,
  payloadByteLength: number,
): string {
  const located = failure.byteOffset === undefined
    ? failure.message
    : `${failure.message}${failure.path === "" ? "" : ` at ${failure.path}`} (byte ${failure.byteOffset})`;
  const guidance = payloadByteLength > REVIEWER_PAYLOAD_LIMITS.retryGuidanceBytes
    ? `keep the final JSON under ${REVIEWER_PAYLOAD_LIMITS.retryGuidanceBytes} bytes — compress re-verification reasons to one sentence per prior finding and escape every quote inside prose`
    : `validate the emitted JSON with JSON.parse before finalizing`;
  return `${located} (payload ${payloadByteLength} bytes; ${guidance})`;
}

export function parseStandaloneReviewerPayloadV3(rawBytes: Uint8Array): DomainResult<StandaloneReviewerPayloadV3, ReviewerProtocolFailure> {
  const decoded = parseBoundedReviewerJson(rawBytes, REVIEWER_PAYLOAD_LIMITS.bytes);
  if (!decoded.ok) return decoded;
  const value = decoded.value;
  if (typeof value === "object" && value !== null && (
    ("priorAssessments" in value && Array.isArray(value.priorAssessments) && value.priorAssessments.length > REVIEWER_PAYLOAD_LIMITS.priorFindings) ||
    ("findings" in value && Array.isArray(value.findings) && value.findings.length > REVIEWER_PAYLOAD_LIMITS.findings))) {
    return rejected("invalid-payload", "Standalone v3 inventory exceeds its pre-copy count budget.");
  }
  const parsed = standaloneReviewerPayloadV3Schema.safeParse(value);
  return parsed.success ? success(parsed.data)
    : rejected("invalid-payload", "Reviewer payload does not conform to the issued standalone v3 schema.", pointer(parsed.error.issues[0]?.path ?? []));
}

export function parseReviewerPayloadV2(rawBytes: Uint8Array): DomainResult<ReviewerPayloadV2, ReviewerProtocolFailure> {
  const decoded = parseBoundedReviewerJson(rawBytes, REVIEWER_PAYLOAD_LIMITS.bytes);
  if (!decoded.ok) return decoded;
  try {
    const parsed = reviewerPayloadV2Schema.safeParse(decoded.value);
    if (!parsed.success) {
      return rejected("invalid-payload", "Reviewer payload does not conform to the issued v2 schema.", pointer(parsed.error.issues[0]?.path ?? []));
    }
    return success(parsed.data);
  } catch {
    // Never expose a dependency exception: it can contain the complete input.
    return rejected("invalid-payload", "Reviewer payload could not be inspected safely.");
  }
}

/** The stamper consumes this same executable schema, parsed example and exact rubric. */
export function renderReviewerWireContract(): string {
  return `${REVIEWER_OUTPUT_CONTRACT}\n\n## reviewer-payload-schema\n\n\`\`\`json\n${REVIEWER_PAYLOAD_SCHEMA_V2}\n\`\`\`\n\n## Current example (standalone)\n\n\`\`\`json\n${JSON.stringify(REVIEWER_PAYLOAD_EXAMPLE_V2, null, 2)}\n\`\`\`\n\n## reviewer-impact-rubric\n\n${REVIEWER_IMPACT_RUBRIC_V1}`;
}
