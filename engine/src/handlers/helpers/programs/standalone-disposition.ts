/** Per-program no-agent advisory publisher.
 * Registration → registered checkpoint → artifact → artifact checkpoint → receipt → done checkpoint.
 * Every resume reauthenticates source and exact selected revisions; no latest inference or historical fallback.
 */
import { dirname } from "node:path";
import { canonicalStructuralEquals } from "../../../core/orchestration-contract";
import type { StandalonePublicationReference } from "../../../core/standalone-lineage-contract";
import type { StandaloneLineageSource } from "../../../core/standalone-review";
import { registerStandaloneDisposition, standaloneDispositionReceipt,
  type RegisteredStandaloneDispositionProgram, type StandaloneDispositionStartInput, type StandaloneDispositionState } from "../../../core/standalone-disposition-machine";
import { parseRunDirectoryReference, parseRunEventResourcePolicy, type RunDirHandle } from "../../../orchestration/run-directory-handle";
import { readAuthenticatedStandaloneLineageSource } from "./standalone-source";
import { openStandalonePublicationRun, prepareStandaloneDispositionRecord, readStandaloneDispositionPublication } from "./standalone-disposition-source";
import type { FacadeDriveResult, ProgramParse } from "./program-result";
export { readSelectedStandaloneDisposition } from "./standalone-disposition-source";

const eventPolicy = parseRunEventResourcePolicy({ maxEventBytes: 1024, maxJournalBytes: 1024, maxRecords: 1 });
if (!eventPolicy.ok) throw new Error(eventPolicy.error.message);
export const STANDALONE_DISPOSITION_EVENT_RESOURCE_POLICY = eventPolicy.value;
const encoded = (raw: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(raw));
const problem = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export async function readStandaloneDispositionSource(reference: StandalonePublicationReference): Promise<ProgramParse<StandaloneLineageSource>> {
  try {
    openStandalonePublicationRun(reference.locator, reference.runId);
    const lineage = await readAuthenticatedStandaloneLineageSource(dirname(reference.locator), reference.locator);
    if (!lineage.ok) return lineage;
    return canonicalStructuralEquals(lineage.value.publication, reference)
      ? { ok: true, value: lineage.value } : { ok: false, message: "source publication differs from explicit Run/result identity" };
  } catch (cause) { return { ok: false, message: problem(cause) }; }
}

export async function prepareStandaloneDispositionFacadeStart(input: StandaloneDispositionStartInput,
  runsRoot: string, run: string): Promise<ProgramParse<RegisteredStandaloneDispositionProgram>> {
  try {
    const destination = parseRunDirectoryReference(runsRoot, run);
    if (!destination.ok) return { ok: false, message: destination.error.message };
    const source = await readStandaloneDispositionSource(input.source);
    if (!source.ok) return source;
    prepareStandaloneDispositionRecord(source.value, input, destination.value.runDirectory);
    const registration = registerStandaloneDisposition(destination.value.runId, input);
    return registration.ok ? registration : { ok: false, message: registration.error.message };
  } catch (cause) { return { ok: false, message: problem(cause) }; }
}

async function rehydrate(handle: RunDirHandle, expected: RegisteredStandaloneDispositionProgram) {
  openStandalonePublicationRun(handle.runDirectory, handle.runId);
  const events = await handle.readEvents(STANDALONE_DISPOSITION_EVENT_RESOURCE_POLICY);
  if (events.length !== 0) throw new Error("no-agent disposition publication cannot import events");
  const publication = readStandaloneDispositionPublication(handle, expected);
  const source = await readStandaloneDispositionSource(publication.registration.input.source);
  if (!source.ok) throw new Error(source.message);
  return publication.reconcile(source.value);
}

export async function inspectStandaloneDispositionFacade(handle: RunDirHandle,
  registration: RegisteredStandaloneDispositionProgram): Promise<ProgramParse<StandaloneDispositionState>> {
  try { return { ok: true, value: (await rehydrate(handle, registration)).state }; }
  catch (cause) { return { ok: false, message: problem(cause) }; }
}

export async function resumeStandaloneDispositionFacade(handle: RunDirHandle,
  registration: RegisteredStandaloneDispositionProgram): Promise<FacadeDriveResult> {
  try {
    let current = await rehydrate(handle, registration);
    if (current.state.kind === "registered") {
      await handle.writeCheckpoint(JSON.stringify(current.state));
      const artifact = await handle.publishArtifactSet([{ relativePath: "disposition.json", bytes: [...encoded(current.prepared.record)] }]);
      if (!artifact.ok) return { ok: false, message: artifact.error.message };
      current = await rehydrate(handle, registration);
    }
    if (current.state.kind === "artifact-published") {
      await handle.writeCheckpoint(JSON.stringify(current.state));
      const receipt = await handle.recordReceipt(standaloneDispositionReceipt(registration));
      if (!receipt.ok) return { ok: false, message: receipt.error.message };
      current = await rehydrate(handle, registration);
    }
    if (current.published === null || current.state.kind !== "done") return { ok: false, message: "disposition publication did not complete" };
    await handle.writeCheckpoint(JSON.stringify(current.state));
    return { ok: true, action: { kind: "done", runId: handle.runId, outcome: { kind: "standalone-disposition-published",
      provenance: "DECLARED", publication: current.published.publication, receipt: current.state.receipt, record: current.published.record } } };
  } catch (cause) { return { ok: false, message: problem(cause) }; }
}

export async function startStandaloneDispositionFacade(handle: RunDirHandle,
  registration: RegisteredStandaloneDispositionProgram): Promise<FacadeDriveResult> {
  const stored = await handle.registerProgram(registration);
  return stored.ok ? resumeStandaloneDispositionFacade(handle, registration) : { ok: false, message: stored.error.message };
}
