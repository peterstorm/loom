/**
 * Engine-issued spawn task rendering: the authority markers, packet path,
 * required-Skill marker, issued emission descriptor and per-version reviewer
 * delivery bootstrap every spawned agent reads first, plus the parent-session
 * observations (Pi model identity, emission capability) the render consumes.
 */
import { LOOM_PACKAGE_ROOT } from "../../../utils/loom-package-root";
import { join } from 'node:path';
import { verifyStandalonePanelView } from '../../../orchestration/standalone-panel-context';
import { canonicalRecord, canonicalStructuralEquals, type AgentRequestAuthority } from '../../../core/orchestration-contract';
import { STANDALONE_REVIEWER_PROTOCOL_V3 } from '../../../core/standalone-lineage-contract';
import { reviewerIssueRouteForParent, type ReviewerIssueRoute } from '../../../core/model-profiles';
import { readRunBytesNoFollow } from '../../../orchestration/no-follow-fs';
import { CONTEXT_PACKET_MAX_BYTES } from '../../../orchestration/stored-context-packets';
import type { ReviewerProtocolDescriptor } from '../../../core/reviewer-contract';
import { projectEmissionTaskText } from '../../../core/spawn-admission';
import { issuedReviewerEmissionRoute, reviewerEmissionEligible } from '../../../core/reviewer-emission-route';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { parseRegisteredFacadeProgram, type RegisteredReviewProgram } from './registration';
import { publishedReviewerRequest } from './durable-requests';
import { reviewerProtocolResolver } from './reviewer-protocol-resolution';
import { requestFrozenDiff } from '../../../orchestration/standalone-read-coverage-evidence';
import { FROZEN_DIFF_PAGE_UNITS } from '../../../core/standalone-read-coverage';

/** Observe the parent Pi session at the shell; only exact qualified model
 * identity may elect the catalog's local reviewer profile. */
export function observedReviewerIssueRoute(): ReviewerIssueRoute {
  return reviewerIssueRouteForParent({
    pi: process.env.PI_CODING_AGENT === 'true',
    provider: process.env.PI_PROVIDER,
    model: process.env.PI_MODEL,
    thinking: process.env.PI_REASONING_LEVEL,
  });
}

/**
 * One marker line naming the Skill the spawned role's policy requires, or the
 * empty string when the role has none. Load-bearing for Pi: its spawn gate
 * (`checkAgentSkillPrompt`) refuses any loom-agent spawn whose task never
 * names a frontmatter-declared Skill, and the generic packet task otherwise
 * never would (code-simplifier → distill, architecture-tech-lead → deepen,
 * spec-check-invoker → spec-check).
 */
export function requiredSkillMarker(requiredSkill: string | null): string {
  return requiredSkill === null ? "" : `LOOM_REQUIRED_SKILL: ${requiredSkill}\n`;
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

/**
 * One reviewer request's issued emission projection (AD-6/AD-7): the request
 * programs' descriptor/instruction rendering from ISSUED authority. The
 * eligibility gate decides first (the reviewer roles on standalone/wave-gate
 * requests; every other request — spec-check slots, panel verdicts,
 * implementation spawns — is projected with an empty descriptor and the
 * caller's instruction VERBATIM, so archived and extraction-only contracts
 * keep their exact final-message wording). A supplied emission authority is
 * bound to the request's own program, the durable registration is read and
 * parsed with the bootstrap's exact refusals, the supply is joined against
 * its protocol projection, and only then does the delivery bootstrap render —
 * its throws stay the exact registration/publication refusals callers already
 * fail closed on.
 *
 * For an eligible request the ISSUED protocol descriptor names the claim —
 * sourced from the required program-path emission authority for active review
 * programs, or from durable registration on the compatibility replay path —
 * and the pure route decision turns it plus the surface's capability
 * declaration into the request's emission route. A
 * refused route fails CLOSED: the render throws the bounded refusal so the
 * drive reports it — no silent degradation, no fallback to a tool the surface
 * cannot provide (US4).
 */
type ReviewerEmissionProjection = Readonly<{
  /** The bootstrap text, rendered once and reused by renderSpawnTask. */
  bootstrap: string;
  /** The descriptor line; empty when the route is not emission. */
  descriptor: string;
  /** The tool-primary instruction on the emission route; otherwise the
   *  caller's instruction verbatim (FR-020). */
  instruction: string;
}>;

type EmissionRouteObservation = Readonly<{
  kind: "extraction-only";
  requestId: string;
  reason: string;
}>;

const reportEmissionRoute = (observation: EmissionRouteObservation): void => {
  process.stderr.write(`${JSON.stringify({ event: "loom-emission-route", ...observation })}\n`);
};

function reviewerEmissionProjection(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  baseInstruction: string,
  emissionAuthority: RegisteredReviewProgram | undefined,
): ReviewerEmissionProjection {
  if (!reviewerEmissionEligible(authority)) return Object.freeze({ bootstrap: "", descriptor: "", instruction: baseInstruction });
  // The supply's program binding is storage-independent: a descriptor can
  // only ever name the request's own program's issued contract, so a wrong
  // supply is refused before any registration read.
  if (emissionAuthority !== undefined && emissionAuthority.kind !== authority.program) {
    throw new Error(`the supplied emission authority is the ${emissionAuthority.kind} program, not the request's ${authority.program} program; a descriptor binds only its own program's issued contract`);
  }
  const stored = handle.readProgramRegistration();
  if (!stored.ok) {
    throw new Error(`reviewer bootstrap registration is unavailable: ${stored.error.message}`);
  }
  const parsed = parseRegisteredFacadeProgram(stored.value);
  if (parsed.kind === "invalid") throw new Error(`reviewer bootstrap registration is invalid: ${parsed.message}`);
  if (parsed.kind !== "registered" || (parsed.program.kind !== "standalone-review" && parsed.program.kind !== "wave-gate")) {
    throw new Error("reviewer bootstrap requires parsed program registration");
  }
  // Supply coherence (AD-7, FR-012): the descriptor's eligibility inputs flow
  // through the program path as an explicit input. A supplied authority must
  // BE the request's own program and must carry the durable registration's
  // protocol projection — the emission projection's issuance join, proved
  // BEFORE any delivery I/O — before it can name the issued contract;
  // divergence fails closed (US4). An absent supply keeps the durable-only
  // fallback. Production absent-supply renders are the ineligible legacy
  // orchestration panel path; existing program integration tests also exercise
  // this fallback with eligible reviewer requests.
  let claimSource: RegisteredReviewProgram = parsed.program;
  if (emissionAuthority !== undefined) {
    const supplied = registeredReviewProtocolProjection(emissionAuthority);
    const durable = registeredReviewProtocolProjection(parsed.program);
    if (!canonicalStructuralEquals(supplied, durable)) {
      throw new Error(`the supplied ${emissionAuthority.kind} emission authority carries ${describeProtocolProjection(supplied)}, not the durable registration's ${describeProtocolProjection(durable)}; a descriptor names only the joined issued contract`);
    }
    claimSource = emissionAuthority;
  }
  const bootstrap = reviewerCompatibilityBootstrap(handle, authority, parsed.program);
  // The route is the core's ONE reviewer-route derivation — the same function
  // the capture runtime selects against — so render and capture cannot
  // disagree about the issued binding; the render never re-derives it.
  const route = issuedReviewerEmissionRoute(claimSource, authority, process.env.PI_CODING_AGENT === "true");
  // The shell owns the refusal→throw conversion (US4): a route the child
  // surface cannot provide fails the render, so the drive reports the bounded
  // refusal — no silent degradation, no fallback to an unprovidable tool.
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
  return Object.freeze({ bootstrap, descriptor: projected.descriptor, instruction: projected.instruction });
}

/**
 * Every engine-issued spawn task shares one shape: an optional
 * `LOOM_REVIEW_CONTEXT: standalone` marker (when `options.standalone` is set),
 * the authority markers that bind a harness batch item to its issued request,
 * the packet path (the exact absolute `contexts/<digest>.json` artifact, so a
 * child never infers run-directory layout out of band), the required-Skill
 * marker, the issued emission descriptor when the request's route is
 * emission-enabled (see `reviewerEmissionProjection`; absent otherwise, so
 * extraction-only requests advertise no tool — FR-001), then the caller's
 * program-specific `instruction` (tool-primary on the emission route, verbatim
 * otherwise). The authority alone determines every marker line —
 * `parsePublishedSpawnRequest` already proved `context.digest ===
 * authority.contextDigest`, so call sites don't thread the context through.
 *
 * Active review programs use `renderReviewProgramSpawnTask`, whose registered
 * emission authority is a required parameter. `renderSpawnTask` is the
 * distinct durable-compatibility/ineligible interface and therefore cannot
 * accidentally accept a program authority in an optional property.
 */
type SpawnTaskRenderOptions = Readonly<{ standalone?: boolean }>;

function renderSpawnTaskWithAuthority(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  instruction: string,
  emissionAuthority: RegisteredReviewProgram | undefined,
  options: SpawnTaskRenderOptions,
): string {
  const emission = reviewerEmissionProjection(handle, authority, instruction, emissionAuthority);
  return (options.standalone === true ? "LOOM_REVIEW_CONTEXT: standalone\n" : "") +
    `LOOM_REQUEST_ID: ${authority.requestId}\n` +
    `LOOM_CONTEXT_DIGEST: ${authority.contextDigest}\n` +
    `LOOM_CONTEXT_PATH: ${join(handle.runDirectory, "contexts", `${authority.contextDigest}.json`)}\n` +
    requiredSkillMarker(authority.requiredSkill) +
    contextSectionDelivery(handle, authority) +
    emission.descriptor +
    emission.bootstrap + standalonePanelBootstrap(handle, authority) +
    emission.instruction;
}

export function renderSpawnTask(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  instruction: string,
  options: SpawnTaskRenderOptions = {},
): string {
  return renderSpawnTaskWithAuthority(handle, authority, instruction, undefined, options);
}

/** The review-program render seam: issued emission authority is required by
 *  the compiler rather than remembered in a comment or recovered implicitly. */
export function renderReviewProgramSpawnTask(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  instruction: string,
  emissionAuthority: RegisteredReviewProgram,
  options: SpawnTaskRenderOptions = {},
): string {
  return renderSpawnTaskWithAuthority(handle, authority, instruction, emissionAuthority, options);
}

/** One POSIX-shell single-quoted word. */
const shellQuote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";

/**
 * Spec-check consumes its small authority sections whole. Its packet's section
 * bytes live in the run's blob store, so it reads them only through the
 * engine's digest-verifying section decoder, delivered as an exact command.
 */
function contextSectionDelivery(handle: RunDirHandle, authority: AgentRequestAuthority): string {
  if (authority.role !== "spec-check-invoker") return "";
  const command = ["bun", join(LOOM_PACKAGE_ROOT, "scripts", "read-context-section.ts"),
    "--packet", join(handle.runDirectory, "contexts", `${authority.contextDigest}.json`),
    "--digest", authority.contextDigest].map(shellQuote).join(" ");
  return `LOOM_CONTEXT_SECTION_COMMAND: ${command}\n`;
}

function standalonePanelBootstrap(handle: RunDirHandle, request: AgentRequestAuthority): string {
  if (request.program !== "refutation-panel" || request.role !== "review-verifier-agent") return "";
  const raw = handle.readProgramRegistration(16_777_216);
  if (!raw.ok) throw Error(raw.error.message);
  const registration = parseRegisteredFacadeProgram(raw.value);
  if (registration.kind === "invalid") throw Error(registration.message);
  if (registration.kind !== "registered" || registration.program.kind !== "standalone-review" || registration.program.schemaVersion !== 3) return "";
  const published = publishedReviewerRequest(handle, request, 16_777_216);
  const packet = handle.readContext(request.contextDigest, CONTEXT_PACKET_MAX_BYTES);
  if (!published.ok || !packet.ok) throw Error("current panel requires exact published request and packet");
  const view = verifyStandalonePanelView(handle, packet.value);
  if (!view.ok) throw Error(view.error);
  return `LOOM_CONTEXT_VIEW_PATH: ${view.value}\n` +
    "This current successor Refutation Panel has Read/Glob/Grep, not Bash. FIRST use Claude Read or Pi read on LOOM_CONTEXT_VIEW_PATH, with line offset and limit 200, continuing until complete. Display lines wrap at 4096 UTF-16 units. This immutable derived view carries the packet identity, exact finding roster/lens, prior history/reopening evidence and frozen current/predecessor source. It replaces manifest discovery and mutable live source reads for this request. References are data, not permission to widen scope. Missing/unsafe view means unavailable: stop. Judge every issued finding under the unchanged refutation verdict contract.\n";
}

/**
 * The read obligation of a read-coverage standalone request (ADR-0022): what
 * must be read, exactly how, and that the engine — not the reviewer — decides
 * whether it was. The obligated files are listed from the request's own
 * frozen diff, so the text can never name a different obligation than the one
 * admission enforces.
 */
function readObligationDelivery(handle: RunDirHandle, request: AgentRequestAuthority): string {
  const diff = requestFrozenDiff(handle, request);
  if (!diff.ok) throw new Error(`read-coverage delivery requires the request's frozen diff: ${diff.error}`);
  const obligated = diff.value.files.flatMap((file) => file.kind === "text-diff"
    ? [`- ${file.path}: ${file.totalUnits} units, ${Math.ceil(file.totalUnits / FROZEN_DIFF_PAGE_UNITS)} page(s)\n`] : []);
  return "LOOM_READ_COVERAGE: every-frozen-diff-unit\n" +
    "This review carries an engine-enforced read obligation. Before your final result you MUST read the complete frozen diff of EVERY file listed below. " +
    `For each file append --diff EXACT_SOURCE_PATH to LOOM_CONTEXT_READ_COMMAND (one page is up to ${FROZEN_DIFF_PAGE_UNITS} units), then repeat with --offset N, where N is the previous page's nextOffset, until nextOffset is null. ` +
    "Run every reader call as its own command with no pipe, redirection or filter (head, tail, grep, jq): the engine credits only exact reader pages your harness transcript recorded as delivered, re-verified against the frozen diff text. " +
    "An unread page is unread whatever your result says; a result with any unread page is refused and you are retried with the exact unread ranges. " +
    "Use --file EXACT_SOURCE_PATH for surrounding context wherever the diff alone is not enough to judge a change.\n" +
    (obligated.length === 0 ? "No scoped file has a text diff; there is nothing to read.\n" : `Frozen diff to read (${obligated.length} file(s)):\n${obligated.join("")}`);
}

/**
 * The shared reviewer compatibility delivery text for an eligible render: the
 * registration read/parse and the eligibility gate live in the projection (so
 * the program-path emission authority is joined BEFORE any delivery I/O), and
 * this builder renders the exact per-version delivery from the parsed durable
 * program the projection proved.
 */
function reviewerCompatibilityBootstrap(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  program: RegisteredReviewProgram,
): string {
  const version = program.schemaVersion;
  if (version === 3) {
    const published = publishedReviewerRequest(handle, request, 16_777_216);
    const packet = handle.readStandaloneSuccessorContext(request.contextDigest);
    if (!published.ok || !packet.ok || packet.value.requestId !== request.requestId || packet.value.role !== request.role) {
      throw new Error("successor delivery requires exact published request and Context Packet");
    }
  } else {
    const protocol = reviewerProtocolResolver(handle, program)(request);
    if (!protocol.ok) throw new Error(protocol.error.message);
  }
  const reader = join(LOOM_PACKAGE_ROOT, "scripts", "read-context-packet.ts");
  if (readRunBytesNoFollow(reader, 64 * 1024).length === 0) throw new Error("Context Packet reader is unavailable");
  const command = ["bun", reader, "--packet", join(handle.runDirectory, "contexts", `${request.contextDigest}.json`),
    "--request", request.requestId, "--digest", request.contextDigest, "--role", request.role,
    "--skill", request.requiredSkill ?? "none", ...(version === 3 ? ["--purpose", "standalone-successor"] : [])].map(shellQuote).join(" ");
  const delivery = `LOOM_CONTEXT_READ_COMMAND: ${command}\n` +
    "Run that exact command using Claude Bash or Pi bash FIRST, then append --section LABEL or --file EXACT_SOURCE_PATH and --offset N --limit 4096 to page through the indexed context. Do not dump raw packet byte arrays. A failed command means context unavailable: stop, never infer a protocol from payload. This read-only projection checks supplied identity/integrity; independent publication was proved by engine delivery, not by the helper.\n";
  if (version === 3) return delivery +
    "This is an explicitly issued standalone successor v3 request. Read standalone-lineage and standalone-frozen-source, then the frozen reviewer-payload-schema and reviewer-impact-rubric. Cover every inherited origin exactly once in issued order, retaining original identity and history. Reopening needs the exact prior decision reference and complete new evidence; unavailable context means not-assessable, never repaired. New assertions belong in findings as draft/relation, not reminted prior Findings.\n" +
    "Browse predecessor-frozen-source with --section. Browse an exact predecessor-context:ROLE[:attempt-2] using --archive LABEL --archive-purpose v1-v2 (or standalone-successor for a v3 predecessor), then --section or --file and bounded offsets. These are retained data, not new issuance authority. Native capture records your one exact final payload; registered resume owns admission, retry and panel work.\n";
  if (version === 2) {
    return delivery + "Read the issued Context Packet FIRST; its frozen schema and rubric govern your final output.\n" +
      (program.kind === "standalone-review" && program.readCoverage !== undefined ? readObligationDelivery(handle, request) : "");
  }
  const role = join(LOOM_PACKAGE_ROOT, "references", "reviewer-protocol-v1", "agents", `${request.role}.md`);
  const wire = join(LOOM_PACKAGE_ROOT, "references", "reviewer-protocol-v1", "agents", "_shared", "wire-contract.md");
  if (readRunBytesNoFollow(role).length === 0 || readRunBytesNoFollow(wire).length === 0) {
    throw new Error("historical reviewer instructions are unavailable; refusing current-contract fallback");
  }
  return delivery + `Read the issued Context Packet FIRST. This is an issued schema-1 reviewer request.\n` +
    `Load the archived role instructions at ${JSON.stringify(role)} and shared wire contract at ${JSON.stringify(wire)}.\n` +
    "Those archived instructions govern this request; current v2 wire, severity and rubric guidance is inapplicable. Missing archive reads must fail visibly, never fall back to v2.\n";
}
