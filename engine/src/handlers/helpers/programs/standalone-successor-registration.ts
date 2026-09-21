/** Explicit successor ingress and frozen source data. These records are not nominal predecessor authority. */
import { boundedThrownCause, canonicalStructuralEquals } from "../../../core/orchestration-contract";
import { parseBoundedReviewerJson } from "../../../core/reviewer-protocol";
import { parseStandaloneReviewScope, STANDALONE_REVIEWER_ROLES, type StandaloneReviewKind } from "../../../core/standalone-review";
import { STANDALONE_LINEAGE_LIMITS, STANDALONE_REVIEWER_PROTOCOL_V3, parseStandaloneReviewerProtocolV3,
  standalonePublicationReferenceSchema, type StandalonePublicationReference } from "../../../core/standalone-lineage-contract";
import type { StandaloneDispositionPublicationReference } from "../../../core/standalone-lineage";
import { encodeByteSection, boundedByteIterable, type ByteSection } from "../../../core/context-packets";
import type { ProgramParse } from "./program-result";

// The bounded thrown-cause capture lives in the orchestration-contract kernel
// (cs-6: ONE owner for the packet parsers, the projection read-model, and the
// adapters). Re-exported so the sibling adapters that import it from here keep
// working; this module's own callsites pass the full "successor …" subject
// phrase that preserves the historical fallback prose byte-for-byte.
export { boundedThrownCause } from "../../../core/orchestration-contract";

export type StandaloneSuccessorStartInput = Readonly<{
  schemaVersion: 3; kind: StandaloneReviewKind; files: readonly string[]; dryRun: false;
  successor: Readonly<{ source: StandalonePublicationReference; disposition:
    | Readonly<{ kind: "historical-decision-unavailable" }>
    | Readonly<{ kind: "selected-record"; publication: StandaloneDispositionPublicationReference }> }>;
}>;
export type RegisteredStandaloneSuccessorProgram = Readonly<{
  schemaVersion: 3; kind: "standalone-review"; reviewerProtocol: typeof STANDALONE_REVIEWER_PROTOCOL_V3;
  input: StandaloneSuccessorStartInput; authority: unknown; currentSource: ByteSection; previousContexts: readonly ByteSection[];
}>;
const bad = (message: string): ProgramParse<never> => ({ ok: false, message });
function exact(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && Reflect.ownKeys(raw).length === keys.length &&
    keys.every(key => { const field = Object.getOwnPropertyDescriptor(raw, key); return field !== undefined && "value" in field && field.enumerable; });
}
export function parseStandaloneSuccessorStartInput(raw: unknown): ProgramParse<StandaloneSuccessorStartInput> {
  if (!exact(raw, ["schemaVersion", "kind", "files", "dryRun", "successor"]) || raw.schemaVersion !== 3 || raw.dryRun !== false ||
      !exact(raw.successor, ["source", "disposition"])) return bad("successor input requires explicit schemaVersion 3, kind, files, dryRun false, and successor source/disposition");
  const kinds: readonly StandaloneReviewKind[] = ["code", "errors", "tests", "types", "comments", "architecture", "simplify", "all"];
  const kind = kinds.find(kind => kind === raw.kind);
  if (kind === undefined || !Array.isArray(raw.files) || raw.files.length > STANDALONE_LINEAGE_LIMITS.paths) return bad("successor kind or bounded explicit scope is invalid");
  const scope = parseStandaloneReviewScope(raw.files);
  if (!scope.ok || !canonicalStructuralEquals(scope.value, raw.files)) return bad("successor files must be the ordered canonical explicit scope");
  if (!exact(raw.successor.source, ["locator", "runId", "resultDigest"])) return bad("successor publication reference must contain only exact own-data fields");
  const source = standalonePublicationReferenceSchema.safeParse(raw.successor.source);
  if (!source.success) return bad("successor source must name an exact publication locator, Run and result digest");
  const selection = raw.successor.disposition;
  let disposition: StandaloneSuccessorStartInput["successor"]["disposition"];
  if (exact(selection, ["kind"]) && selection.kind === "historical-decision-unavailable") {
    disposition = Object.freeze({ kind: "historical-decision-unavailable" });
  } else if (exact(selection, ["kind", "publication"]) && selection.kind === "selected-record" &&
      exact(selection.publication, ["locator", "runId", "dispositionDigest"])) {
    const publication = standalonePublicationReferenceSchema.safeParse({ locator: selection.publication.locator,
      runId: selection.publication.runId, resultDigest: selection.publication.dispositionDigest });
    if (!publication.success) return bad("successor disposition requires an exact published revision");
    disposition = Object.freeze({ kind: "selected-record", publication: Object.freeze({ locator: publication.data.locator,
      runId: publication.data.runId, dispositionDigest: publication.data.resultDigest }) });
  } else return bad("successor disposition selection is invalid; no inferred latest or fallback");
  return { ok: true, value: Object.freeze({ schemaVersion: 3, kind, files: scope.value, dryRun: false,
    successor: Object.freeze({ source: source.data, disposition }) }) };
}

/** The section byte grammar is owned by the packet core (`boundedByteIterable`);
 *  this adapter keeps the registration parser's null-collapse refusal shape, so
 *  the successor path cannot drift from the packet parser on what legal bytes
 *  are while its own "invalid bounded ... section" messages stay exact. */
function boundedSectionBytes(raw: unknown, maximum: number): Uint8Array | null {
  const parsed = boundedByteIterable(raw, maximum);
  return parsed.ok ? parsed.value : null;
}

/** Structural dispatch only. LC-2 parsing additionally requires independently authenticated nominal successor data. */
export function parseStandaloneSuccessorRegistration(raw: unknown): ProgramParse<RegisteredStandaloneSuccessorProgram> {
  if (!exact(raw, ["schemaVersion", "kind", "reviewerProtocol", "input", "authority", "currentSource", "previousContexts"]) ||
      raw.schemaVersion !== 3 || raw.kind !== "standalone-review") return bad("invalid standalone successor registration fields");
  const descriptor = parseStandaloneReviewerProtocolV3(raw.reviewerProtocol);
  const input = parseStandaloneSuccessorStartInput(raw.input);
  if (!descriptor.ok) return bad(descriptor.error.message);
  if (!input.ok) return input;
  if (!exact(raw.currentSource, ["label", "bytes", "digest", "byteLength"]) || raw.currentSource.label !== "standalone-frozen-source") {
    return bad("invalid bounded frozen successor source section");
  }
  const currentBytes = boundedSectionBytes(raw.currentSource.bytes, 4_194_304);
  if (currentBytes === null) return bad("invalid bounded frozen successor source section");
  try {
    const decoded = parseBoundedReviewerJson(currentBytes, STANDALONE_LINEAGE_LIMITS.retainedBytes);
    if (!decoded.ok) return bad(decoded.error.message);
    const section = encodeByteSection("standalone-frozen-source", new TextDecoder("utf-8", { fatal: true }).decode(currentBytes));
    if (!section.ok) return bad(`frozen successor source section could not be encoded: ${section.error.message}`);
    if (section.value.digest !== raw.currentSource.digest || section.value.byteLength !== raw.currentSource.byteLength) return bad("frozen successor source section differs from exact bytes");
    if (!Array.isArray(raw.previousContexts) || raw.previousContexts.length > STANDALONE_REVIEWER_ROLES.length * 2 + 1) return bad("bounded predecessor contexts are required");
    const previousContexts: ByteSection[] = [];
    let remaining = 2_097_152;
    for (const previous of raw.previousContexts) {
      if (!exact(previous, ["label", "bytes", "digest", "byteLength"]) || typeof previous.label !== "string") {
        return bad("invalid bounded predecessor context section");
      }
      const previousBytes = boundedSectionBytes(previous.bytes, remaining);
      if (previousBytes === null) return bad("invalid bounded predecessor context section");
      remaining -= previousBytes.length;
      const section = encodeByteSection(previous.label, new TextDecoder("utf-8", { fatal: true }).decode(previousBytes));
      if (!section.ok) return bad(`predecessor context section could not be encoded: ${section.error.message}`);
      if (section.value.digest !== previous.digest || section.value.byteLength !== previous.byteLength) return bad("predecessor context section differs from exact bytes");
      previousContexts.push(section.value);
    }
    return { ok: true, value: Object.freeze({ schemaVersion: 3, kind: "standalone-review", reviewerProtocol: descriptor.value,
      input: input.value, authority: raw.authority, currentSource: section.value, previousContexts: Object.freeze(previousContexts) }) };
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "successor source");
    return bad(`frozen successor source cannot be decoded: ${cause.name}: ${cause.message}`);
  }
}
