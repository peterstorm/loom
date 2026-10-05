/**
 * Facade program registrations: the start inputs and durable registrations of
 * the standalone-review, remediation, wave-gate and standalone-disposition
 * programs, parsed from untrusted stored bytes into frozen typed programs.
 * Pure — no Run Directory or Git access; callers read the bytes and hand them
 * here. The Wave Gate program ADT itself lives in core/wave-gate-program.
 */
import { parseStandaloneSuccessorRegistration, parseStandaloneSuccessorStartInput, type RegisteredStandaloneSuccessorProgram } from './standalone-successor-registration';
import type { PreparedStandaloneSuccessor } from '../../../core/standalone-review-model';
import { parseRegisteredStandaloneDispositionProgram, type RegisteredStandaloneDispositionProgram } from '../../../core/standalone-disposition-machine';
import { canonicalStructuralEquals, boundedThrownCause } from '../../../core/orchestration-contract';
import { serializeStandaloneReviewAuthority } from '../../../core/standalone-review-records';
import { parseStandaloneReviewAuthority } from '../../../core/standalone-review-preparation';
import { type FrozenStandaloneReviewAuthority } from '../../../core/standalone-review-model';
import { type StandaloneReviewKind } from '../../../core/standalone-review-scope';
import { parseReviewerProtocolDescriptor } from '../../../core/reviewer-contract';
import type { OrphanedWaveGateRecoveryAudit, RegisteredReviewerProtocol, RegisteredWaveGateProgram, WaveGateRestartAudit } from '../../../core/wave-gate-program';
import { parseRunDirectoryReference } from '../../../orchestration/run-directory-handle';
import {
  parseRegisteredRemediationProgram,
  parseRemediationStartInputV2,
  type RegisteredRemediationProgram,
  type RemediationStartInputV2,
} from './remediation-registration';
import type { ProgramParse } from './program-result';

export type RegisteredStandaloneProgram = RegisteredStandaloneSuccessorProgram | (RegisteredReviewerProtocol & Readonly<{
  kind: "standalone-review";
  input: Readonly<{ kind: StandaloneReviewKind; files: readonly string[] | null; dryRun: boolean }>;
  authority: unknown;
}>);

export type RegisteredFacadeProgram = RegisteredStandaloneProgram | RegisteredRemediationProgram | RegisteredWaveGateProgram | RegisteredStandaloneDispositionProgram;

/**
 * The registered review program whose ISSUED protocol descriptor names a
 * spawn task's emission eligibility (AD-6/AD-7): the standalone-review and
 * wave-gate facade programs. The request programs hold exactly this value in
 * scope wherever they build issued tasks, so the descriptor claim's
 * (schemaVersion, reviewerProtocol digest) flow through the program path as
 * explicit inputs to the projection seam instead of a second ambient read
 * inside the render. Review-program callers cross the required
 * `renderReviewProgramSpawnTask`/`publishReviewInitialBatch` interfaces;
 * durable compatibility replay remains the separate authority-free render.
 */
export type RegisteredReviewProgram = RegisteredStandaloneProgram | RegisteredWaveGateProgram;

export function exactObject(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
    Reflect.ownKeys(raw).length === keys.length && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
    });
}

export function parseStandaloneStartInput(raw: unknown): ProgramParse<RegisteredStandaloneProgram["input"]> {
  if (typeof raw === "object" && raw !== null && Object.hasOwn(raw, "schemaVersion")) return parseStandaloneSuccessorStartInput(raw);
  if (!exactObject(raw, ["kind", "files", "dryRun"])) {
    return { ok: false, message: "standalone-review input must contain exactly kind, files, and dryRun" };
  }
  const kinds = ["code", "errors", "tests", "types", "comments", "architecture", "simplify", "all"];
  if (typeof raw.kind !== "string" || !kinds.includes(raw.kind)) {
    return { ok: false, message: "standalone-review kind is invalid" };
  }
  if (raw.files !== null && (!Array.isArray(raw.files) || raw.files.length === 0 ||
      raw.files.some((path) => typeof path !== "string" || path.length === 0))) {
    return { ok: false, message: "standalone-review files must be null or a non-empty string array" };
  }
  if (typeof raw.dryRun !== "boolean") return { ok: false, message: "standalone-review dryRun must be boolean" };
  return { ok: true, value: Object.freeze({
    kind: raw.kind as StandaloneReviewKind,
    files: raw.files === null ? null : Object.freeze([...(raw.files as string[])]),
    dryRun: raw.dryRun,
  }) };
}

function registrationProtocol(raw: unknown): ProgramParse<RegisteredReviewerProtocol> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "reviewer registration must be an object" };
  }
  const version = Object.getOwnPropertyDescriptor(raw, "schemaVersion");
  if (version === undefined || !("value" in version)) {
    return { ok: false, message: "reviewer registration version must be own data" };
  }
  if (version.value === 1 && !Object.hasOwn(raw, "reviewerProtocol")) {
    return { ok: true, value: Object.freeze({ schemaVersion: 1 }) };
  }
  if (version.value === 2) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, "reviewerProtocol");
    const parsed = parseReviewerProtocolDescriptor(descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined);
    return parsed.ok
      ? { ok: true, value: Object.freeze({ schemaVersion: 2, reviewerProtocol: parsed.value }) }
      : { ok: false, message: parsed.error.message };
  }
  return { ok: false, message: "reviewer registration version or descriptor is invalid" };
}

export function parseRegistration(raw: unknown): ProgramParse<RegisteredStandaloneProgram> {
  try {
    if (typeof raw === "object" && raw !== null && Object.getOwnPropertyDescriptor(raw, "schemaVersion")?.value === 3) return parseStandaloneSuccessorRegistration(raw);
    const protocol = registrationProtocol(raw);
    if (!protocol.ok) return protocol;
    const keys = ["schemaVersion", "kind", "input", "authority"];
    if (protocol.value.schemaVersion === 2) keys.push("reviewerProtocol");
    if (!exactObject(raw, keys) || raw.kind !== "standalone-review") {
      return { ok: false, message: "standalone-review registration fields or kind are invalid" };
    }
    const input = parseStandaloneStartInput(raw.input);
    if (!input.ok) return input;
    if ("schemaVersion" in input.value) return { ok: false, message: "successor input requires version 3 registration" };
    const authority = parseStandaloneReviewAuthority(raw.authority);
    if (!authority.ok) return { ok: false, message: authority.errors.join("; ") };
    if (authority.value.schemaVersion !== protocol.value.schemaVersion ||
        !canonicalStructuralEquals(authority.value.reviewerProtocol, protocol.value.reviewerProtocol)) {
      return { ok: false, message: "standalone-review registration protocol differs from frozen authority" };
    }
    if (!canonicalStructuralEquals(authority.value.reviewMetadata.requestedKinds, [input.value.kind]) ||
        (input.value.files === null) !== (authority.value.scopeSource === "changed-path-union") ||
        (input.value.files !== null && !canonicalStructuralEquals(input.value.files, authority.value.scope))) {
      return { ok: false, message: "standalone-review registration input differs from its frozen kind or complete scope" };
    }
    return { ok: true, value: Object.freeze({
      ...protocol.value, kind: "standalone-review", input: input.value,
      authority: freezeRegistrationAuthority(JSON.parse(serializeStandaloneReviewAuthority(authority.value))),
    }) };
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "successor standalone-registration");
    return { ok: false, message: `standalone-review registration cannot be inspected safely (${cause.name}: ${cause.message})` };
  }
}

function freezeRegistrationAuthority(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(freezeRegistrationAuthority);
    Object.freeze(value);
  }
  return value;
}

export function parseWaveGateStartInput(raw: unknown): ProgramParse<RegisteredWaveGateProgram["input"]> {
  if (!exactObject(raw, ["wave"]) || (raw.wave !== null &&
      (typeof raw.wave !== "number" || !Number.isSafeInteger(raw.wave) || raw.wave < 1))) {
    return { ok: false, message: "wave-gate input must contain exactly wave (null or a positive integer)" };
  }
  return { ok: true, value: Object.freeze({ wave: raw.wave as number | null }) };
}

export function parseRemediationStartInput(raw: unknown): ProgramParse<RemediationStartInputV2> {
  const parsed = parseRemediationStartInputV2(raw);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  // Refuse a malformed source relation before preflight does any I/O.
  const source = parseRunDirectoryReference(parsed.value.sourceRunsRoot, parsed.value.sourceRun);
  return source.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, message: `remediation input sourceRun: ${source.error.message}` };
}

/**
 * How a stored program registration parses against the facade programs.
 *
 * "unclaimed" — the record does not name a facade program at all (its `kind`
 * is absent or foreign), so a caller may hand it to the panel parser.
 * "invalid" — the record CLAIMS a facade kind but fails that variant's
 * validation; the message is the exact defect. Collapsing this case to null
 * used to launder "wave.wave must be a positive integer" into "registered
 * orchestration program is malformed" — or worse, into a sibling caller's
 * "restart currently requires a registered Wave Gate run" for a run that IS a
 * wave-gate run.
 */
export type FacadeRegistrationParse =
  | Readonly<{ kind: "registered"; program: RegisteredFacadeProgram }>
  | Readonly<{ kind: "unclaimed" }>
  | Readonly<{ kind: "invalid"; message: string }>;

const invalidRegistration = (message: string): FacadeRegistrationParse => Object.freeze({ kind: "invalid", message });
const registeredProgram = (program: RegisteredFacadeProgram): FacadeRegistrationParse => Object.freeze({ kind: "registered", program });

export function parseRegisteredFacadeProgram(raw: unknown): FacadeRegistrationParse {
  try {
    return parseFacadeRegistration(raw);
  } catch (thrown) {
    const cause = boundedThrownCause(thrown, "successor facade-registration");
    return invalidRegistration(`program registration cannot be inspected safely (${cause.name}: ${cause.message})`);
  }
}

function parseWaveRegistrationAudit(raw: Readonly<Record<string, unknown>>): ProgramParse<Pick<RegisteredWaveGateProgram, "restart" | "orphanRecovery">> {
  let restart: WaveGateRestartAudit | undefined;
  if (Object.hasOwn(raw, "restart")) {
    if (!exactObject(raw.restart, ["previousRunId", "exhaustedSlots"]) ||
        typeof raw.restart.previousRunId !== "string" || !Array.isArray(raw.restart.exhaustedSlots) ||
        raw.restart.exhaustedSlots.length === 0 || raw.restart.exhaustedSlots.some((slot) => typeof slot !== "string" || slot.length === 0)) {
      return { ok: false, message: "wave-gate registration restart audit must contain previousRunId and non-empty exhaustedSlots" };
    }
    restart = Object.freeze({ previousRunId: raw.restart.previousRunId,
      exhaustedSlots: Object.freeze([...(raw.restart.exhaustedSlots as string[])]) });
  }
  let orphanRecovery: OrphanedWaveGateRecoveryAudit | undefined;
  if (Object.hasOwn(raw, "orphanRecovery")) {
    if (!exactObject(raw.orphanRecovery, ["previousRunId", "previousAuthorityDigest"]) ||
        typeof raw.orphanRecovery.previousRunId !== "string" || typeof raw.orphanRecovery.previousAuthorityDigest !== "string") {
      return { ok: false, message: "wave-gate registration orphanRecovery audit must contain previousRunId and previousAuthorityDigest" };
    }
    orphanRecovery = Object.freeze({ previousRunId: raw.orphanRecovery.previousRunId,
      previousAuthorityDigest: raw.orphanRecovery.previousAuthorityDigest });
  }
  return { ok: true, value: Object.freeze({
    ...(restart === undefined ? {} : { restart }), ...(orphanRecovery === undefined ? {} : { orphanRecovery }),
  }) };
}

function parseFacadeRegistration(raw: unknown): FacadeRegistrationParse {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Readonly<Record<string, unknown>>
    : null;
  const kindDescriptor = record === null ? undefined : Object.getOwnPropertyDescriptor(record, "kind");
  if (kindDescriptor !== undefined && !("value" in kindDescriptor)) return invalidRegistration("program kind must be own data");
  const kind: unknown = kindDescriptor?.value;
  if (kind !== "standalone-review" && kind !== "remediation" && kind !== "wave-gate" && kind !== "standalone-disposition") {
    return Object.freeze({ kind: "unclaimed" });
  }

  if (kind === "standalone-disposition") {
    const disposition = parseRegisteredStandaloneDispositionProgram(raw);
    return disposition.ok ? registeredProgram(disposition.value) : invalidRegistration(disposition.error.message);
  }

  if (kind === "standalone-review") {
    const standalone = parseRegistration(raw);
    return standalone.ok ? registeredProgram(standalone.value) : invalidRegistration(standalone.message);
  }

  if (kind === "remediation") {
    const remediation = parseRegisteredRemediationProgram(raw);
    return remediation.ok
      ? registeredProgram(remediation.value)
      : invalidRegistration(remediation.error.message);
  }
  return parseRegisteredWaveGateProgram(raw);
}

function parseRegisteredWaveGateProgram(raw: unknown): FacadeRegistrationParse {
  const protocol = registrationProtocol(raw);
  if (!protocol.ok) return invalidRegistration(protocol.message);
  const waveBaseKeys = ["schemaVersion", "kind", "input", "taskIds", "authorityDigest",
    ...(protocol.value.schemaVersion === 2 ? ["reviewerProtocol"] : [])];
  let waveKeys: readonly string[] = waveBaseKeys;
  if (Object.hasOwn(raw as object, "restart")) {
    waveKeys = [...waveBaseKeys, "restart"];
  } else if (Object.hasOwn(raw as object, "orphanRecovery")) {
    waveKeys = [...waveBaseKeys, "orphanRecovery"];
  }
  if (!exactObject(raw, waveKeys)) {
    return invalidRegistration(`wave-gate registration must contain exactly ${waveKeys.join(", ")}`);
  }
  if (!Array.isArray(raw.taskIds) || raw.taskIds.some((id) => typeof id !== "string")) {
    return invalidRegistration("wave-gate registration taskIds must be a string array");
  }
  if (typeof raw.authorityDigest !== "string") {
    return invalidRegistration("wave-gate registration authorityDigest must be a string");
  }
  if (protocol.value.schemaVersion === 2 && (!/^[0-9a-f]{64}$/.test(raw.authorityDigest) ||
      raw.taskIds.length === 0 || new Set(raw.taskIds).size !== raw.taskIds.length ||
      raw.taskIds.some((id) => id.trim() === ""))) {
    return invalidRegistration("current wave-gate registration requires a SHA-256 authorityDigest and distinct non-empty Task IDs");
  }
  const audit = parseWaveRegistrationAudit(raw);
  if (!audit.ok) return invalidRegistration(audit.message);
  const input = parseWaveGateStartInput(raw.input);
  return input.ok
    ? registeredProgram(Object.freeze({
        ...protocol.value, kind: "wave-gate", input: input.value,
        taskIds: Object.freeze([...(raw.taskIds as string[])]), authorityDigest: raw.authorityDigest,
        ...audit.value,
      }))
    : invalidRegistration(input.message);
}

export function parsedAuthority(registration: RegisteredStandaloneProgram, successor?: PreparedStandaloneSuccessor): ProgramParse<FrozenStandaloneReviewAuthority> {
  const parsed = parseRegistration(registration);
  if (!parsed.ok) return parsed;
  const result = parseStandaloneReviewAuthority(parsed.value.authority, successor);
  if (result.ok && result.value.schemaVersion !== parsed.value.schemaVersion) return { ok: false, message: "registered standalone version differs from frozen authority" };
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.errors.join("; ") };
}

/** Inputs must be parsed registrations: exact section hashes already cover their immutable bytes. */
export function sameRegisteredStandalonePrograms(left: RegisteredStandaloneProgram, right: RegisteredStandaloneProgram): boolean {
  const identity = (registration: RegisteredStandaloneProgram) => {
    if (registration.schemaVersion !== 3) return registration;
    const section = ({ label, digest, byteLength }: RegisteredStandaloneSuccessorProgram["currentSource"]) => ({ label, digest, byteLength });
    return { ...registration, currentSource: section(registration.currentSource), previousContexts: registration.previousContexts.map(section) };
  };
  return canonicalStructuralEquals(identity(left), identity(right));
}
