/** The executable no-agent disposition publication lifecycle. Registration is data, never publication authority. */
import { match } from "ts-pattern";
import { readDenseDataArray, readExactDataRecord } from "./orchestration-contract/bytes";
import { canonicalRecord, canonicalStructuralEquals, failure, success, parseOrchestrationRunId, type DomainResult } from "./orchestration-contract/identity";
import { parseEffectReceipt, type ArtifactSetPublished } from "./orchestration-contract/effects";
import { sha256Hex } from "./digest";
import { parseBoundedReviewerJson } from "./reviewer-protocol";
import { STANDALONE_LINEAGE_LIMITS, standaloneDispositionSchema, standalonePublicationReferenceSchema,
  type StandaloneDispositionRecord, type StandalonePublicationReference } from "./standalone-lineage-contract";
import type { StandaloneDispositionPublicationReference } from "./standalone-review-model";

type Error = Readonly<{ message: string }>;
const reject = (message: string): DomainResult<never, Error> => failure(canonicalRecord({ message }));
export type StandaloneDispositionStartInput = Readonly<{
  source: StandalonePublicationReference;
  record: StandaloneDispositionRecord;
  previous: StandaloneDispositionPublicationReference | null;
}>;
export type RegisteredStandaloneDispositionProgram = Readonly<{
  schemaVersion: 1; kind: "standalone-disposition"; runId: string;
  input: StandaloneDispositionStartInput; registrationDigest: string;
}>;

function readPublicationReference(raw: unknown): DomainResult<StandalonePublicationReference, Error> {
  const fields = readExactDataRecord(raw, ["locator", "runId", "resultDigest"], "source publication");
  if (!fields.ok) return reject(fields.error.message);
  const parsed = standalonePublicationReferenceSchema.safeParse(fields.value);
  return parsed.success ? success(parsed.data) : reject("source publication is malformed");
}

function readDeclaredDisposition(raw: unknown): DomainResult<StandaloneDispositionRecord, Error> {
  const fields = readExactDataRecord(raw, ["schemaVersion", "source", "provenance", "revision", "entries"], "DECLARED disposition");
  if (!fields.ok) return reject(fields.error.message);
  const source = readPublicationReference(fields.value.source);
  if (!source.ok) return source;
  const revision = readExactDataRecord(fields.value.revision, ["kind", "previousDigest", "proseReference", "prose"], "disposition revision");
  if (!revision.ok) return reject(revision.error.message);
  const rawEntries = fields.value.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length > STANDALONE_LINEAGE_LIMITS.inventory) return reject("disposition inventory exceeds 4096 rows or is malformed");
  const entries = readDenseDataArray(rawEntries, "advisory entries");
  if (!entries.ok) return reject(entries.error.message);
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const entry of entries.value) {
    const row = readExactDataRecord(entry, ["origin", "decision", "reason"], "advisory entry");
    if (!row.ok) return reject(row.error.message);
    rows.push(row.value);
  }
  const parsed = standaloneDispositionSchema.safeParse({ ...fields.value, source: source.value, revision: revision.value, entries: rows });
  return parsed.success ? success(parsed.data) : reject("DECLARED disposition is malformed");
}

export function parseStandaloneDispositionStartInput(raw: unknown): DomainResult<StandaloneDispositionStartInput, Error> {
  const fields = readExactDataRecord(raw, ["source", "record", "previous"], "disposition input");
  if (!fields.ok || Object.keys(fields.value).length !== 3) return reject("disposition input requires exactly source, record and previous");
  const source = readPublicationReference(fields.value.source);
  const record = readDeclaredDisposition(fields.value.record);
  if (!source.ok || !record.ok || !canonicalStructuralEquals(source.value, record.value.source)) return reject("disposition source or DECLARED record is malformed or mismatched");
  let previous: StandaloneDispositionPublicationReference | null = null;
  if (fields.value.previous !== null) {
    const ref = readExactDataRecord(fields.value.previous, ["locator", "runId", "dispositionDigest"], "previous revision");
    if (!ref.ok || Object.keys(ref.value).length !== 3) return reject("previous revision requires exact locator, Run and dispositionDigest");
    const parsed = standalonePublicationReferenceSchema.safeParse({ locator: ref.value.locator, runId: ref.value.runId, resultDigest: ref.value.dispositionDigest });
    if (!parsed.success) return reject("previous revision reference is malformed");
    previous = canonicalRecord({ locator: parsed.data.locator, runId: parsed.data.runId, dispositionDigest: parsed.data.resultDigest });
  }
  if (record.value.revision.kind === "correction") {
    if (previous === null || previous.dispositionDigest !== record.value.revision.previousDigest) return reject("correction requires the exact published previous revision reference");
  } else if (previous !== null) return reject("only corrections may name a previous revision");
  return success(canonicalRecord({ source: source.value, record: record.value, previous }));
}

export function parseStandaloneDispositionStartBytes(bytes: Uint8Array): DomainResult<StandaloneDispositionStartInput, Error> {
  const decoded = parseBoundedReviewerJson(bytes, STANDALONE_LINEAGE_LIMITS.retainedBytes);
  return decoded.ok ? parseStandaloneDispositionStartInput(decoded.value) : reject(decoded.error.message);
}

export function registerStandaloneDisposition(run: string, input: StandaloneDispositionStartInput): DomainResult<RegisteredStandaloneDispositionProgram, Error> {
  const runId = parseOrchestrationRunId(run);
  const parsed = parseStandaloneDispositionStartInput(input);
  if (!runId.ok || !parsed.ok) return reject("invalid disposition registration Run or input");
  const base = canonicalRecord({ schemaVersion: 1, kind: "standalone-disposition", runId: runId.value, input: parsed.value });
  const registration = canonicalRecord({ ...base, registrationDigest: sha256Hex(JSON.stringify(base)) });
  if (new TextEncoder().encode(JSON.stringify(registration)).length > STANDALONE_LINEAGE_LIMITS.retainedBytes) return reject("disposition registration exceeds 16777216 byte limit");
  return success(registration);
}

export function parseRegisteredStandaloneDispositionProgram(raw: unknown): DomainResult<RegisteredStandaloneDispositionProgram, Error> {
  const fields = readExactDataRecord(raw, ["schemaVersion", "kind", "runId", "input", "registrationDigest"], "disposition registration");
  if (!fields.ok || Object.keys(fields.value).length !== 5 || fields.value.schemaVersion !== 1 || fields.value.kind !== "standalone-disposition" || typeof fields.value.runId !== "string") return reject("invalid standalone-disposition registration");
  const input = parseStandaloneDispositionStartInput(fields.value.input);
  if (!input.ok) return input;
  const rebuilt = registerStandaloneDisposition(fields.value.runId, input.value);
  return rebuilt.ok && rebuilt.value.registrationDigest === fields.value.registrationDigest ? rebuilt : reject("disposition registration digest mismatch");
}

export type StandaloneDispositionState = Readonly<{ schemaVersion: 1; registrationDigest: string }> & (
  | Readonly<{ kind: "registered" }>
  | Readonly<{ kind: "artifact-published" }>
  | Readonly<{ kind: "done"; receipt: ArtifactSetPublished }>
);
export type StandaloneDispositionEvent =
  | Readonly<{ kind: "artifact-published" }>
  | Readonly<{ kind: "receipt-recorded"; receipt: unknown }>;
export const startStandaloneDisposition = (registration: RegisteredStandaloneDispositionProgram): StandaloneDispositionState =>
  canonicalRecord({ schemaVersion: 1, registrationDigest: registration.registrationDigest, kind: "registered" });

export function standaloneDispositionReceipt(registration: RegisteredStandaloneDispositionProgram): ArtifactSetPublished {
  const text = JSON.stringify(registration.input.record);
  const digest = sha256Hex(text);
  // All components derive from parsed registration; parseEffectReceipt supplies branded kernel identity.
  const parsed = parseEffectReceipt({ kind: "artifact-set-published", runId: registration.runId,
    effectId: `effect:standalone-disposition:${digest}`, artifacts: [{ runId: registration.runId,
      slot: { kind: "fixed-artifact-slot", path: "artifacts/disposition.json" }, digest, byteLength: new TextEncoder().encode(text).length }] });
  if (!parsed.ok || parsed.value.kind !== "artifact-set-published") throw new TypeError("parsed disposition registration invariant violated");
  return parsed.value;
}

export function reduceStandaloneDisposition(registration: RegisteredStandaloneDispositionProgram, state: StandaloneDispositionState,
  event: StandaloneDispositionEvent): DomainResult<StandaloneDispositionState, Error> {
  if (state.registrationDigest !== registration.registrationDigest) return reject("foreign disposition checkpoint");
  return match(event)
    .with({ kind: "artifact-published" }, () => success(state.kind === "registered"
      ? canonicalRecord({ ...state, kind: "artifact-published" }) : state))
    .with({ kind: "receipt-recorded" }, ({ receipt }) => {
      if (state.kind === "registered") return reject("receipt cannot precede artifact publication");
      const parsed = parseEffectReceipt(receipt);
      const expected = standaloneDispositionReceipt(registration);
      if (!parsed.ok || !canonicalStructuralEquals(parsed.value, expected)) return reject("disposition receipt differs from registered publication");
      return success(canonicalRecord({ schemaVersion: 1, registrationDigest: registration.registrationDigest, kind: "done", receipt: expected }));
    }).exhaustive();
}

/** Checkpoints may lag durable effects, but cannot invent progress or contradictory receipts. */
export function checkStandaloneDispositionCheckpoint(registration: RegisteredStandaloneDispositionProgram,
  observed: StandaloneDispositionState, raw: unknown | null): DomainResult<StandaloneDispositionState, Error> {
  if (raw === null) return success(observed);
  const registered = startStandaloneDisposition(registration);
  const artifact = reduceStandaloneDisposition(registration, registered, { kind: "artifact-published" });
  const candidates = [registered, ...(observed.kind !== "registered" && artifact.ok ? [artifact.value] : []), ...(observed.kind === "done" ? [observed] : [])];
  return candidates.some(candidate => canonicalStructuralEquals(candidate, raw)) ? success(observed) : reject("disposition checkpoint is corrupt or ahead of authenticated publication");
}
