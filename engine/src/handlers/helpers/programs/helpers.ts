/**
 * Façade program driver volume (A14): the imperative shell's program drivers
 * were one 2,900-line module; this volume owns ONE program's driver (or, for
 * helpers, the shared recovery/git/scope machinery). The public surface is
 * re-exported by index.ts so all existing import sites are unchanged.
 */
import { createHash } from 'node:crypto';
import { publishStandalonePanelView, verifyStandalonePanelView } from '../../../orchestration/standalone-panel-context';
import { parseStandaloneSuccessorRegistration, parseStandaloneSuccessorStartInput, boundedThrownCause, type RegisteredStandaloneSuccessorProgram } from './standalone-successor-registration';
import type { PreparedStandaloneSuccessor } from '../../../core/standalone-lineage';
import { buildStandaloneSuccessorReviewerContext, parseIssuedStandaloneSuccessorReviewer, standaloneSuccessorReviewerRegistration } from '../../../core/standalone-successor-reviewer';
import type { StandaloneReviewerProtocolResolver } from '../../../core/standalone-review';
import type { StandaloneReviewerContextPacketV3 } from '../../../core/context-packets';
import { parseRegisteredStandaloneDispositionProgram, type RegisteredStandaloneDispositionProgram } from '../../../core/standalone-disposition-machine';
import { devNull } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalStructuralEquals, sameAgentRequestAuthority, parseAgentRequestAuthority, type DomainResult, createAtomicInitialPublicationClaimPort, createInitialBatchPublicationReconciler, createInitialPublicationEffectPort, createPublicationAuthorityResolver, parseBatchPublishedReceipt, parseEffectId, parseIssuedSpawnRequest, prepareInitialBatchPublicationIntent, spawnBatchAction, AGENT_REQUIRED_SKILLS, type AgentRequestAuthority, type BatchPublishedReceipt, type EffectId, type InitialSpawnRequestInput, type PublicationAuthorityResolver, type SpawnRequest } from '../../../core/orchestration-contract';
import { serializeAdjudicatedStandaloneReview, STANDALONE_REVIEWER_ROLES, serializeStandaloneReviewAuthority, parseStandaloneReviewAuthority, selectStandaloneReviewers, type FrozenStandaloneReviewAuthority, type StandaloneReviewKind, type StandaloneReviewMetadata } from '../../../core/standalone-review';
import { safeIoCause } from '../../../core/safe-io-cause';
import { buildContextPacket, buildReviewerContextPacket, encodeByteSection, type ContextPacket } from '../../../core/context-packets';
import { readRunBytesNoFollow, openDirectoryNoFollow, closeAnchoredDirectory, listDirectoryNamesNoFollow, readDirectoryFileNoFollow } from '../../../orchestration/no-follow-fs';
import { parseReviewerProtocolDescriptor, type ReviewerProtocolDescriptor, type ReviewerProtocolFailure } from '../../../core/reviewer-contract';
import { parseIssuedReviewerProtocol, type ReviewerProtocolAuthorityResolver, type ReviewerProtocolRegistration, type ReviewerSubjectBinding } from '../../../core/review-output';
import { readWaveReviewContext } from '../../../core/wave-review-authority';
import type { StandaloneDoneState } from '../../../core/standalone-review-machine';
import { parseRunDirectoryReference, type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { isExcludedRemediationPath, parseCanonicalRepositoryRelativePath } from '../../../core/remediation-machine';
import type { PersistentRefutationPanelEvent } from '../../../core/panel-program';
import {
  parseRegisteredRemediationProgram,
  parseRemediationStartInputV2,
  type RegisteredRemediationProgram,
  type RemediationStartInputV2,
} from './remediation-registration';
export type {
  RegisteredRemediationProgram,
  RemediationStartInputV2,
} from './remediation-registration';

type RegisteredReviewerProtocol =
  | Readonly<{ schemaVersion: 1; reviewerProtocol?: never }>
  | Readonly<{ schemaVersion: 2; reviewerProtocol: ReviewerProtocolDescriptor }>;

export type RegisteredStandaloneProgram = RegisteredStandaloneSuccessorProgram | (RegisteredReviewerProtocol & Readonly<{
  kind: "standalone-review";
  input: Readonly<{ kind: StandaloneReviewKind; files: readonly string[] | null; dryRun: boolean }>;
  authority: unknown;
}>);

export type WaveGateRestartAudit = Readonly<{
  previousRunId: string;
  exhaustedSlots: readonly string[];
}>;

export type OrphanedWaveGateRecoveryAudit = Readonly<{
  previousRunId: string;
  previousAuthorityDigest: string;
}>;

export type RegisteredWaveGateProgram = RegisteredReviewerProtocol & Readonly<{
  kind: "wave-gate";
  input: Readonly<{ wave: number | null }>;
  taskIds: readonly string[];
  authorityDigest: string;
  restart?: WaveGateRestartAudit;
  orphanRecovery?: OrphanedWaveGateRecoveryAudit;
}>;

export type RegisteredFacadeProgram = RegisteredStandaloneProgram | RegisteredRemediationProgram | RegisteredWaveGateProgram | RegisteredStandaloneDispositionProgram;

import type { FacadeDriveResult, ProgramParse } from './program-result';
export type { FacadeDriveResult, ProgramParse } from './program-result';

export const failed = (message: string): FacadeDriveResult => ({ ok: false, message });

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

function gitPaths(args: readonly string[]): readonly string[] {
  const result = spawnSync("git", args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  // status stays null when the process never ran (git missing from PATH,
  // EACCES); result.error then holds the only real diagnostic.
  if (result.error) throw new Error(`git ${args[0]} could not be spawned: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr ?? Buffer.alloc(0)).toString("utf8").trim() || `git ${args[0]} failed`);
  return Object.freeze((result.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0").filter(Boolean).sort());
}

export function gitText(args: readonly string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args[0]} could not be spawned: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || `git ${args[0]} failed`);
  return (result.stdout ?? "").trim();
}

export type CanonicalChangedPaths = Readonly<{
  /** Tracked files whose worktree content differs from the index, plus untracked non-ignored files. */
  unstaged: readonly string[];
  staged: readonly string[];
  committed: readonly string[];
  base_revision: string | null;
  head_revision: string;
}>;

export type DerivedChangedPaths = Readonly<{
  authority: CanonicalChangedPaths;
  /** Kept separately so diff statistics can add new files exactly once. */
  untracked: readonly string[];
  /**
   * Paths that did not exist before this change: untracked files plus files
   * added (not modified) in the index or on the branch since the base
   * revision. This is what makes `newStructure` mean "new", not "deep".
   */
  created: ReadonlySet<string>;
}>;

/**
 * Changed-path discovery omits paths this repository cannot canonicalize and
 * excludes orchestration evidence from the derived review scope. Callers that
 * require explicit complete coverage must supply and parse that scope instead
 * of treating this filter as rejection authority.
 */
function reviewablePath(path: string): boolean {
  const parsed = parseCanonicalRepositoryRelativePath(path, "standalone review scope path");
  return parsed.ok && !isExcludedRemediationPath(parsed.value);
}

export function deriveChangedPaths(): DerivedChangedPaths {
  const head = gitText(["rev-parse", "HEAD"]);
  let base: string | null = null;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const probe = spawnSync("git", ["merge-base", candidate, head], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() !== "") { base = probe.stdout.trim(); break; }
  }
  const untracked = gitPaths(["ls-files", "--others", "--exclude-standard", "-z", "--"]).filter(reviewablePath);
  const trackedUnstaged = gitPaths(["diff", "--name-only", "-z", "--"]).filter(reviewablePath);
  const stagedAdded = gitPaths(["diff", "--cached", "--name-only", "--diff-filter=A", "-z", "--"]).filter(reviewablePath);
  const committedAdded = base === null
    ? []
    : gitPaths(["diff", "--name-only", "--diff-filter=A", "-z", `${base}...${head}`, "--"]).filter(reviewablePath);
  return Object.freeze({
    authority: Object.freeze({
      unstaged: Object.freeze([...new Set([...trackedUnstaged, ...untracked])].sort()),
      staged: gitPaths(["diff", "--cached", "--name-only", "-z", "--"]).filter(reviewablePath),
      committed: base === null ? Object.freeze([]) : gitPaths(["diff", "--name-only", "-z", `${base}...${head}`, "--"]).filter(reviewablePath),
      base_revision: base,
      head_revision: head,
    }),
    untracked,
    created: Object.freeze(new Set([...untracked, ...stagedAdded, ...committedAdded])),
  });
}

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".java", ".rs", ".py", ".go", ".c", ".cpp"]);
export const TYPE_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".java", ".rs"]);

function parseNumstatAdditions(output: string): number {
  return output.split("\n").reduce((sum, line) => {
    const additions = Number.parseInt(line.split("\t", 1)[0] ?? "", 10);
    return sum + (Number.isFinite(additions) ? additions : 0);
  }, 0);
}

function trackedAdditions(baseline: string, paths: readonly string[]): number {
  if (paths.length === 0) return 0;
  const result = spawnSync("git", ["diff", "--numstat", baseline, "--", ...paths], { encoding: "utf8" });
  if (result.error) throw new Error(`git diff could not be spawned: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || "git diff --numstat failed");
  return parseNumstatAdditions(result.stdout ?? "");
}

function untrackedAdditions(paths: readonly string[]): number {
  return paths.reduce((sum, path) => {
    const result = spawnSync("git", ["diff", "--no-index", "--numstat", "--", devNull, path], { encoding: "utf8" });
    if (result.error) throw new Error(`git diff could not be spawned: ${result.error.message}`);
    const diagnostic = (result.stderr ?? "").trim();
    if ((result.status !== 0 && result.status !== 1) || diagnostic !== "") {
      throw new Error(diagnostic || `cannot measure untracked additions for ${path}`);
    }
    return sum + parseNumstatAdditions(result.stdout ?? "");
  }, 0);
}

/**
 * Pure scope classification — the policy `selectStandaloneReviewers` consumes,
 * separated from the git subprocess that measures `additions` so the rules are
 * table-testable with plain data. Both regexes anchor their directory-name
 * alternatives to a full path segment: `docs?`/`README` must be followed by a
 * separator, an extension dot, or end-of-path, so `docker-compose.yml` and
 * `src/docker/build.ts` are NOT documentation.
 */
export function classifyScope(
  kind: StandaloneReviewKind,
  scope: readonly string[],
  created: ReadonlySet<string>,
  additions: number,
): StandaloneReviewMetadata {
  const extensions = scope.map((path) => extname(path).toLowerCase());
  const languages = [...new Set(extensions.filter(Boolean).map((extension) => extension.slice(1)))].sort();
  const sourceOrTestChanged = scope.some((path, index) =>
    SOURCE_EXTENSIONS.has(extensions[index]!) || /(^|\/)(test|tests|__tests__)(\/|$)/.test(path));
  // Canonically, docsOnly implies commentsChanged and excludes sourceOrTestChanged.
  const docsOnly = !sourceOrTestChanged
    && scope.every((path) => /(^|\/)(docs?|README)(\/|\.|$)|\.(md|mdx|txt)$/.test(path));
  return Object.freeze({
    requestedKinds: Object.freeze([kind]) as readonly [StandaloneReviewKind],
    ...(docsOnly
      ? { docsOnly: true as const, sourceOrTestChanged: false as const, commentsChanged: true as const }
      : { docsOnly: false as const, sourceOrTestChanged, commentsChanged: scope.some((path) => /\.(md|mdx)$/.test(path)) }),
    typesChanged: scope.some((_, index) => TYPE_EXTENSIONS.has(extensions[index]!)),
    additions,
    fileCount: scope.length,
    // "New structure" means a genuinely NEW deep path (a fresh service,
    // package, or migration directory) — not an ordinary edit to an existing
    // deeply nested file.
    newStructure: scope.some((path) => created.has(path) && path.split("/").length >= 4),
    languages: Object.freeze(languages),
  });
}

export function metadata(
  kind: StandaloneReviewKind,
  scope: readonly string[],
  changed: DerivedChangedPaths,
): StandaloneReviewMetadata {
  const scopedUntracked = new Set(changed.untracked.filter((path) => scope.includes(path)));
  const trackedScope = scope.filter((path) => !scopedUntracked.has(path));
  const baseline = changed.authority.base_revision ?? changed.authority.head_revision;
  const additions = trackedAdditions(baseline, trackedScope) + untrackedAdditions([...scopedUntracked].sort());
  return classifyScope(kind, scope, changed.created, additions);
}

export function safeScope(scope: readonly string[]): readonly Readonly<{ path: string; status: "safe" | "absent" }>[] {
  return Object.freeze(scope.map((path) => {
    try {
      readRunBytesNoFollow(path);
      return Object.freeze({ path, status: "safe" as const });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ path, status: "absent" as const });
      throw error;
    }
  }));
}

export function standaloneRequestId(runId: string, role: string, attempt: 1 | 2): string {
  return `request:${createHash("sha256").update(`${runId}\u0000${role}\u0000${attempt}`).digest("hex")}`;
}

export function frozenScopeSection(scope: readonly string[], headRevision: string) {
  const files = scope.map((path) => {
    try {
      const bytes = readRunBytesNoFollow(path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      try {
        return Object.freeze({
          path,
          kind: "text" as const,
          digest,
          byteLength: bytes.length,
          content: new TextDecoder("utf8", { fatal: true }).decode(bytes),
        });
      } catch {
        return Object.freeze({
          path,
          kind: "binary" as const,
          digest,
          byteLength: bytes.length,
          contentBase64: Buffer.from(bytes).toString("base64"),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({ path, kind: "absent" as const, digest: null, byteLength: 0 });
      }
      throw error;
    }
  });
  const section = encodeByteSection("standalone-frozen-source", JSON.stringify({ schemaVersion: 1, headRevision, files }));
  if (!section.ok) throw new Error(section.error.message);
  return section.value;
}

export function standalonePackets(
  runId: string,
  reviewMetadata: StandaloneReviewMetadata,
  scope: readonly string[],
  headRevision: string,
): Readonly<{ contexts: readonly Readonly<{ attempts: readonly [string, string] }>[]; packets: readonly ContextPacket[] }> {
  const reviewers = selectStandaloneReviewers(reviewMetadata);
  const sourceSection = frozenScopeSection(scope, headRevision);
  const packets: ContextPacket[] = [];
  const contexts = reviewers.map((role) => {
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = standaloneRequestId(runId, role, attempt);
      const section = encodeByteSection("standalone-review-authority", JSON.stringify({ runId, scope, role, attempt }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildReviewerContextPacket({
        requestId: requestId as never,
        role,
        requiredSkill: AGENT_REQUIRED_SKILLS[role] ?? "none",
        fixedContext: Object.freeze([section.value, sourceSection]),
        variableContext: Object.freeze([]),
      });
      if (!packet.ok) throw new Error(packet.error.message);
      packets.push(packet.value);
      return packet.value.digest;
    });
    return Object.freeze({ attempts: Object.freeze(attempts) as unknown as readonly [string, string] });
  });
  return Object.freeze({ contexts: Object.freeze(contexts), packets: Object.freeze(packets) });
}

export function publicationFile(effectId: string): string {
  return `publications/${createHash("sha256").update(effectId).digest("hex")}.json`;
}

export function publicationResolver(handle: RunDirHandle, maximumBytes?: number): PublicationAuthorityResolver {
  return createPublicationAuthorityResolver((lookup) => {
    try {
      const bytes = readRunBytesNoFollow(`${handle.runDirectory}/artifacts/${publicationFile(lookup.effectId)}`, maximumBytes);
      return { ok: true, value: Object.freeze([...bytes]) };
    } catch (error) {
      return { ok: false, error: {
        kind: "publication-authority-unavailable",
        field: "registration",
        message: error instanceof Error ? error.message : String(error),
      } };
    }
  });
}

const protocolUnavailable = (message: string): DomainResult<never, ReviewerProtocolFailure> => ({
  ok: false, error: Object.freeze({ kind: "reviewer-protocol-failed", code: "authority-unavailable", path: "/registration", message }),
});

/** Read the exact durable publication; reservation or packet hashes alone do not issue a request. */
export function publishedReviewerRequest(handle: RunDirHandle, request: AgentRequestAuthority, maximumBytes?: number): ProgramParse<SpawnRequest> {
  const reserved = handle.readIssuedRequests();
  if (!reserved.ok) return { ok: false, message: "reviewer request reservations are unavailable" };
  const matching = reserved.value.filter((entry) => entry.requestId === request.requestId);
  if (matching.length !== 1 || !sameAgentRequestAuthority(matching[0]!, request)) {
    return { ok: false, message: "reviewer request does not match its exact durable reservation" };
  }
  const directory = openDirectoryNoFollow(join(handle.runDirectory, "artifacts", "publications"));
  try {
    const candidates: SpawnRequest[] = [];
    for (const name of listDirectoryNamesNoFollow(directory, maximumBytes === undefined ? undefined : 128)) {
      if (!name.endsWith(".json")) continue;
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readDirectoryFileNoFollow(directory, name, maximumBytes)));
      const receipt = parseBatchPublishedReceipt(raw);
      if (!receipt.ok || receipt.value.runId !== handle.runId || publicationFile(receipt.value.effectId) !== `publications/${name}`) {
        return { ok: false, message: "reviewer publication receipt is malformed or belongs to another run/effect" };
      }
      const batchIndex = receipt.value.issuedRequests.findIndex((entry) => entry.authority.requestId === request.requestId);
      if (batchIndex < 0) continue;
      const entry = receipt.value.issuedRequests[batchIndex]!;
      if (!sameAgentRequestAuthority(entry.authority, request)) {
        return { ok: false, message: "reviewer publication differs from the exact requested authority" };
      }
      const issued = parseIssuedSpawnRequest(publicationResolver(handle, maximumBytes), {
        ...entry, issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof", runId: handle.runId,
          effectId: receipt.value.effectId, publicationDigest: receipt.value.publicationDigest, batchIndex },
      });
      if (!issued.ok) return { ok: false, message: "reviewer publication cannot prove request issuance" };
      candidates.push(issued.value);
    }
    return candidates.length === 1
      ? { ok: true, value: candidates[0]! }
      : { ok: false, message: "reviewer request must have exactly one durable publication" };
  } finally {
    closeAnchoredDirectory(directory);
  }
}

function registeredReviewerSubject(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram | RegisteredWaveGateProgram,
  request: AgentRequestAuthority,
  packet: ContextPacket,
): ProgramParse<ReviewerSubjectBinding> {
  if (registration.kind === "standalone-review") {
    const authority = parsedAuthority(registration);
    if (!authority.ok) return authority;
    const expected = authority.value.roster.orderedSlots.flatMap(({ attempts }) => attempts)
      .find((entry) => entry.requestId === request.requestId);
    if (authority.value.runId !== handle.runId || expected === undefined || !sameAgentRequestAuthority(expected, request)) {
      return { ok: false, message: "reviewer request differs from the registered standalone roster" };
    }
    return { ok: true, value: Object.freeze({ kind: "standalone-review", runId: handle.runId, scope: authority.value.scope }) };
  }
  const context = readWaveReviewContext([packet], packet.digest);
  if (context.kind !== "loaded" || context.value.task === null || context.value.taskRun === null || context.value.packetId === null) {
    return { ok: false, message: "published Wave reviewer context authority is unavailable" };
  }
  const { task, taskRun } = context.value;
  if (context.value.runId !== handle.runId || context.value.wave !== registration.input.wave ||
      context.value.authorityDigest !== registration.authorityDigest || !registration.taskIds.includes(task.id)) {
    return { ok: false, message: "published Wave context differs from its complete program registration" };
  }
  return { ok: true, value: Object.freeze({ kind: "wave-review", runId: handle.runId, taskId: task.id,
    packetId: context.value.packetId, generation: taskRun.generation,
    priorFindingIds: Object.freeze(task.priorFindings.map(({ id }) => id)),
    scope: Object.freeze([...new Set([...task.declaredFiles, ...task.modifiedFiles])].sort()),
  }) };
}

/** Legacy resolution retains its exact joins; the explicit successor arm requires nominal source authority. */
export function reviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneProgram | RegisteredWaveGateProgram,
  maximumBytes?: number): ReviewerProtocolAuthorityResolver;
export function reviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneProgram,
  maximumBytes: number, successor: PreparedStandaloneSuccessor): StandaloneReviewerProtocolResolver;
export function reviewerProtocolResolver(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram | RegisteredWaveGateProgram,
  maximumBytes?: number,
  successor?: PreparedStandaloneSuccessor,
): StandaloneReviewerProtocolResolver {
  if (successor !== undefined) return registration.kind === "standalone-review" && registration.schemaVersion === 3
    ? successorReviewerProtocolResolver(handle, registration, successor, maximumBytes ?? 16_777_216)
    : () => protocolUnavailable("successor purpose requires an explicit standalone v3 registration");
  return (request) => {
    try {
      const stored = handle.readProgramRegistration();
      if (!stored.ok) return protocolUnavailable("reviewer program registration is unavailable");
      const parsed = parseRegisteredFacadeProgram(stored.value);
      const expected = parseRegisteredFacadeProgram(registration);
      if (parsed.kind !== "registered" || (parsed.program.kind !== "standalone-review" && parsed.program.kind !== "wave-gate") || expected.kind !== "registered" ||
          !canonicalStructuralEquals(parsed.program, expected.program) || request.runId !== handle.runId ||
          request.program !== parsed.program.kind) {
        return protocolUnavailable("reviewer registration or request differs from independently parsed durable authority");
      }
      if (parsed.program.schemaVersion === 3) return protocolUnavailable("standalone v3 requires the independently authenticated successor purpose");
      const published = publishedReviewerRequest(handle, request, maximumBytes);
      if (!published.ok) return protocolUnavailable(published.message);
      const packet = handle.readContext(request.contextDigest);
      if (!packet.ok) return protocolUnavailable("published reviewer Context Packet is unavailable");
      const subject = registeredReviewerSubject(handle, parsed.program, request, packet.value);
      if (!subject.ok) return protocolUnavailable(subject.message);
      const protocol: ReviewerProtocolRegistration = parsed.program.schemaVersion === 2
        ? { schemaVersion: 2, runId: handle.runId, program: parsed.program.kind, reviewerProtocol: parsed.program.reviewerProtocol }
        : { schemaVersion: 1, runId: handle.runId, program: parsed.program.kind };
      return parseIssuedReviewerProtocol({ request: published.value, packet: packet.value, registration: protocol, subject: subject.value });
    } catch (cause) {
      return protocolUnavailable(`reviewer registration/publication/context cannot be read safely (${safeIoCause(cause)})`);
    }
  };
}

/** Select from registration, never reviewer payload shape or a global current version. */
export function standaloneReviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneProgram,
  successor?: PreparedStandaloneSuccessor, maximumBytes = 16_777_216): StandaloneReviewerProtocolResolver {
  if (registration.schemaVersion !== 3) return reviewerProtocolResolver(handle, registration, maximumBytes);
  return successor === undefined ? () => protocolUnavailable("successor resolver requires independently authenticated predecessor")
    : reviewerProtocolResolver(handle, registration, maximumBytes, successor);
}

function successorReviewerProtocolResolver(handle: RunDirHandle, registration: RegisteredStandaloneSuccessorProgram,
  successor: PreparedStandaloneSuccessor, maximumBytes: number): StandaloneReviewerProtocolResolver {
  // One operation-local immutable registration snapshot; every request still proves
  // its own publication/reservation and rereads its exact Context Packet bytes.
  const authority = readRegisteredStandaloneAuthority(handle, registration, successor);
  return request => {
    try {
      if (!authority.ok) return protocolUnavailable(authority.message);
      const expected = authority.value.roster.orderedSlots.flatMap(slot => slot.attempts).find(entry => entry.requestId === request.requestId);
      if (expected === undefined || !sameAgentRequestAuthority(expected, request)) return protocolUnavailable("successor request differs from registered roster");
      const issued = publishedReviewerRequest(handle, request, maximumBytes);
      if (!issued.ok) return protocolUnavailable(issued.message);
      const packet = handle.readStandaloneSuccessorContext(request.contextDigest, maximumBytes);
      if (!packet.ok) return protocolUnavailable(packet.error.message);
      return parseIssuedStandaloneSuccessorReviewer({ request: issued.value, packet: packet.value,
        registration: standaloneSuccessorReviewerRegistration(successor), prepared: successor });
    } catch (cause) { return protocolUnavailable(`successor publication/context unavailable (${safeIoCause(cause)})`); }
  };
}

export async function publishInitialBatch(
  handle: RunDirHandle,
  requests: readonly InitialSpawnRequestInput[],
  packets: readonly (ContextPacket | StandaloneReviewerContextPacketV3)[],
  label: string,
): Promise<Readonly<{ ok: true; requests: readonly SpawnRequest[]; action: unknown }> | Readonly<{ ok: false; message: string }>> {
  const effectId = parseEffectId(`effect:${label}:${createHash("sha256").update(requests.map((entry) =>
    (entry.authority as AgentRequestAuthority).requestId).join("|")).digest("hex")}`);
  if (!effectId.ok) return { ok: false, message: effectId.error.message };
  const intent = prepareInitialBatchPublicationIntent(handle.runId, effectId.value, requests);
  if (!intent.ok) return { ok: false, message: intent.error.message };
  for (const packet of packets) {
    const published = await handle.publishContext(packet);
    if (!published.ok) return { ok: false, message: published.error.message };
    if (packet.schemaVersion === 1 && packet.role === "review-verifier-agent") {
      const raw = handle.readProgramRegistration(16_777_216);
      if (!raw.ok) return { ok: false, message: raw.error.message };
      const registration = parseRegisteredFacadeProgram(raw.value);
      if (registration.kind === "invalid") return { ok: false, message: registration.message };
      if (registration.kind === "registered" && registration.program.kind === "standalone-review" && registration.program.schemaVersion === 3) {
        await publishStandalonePanelView(handle, packet);
      }
    }
  }
  for (const request of intent.value.issuedRequests) {
    const reserved = await handle.reserveRequest(request.authority);
    if (!reserved.ok) return { ok: false, message: reserved.error.message };
  }
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    kind: "batch-published" as const,
    effectId: intent.value.identity.effectId,
    runId: intent.value.identity.runId,
    requestIds: intent.value.requestIds,
    contextDigests: intent.value.contextDigests,
    issuedRequests: intent.value.issuedRequests,
    publicationDigest: intent.value.identity.publicationDigest,
  });
  const receiptBytes = Buffer.from(JSON.stringify(receipt), "utf8");
  const publishedReceipt = await handle.publishArtifactSet([{ relativePath: publicationFile(effectId.value), bytes: [...receiptBytes] }]);
  if (!publishedReceipt.ok) return { ok: false, message: publishedReceipt.error.message };
  const effectPort = createInitialPublicationEffectPort(() => ({ ok: true, value: Object.freeze([...receiptBytes]) }));
  const claimPort = createAtomicInitialPublicationClaimPort((request) => ({ ok: true, value: Object.freeze({
    schemaVersion: 1 as const,
    kind: "initial-publication-claimed" as const,
    key: request.key,
    identity: request.identity,
  }) }));
  const issuance = createInitialBatchPublicationReconciler(effectPort, claimPort)(intent.value);
  if (!issuance.ok) return { ok: false, message: issuance.error.message };
  const action = spawnBatchAction(issuance.value, requests);
  if (!action.ok) return { ok: false, message: action.error.message };
  const standalone = label.startsWith("standalone");
  return { ok: true, requests: action.value.requests, action: Object.freeze({
    ...action.value,
    requests: Object.freeze(action.value.requests.map((request) => Object.freeze({
      ...request,
      task: renderSpawnTask(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.", { standalone }),
    }))),
  }) };
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
 * Every engine-issued spawn task shares one shape: an optional
 * `LOOM_REVIEW_CONTEXT: standalone` marker (when `options.standalone` is set),
 * the authority markers that bind a harness batch item to its issued request,
 * the packet path (the exact absolute `contexts/<digest>.json` artifact, so a
 * child never infers run-directory layout out of band), the required-Skill
 * marker, then the caller's program-specific `instruction`. The authority
 * alone determines every marker line — `parsePublishedSpawnRequest` already
 * proved `context.digest === authority.contextDigest`, so call sites don't
 * thread the context through.
 */
export function renderSpawnTask(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  instruction: string,
  options: { standalone?: boolean } = {},
): string {
  return (options.standalone === true ? "LOOM_REVIEW_CONTEXT: standalone\n" : "") +
    `LOOM_REQUEST_ID: ${authority.requestId}\n` +
    `LOOM_CONTEXT_DIGEST: ${authority.contextDigest}\n` +
    `LOOM_CONTEXT_PATH: ${join(handle.runDirectory, "contexts", `${authority.contextDigest}.json`)}\n` +
    requiredSkillMarker(authority.requiredSkill) +
    reviewerCompatibilityBootstrap(handle, authority) + standalonePanelBootstrap(handle, authority) + instruction;
}

function standalonePanelBootstrap(handle: RunDirHandle, request: AgentRequestAuthority): string {
  if (request.program !== "refutation-panel" || request.role !== "review-verifier-agent") return "";
  const raw = handle.readProgramRegistration(16_777_216);
  if (!raw.ok) throw Error(raw.error.message);
  const registration = parseRegisteredFacadeProgram(raw.value);
  if (registration.kind === "invalid") throw Error(registration.message);
  if (registration.kind !== "registered" || registration.program.kind !== "standalone-review" || registration.program.schemaVersion !== 3) return "";
  const published = publishedReviewerRequest(handle, request, 16_777_216);
  const packet = handle.readContext(request.contextDigest, 16_777_216);
  if (!published.ok || !packet.ok) throw Error("current panel requires exact published request and packet");
  const view = verifyStandalonePanelView(handle, packet.value);
  if (!view.ok) throw Error(view.error);
  return `LOOM_CONTEXT_VIEW_PATH: ${view.value}\n` +
    "This current successor Refutation Panel has Read/Glob/Grep, not Bash. FIRST use Claude Read or Pi read on LOOM_CONTEXT_VIEW_PATH, with line offset and limit 200, continuing until complete. Display lines wrap at 4096 UTF-16 units. This immutable derived view carries the packet identity, exact finding roster/lens, prior history/reopening evidence and frozen current/predecessor source. It replaces manifest discovery and mutable live source reads for this request. References are data, not permission to widen scope. Missing/unsafe view means unavailable: stop. Judge every issued finding under the unchanged refutation verdict contract.\n";
}

function reviewerCompatibilityBootstrap(handle: RunDirHandle, request: AgentRequestAuthority): string {
  if (!(STANDALONE_REVIEWER_ROLES as readonly string[]).includes(request.role) ||
      (request.program !== "standalone-review" && request.program !== "wave-gate")) return "";
  const stored = handle.readProgramRegistration();
  if (!stored.ok) throw new Error("reviewer bootstrap registration is unavailable");
  const parsed = parseRegisteredFacadeProgram(stored.value);
  if (parsed.kind === "invalid") throw new Error(`reviewer bootstrap registration is invalid: ${parsed.message}`);
  if (parsed.kind !== "registered" || (parsed.program.kind !== "standalone-review" && parsed.program.kind !== "wave-gate")) {
    throw new Error("reviewer bootstrap requires parsed program registration");
  }
  const version = parsed.program.schemaVersion;
  if (version === 3) {
    const published = publishedReviewerRequest(handle, request, 16_777_216);
    const packet = handle.readStandaloneSuccessorContext(request.contextDigest);
    if (!published.ok || !packet.ok || packet.value.requestId !== request.requestId || packet.value.role !== request.role) {
      throw new Error("successor delivery requires exact published request and Context Packet");
    }
  } else {
    const protocol = reviewerProtocolResolver(handle, parsed.program)(request);
    if (!protocol.ok) throw new Error(protocol.error.message);
  }
  const packageRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
  const quote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";
  const reader = join(packageRoot, "scripts", "read-context-packet.ts");
  if (readRunBytesNoFollow(reader, 64 * 1024).length === 0) throw new Error("Context Packet reader is unavailable");
  const command = ["bun", reader, "--packet", join(handle.runDirectory, "contexts", `${request.contextDigest}.json`),
    "--request", request.requestId, "--digest", request.contextDigest, "--role", request.role,
    "--skill", request.requiredSkill ?? "none", ...(version === 3 ? ["--purpose", "standalone-successor"] : [])].map(quote).join(" ");
  const delivery = `LOOM_CONTEXT_READ_COMMAND: ${command}\n` +
    "Run that exact command using Claude Bash or Pi bash FIRST, then append --section LABEL or --file EXACT_SOURCE_PATH and --offset N --limit 4096 to page through the indexed context. Do not dump raw packet byte arrays. A failed command means context unavailable: stop, never infer a protocol from payload. This read-only projection checks supplied identity/integrity; independent publication was proved by engine delivery, not by the helper.\n";
  if (version === 3) return delivery +
    "This is an explicitly issued standalone successor v3 request. Read standalone-lineage and standalone-frozen-source, then the frozen reviewer-payload-schema and reviewer-impact-rubric. Cover every inherited origin exactly once in issued order, retaining original identity and history. Reopening needs the exact prior decision reference and complete new evidence; unavailable context means not-assessable, never repaired. New assertions belong in findings as draft/relation, not reminted prior Findings.\n" +
    "Browse predecessor-frozen-source with --section. Browse an exact predecessor-context:ROLE[:attempt-2] using --archive LABEL --archive-purpose v1-v2 (or standalone-successor for a v3 predecessor), then --section or --file and bounded offsets. These are retained data, not new issuance authority. Native capture records your one exact final payload; registered resume owns admission, retry and panel work.\n";
  if (version === 2) return delivery + "Read the issued Context Packet FIRST; its frozen schema and rubric govern your final output.\n";
  const role = join(packageRoot, "references", "reviewer-protocol-v1", "agents", `${request.role}.md`);
  const wire = join(packageRoot, "references", "reviewer-protocol-v1", "agents", "_shared", "wire-contract.md");
  if (readRunBytesNoFollow(role).length === 0 || readRunBytesNoFollow(wire).length === 0) {
    throw new Error("historical reviewer instructions are unavailable; refusing current-contract fallback");
  }
  return delivery + `Read the issued Context Packet FIRST. This is an issued schema-1 reviewer request.\n` +
    `Load the archived role instructions at ${JSON.stringify(role)} and shared wire contract at ${JSON.stringify(wire)}.\n` +
    "Those archived instructions govern this request; current v2 wire, severity and rubric guidance is inapplicable. Missing archive reads must fail visibly, never fall back to v2.\n";
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

export function readRegisteredStandaloneAuthority(
  handle: RunDirHandle,
  expected: RegisteredStandaloneProgram,
  successor?: PreparedStandaloneSuccessor,
): ProgramParse<FrozenStandaloneReviewAuthority> {
  const raw = handle.readProgramRegistration();
  if (!raw.ok) return { ok: false, message: "standalone program registration is unavailable" };
  const registered = parseRegistration(raw.value);
  const supplied = parseRegistration(expected);
  if (!registered.ok || !supplied.ok || !sameRegisteredStandalonePrograms(registered.value, supplied.value)) {
    return { ok: false, message: "standalone registration differs from independently parsed durable program authority" };
  }
  return parsedAuthority(registered.value, successor);
}

export function readPublishedStandaloneResult(handle: RunDirHandle, state: StandaloneDoneState, maximumBytes?: number): ProgramParse<StandaloneDoneState> {
  try {
    const receipt = handle.readReceipt(state.publicationReceipt.effectId);
    if (!receipt.ok || !canonicalStructuralEquals(receipt.value, state.publicationReceipt)) {
      return { ok: false, message: "standalone result publication receipt is missing or differs from replay" };
    }
    const bytes = readRunBytesNoFollow(join(handle.runDirectory, "result.json"), maximumBytes);
    if (!bytes.equals(Buffer.from(serializeAdjudicatedStandaloneReview(state.result)))) {
      return { ok: false, message: "published standalone result bytes differ from replay" };
    }
    return { ok: true, value: state };
  } catch (cause) {
    return { ok: false, message: `published standalone result is unavailable (${safeIoCause(cause)})` };
  }
}

export function standalonePublicationEffectId(authority: FrozenStandaloneReviewAuthority) {
  return parseEffectId(`effect:standalone-review:${createHash("sha256").update(authority.roster.orderedSlots.map((entry) =>
    entry.attempts[0].requestId).join("|")).digest("hex")}`);
}

export type DurableRequestRecovery =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "found"; requests: readonly SpawnRequest[] }>
  | Readonly<{ kind: "corrupt"; message: string }>;

/**
 * The one durable-publication accessor: the receipt bytes are PARSED, never
 * cast, and must name exactly this run/effect — reservation or packet hashes
 * alone do not issue a request. Consumers recover either the parsed receipt
 * with its proven digest, or the absent/corrupt diagnosis; the digest is a
 * projection of the parsed receipt, never an independent untyped read.
 */
export function durablePublishedReceipt(
  handle: RunDirHandle,
  effectId: EffectId,
):
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "found"; receipt: BatchPublishedReceipt; digest: string }>
  | Readonly<{ kind: "corrupt"; message: string }> {
  const path = `${handle.runDirectory}/artifacts/${publicationFile(effectId)}`;
  let bytes: Buffer;
  try {
    bytes = readRunBytesNoFollow(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "corrupt", message: `cannot read durable publication receipt: ${error instanceof Error ? error.message : String(error)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    return { kind: "corrupt", message: `durable publication receipt is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const receipt = parseBatchPublishedReceipt(raw);
  if (!receipt.ok) return { kind: "corrupt", message: `durable publication receipt is invalid: ${receipt.error.message}` };
  if (receipt.value.runId !== handle.runId || receipt.value.effectId !== effectId) {
    return { kind: "corrupt", message: "durable publication receipt does not match run/effect authority" };
  }
  return { kind: "found", receipt: receipt.value, digest: receipt.value.publicationDigest };
}

export function durablePublicationDigest(
  handle: RunDirHandle,
  effectId: EffectId,
): Readonly<{ kind: "absent" }> | Readonly<{ kind: "found"; digest: string }> | Readonly<{ kind: "corrupt"; message: string }> {
  const receipt = durablePublishedReceipt(handle, effectId);
  return receipt.kind === "found" ? { kind: "found", digest: receipt.digest } : receipt;
}

export function durableRequests(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
): DurableRequestRecovery {
  const requests: SpawnRequest[] = [];
  const effectId = standalonePublicationEffectId(authority);
  if (!effectId.ok) return { kind: "corrupt", message: effectId.error.message };
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind !== "found") return publication;
  for (const slot of authority.roster.orderedSlots) {
    const raw = slot.attempts[0];
    const parsed = parseIssuedSpawnRequest(resolver, {
      authority: raw,
      context: {
        digest: raw.contextDigest,
        slot: { kind: "fixed-artifact-slot", path: `contexts/${raw.contextDigest}.json` },
      },
      issuance: {
        schemaVersion: 1,
        kind: "issued-spawn-request-proof",
        runId: authority.runId,
        effectId: effectId.value,
        publicationDigest: publication.digest,
        batchIndex: requests.length,
      },
    });
    if (!parsed.ok) return { kind: "corrupt", message: `durable issued request is invalid: ${parsed.error.message}` };
    requests.push(parsed.value);
  }
  return { kind: "found", requests: Object.freeze(requests) };
}

/**
 * One rejected reviewer slot's attempt-2 recovery identity.
 *
 * The retry batch is published under its own effect label (exactly like the
 * refutation panel's per-slot retry batches), so a crash between the semantic
 * rejection checkpoint and the retry spawn is recovered on the next resume by
 * reading the durable publication receipt — never by re-deriving request
 * authority from prose.
 */
export function standaloneRetryEffectId(slotId: string, requestId: string): ProgramParse<EffectId> {
  const label = `standalone-review-retry:${slotId}`;
  const parsed = parseEffectId(`effect:${label}:${createHash("sha256").update(requestId).digest("hex")}`);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, message: parsed.error.message };
}

export async function recoverOrPublishStandaloneRetry(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  slot: Readonly<{ slotId: string; attempts: readonly [AgentRequestAuthority, AgentRequestAuthority] }>,
  resolver: PublicationAuthorityResolver,
): Promise<Readonly<{ ok: true; request: SpawnRequest }> | Readonly<{ ok: false; message: string }>> {
  const retryAuthority = slot.attempts[1];
  if (retryAuthority.attempt !== 2 || retryAuthority.program !== "standalone-review") {
    return { ok: false, message: `slot ${slot.slotId} has no canonical standalone attempt-2 authority` };
  }
  const input: InitialSpawnRequestInput = Object.freeze({
    authority: retryAuthority,
    context: Object.freeze({
      digest: retryAuthority.contextDigest,
      slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${retryAuthority.contextDigest}.json` }),
    }),
  });

  if (authority.schemaVersion === 3) {
    const packet = handle.readStandaloneSuccessorContext(retryAuthority.contextDigest);
    if (!packet.ok) return { ok: false, message: packet.error.message };
    const rebuilt = buildStandaloneSuccessorReviewerContext(authority.successor, retryAuthority, packet.value.variableContext);
    if (!rebuilt.ok || rebuilt.value.digest !== retryAuthority.contextDigest) return { ok: false, message: "successor retry packet differs from frozen authority" };
    const recovered = durableRefutationRequests(handle, [input], resolver, `standalone-review-retry:${slot.slotId}`);
    if (recovered.kind === "corrupt") return { ok: false, message: recovered.message };
    if (recovered.kind === "found") return { ok: true, request: recovered.requests[0]! };
    const published = await publishInitialBatch(handle, [input], [packet.value], `standalone-review-retry:${slot.slotId}`);
    return published.ok ? { ok: true, request: published.requests[0]! } : published;
  }
  let packet = handle.readContext(retryAuthority.contextDigest);
  if (!packet.ok) {
    // Runs started before the engine published attempt-2 packets up front need
    // a deterministic fallback: the attempt-2 packet is rebuilt from the
    // PERSISTED attempt-1 packet — the frozen-source section is re-read from
    // the run directory rather than re-derived from worktree bytes, so the
    // digest can never drift — and the rebuild is refused if its digest does
    // not equal the digest the roster froze at start.
    const attemptOne = handle.readContext(slot.attempts[0].contextDigest);
    if (!attemptOne.ok) return { ok: false, message: attemptOne.error.message };
    const frozenSource = attemptOne.value.fixedContext.find((section) => section.label === "standalone-frozen-source");
    if (frozenSource === undefined) {
      return { ok: false, message: "attempt-1 context packet lacks the standalone-frozen-source section" };
    }
    const authoritySection = encodeByteSection("standalone-review-authority", JSON.stringify({
      runId: handle.runId,
      scope: authority.scope,
      role: retryAuthority.role,
      attempt: 2,
    }));
    if (!authoritySection.ok) return { ok: false, message: authoritySection.error.message };
    if (attemptOne.value.schemaVersion !== authority.schemaVersion) {
      return { ok: false, message: "retry predecessor protocol differs from frozen registration" };
    }
    const input = { requestId: retryAuthority.requestId, role: retryAuthority.role,
      requiredSkill: attemptOne.value.requiredSkill,
      fixedContext: Object.freeze([authoritySection.value, frozenSource]), variableContext: Object.freeze([]) };
    const rebuilt = authority.schemaVersion === 2 ? buildReviewerContextPacket(input)
      : buildContextPacket({ ...input, outputContract: attemptOne.value.outputContract });
    if (!rebuilt.ok) return { ok: false, message: rebuilt.error.message };
    if (rebuilt.value.digest !== retryAuthority.contextDigest) {
      return {
        ok: false,
        message: `rebuilt attempt-2 context digest ${rebuilt.value.digest} differs from the frozen roster digest ${retryAuthority.contextDigest}`,
      };
    }
    const published = await handle.publishContext(rebuilt.value);
    if (!published.ok) return { ok: false, message: published.error.message };
    packet = rebuilt;
  }
  const effectId = standaloneRetryEffectId(slot.slotId, retryAuthority.requestId);
  if (!effectId.ok) return { ok: false, message: effectId.message };
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind === "corrupt") return { ok: false, message: publication.message };
  if (publication.kind === "found") {
    const parsed = parseIssuedSpawnRequest(resolver, {
      authority: input.authority,
      context: input.context,
      issuance: {
        schemaVersion: 1,
        kind: "issued-spawn-request-proof",
        runId: handle.runId,
        effectId: effectId.value,
        publicationDigest: publication.digest,
        batchIndex: 0,
      },
    });
    if (!parsed.ok) return { ok: false, message: `durable standalone retry request is invalid: ${parsed.error.message}` };
    return { ok: true, request: parsed.value };
  }
  const publishedBatch = await publishInitialBatch(handle, [input], [packet.value], `standalone-review-retry:${slot.slotId}`);
  return publishedBatch.ok
    ? { ok: true, request: publishedBatch.requests[0]! }
    : { ok: false, message: publishedBatch.message };
}

/**
 * The verdict-parse diagnostic, surfaced on a Refutation Panel retry task.
 *
 * A verifier's attempt-2 prompt used to be BYTE-IDENTICAL to attempt 1 — no
 * notice that anything was refused, no reason. The engine re-asked the identical
 * question and got the identical malformed shape back, exhausting the slot and
 * terminal-blocking whole runs. Naming the defect is what makes the retry worth
 * spending.
 */
function refutationRetryTask(task: string, diagnostic: string | null): string {
  return [
    task,
    "",
    ...(diagnostic === null
      ? ["Your previous attempt was rejected: its verdict payload could not be parsed."]
      : ["Your previous attempt was rejected:", "", diagnostic]),
    "",
    "Your FINAL message must be exactly one JSON object and nothing else — no preamble,",
    "no postscript, no code fences, no second object. Re-emit the verdict for the same",
    "criterion covering every finding id you were given.",
  ].join("\n");
}

/**
 * The admission diagnostic, surfaced on the retry spawn task.
 *
 * The text must NOT presume which admission rule failed. It used to name the
 * frozen-scope validator unconditionally, so a transcript refused for a missing
 * `### Machine Summary` block told the reviewer to fix its scope — the retried
 * agent then re-emitted the same unparseable shape and exhausted the slot. Both
 * failure classes are now stated, with the engine's own diagnostic first
 * whenever one survived to here.
 */
export function standaloneRetryTask(task: string, diagnostic: string | null, authority: FrozenStandaloneReviewAuthority): string {
  if (authority.schemaVersion !== 1) {
    return [task, "", "Your previous attempt was rejected by the engine's admission check.",
      ...(diagnostic === null ? [] : [JSON.stringify(diagnostic)]), "",
      "This is your final attempt. Emit exactly one JSON object conforming to the unchanged reviewer-payload-schema and reviewer-impact-rubric sections."].join("\n");
  }
  const marker = diagnostic === null
    ? ["Your previous attempt was rejected by the engine's admission check."]
    : ["Your previous attempt was rejected by the engine's admission check:", "", diagnostic];
  return [
    task,
    "",
    ...marker,
    "",
    "Re-emit the exact required reviewer result. It must satisfy BOTH admission rules:",
    "1. End with a `### Machine Summary` block carrying literal `CRITICAL_COUNT:` and",
    "   `ADVISORY_COUNT:` lines and a fenced ```findings``` block — even when both counts are 0.",
    "2. Every structured finding must name a path strictly inside the frozen scope.",
  ].join("\n");
}

/** Deterministic rejection detail recovered from the Refutation Panel event prefix. */
export function refutationRejectionDiagnostic(event: PersistentRefutationPanelEvent | undefined): string | null {
  return event !== undefined && event.type === "refutation-verdict-rejected" ? event.message : null;
}

export function executableRefutationRequests(
  handle: RunDirHandle,
  requests: readonly SpawnRequest[],
  standalone: boolean,
  retryDiagnostic: string | null = null,
): readonly Readonly<SpawnRequest & { task: string }>[] {
  return requests.map((request) => {
    const task = renderSpawnTask(
      handle,
      request.authority,
      "Read the immutable context packet at LOOM_CONTEXT_PATH, then complete the exact pending Refutation Panel request.",
      { standalone },
    );
    return Object.freeze({
      ...request,
      task: request.authority.attempt === 2 ? refutationRetryTask(task, retryDiagnostic) : task,
    });
  });
}

export function durableRefutationRequests(
  handle: RunDirHandle,
  inputs: readonly InitialSpawnRequestInput[],
  resolver: PublicationAuthorityResolver,
  label = "standalone-refutation",
): DurableRequestRecovery {
  const effectId = parseEffectId(`effect:${label}:${createHash("sha256").update(inputs.map((input) =>
    (input.authority as AgentRequestAuthority).requestId).join("|")).digest("hex")}`);
  if (!effectId.ok) return { kind: "corrupt", message: effectId.error.message };
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind !== "found") return publication;
  const requests: SpawnRequest[] = [];
  for (const [batchIndex, input] of inputs.entries()) {
    const parsed = parseIssuedSpawnRequest(resolver, {
      ...input,
      issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof", runId: handle.runId,
        effectId: effectId.value, publicationDigest: publication.digest, batchIndex },
    });
    if (!parsed.ok) return { kind: "corrupt", message: `durable refutation request is invalid: ${parsed.error.message}` };
    requests.push(parsed.value);
  }
  return { kind: "found", requests: Object.freeze(requests) };
}

export async function durableCaptureRejection(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
): Promise<string | null> {
  const events = await handle.readEvents();
  const rejected = events.find(({ event }) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
    const record = event as Record<string, unknown>;
    return record.kind === "request-capture-rejected" && record.requestId === authority.requestId &&
      record.slotId === authority.slotId && record.attempt === authority.attempt;
  });
  if (rejected !== undefined && typeof rejected.event === "object" && rejected.event !== null) {
    const diagnostic = (rejected.event as Record<string, unknown>).diagnostic;
    return typeof diagnostic === "string" ? diagnostic : "capture was rejected without a diagnostic";
  }
  const marker = handle.readCaptureRejection(authority);
  if (!marker.ok) throw new Error(marker.error.message);
  return marker.value;
}

/**
 * What recovering (or publishing) one refutation attempt-2 retry turned up.
 *
 * `capture-rejected` is a PANEL rejection, not a publication failure: the
 * attempt's bytes never landed (the harness terminally rejected the capture),
 * so re-issuing the spawn can never land evidence. The failure carries the
 * rejection and the durable attempt-2 request AS DATA — the identity the
 * panel rejection records — so the caller routes it into the panel's own
 * rejection path (`rejectRefutationVerdict`) instead of matching prose. The
 * tombstone proves the attempt was issued, so the durable request is
 * recoverable here; `null` request degrades only when the prepared input
 * itself is gone, and the caller falls back to the raw message.
 */
export type RefutationRetryRecovery =
  | Readonly<{ ok: true; request: SpawnRequest }>
  | Readonly<{ ok: false; kind: "capture-rejected"; rejection: string; request: SpawnRequest | null; message: string }>
  | Readonly<{ ok: false; kind: "unrecoverable"; message: string }>;

export async function recoverOrPublishRefutationRetry(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  retryInputs: readonly Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[],
  resolver: PublicationAuthorityResolver,
  label: string,
): Promise<RefutationRetryRecovery> {
  const rejection = await durableCaptureRejection(handle, authority);
  const prepared = retryInputs.find(({ input }) =>
    (input.authority as AgentRequestAuthority).requestId === authority.requestId);
  const retryLabel = `${label}-retry:${authority.slotId}`;
  if (rejection !== null) {
    // The attempt-2 capture was TERMINALLY rejected: the capture runtime
    // refuses any future capture for this slot, so re-issuing the spawn can
    // never land evidence — that is the attempt-2 doom loop this guard exists
    // to break. The tombstone proves the attempt was issued, so the durable
    // request the panel rejection records is recoverable here; the panel
    // machine owns the rejection decision, and the failure carries it as data
    // instead of leaving the caller to match prose.
    const recovered = prepared === undefined ? { kind: "absent" as const }
      : durableRefutationRequests(handle, [prepared.input], resolver, retryLabel);
    return {
      ok: false,
      kind: "capture-rejected" as const,
      rejection,
      request: recovered.kind === "found" ? recovered.requests[0]! : null,
      message: `refutation attempt 2 exhausted after capture rejection: ${rejection}`,
    };
  }
  const preparedAuthority = prepared === undefined ? null : parseAgentRequestAuthority(prepared.input.authority);
  if (prepared === undefined || !preparedAuthority?.ok || !sameAgentRequestAuthority(preparedAuthority.value, authority)) {
    return { ok: false, kind: "unrecoverable" as const, message: `refutation retry ${authority.requestId} is not exact prepared attempt-2 authority` };
  }
  const recovered = durableRefutationRequests(handle, [prepared.input], resolver, retryLabel);
  if (recovered.kind === "corrupt") return { ok: false, kind: "unrecoverable" as const, message: recovered.message };
  if (recovered.kind === "found") return { ok: true, request: recovered.requests[0]! };
  const published = await publishInitialBatch(handle, [prepared.input], [prepared.packet], retryLabel);
  return published.ok
    ? { ok: true, request: published.requests[0]! }
    : { ok: false, kind: "unrecoverable" as const, message: published.message };
}

