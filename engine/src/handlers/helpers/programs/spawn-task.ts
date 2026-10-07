/**
 * Engine-issued spawn task rendering — the imperative shell. It gathers and
 * verifies every fact one render depends on in a single observation step (the
 * parsed durable registration, the published request and Context Packet, the
 * reader and archive presence, the frozen diff, the Pi parent flag and the
 * issued emission route), converts every refusal into a thrown bounded error,
 * reports an extraction-only route on stderr, and hands the facts to the pure
 * `renderSpawnTaskText` (core/spawn-task-text). The parent-session observation
 * the review programs need for profile selection lives here too.
 */
import { LOOM_PACKAGE_ROOT } from "../../../utils/loom-package-root";
import { verifyStandalonePanelView } from '../../../orchestration/standalone-panel-context';
import { canonicalRecord, canonicalStructuralEquals, type AgentRequestAuthority } from '../../../core/orchestration-contract';
import { STANDALONE_REVIEWER_PROTOCOL_V3 } from '../../../core/standalone-lineage-contract';
import { reviewerIssueRouteForParent, type ReviewerIssueRoute } from '../../../core/model-profiles';
import { readRunBytesNoFollow } from '../../../orchestration/no-follow-fs';
import { CONTEXT_PACKET_MAX_BYTES } from '../../../orchestration/stored-context-packets';
import type { ReviewerProtocolDescriptor } from '../../../core/reviewer-contract';
import { projectEmissionTaskText, type IssuedSpawnEmissionRoute } from '../../../core/issued-emission-capability';
import { issuedReviewerEmissionRoute, reviewerEmissionEligible } from '../../../core/reviewer-emission-route';
import {
  archivedReviewerInstructionPaths,
  contextPacketReaderPath,
  renderSpawnTaskText,
  type ReviewerDelivery,
  type SpawnTaskFacts,
} from '../../../core/spawn-task-text';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { parseRegisteredFacadeProgram, type RegisteredReviewProgram } from './registration';
import { publishedReviewerRequest } from './durable-requests';
import { reviewerProtocolResolver } from './reviewer-protocol-resolution';
import { requestFrozenDiff } from '../../../orchestration/standalone-read-coverage-evidence';

/** The parent Pi flag: the one ambient read the emission route consumes. */
const piParentExists = (): boolean => process.env.PI_CODING_AGENT === 'true';

/** Observe the parent Pi session at the shell; only exact qualified model
 * identity may elect the catalog's local reviewer profile. */
export function observedReviewerIssueRoute(): ReviewerIssueRoute {
  return reviewerIssueRouteForParent({
    pi: piParentExists(),
    provider: process.env.PI_PROVIDER,
    model: process.env.PI_MODEL,
    thinking: process.env.PI_REASONING_LEVEL,
  });
}

/**
 * The protocol projection a registered review program carries — exactly the
 * descriptor-eligibility inputs (schemaVersion, reviewer protocol descriptor)
 * an issued emission claim reads (AD-7). It is the JOIN VALUE of the
 * program-path emission seam: the request programs supply their registration
 * through the program path, and the render admits a descriptor only when the
 * supply equals the durable registration's projection — the emission
 * projection's own issuance join, retained regardless of emission-tool
 * availability (FR-012).
 */
type RegisteredReviewProtocolProjection =
  | Readonly<{ schemaVersion: 1 }>
  | Readonly<{ schemaVersion: 2; reviewerProtocol: ReviewerProtocolDescriptor }>
  | Readonly<{ schemaVersion: 3; reviewerProtocol: typeof STANDALONE_REVIEWER_PROTOCOL_V3 }>;

function registeredReviewProtocolProjection(
  registration: RegisteredReviewProgram,
): RegisteredReviewProtocolProjection {
  if (registration.schemaVersion === 1) return canonicalRecord({ schemaVersion: 1 as const });
  if (registration.schemaVersion === 2) {
    return canonicalRecord({ schemaVersion: 2 as const, reviewerProtocol: registration.reviewerProtocol });
  }
  return canonicalRecord({ schemaVersion: 3 as const, reviewerProtocol: registration.reviewerProtocol });
}

const describeProtocolProjection = (projection: RegisteredReviewProtocolProjection): string =>
  projection.schemaVersion === 1
    ? "the archived schema-1 contract (no issued emission schema)"
    : `schema version ${projection.schemaVersion} with issued digest ${projection.reviewerProtocol.schemaDigest}`;

/** The route of a request that is not emission-eligible: it carries no issued
 *  reviewer-payload contract, so it is extraction-only by construction and is
 *  neither rendered with a descriptor nor reported (FR-001). */
const INELIGIBLE_ROUTE: IssuedSpawnEmissionRoute = Object.freeze({
  kind: "extraction-only",
  reason: "the request is not emission-eligible: only reviewer roles on standalone-review and wave-gate requests carry the issued reviewer-payload contract",
});

type EmissionRouteObservation = Readonly<{
  kind: "extraction-only";
  requestId: string;
  reason: string;
}>;

const reportEmissionRoute = (observation: EmissionRouteObservation): void => {
  process.stderr.write(`${JSON.stringify({ event: "loom-emission-route", ...observation })}\n`);
};

/** The run's durable program registration, read and parsed once per render. */
function observedRegistration(handle: RunDirHandle, maximumBytes?: number) {
  const stored = handle.readProgramRegistration(maximumBytes);
  if (!stored.ok) return { ok: false as const, message: stored.error.message };
  return { ok: true as const, parsed: parseRegisteredFacadeProgram(stored.value) };
}

type ReviewerObservation = Readonly<{
  descriptor: string;
  instruction: string;
  delivery: ReviewerDelivery;
  /** The issued route the descriptor and instruction were projected from. */
  route: IssuedSpawnEmissionRoute;
}>;

/**
 * One eligible reviewer request's observed delivery facts (AD-6/AD-7). A
 * supplied emission authority is bound to the request's own program, the
 * durable registration is read and parsed with the bootstrap's exact refusals,
 * the supply is joined against its protocol projection BEFORE any delivery
 * I/O, and only then are the per-version delivery inputs verified — its throws
 * stay the exact registration/publication refusals callers already fail closed
 * on.
 *
 * The ISSUED protocol descriptor names the claim — sourced from the required
 * program-path emission authority for active review programs, or from durable
 * registration on the compatibility path (legacy schema-1 batches and Pi's
 * extraction-only canonical re-render) — and the core's ONE reviewer-route
 * derivation, the same function the capture runtime selects against, turns it
 * plus the Pi parent observation into the route. A refused route fails CLOSED:
 * the observation throws the bounded refusal so the drive reports it — no
 * silent degradation, no fallback to a tool the surface cannot provide (US4).
 */
function observeReviewerDelivery(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  baseInstruction: string,
  emissionAuthority: RegisteredReviewProgram | undefined,
): ReviewerObservation {
  // The supply's program binding is storage-independent: a descriptor can
  // only ever name the request's own program's issued contract, so a wrong
  // supply is refused before any registration read.
  if (emissionAuthority !== undefined && emissionAuthority.kind !== authority.program) {
    throw new Error(`the supplied emission authority is the ${emissionAuthority.kind} program, not the request's ${authority.program} program; a descriptor binds only its own program's issued contract`);
  }
  const registration = observedRegistration(handle);
  if (!registration.ok) throw new Error(`reviewer bootstrap registration is unavailable: ${registration.message}`);
  const { parsed } = registration;
  if (parsed.kind === "invalid") throw new Error(`reviewer bootstrap registration is invalid: ${parsed.message}`);
  if (parsed.kind !== "registered" || (parsed.program.kind !== "standalone-review" && parsed.program.kind !== "wave-gate")) {
    throw new Error("reviewer bootstrap requires parsed program registration");
  }
  const program = parsed.program;
  if (emissionAuthority !== undefined) {
    const supplied = registeredReviewProtocolProjection(emissionAuthority);
    const durable = registeredReviewProtocolProjection(program);
    if (!canonicalStructuralEquals(supplied, durable)) {
      throw new Error(`the supplied ${emissionAuthority.kind} emission authority carries ${describeProtocolProjection(supplied)}, not the durable registration's ${describeProtocolProjection(durable)}; a descriptor names only the joined issued contract`);
    }
  }
  const delivery = observeDeliveryInputs(handle, authority, program);
  const route = issuedReviewerEmissionRoute(emissionAuthority ?? program, authority, piParentExists());
  if (route.kind === "refused") {
    throw new Error(`emission route refused for request ${authority.requestId}: ${route.reason}`);
  }
  const projected = projectEmissionTaskText(route, baseInstruction);
  if (projected.decision.kind === "extraction-only") {
    reportEmissionRoute(Object.freeze({
      kind: "extraction-only",
      requestId: authority.requestId,
      reason: projected.decision.reason,
    }));
  }
  return Object.freeze({ descriptor: projected.descriptor, instruction: projected.instruction, delivery, route: projected.decision });
}

/** Verify the per-version delivery inputs of the parsed durable program and return them as data. */
function observeDeliveryInputs(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  program: RegisteredReviewProgram,
): ReviewerDelivery {
  if (program.schemaVersion === 3) {
    const published = publishedReviewerRequest(handle, request, 16_777_216);
    const packet = handle.readStandaloneSuccessorContext(request.contextDigest);
    if (!published.ok || !packet.ok || packet.value.requestId !== request.requestId || packet.value.role !== request.role) {
      throw new Error("successor delivery requires exact published request and Context Packet");
    }
  } else {
    const protocol = reviewerProtocolResolver(handle, program)(request);
    if (!protocol.ok) throw new Error(protocol.error.message);
  }
  if (readRunBytesNoFollow(contextPacketReaderPath(LOOM_PACKAGE_ROOT), 64 * 1024).length === 0) {
    throw new Error("Context Packet reader is unavailable");
  }
  if (program.schemaVersion === 3) return Object.freeze({ version: 3 });
  if (program.schemaVersion === 2) {
    if (program.kind !== "standalone-review" || program.readCoverage === undefined) {
      return Object.freeze({ version: 2, readObligation: null });
    }
    const diff = requestFrozenDiff(handle, request);
    if (!diff.ok) throw new Error(`read-coverage delivery requires the request's frozen diff: ${diff.error}`);
    return Object.freeze({ version: 2, readObligation: diff.value });
  }
  const archived = archivedReviewerInstructionPaths(LOOM_PACKAGE_ROOT, request.role);
  if (readRunBytesNoFollow(archived.rolePath).length === 0 || readRunBytesNoFollow(archived.wirePath).length === 0) {
    throw new Error("historical reviewer instructions are unavailable; refusing current-contract fallback");
  }
  return Object.freeze({ version: 1, ...archived });
}

/** The verified derived view of a standalone successor Refutation Panel verifier, or null for any other request. */
function observePanelView(handle: RunDirHandle, request: AgentRequestAuthority): string | null {
  if (request.program !== "refutation-panel" || request.role !== "review-verifier-agent") return null;
  const registration = observedRegistration(handle, 16_777_216);
  if (!registration.ok) throw Error(registration.message);
  const { parsed } = registration;
  if (parsed.kind === "invalid") throw Error(parsed.message);
  if (parsed.kind !== "registered" || parsed.program.kind !== "standalone-review" || parsed.program.schemaVersion !== 3) return null;
  const published = publishedReviewerRequest(handle, request, 16_777_216);
  const packet = handle.readContext(request.contextDigest, CONTEXT_PACKET_MAX_BYTES);
  if (!published.ok || !packet.ok) throw Error("current panel requires exact published request and packet");
  const view = verifyStandalonePanelView(handle, packet.value);
  if (!view.ok) throw Error(view.error);
  return view.value;
}

/**
 * Every engine-issued spawn task shares one shape (rendered by the pure
 * `renderSpawnTaskText`): an optional `LOOM_REVIEW_CONTEXT: standalone` marker
 * (when `options.standalone` is set), the authority markers, the packet path,
 * the required-Skill marker, the issued emission descriptor when the route is
 * emission-enabled (absent otherwise, so extraction-only requests advertise no
 * tool — FR-001), the per-version delivery, then the program-specific
 * instruction (tool-primary on the emission route, verbatim otherwise).
 *
 * Active review programs use `renderReviewProgramSpawn`, whose registered
 * emission authority is a required parameter. `renderSpawnTask` is the
 * distinct durable-compatibility/ineligible interface and therefore cannot
 * accidentally accept a program authority in an optional property.
 */
type SpawnTaskRenderOptions = Readonly<{ standalone?: boolean }>;

/** One rendered review-program spawn: the task text and the issued route it
 *  was rendered from, so a retry closes on the route as data rather than
 *  re-parsing it out of the task. */
export type ReviewProgramSpawn = Readonly<{ task: string; route: IssuedSpawnEmissionRoute }>;

/** What the one observation step yields: the pure render's facts plus the
 *  issued route those facts were projected from. */
type ObservedSpawnTask = Readonly<{ facts: SpawnTaskFacts; route: IssuedSpawnEmissionRoute }>;

/** The one observation step: every fact the pure render reads, gathered and verified here. */
function observeSpawnTaskFacts(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  instruction: string,
  emissionAuthority: RegisteredReviewProgram | undefined,
  options: SpawnTaskRenderOptions,
): ObservedSpawnTask {
  const reviewer = reviewerEmissionEligible(authority)
    ? observeReviewerDelivery(handle, authority, instruction, emissionAuthority)
    : null;
  const facts: SpawnTaskFacts = Object.freeze({
    authority,
    runDirectory: handle.runDirectory,
    packageRoot: LOOM_PACKAGE_ROOT,
    standalone: options.standalone === true,
    descriptor: reviewer?.descriptor ?? "",
    instruction: reviewer?.instruction ?? instruction,
    reviewer: reviewer?.delivery ?? null,
    panelViewPath: observePanelView(handle, authority),
  });
  return Object.freeze({ facts, route: reviewer?.route ?? INELIGIBLE_ROUTE });
}

/**
 * The durable-compatibility render: an emission-eligible request derives its
 * issued claim from the durable registration alone. Its production callers are
 * the ineligible panel/spec-check paths, legacy schema-1 initial batches
 * (`publishLegacyInitialBatch`) and Pi's extraction-only canonical re-render
 * (pi/review-run-authority.ts), which re-derives the same route from the same
 * durable registration. Active review programs use
 * `renderReviewProgramSpawn`, whose registered emission authority is a
 * required parameter, so this interface cannot accidentally accept one.
 */
export function renderSpawnTask(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  instruction: string,
  options: SpawnTaskRenderOptions = {},
): string {
  return renderSpawnTaskText(observeSpawnTaskFacts(handle, authority, instruction, undefined, options).facts);
}

/** The review-program render seam: issued emission authority is required by
 *  the compiler rather than remembered in a comment or recovered implicitly. */
export function renderReviewProgramSpawn(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  instruction: string,
  emissionAuthority: RegisteredReviewProgram,
  options: SpawnTaskRenderOptions = {},
): ReviewProgramSpawn {
  const { facts, route } = observeSpawnTaskFacts(handle, authority, instruction, emissionAuthority, options);
  return Object.freeze({ task: renderSpawnTaskText(facts), route });
}
