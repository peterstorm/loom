import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { devNull } from "node:os";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseAgentRequestAuthority,
  parseBatchPublishedReceipt,
  parseEffectId,
  parseIssuedSpawnRequest,
  parseRequestId,
  parseSlotId,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  AGENT_REQUIRED_SKILLS,
  type AgentRequestAuthority,
  type EffectId,
  type InitialSpawnRequestInput,
  type PublicationAuthorityResolver,
  type SpawnRequest,
} from "../../core/orchestration-contract";
import {
  aggregateStandaloneReview,
  bindStandaloneCaptureAuthority,
  captureStandaloneReviewerBytes,
  canonicalStandaloneResultArtifact,
  completeStandaloneReviewerCapture,
  prepareFreshStandaloneReview,
  parseStandaloneReviewAuthority,
  proveStandaloneRosterCompletion,
  selectStandaloneReviewers,
  serializeStandaloneReviewAuthority,
  serializeAdjudicatedStandaloneReview,
  type FrozenStandaloneReviewAuthority,
  type StandaloneReviewKind,
  type StandaloneReviewMetadata,
} from "../../core/standalone-review";
import {
  parseStandaloneReviewMachineState,
  reduceStandaloneReviewMachine,
  freezeStandaloneRefutationPanelAuthority,
  parseStandaloneRefutationCompletion,
  serializeStandaloneReviewMachineState,
  startStandaloneReviewMachine,
  type StandaloneReviewMachineState,
} from "../../core/standalone-review-machine";
import {
  buildStandaloneFindingBrief,
  defaultRefutationThreshold,
  reviewSignals,
  selectReviewLenses,
} from "../../core/review-panel";
import {
  completePersistentRefutationPanel,
  deriveRefutationVerifierBinding,
  panelRequestIdentity,
  parseRefutationPanelAuthority,
  startPersistentRefutationPanel,
  submitRefutationVerdict,
} from "../../core/panel-program";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../orchestration/context-packets";
import { readRunBytesNoFollow, writeRunBytesExclusiveNoFollow } from "../../orchestration/no-follow-fs";
import { captureKey } from "../../core/harness-capture";
import { openRunDirectory, type RunDirHandle } from "../../orchestration/run-directory-handle";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import {
  commitWaveGateCompletion,
  deriveWaveReadiness,
  deriveWaveRefutationPlan,
  WAVE_REVIEW_AGENTS,
} from "../../core/wave-gate-machine";
import { loadPlanModelsSource } from "./complete-wave-gate";
import { applyFindingOutcomes } from "../../core/findings";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  resolveTaskReviewFindings,
} from "../../core/review-output";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../../core/spec-check";
import { resolveModelProfile, lowerModelProfile } from "../../core/model-profiles";
import {
  auditRemediationPaths,
  isExcludedRemediationPath,
  parseCanonicalRepositoryRelativePath,
  parseRepositorySnapshotWitness,
  prepareLiteralGitPathspec,
  prepareVerifiedIndexInstallation,
  reduceRemediation,
  stageTemporaryIndex,
  startRemediation,
  verifyTemporaryIndex,
  type RemediationState,
} from "../../core/remediation-machine";
import {
  createTemporaryIndex,
  digestTemporaryIndex,
  installVerifiedIndex,
  observeDirtyPaths,
  observeStagedPaths,
  openGitRepository,
  readStagedPaths,
  snapshotRepositoryWitness,
  stageAuditedPaths,
} from "../../orchestration/git-remediation";

export type RegisteredStandaloneProgram = Readonly<{
  schemaVersion: 1;
  kind: "standalone-review";
  input: Readonly<{ kind: StandaloneReviewKind; files: readonly string[] | null; dryRun: boolean }>;
  authority: unknown;
}>;

export type RegisteredWaveGateProgram = Readonly<{
  schemaVersion: 1;
  kind: "wave-gate";
  input: Readonly<{ wave: number | null }>;
  taskIds: readonly string[];
  authorityDigest: string;
}>;

export type RegisteredRemediationProgram = Readonly<{
  schemaVersion: 1;
  kind: "remediation";
  input: Readonly<{ sourceRunsRoot: string; sourceRun: string; supportPaths: readonly string[] }>;
}>;

export type RegisteredFacadeProgram = RegisteredStandaloneProgram | RegisteredRemediationProgram | RegisteredWaveGateProgram;

export type FacadeDriveResult =
  | Readonly<{ ok: true; action: unknown }>
  | Readonly<{ ok: false; message: string }>;

const failed = (message: string): FacadeDriveResult => ({ ok: false, message });

function exactObject(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
    Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));
}

export function parseStandaloneStartInput(raw: unknown): Readonly<{
  ok: true;
  value: RegisteredStandaloneProgram["input"];
}> | Readonly<{ ok: false; message: string }> {
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
  if (result.status !== 0) throw new Error((result.stderr ?? Buffer.alloc(0)).toString("utf8").trim() || `git ${args[0]} failed`);
  return Object.freeze((result.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0").filter(Boolean).sort());
}

function gitText(args: readonly string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || `git ${args[0]} failed`);
  return (result.stdout ?? "").trim();
}

type CanonicalChangedPaths = Readonly<{
  /** Worktree paths not represented by HEAD, including untracked files. */
  unstaged: readonly string[];
  staged: readonly string[];
  committed: readonly string[];
  base_revision: string | null;
  head_revision: string;
}>;

type DerivedChangedPaths = Readonly<{
  authority: CanonicalChangedPaths;
  /** Kept separately so diff statistics can add new files exactly once. */
  untracked: readonly string[];
}>;

function reviewablePath(path: string): boolean {
  const parsed = parseCanonicalRepositoryRelativePath(path, "standalone review scope path");
  return !parsed.ok || !isExcludedRemediationPath(parsed.value);
}

function deriveChangedPaths(): DerivedChangedPaths {
  const head = gitText(["rev-parse", "HEAD"]);
  let base: string | null = null;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const probe = spawnSync("git", ["merge-base", candidate, "HEAD"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() !== "") { base = probe.stdout.trim(); break; }
  }
  const untracked = gitPaths(["ls-files", "--others", "--exclude-standard", "-z", "--"]).filter(reviewablePath);
  const trackedUnstaged = gitPaths(["diff", "--name-only", "-z", "--"]).filter(reviewablePath);
  return Object.freeze({
    authority: Object.freeze({
      unstaged: Object.freeze([...new Set([...trackedUnstaged, ...untracked])].sort()),
      staged: gitPaths(["diff", "--cached", "--name-only", "-z", "--"]).filter(reviewablePath),
      committed: base === null ? Object.freeze([]) : gitPaths(["diff", "--name-only", "-z", `${base}...HEAD`, "--"]).filter(reviewablePath),
      base_revision: base,
      head_revision: head,
    }),
    untracked,
  });
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".java", ".rs", ".py", ".go", ".c", ".cpp"]);
const TYPE_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".java", ".rs"]);

function parseNumstatAdditions(output: string): number {
  return output.split("\n").reduce((sum, line) => {
    const additions = Number.parseInt(line.split("\t", 1)[0] ?? "", 10);
    return sum + (Number.isFinite(additions) ? additions : 0);
  }, 0);
}

function trackedAdditions(baseline: string, paths: readonly string[]): number {
  if (paths.length === 0) return 0;
  const result = spawnSync("git", ["diff", "--numstat", baseline, "--", ...paths], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || "git diff --numstat failed");
  return parseNumstatAdditions(result.stdout ?? "");
}

function untrackedAdditions(paths: readonly string[]): number {
  return paths.reduce((sum, path) => {
    const result = spawnSync("git", ["diff", "--no-index", "--numstat", "--", devNull, path], { encoding: "utf8" });
    const diagnostic = (result.stderr ?? "").trim();
    if ((result.status !== 0 && result.status !== 1) || diagnostic !== "") {
      throw new Error(diagnostic || `cannot measure untracked additions for ${path}`);
    }
    return sum + parseNumstatAdditions(result.stdout ?? "");
  }, 0);
}

function metadata(
  kind: StandaloneReviewKind,
  scope: readonly string[],
  changed: DerivedChangedPaths,
): StandaloneReviewMetadata {
  const extensions = scope.map((path) => extname(path).toLowerCase());
  const docsOnly = scope.every((path) => /(^|\/)(docs?|README)|\.(md|mdx|txt)$/.test(path));
  const languages = [...new Set(extensions.filter(Boolean).map((extension) => extension.slice(1)))].sort();
  const scopedUntracked = new Set(changed.untracked.filter((path) => scope.includes(path)));
  const trackedScope = scope.filter((path) => !scopedUntracked.has(path));
  const baseline = changed.authority.base_revision ?? changed.authority.head_revision;
  const additions = trackedAdditions(baseline, trackedScope) + untrackedAdditions([...scopedUntracked].sort());
  return Object.freeze({
    requestedKinds: Object.freeze([kind]) as readonly [StandaloneReviewKind],
    docsOnly,
    sourceOrTestChanged: scope.some((path, index) => SOURCE_EXTENSIONS.has(extensions[index]!) || /(^|\/)(test|tests|__tests__)(\/|$)/.test(path)),
    typesChanged: scope.some((_, index) => TYPE_EXTENSIONS.has(extensions[index]!)),
    commentsChanged: docsOnly || scope.some((path) => /\.(md|mdx)$/.test(path)),
    additions,
    fileCount: scope.length,
    newStructure: scope.some((path) => path.split("/").length >= 4),
    languages: Object.freeze(languages),
  });
}

function safeScope(scope: readonly string[]): readonly Readonly<{ path: string; status: "safe" | "absent" }>[] {
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

function standaloneRequestId(runId: string, role: string, attempt: 1 | 2): string {
  return `request:${createHash("sha256").update(`${runId}\u0000${role}\u0000${attempt}`).digest("hex")}`;
}

function frozenScopeSection(scope: readonly string[]) {
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
  const section = encodeByteSection("standalone-frozen-source", JSON.stringify({ schemaVersion: 1, files }));
  if (!section.ok) throw new Error(section.error.message);
  return section.value;
}

function standalonePackets(
  runId: string,
  reviewMetadata: StandaloneReviewMetadata,
  scope: readonly string[],
): Readonly<{ contexts: readonly Readonly<{ attempts: readonly [string, string] }>[]; packets: readonly ContextPacket[] }> {
  const reviewers = selectStandaloneReviewers(reviewMetadata);
  const sourceSection = frozenScopeSection(scope);
  const packets: ContextPacket[] = [];
  const contexts = reviewers.map((role) => {
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = standaloneRequestId(runId, role, attempt);
      const section = encodeByteSection("standalone-review-authority", JSON.stringify({ runId, scope, role, attempt }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId: requestId as never,
        role,
        requiredSkill: AGENT_REQUIRED_SKILLS[role] ?? "none",
        outputContract: "Review the exact frozen scope. Return the Loom Machine Summary and findings contract for your reviewer role.",
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

function publicationFile(effectId: string): string {
  return `publications/${createHash("sha256").update(effectId).digest("hex")}.json`;
}

function publicationResolver(handle: RunDirHandle): PublicationAuthorityResolver {
  return createPublicationAuthorityResolver((lookup) => {
    try {
      const bytes = readRunBytesNoFollow(`${handle.runDirectory}/artifacts/${publicationFile(lookup.effectId)}`);
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

async function publishInitialBatch(
  handle: RunDirHandle,
  requests: readonly InitialSpawnRequestInput[],
  packets: readonly ContextPacket[],
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
  const standaloneMarker = label.startsWith("standalone") ? "LOOM_REVIEW_CONTEXT: standalone\n" : "";
  return { ok: true, requests: action.value.requests, action: Object.freeze({
    ...action.value,
    requests: Object.freeze(action.value.requests.map((request) => Object.freeze({
      ...request,
      task: `${standaloneMarker}LOOM_REQUEST_ID: ${request.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${request.context.digest}\nReview the immutable context packet and emit only the required reviewer result.`,
    }))),
  }) };
}

function parseRegistration(raw: unknown): RegisteredStandaloneProgram | null {
  if (!exactObject(raw, ["schemaVersion", "kind", "input", "authority"]) || raw.schemaVersion !== 1 || raw.kind !== "standalone-review") return null;
  const input = parseStandaloneStartInput(raw.input);
  return input.ok ? Object.freeze({ schemaVersion: 1, kind: "standalone-review", input: input.value, authority: raw.authority }) : null;
}

export function parseWaveGateStartInput(raw: unknown): Readonly<{
  ok: true;
  value: RegisteredWaveGateProgram["input"];
}> | Readonly<{ ok: false; message: string }> {
  if (!exactObject(raw, ["wave"]) || (raw.wave !== null &&
      (typeof raw.wave !== "number" || !Number.isSafeInteger(raw.wave) || raw.wave < 1))) {
    return { ok: false, message: "wave-gate input must contain exactly wave (null or a positive integer)" };
  }
  return { ok: true, value: Object.freeze({ wave: raw.wave as number | null }) };
}

export function parseRemediationStartInput(raw: unknown): Readonly<{
  ok: true;
  value: RegisteredRemediationProgram["input"];
}> | Readonly<{ ok: false; message: string }> {
  if (!exactObject(raw, ["sourceRunsRoot", "sourceRun", "supportPaths"]) ||
      typeof raw.sourceRunsRoot !== "string" || raw.sourceRunsRoot.length === 0 ||
      typeof raw.sourceRun !== "string" || raw.sourceRun.length === 0 ||
      !Array.isArray(raw.supportPaths) || raw.supportPaths.some((path) => typeof path !== "string" || path.length === 0)) {
    return { ok: false, message: "remediation input must contain sourceRunsRoot, sourceRun, and supportPaths" };
  }
  return { ok: true, value: Object.freeze({
    sourceRunsRoot: raw.sourceRunsRoot,
    sourceRun: raw.sourceRun,
    supportPaths: Object.freeze([...(raw.supportPaths as string[])]),
  }) };
}

export function parseRegisteredFacadeProgram(raw: unknown): RegisteredFacadeProgram | null {
  const standalone = parseRegistration(raw);
  if (standalone !== null) return standalone;
  if (exactObject(raw, ["schemaVersion", "kind", "input"]) && raw.schemaVersion === 1 && raw.kind === "remediation") {
    const input = parseRemediationStartInput(raw.input);
    return input.ok ? Object.freeze({ schemaVersion: 1, kind: "remediation", input: input.value }) : null;
  }
  if (!exactObject(raw, ["schemaVersion", "kind", "input", "taskIds", "authorityDigest"]) ||
      raw.schemaVersion !== 1 || raw.kind !== "wave-gate" || !Array.isArray(raw.taskIds) ||
      raw.taskIds.some((id) => typeof id !== "string") || typeof raw.authorityDigest !== "string") return null;
  const input = parseWaveGateStartInput(raw.input);
  return input.ok ? Object.freeze({
    schemaVersion: 1, kind: "wave-gate", input: input.value,
    taskIds: Object.freeze([...(raw.taskIds as string[])]), authorityDigest: raw.authorityDigest,
  }) : null;
}

function parsedAuthority(registration: RegisteredStandaloneProgram): Readonly<{ ok: true; value: FrozenStandaloneReviewAuthority }> | Readonly<{ ok: false; message: string }> {
  const result = parseStandaloneReviewAuthority(registration.authority);
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.errors.join("; ") };
}

function standalonePublicationEffectId(authority: FrozenStandaloneReviewAuthority) {
  return parseEffectId(`effect:standalone-review:${createHash("sha256").update(authority.roster.orderedSlots.map((entry) =>
    entry.attempts[0].requestId).join("|")).digest("hex")}`);
}

type DurableRequestRecovery =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "found"; requests: readonly SpawnRequest[] }>
  | Readonly<{ kind: "corrupt"; message: string }>;

function durablePublicationDigest(
  handle: RunDirHandle,
  effectId: EffectId,
): Readonly<{ kind: "absent" }> | Readonly<{ kind: "found"; digest: string }> | Readonly<{ kind: "corrupt"; message: string }> {
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
  return { kind: "found", digest: receipt.value.publicationDigest };
}

function durableRequests(
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

export async function startStandaloneFacade(
  handle: RunDirHandle,
  input: RegisteredStandaloneProgram["input"],
): Promise<FacadeDriveResult> {
  try {
    const changed = deriveChangedPaths();
    const union = [...new Set([
      ...changed.authority.unstaged,
      ...changed.authority.staged,
      ...changed.authority.committed,
    ])].sort();
    const scope = input.files ?? union;
    if (scope.length === 0) return failed("standalone review has no explicit or changed-path scope");
    const reviewMetadata = metadata(input.kind, scope, changed);
    const packetSet = standalonePackets(handle.runId, reviewMetadata, scope);
    const prepared = prepareFreshStandaloneReview({
      runId: handle.runId,
      ...(input.files === null ? {} : { explicitScope: input.files }),
      changedPaths: changed.authority,
      reviewMetadata: {
        requested_kinds: reviewMetadata.requestedKinds,
        docs_only: reviewMetadata.docsOnly,
        source_or_test_changed: reviewMetadata.sourceOrTestChanged,
        types_changed: reviewMetadata.typesChanged,
        comments_changed: reviewMetadata.commentsChanged,
        additions: reviewMetadata.additions,
        file_count: reviewMetadata.fileCount,
        new_structure: reviewMetadata.newStructure,
        languages: reviewMetadata.languages,
      },
      scopeSafety: safeScope(scope),
      reviewerContexts: packetSet.contexts,
    });
    if (!prepared.ok) return failed(prepared.error.errors.join("; "));
    const registration: RegisteredStandaloneProgram = Object.freeze({
      schemaVersion: 1,
      kind: "standalone-review",
      input,
      authority: JSON.parse(serializeStandaloneReviewAuthority(prepared.value.authority)),
    });
    const registered = await handle.registerProgram(registration);
    if (!registered.ok) return failed(registered.error.message);
    const initialRequests = prepared.value.initialRequests.map((authority) => Object.freeze({
      authority,
      context: Object.freeze({
        digest: authority.contextDigest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${authority.contextDigest}.json` }),
      }),
    }));
    const batch = await publishInitialBatch(handle, initialRequests, packetSet.packets.filter((_, index) => index % 2 === 0), "standalone-review");
    if (!batch.ok) return failed(batch.message);
    const awaiting = reduceStandaloneReviewMachine(startStandaloneReviewMachine(prepared.value.authority), {
      kind: "review-batch-published", runId: handle.runId,
    });
    if (!awaiting.ok) return failed(awaiting.error.message);
    await handle.writeCheckpoint(serializeStandaloneReviewMachineState(awaiting.value));
    return { ok: true, action: batch.action };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

const waveGateDeps = Object.freeze({ loadPlanModels: loadPlanModelsSource, fileExists: existsSync });

export function waveAdvisoryDecisionRequestId(
  runId: string,
  tasks: readonly Readonly<{ id?: string; findings?: readonly Readonly<{ id: string; severity: string; claim: string }>[] }>[],
): string {
  const advisories = tasks.flatMap(({ id: taskId, findings }) => (findings ?? [])
    .filter(({ severity }) => severity === "advisory")
    .map(({ id, claim }) => Object.freeze({ taskId: taskId ?? null, id, claim })))
    .sort((left, right) => left.id.localeCompare(right.id) || left.claim.localeCompare(right.claim));
  const digest = createHash("sha256").update(JSON.stringify(advisories)).digest("hex").slice(0, 32);
  return `wave-advisory:${runId}:${digest}`;
}

function waveBlocked(handle: RunDirHandle, message: string): FacadeDriveResult {
  return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: { kind: "wave-gate-blocked", message } } };
}

type WaveTaskRunAuthority = Readonly<{
  taskId: string;
  generation: number;
  packetId: string;
  headSha: string;
}>;

type WaveRequestBatch = Readonly<{
  batchEpoch: string;
  requests: readonly InitialSpawnRequestInput[];
  packets: readonly ContextPacket[];
  taskRuns: readonly WaveTaskRunAuthority[];
}>;

function waveRequests(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  attempt: 1 | 2,
): WaveRequestBatch {
  const tasks = graph.tasks.filter((task) => registration.taskIds.includes(task.id));
  const batchEpoch = createHash("sha256").update(JSON.stringify({
    runId: handle.runId,
    wave: registration.input.wave,
    authorityDigest: registration.authorityDigest,
    tasks: tasks.map((task) => ({
      id: task.id,
      generation: task.review_generation ?? 0,
      files: task.file_list ?? [],
      modified: task.files_modified ?? [],
      priorFindingIds: task.review_run?.prior_finding_ids ?? (task.findings ?? []).map(({ id }) => id),
    })),
    specFile: graph.spec_file ?? null,
    planFile: graph.plan_file ?? null,
  })).digest("hex");
  const taskRuns = tasks.map((task) => Object.freeze({
    taskId: task.id,
    generation: task.review_generation ?? 0,
    packetId: createHash("sha256").update(`${batchEpoch}|packet|${task.id}`).digest("hex"),
    headSha: batchEpoch,
  }));
  const subjects = [
    { role: "spec-check-invoker" as const, taskId: null as string | null },
    ...tasks.flatMap((task) => WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: task.id as string | null }))),
  ];
  const requests: InitialSpawnRequestInput[] = [];
  const packets: ContextPacket[] = [];
  for (const subject of subjects) {
    const taskRun = subject.taskId === null ? null : taskRuns.find(({ taskId }) => taskId === subject.taskId) ?? null;
    const identity = JSON.stringify({ runId: handle.runId, registration, batchEpoch, subject, taskRun });
    const hash = createHash("sha256").update(identity).digest("hex");
    const slotId = parseSlotId(`wave-slot:${hash.slice(0, 32)}`);
    const requestId = parseRequestId(`wave-request:${hash.slice(0, 32)}:${attempt}`);
    if (!slotId.ok) throw new Error(slotId.error.message);
    if (!requestId.ok) throw new Error(requestId.error.message);
    const profileId = subject.role === "comment-analyzer" ? "mechanical"
      : subject.role === "code-reviewer" || subject.role === "spec-check-invoker" ? "general-review" : "focused-review";
    const profile = resolveModelProfile(profileId);
    if (!profile.ok) throw new Error(profile.error.message);
    const requiredSkill = AGENT_REQUIRED_SKILLS[subject.role] ?? null;
    const section = encodeByteSection("wave-review-authority", JSON.stringify({
      runId: handle.runId,
      wave: registration.input.wave,
      authorityDigest: registration.authorityDigest,
      batchEpoch,
      subject,
      taskRun,
      task: subject.taskId === null ? null : (() => {
        const task = tasks.find(({ id }) => id === subject.taskId);
        return task === undefined ? null : {
          id: task.id,
          description: task.description,
          agent: task.agent,
          generation: task.review_generation ?? 0,
          planContext: task.plan_context ?? null,
          specAnchors: task.spec_anchors ?? [],
          declaredFiles: task.file_list ?? [],
          modifiedFiles: task.files_modified ?? [],
          proof: task.proof ?? null,
          testResult: task.test_result ?? null,
          findings: task.findings ?? [],
        };
      })(),
      specFile: graph.spec_file,
      planFile: graph.plan_file,
    }));
    if (!section.ok) throw new Error(section.error.message);
    const outputContract = subject.role === "spec-check-invoker"
      ? `Run the Wave ${registration.input.wave} spec alignment check and emit its exact Machine Summary.`
      : `Review Task ${subject.taskId} from the immutable packet and emit the exact Machine Summary and findings contract.`;
    const packet = buildContextPacket({
      requestId: requestId.value,
      role: subject.role,
      requiredSkill: requiredSkill ?? "none",
      outputContract,
      fixedContext: Object.freeze([section.value]),
      variableContext: Object.freeze([]),
    });
    if (!packet.ok) throw new Error(packet.error.message);
    const authority = parseAgentRequestAuthority({
      runId: handle.runId,
      requestId: requestId.value,
      slotId: slotId.value,
      program: "wave-gate",
      role: subject.role,
      attempt,
      modelProfile: profile.value.id,
      harnessBinding: {
        pi: lowerModelProfile(profile.value, "pi"),
        claude: lowerModelProfile(profile.value, "claude-code"),
      },
      requiredSkill,
      contextDigest: packet.value.digest,
      outputSlot: `transcripts/${slotId.value}/attempt-${attempt}.raw`,
    });
    if (!authority.ok) throw new Error(authority.error.violations.map(({ message }) => message).join("; "));
    packets.push(packet.value);
    requests.push(Object.freeze({ authority: authority.value, context: Object.freeze({
      digest: packet.value.digest,
      slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` }),
    }) }));
  }
  return Object.freeze({
    batchEpoch,
    requests: Object.freeze(requests),
    packets: Object.freeze(packets),
    taskRuns: Object.freeze(taskRuns),
  });
}

type WaveTaskReviewRetry = Readonly<{
  taskId: string;
  packetId: string;
  agent: string;
  slotId: string;
  request: InitialSpawnRequestInput;
  packet: ContextPacket;
}>;

function deriveWaveAttemptTwo(
  handle: RunDirHandle,
  attemptOne: AgentRequestAuthority,
): Readonly<{ request: InitialSpawnRequestInput; packet: ContextPacket }> {
  if (attemptOne.program !== "wave-gate" || attemptOne.attempt !== 1) {
    throw new Error(`slot ${attemptOne.slotId} has no canonical Wave attempt-1 authority`);
  }
  const requestId = parseRequestId(attemptOne.requestId.replace(/:1$/, ":2"));
  if (!requestId.ok || requestId.value === attemptOne.requestId) {
    throw new Error(`Wave request ${attemptOne.requestId} cannot derive canonical attempt-2 identity`);
  }
  const original = handle.readContext(attemptOne.contextDigest);
  if (!original.ok) throw new Error(original.error.message);
  const packet = buildContextPacket({
    requestId: requestId.value,
    role: original.value.role,
    requiredSkill: original.value.requiredSkill,
    outputContract: original.value.outputContract,
    fixedContext: original.value.fixedContext,
    variableContext: original.value.variableContext,
  });
  if (!packet.ok) throw new Error(packet.error.message);
  const authority = parseAgentRequestAuthority({
    ...attemptOne,
    requestId: requestId.value,
    attempt: 2,
    contextDigest: packet.value.digest,
    outputSlot: {
      kind: "fixed-artifact-slot",
      path: attemptOne.outputSlot.path.replace(/attempt-1\.raw$/, "attempt-2.raw"),
    },
  });
  if (!authority.ok) throw new Error(authority.error.violations.map(({ message }) => message).join("; "));
  return Object.freeze({
    request: Object.freeze({
      authority: authority.value,
      context: Object.freeze({
        digest: packet.value.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` }),
      }),
    }),
    packet: packet.value,
  });
}

function currentWaveTaskReviewRetries(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  issued: readonly AgentRequestAuthority[],
): readonly WaveTaskReviewRetry[] {
  return graph.tasks.filter((task) => registration.taskIds.includes(task.id) && task.review_run !== undefined)
    .flatMap((task) => {
      const run = task.review_run!;
      if (run.slot_authority === undefined || run.slot_authority.length !== run.expected_agents.length) {
        throw new Error(`Task ${task.id} active Review Run lacks engine-issued exact slot authority`);
      }
      return run.expected_agents.flatMap((agent, index) => {
        if (run.evidence.some((entry) => entry.agent === agent)) return [];
        const slot = run.slot_authority![index];
        if (slot === undefined || slot.agent !== agent) {
          throw new Error(`Task ${task.id}/${agent} active Review Run slot authority drifted`);
        }
        const attemptOne = issued.find((authority) => authority.program === "wave-gate" && authority.attempt === 1 &&
          authority.slotId === slot.slot_id && authority.role === agent);
        if (attemptOne === undefined) {
          throw new Error(`Task ${task.id}/${agent} has no issued attempt-1 authority for current packet ${run.packet_id}`);
        }
        const retry = deriveWaveAttemptTwo(handle, attemptOne);
        return [Object.freeze({
          taskId: task.id,
          packetId: run.packet_id,
          agent,
          slotId: slot.slot_id,
          request: retry.request,
          packet: retry.packet,
        })];
      });
    });
}

async function markWaveTaskReviewRetriesIssued(
  manager: StateManager,
  retries: readonly WaveTaskReviewRetry[],
): Promise<void> {
  if (retries.length === 0) return;
  await manager.update((locked) => ({
    ...locked,
    tasks: locked.tasks.map((task) => {
      const mine = retries.filter((retry) => retry.taskId === task.id);
      if (mine.length === 0) return task;
      const run = task.review_run;
      if (run === undefined || mine.some((retry) => retry.packetId !== run.packet_id)) {
        throw new Error(`Task ${task.id} Review Packet changed before attempt-2 issuance could commit`);
      }
      if (run.slot_authority === undefined) {
        throw new Error(`Task ${task.id} active Review Run lost exact slot authority`);
      }
      return {
        ...task,
        review_run: {
          ...run,
          slot_authority: run.slot_authority.map((slot) => mine.some((retry) =>
            retry.agent === slot.agent && retry.slotId === slot.slot_id)
            ? { ...slot, attempted: 2 as const }
            : slot) as unknown as typeof run.slot_authority,
        },
      };
    }),
  }));
}

async function installWaveReviewRuns(
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  batch: WaveRequestBatch,
): Promise<void> {
  const reviewAuthorities = batch.requests.filter(({ authority }) =>
    (authority as AgentRequestAuthority).role !== "spec-check-invoker");
  await manager.update((locked) => ({
    ...locked,
    spec_check: undefined,
    wave_review_epoch: {
      runId: registration.taskIds.length > 0 ? (batch.requests[0]!.authority as AgentRequestAuthority).runId : "",
      wave: registration.input.wave ?? locked.current_wave ?? 0,
      batchEpoch: batch.batchEpoch,
    },
    tasks: locked.tasks.map((task) => {
      if (!registration.taskIds.includes(task.id)) return task;
      const taskRun = batch.taskRuns.find(({ taskId }) => taskId === task.id);
      if (taskRun === undefined || taskRun.generation !== (task.review_generation ?? 0)) {
        throw new Error(`Task ${task.id} changed before its current Review Packet could be installed`);
      }
      const authorities = reviewAuthorities.map(({ authority }) => authority as AgentRequestAuthority)
        .filter((authority) => {
          const packet = handleWaveReviewContext(batch.packets, authority.contextDigest);
          return packet?.taskRun?.taskId === task.id;
        });
      if (authorities.length !== WAVE_REVIEW_AGENTS.length) {
        throw new Error(`Task ${task.id} current Review Packet lacks the exact reviewer roster`);
      }
      if (task.review_run !== undefined) {
        const same = task.review_run.packet_id === taskRun.packetId && task.review_run.generation === taskRun.generation;
        if (same) return task;
        throw new Error(`Task ${task.id} already has a different Review Packet in progress`);
      }
      return {
        ...task,
        review_status: "pending" as const,
        review_error: undefined,
        review_evidence_failures: undefined,
        review_run: {
          generation: taskRun.generation,
          packet_id: taskRun.packetId,
          head_sha: taskRun.headSha,
          expected_agents: WAVE_REVIEW_AGENTS,
          prior_finding_ids: (task.findings ?? []).map(({ id }) => id),
          evidence: [],
          slot_authority: authorities.map((authority) => ({
            agent: authority.role,
            slot_id: authority.slotId,
            attempted: 1 as const,
          })) as never,
        },
      };
    }),
  }));
}

function handleWaveReviewContext(
  packets: readonly ContextPacket[],
  digest: string,
): Readonly<{ batchEpoch?: string; taskRun?: WaveTaskRunAuthority | null }> | null {
  const packet = packets.find((candidate) => candidate.digest === digest);
  const section = packet?.fixedContext.find(({ label }) => label === "wave-review-authority");
  if (section === undefined) return null;
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(section.bytes))) as {
      batchEpoch?: string;
      taskRun?: WaveTaskRunAuthority | null;
    };
  } catch {
    return null;
  }
}

function waveRefutationPreparation(
  handle: RunDirHandle,
  readiness: Extract<ReturnType<typeof deriveWaveReadiness>, { ok: true }>["value"],
) {
  const plan = deriveWaveRefutationPlan(readiness);
  if (!plan.ok) throw new Error(plan.error.message);
  const profile = resolveModelProfile("refutation");
  if (!profile.ok) throw new Error(profile.error.message);
  const slots = [];
  const packets: ContextPacket[] = [];
  const inputs: InitialSpawnRequestInput[] = [];
  const retryInputs: Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[] = [];
  for (const lens of plan.value.lenses) {
    const binding = deriveRefutationVerifierBinding(
      plan.value.runId,
      lens,
      [plan.value.findings[0].id, ...plan.value.findings.slice(1).map(({ id }) => id)],
    );
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = binding.value.requestIds[attempt - 1];
      const section = encodeByteSection("wave-refutation-authority", JSON.stringify({
        panelRunId: plan.value.runId, lens, findings: plan.value.findings, attempt,
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({ requestId, role: "review-verifier-agent", requiredSkill: "none",
        outputContract: `Adjudicate every Wave Finding through lens '${lens}' and emit exact refutation verdict JSON.`,
        fixedContext: [section.value], variableContext: [] });
      if (!packet.ok) throw new Error(packet.error.message);
      if (attempt === 1) packets.push(packet.value);
      const authority = parseAgentRequestAuthority({ runId: handle.runId, requestId, slotId: binding.value.slotId,
        program: "refutation-panel", role: "review-verifier-agent", attempt, modelProfile: profile.value.id,
        harnessBinding: { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") },
        requiredSkill: null, contextDigest: packet.value.digest, outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw` });
      if (!authority.ok) throw new Error(authority.error.violations.map(({ message }) => message).join("; "));
      const input = { authority: authority.value, context: { digest: packet.value.digest,
        slot: { kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` } } };
      if (attempt === 1) inputs.push(input);
      else retryInputs.push(Object.freeze({ input: Object.freeze(input), packet: packet.value }));
      return authority.value;
    });
    slots.push({ slotId: binding.value.slotId, attempts });
  }
  const panel = parseRefutationPanelAuthority({
    runId: handle.runId,
    identityRunId: plan.value.runId,
    findings: plan.value.findings,
    lenses: plan.value.lenses,
    verifierSlots: slots,
  });
  if (!panel.ok) throw new Error(panel.error.message);
  return { panel: panel.value, inputs, packets, retryInputs, threshold: defaultRefutationThreshold(plan.value.lenses.length) };
}

export async function startWaveGateFacade(
  handle: RunDirHandle,
  input: RegisteredWaveGateProgram["input"],
): Promise<FacadeDriveResult> {
  try {
    const manager = new StateManager(TASK_GRAPH_PATH);
    const initial = manager.load();
    const wave = input.wave ?? initial.current_wave;
    if (initial.current_phase !== "execute" || wave === undefined || wave !== initial.current_wave) {
      return waveBlocked(handle, "wave-gate start requires exact protected execute/current_wave authority");
    }
    const taskIds = initial.tasks.filter((task) => task.wave === wave).map(({ id }) => id);
    if (taskIds.length === 0) return waveBlocked(handle, `wave ${wave} has no tasks`);
    const authorityDigest = createHash("sha256").update(JSON.stringify({ wave, taskIds, graph: initial })).digest("hex");
    await manager.registerActiveWaveGate({
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: handle.runId,
      wave,
      authorityDigest,
      revision: 0,
      terminalOutcome: null,
    });
    const registration: RegisteredWaveGateProgram = Object.freeze({
      schemaVersion: 1, kind: "wave-gate", input: Object.freeze({ wave }),
      taskIds: Object.freeze(taskIds), authorityDigest,
    });
    const stored = await handle.registerProgram(registration);
    if (!stored.ok) return failed(stored.error.message);
    return resumeWaveGateFacade(handle, registration);
  } catch (error) {
    return waveBlocked(handle, error instanceof Error ? error.message : String(error));
  }
}

export async function applyWaveFacadeSubmission(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  raw: string,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>> {
  try {
    const packet = handle.readContext(authority.contextDigest);
    if (!packet.ok) return { ok: false, message: packet.error.message };
    const section = packet.value.fixedContext.find(({ label }) => label === "wave-review-authority");
    if (section === undefined) return { ok: false, message: "Wave request context lacks subject authority" };
    const context = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(section.bytes))) as {
      wave?: unknown;
      authorityDigest?: unknown;
      batchEpoch?: unknown;
      subject?: { role?: unknown; taskId?: unknown };
      taskRun?: { taskId?: unknown; generation?: unknown; packetId?: unknown; headSha?: unknown } | null;
    };
    if (context.subject?.role !== authority.role) {
      return { ok: false, message: "Wave request role drifted from immutable subject authority" };
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    if (authority.role === "spec-check-invoker") {
      const parsed = parseSpecCheckOutput(raw);
      const wave = context.wave;
      if (typeof wave !== "number" || typeof context.batchEpoch !== "string") {
        return { ok: false, message: "Wave spec-check request lacks exact review epoch authority" };
      }
      const resolution = reconcileSpecCheck(parsed, wave, new Date().toISOString());
      await manager.update((locked) => {
        const epoch = locked.wave_review_epoch;
        if (locked.current_wave !== wave || locked.active_wave_gate?.runId !== authority.runId ||
            locked.active_wave_gate.authorityDigest !== context.authorityDigest ||
            epoch?.runId !== authority.runId || epoch.wave !== wave || epoch.batchEpoch !== context.batchEpoch) {
          throw new Error(`Wave spec-check request ${authority.requestId} does not belong to the exact current review epoch`);
        }
        return { ...locked, spec_check: resolution.specCheck };
      });
      return { ok: true };
    }
    const taskId = context.subject?.taskId;
    if (typeof taskId !== "string") return { ok: false, message: "Wave reviewer request lacks Task identity" };
    await manager.update((locked) => {
      const target = locked.tasks.find((task) => task.id === taskId);
      if (target === undefined) {
        throw new Error(`Wave reviewer task ${taskId} is no longer in the protected task graph`);
      }
      const epoch = locked.wave_review_epoch;
      const run = target.review_run;
      const taskRun = context.taskRun;
      const slot = run?.slot_authority?.find((candidate) => candidate.agent === authority.role);
      if (run === undefined || taskRun === null || taskRun === undefined ||
          taskRun.taskId !== target.id || taskRun.generation !== run.generation ||
          taskRun.packetId !== run.packet_id || taskRun.headSha !== run.head_sha ||
          context.batchEpoch !== run.head_sha || epoch?.runId !== authority.runId ||
          epoch.wave !== context.wave || epoch.batchEpoch !== context.batchEpoch || slot === undefined ||
          slot.slot_id !== authority.slotId || slot.attempted !== authority.attempt) {
        throw new Error(`Wave reviewer request ${authority.requestId} does not belong to Task ${taskId}'s exact current Review Packet slot`);
      }
      const resolution = constrainReviewResolutionToScope(
        resolveTaskReviewFindings(raw, authority.role, run, target.review_generation),
        [...(target.file_list ?? []), ...(target.files_modified ?? [])],
      );
      return {
        ...locked,
        tasks: locked.tasks.map((task) => task.id === taskId ? applyReviewResolution(task, resolution) : task),
      };
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function resumeWaveGateFacade(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
): Promise<FacadeDriveResult> {
  try {
    const terminal = await handle.readCheckpoint();
    if (terminal !== null) {
      const raw = JSON.parse(terminal) as { kind?: unknown; receipt?: unknown };
      if (raw.kind === "wave-gate-done") return { ok: true, action: { kind: "done", runId: handle.runId, outcome: raw.receipt } };
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    const graph = manager.load();
    const active = graph.active_wave_gate;
    if (active === undefined || active.runId !== handle.runId || active.wave !== registration.input.wave ||
        active.authorityDigest !== registration.authorityDigest || active.terminalOutcome !== null) {
      return waveBlocked(handle, "protected active Wave Gate authority differs from the registered façade run");
    }
    const readiness = deriveWaveReadiness(graph, waveGateDeps);
    if (!readiness.ok) return waveBlocked(handle, readiness.error.reasons.map(({ message }) => message).join("; "));
    const preliminary = readiness.value.gateDecision.checks.slice(0, 4).find((check) => !check.passed);
    if (preliminary !== undefined && !preliminary.passed) return waveBlocked(handle, preliminary.reason);

    const issued = handle.readIssuedRequests();
    const captured = handle.readCapturedAttempts();
    if (!issued.ok) return waveBlocked(handle, issued.error.message);
    if (!captured.ok) return waveBlocked(handle, captured.error.message);
    if (issued.value.length === 0) {
      const batch = waveRequests(handle, registration, graph, 1);
      await installWaveReviewRuns(manager, registration, batch);
      const published = await publishInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current");
      if (!published.ok) return failed(published.message);
      const action = published.action as { requests: readonly Record<string, unknown>[] };
      return { ok: true, action: {
        ...action,
        requests: action.requests.map((request, index) => ({
          ...request,
          task: index === 0
            ? `${String(request.task)}\nSpec-check Wave ${registration.input.wave}.`
            : `${String(request.task)}\nReview Task ${registration.taskIds[Math.floor((index - 1) / WAVE_REVIEW_AGENTS.length)]}.`,
        })),
      } };
    }

    let refreshed = manager.load();
    const hasCollectingPacket = refreshed.tasks.some((task) =>
      registration.taskIds.includes(task.id) && task.review_run !== undefined);
    const needsFreshPacket = refreshed.tasks.some((task) =>
      registration.taskIds.includes(task.id) && task.review_run === undefined &&
      task.review_status !== "passed" && task.review_status !== "blocked");
    if (!hasCollectingPacket && needsFreshPacket) {
      const batch = waveRequests(handle, registration, refreshed, 1);
      await installWaveReviewRuns(manager, registration, batch);
      const published = await publishInitialBatch(handle, batch.requests, batch.packets, "wave-gate-current");
      return published.ok ? { ok: true, action: published.action } : failed(published.message);
    }

    refreshed = manager.load();
    const currentRuns = refreshed.tasks.filter((task) =>
      registration.taskIds.includes(task.id) && task.review_run !== undefined);
    let currentIssued = issued.value;
    if (currentRuns.length > 0) {
      const epoch = refreshed.wave_review_epoch;
      if (epoch?.runId !== handle.runId || epoch.wave !== registration.input.wave) {
        return waveBlocked(handle, "active Wave Review Packets lack exact persisted batch epoch authority");
      }
      const candidates: { authority: AgentRequestAuthority; packet: ContextPacket; context: ReturnType<typeof handleWaveReviewContext> }[] = [];
      for (const authority of issued.value.filter((request) => request.program === "wave-gate" && request.attempt === 1)) {
        const read = handle.readContext(authority.contextDigest);
        if (!read.ok) return waveBlocked(handle, read.error.message);
        const context = handleWaveReviewContext([read.value], authority.contextDigest);
        if (context?.batchEpoch === epoch.batchEpoch) candidates.push({ authority, packet: read.value, context });
      }
      const rank = (candidate: typeof candidates[number]): number => {
        if (candidate.authority.role === "spec-check-invoker") return 0;
        const taskIndex = registration.taskIds.indexOf(candidate.context?.taskRun?.taskId ?? "");
        const reviewerIndex = WAVE_REVIEW_AGENTS.indexOf(candidate.authority.role as typeof WAVE_REVIEW_AGENTS[number]);
        return taskIndex < 0 || reviewerIndex < 0 ? Number.MAX_SAFE_INTEGER : 1 + taskIndex * WAVE_REVIEW_AGENTS.length + reviewerIndex;
      };
      candidates.sort((left, right) => rank(left) - rank(right));
      const expectedCount = 1 + registration.taskIds.length * WAVE_REVIEW_AGENTS.length;
      if (candidates.length !== expectedCount || candidates.some((candidate, index) => rank(candidate) !== index)) {
        return waveBlocked(handle, "persisted current Wave review batch is missing, duplicated, or out of canonical subject order");
      }
      const inputs = candidates.map(({ authority }) => Object.freeze({
        authority,
        context: Object.freeze({
          digest: authority.contextDigest,
          slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${authority.contextDigest}.json` }),
        }),
      }));
      const recovered = durableRefutationRequests(
        handle, inputs, publicationResolver(handle), "wave-gate-current",
      );
      if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
      if (recovered.kind === "found") {
        currentIssued = Object.freeze(recovered.requests.map(({ authority }) => authority));
      } else {
        const published = await publishInitialBatch(
          handle, inputs, candidates.map(({ packet }) => packet), "wave-gate-current",
        );
        if (!published.ok) return failed(published.message);
        currentIssued = Object.freeze(published.requests.map(({ authority }) => authority));
      }
    }
    const belongsToCurrentPacket = (request: AgentRequestAuthority): boolean => {
      const context = handleWaveReviewContext(
        request.contextDigest === undefined ? [] : [handle.readContext(request.contextDigest)].flatMap((read) => read.ok ? [read.value] : []),
        request.contextDigest,
      );
      if (context === null) return false;
      if (request.role === "spec-check-invoker") {
        return currentRuns.length > 0 && typeof context.batchEpoch === "string" &&
          currentRuns.every(({ review_run }) => review_run?.head_sha === context.batchEpoch);
      }
      const taskRun = context.taskRun;
      if (taskRun === null || taskRun === undefined) return false;
      const task = currentRuns.find(({ id }) => id === taskRun.taskId);
      return task?.review_run?.packet_id === taskRun.packetId && task.review_run.generation === taskRun.generation &&
        task.review_run.slot_authority?.some(({ agent, slot_id, attempted }) =>
          agent === request.role && slot_id === request.slotId && attempted === request.attempt) === true;
    };

    // Transcript capture is durable before semantic application. Reconcile the
    // crash window idempotently under exact current packet/slot authority.
    for (const request of currentIssued.filter((authority) => authority.program === "wave-gate" &&
      belongsToCurrentPacket(authority) && captured.value.has(captureKey(authority.slotId, authority.attempt)))) {
      const now = manager.load();
      if (request.role === "spec-check-invoker" && now.spec_check?.wave === registration.input.wave &&
          now.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED") continue;
      const contextRead = handle.readContext(request.contextDigest);
      if (!contextRead.ok) return waveBlocked(handle, contextRead.error.message);
      const context = handleWaveReviewContext([contextRead.value], request.contextDigest);
      const taskId = context?.taskRun?.taskId;
      if (request.role !== "spec-check-invoker") {
        const task = now.tasks.find(({ id }) => id === taskId);
        if (task?.review_run === undefined || task.review_run.evidence.some(({ agent }) => agent === request.role)) continue;
      }
      const bytes = handle.readTranscriptBytes(request);
      if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
      const applied = await applyWaveFacadeSubmission(handle, request, Buffer.from(bytes.value).toString("utf8"));
      if (!applied.ok) return waveBlocked(handle, `captured Wave evidence could not be reconciled: ${applied.message}`);
    }

    // Only current Wave review requests may outrank Review Packet recovery.
    // Refutation requests are resumed below, after every packet has closed.
    const uncapturedInitialReviews = currentIssued.filter((request) => request.program === "wave-gate" && request.attempt === 1 &&
      belongsToCurrentPacket(request) && !captured.value.has(captureKey(request.slotId, request.attempt)));
    if (uncapturedInitialReviews.length > 0) {
      return { ok: true, action: {
        kind: "spawn-batch", runId: handle.runId,
        requests: uncapturedInitialReviews.map((authority) => ({
          authority,
          context: { digest: authority.contextDigest, slot: { kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` } },
          task: `LOOM_REQUEST_ID: ${authority.requestId}\nLOOM_CONTEXT_DIGEST: ${authority.contextDigest}\nComplete the exact Wave review request.`,
        })),
      } };
    }

    refreshed = manager.load();
    const collecting = refreshed.tasks.some((task) => registration.taskIds.includes(task.id) && task.review_run !== undefined);
    if (collecting) {
      const retries = currentWaveTaskReviewRetries(handle, registration, refreshed, currentIssued);
      if (retries.length === 0) return waveBlocked(handle, "active Wave Review Packets have no recoverable outstanding reviewer slots");
      const resolver = publicationResolver(handle);
      const durableRequests: SpawnRequest[] = [];
      for (const retry of retries) {
        const label = `wave-gate-retry:${retry.slotId}`;
        const recovered = durableRefutationRequests(handle, [retry.request], resolver, label);
        if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
        if (recovered.kind === "found") {
          durableRequests.push(...recovered.requests);
          continue;
        }
        const published = await publishInitialBatch(handle, [retry.request], [retry.packet], label);
        if (!published.ok) return failed(published.message);
        durableRequests.push(...published.requests);
      }
      await markWaveTaskReviewRetriesIssued(manager, retries);
      for (const { authority } of durableRequests) {
        const rejection = await durableCaptureRejection(handle, authority);
        if (rejection !== null) {
          return waveBlocked(handle, `Wave reviewer attempt 2 exhausted after capture rejection: ${rejection}`);
        }
      }
      const capturedRetries = durableRequests.filter(({ authority }) =>
        captured.value.has(captureKey(authority.slotId, authority.attempt)));
      for (const request of capturedRetries) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
        const applied = await applyWaveFacadeSubmission(handle, request.authority, Buffer.from(bytes.value).toString("utf8"));
        if (!applied.ok) return waveBlocked(handle, `captured Wave retry could not be reconciled: ${applied.message}`);
      }
      if (capturedRetries.length > 0) {
        const afterReplay = manager.load();
        const rejected = capturedRetries.filter(({ authority }) => {
          const retry = retries.find(({ slotId }) => slotId === authority.slotId);
          const task = retry === undefined ? undefined : afterReplay.tasks.find(({ id }) => id === retry.taskId);
          return retry === undefined || (task?.review_run !== undefined &&
            !task.review_run.evidence.some(({ agent }) => agent === retry.agent));
        });
        if (rejected.length > 0) {
          return waveBlocked(handle, `Wave reviewer attempt 2 exhausted without accepted packet evidence: ${rejected.map(({ authority }) => authority.role).join(", ")}`);
        }
        return resumeWaveGateFacade(handle, registration);
      }
      return { ok: true, action: {
        kind: "spawn-batch", runId: handle.runId,
        requests: durableRequests.map((request) => ({
          ...request,
          task: `LOOM_REQUEST_ID: ${request.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${request.context.digest}\nRetry the exact current Wave Review Packet slot.`,
        })),
      } };
    }

    refreshed = manager.load();
    const specAccepted = refreshed.spec_check?.wave === registration.input.wave &&
      refreshed.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED";
    if (!specAccepted) {
      const attemptOne = currentIssued.find((authority) => authority.program === "wave-gate" && authority.attempt === 1 &&
        authority.role === "spec-check-invoker");
      if (attemptOne === undefined) return waveBlocked(handle, "current Wave spec-check has no issued attempt-1 authority");
      const retry = deriveWaveAttemptTwo(handle, attemptOne);
      const recovered = durableRefutationRequests(
        handle, [retry.request], publicationResolver(handle), "wave-gate-spec-retry",
      );
      if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
      let durable: SpawnRequest;
      if (recovered.kind === "found") durable = recovered.requests[0]!;
      else {
        const published = await publishInitialBatch(handle, [retry.request], [retry.packet], "wave-gate-spec-retry");
        if (!published.ok) return failed(published.message);
        durable = published.requests[0]!;
      }
      const captureRejection = await durableCaptureRejection(handle, durable.authority);
      if (captureRejection !== null) {
        return waveBlocked(handle, `Wave spec-check attempt 2 exhausted after capture rejection: ${captureRejection}`);
      }
      if (captured.value.has(captureKey(durable.authority.slotId, durable.authority.attempt))) {
        const bytes = handle.readTranscriptBytes(durable.authority);
        if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
        const applied = await applyWaveFacadeSubmission(handle, durable.authority, Buffer.from(bytes.value).toString("utf8"));
        if (!applied.ok) return waveBlocked(handle, `captured Wave spec-check retry could not be reconciled: ${applied.message}`);
        const accepted = manager.load().spec_check;
        if (accepted?.wave !== registration.input.wave || accepted.verdict === "EVIDENCE_CAPTURE_FAILED") {
          return waveBlocked(handle, "Wave spec-check attempt 2 exhausted without accepted current-wave evidence");
        }
        return resumeWaveGateFacade(handle, registration);
      }
      return { ok: true, action: {
        kind: "spawn-batch", runId: handle.runId,
        requests: [{
          ...durable,
          task: `LOOM_REQUEST_ID: ${durable.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${durable.context.digest}\nRetry the exact current Wave spec-check slot.`,
        }],
      } };
    }

    const current = deriveWaveReadiness(refreshed, waveGateDeps);
    if (!current.ok) return waveBlocked(handle, current.error.reasons.map(({ message }) => message).join("; "));
    if (current.value.facts.findingCounts.kind === "known" && current.value.facts.findingCounts.value.activeCritical > 0) {
      const preparation = waveRefutationPreparation(handle, current.value);
      const resolver = publicationResolver(handle);
      const recovered = durableRefutationRequests(handle, preparation.inputs, resolver, "wave-refutation");
      if (recovered.kind === "corrupt") return waveBlocked(handle, recovered.message);
      if (recovered.kind === "absent") {
        const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "wave-refutation");
        return published.ok ? { ok: true, action: published.action } : failed(published.message);
      }
      const requests = recovered.requests;
      const panelCaptured = handle.readCapturedAttempts();
      if (!panelCaptured.ok) return waveBlocked(handle, panelCaptured.error.message);
      const missing = requests.filter((request) => !panelCaptured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
      if (missing.length > 0) {
        return {
          ok: true,
          action: { kind: "spawn-batch", runId: handle.runId, requests: executableRefutationRequests(missing, false) },
        };
      }
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      for (const request of requests) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
        let submitted = submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), Buffer.from(bytes.value).toString("utf8"));
        if (!submitted.ok) return waveBlocked(handle, submitted.error.message);
        panelState = submitted.value.state;
        if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
          const retryAuthority = submitted.value.action.requests[0];
          const retry = await recoverOrPublishRefutationRetry(
            handle, retryAuthority, preparation.retryInputs, resolver, "wave-refutation",
          );
          if (!retry.ok) return waveBlocked(handle, retry.message);
          const attempts = handle.readCapturedAttempts();
          if (!attempts.ok) return waveBlocked(handle, attempts.error.message);
          if (!attempts.value.has(captureKey(retry.request.authority.slotId, retry.request.authority.attempt))) {
            return { ok: true, action: {
              kind: "spawn-batch", runId: handle.runId,
              requests: executableRefutationRequests([retry.request], false),
            } };
          }
          const retryBytes = handle.readTranscriptBytes(retry.request.authority);
          if (!retryBytes.ok) return waveBlocked(handle, retryBytes.error.message);
          submitted = submitRefutationVerdict(
            panelState, resolver, panelRequestIdentity(retry.request), Buffer.from(retryBytes.value).toString("utf8"),
          );
          if (!submitted.ok) return waveBlocked(handle, submitted.error.message);
          panelState = submitted.value.state;
          if (submitted.value.action?.kind === "refutation-blocked") {
            return waveBlocked(handle, submitted.value.action.diagnostic.message);
          }
        }
      }
      const completed = completePersistentRefutationPanel(panelState, resolver, preparation.threshold);
      if (!completed.ok || completed.value.state.stage !== "done") {
        return waveBlocked(handle, completed.ok ? "Wave Refutation Panel did not reach done" : completed.error.message);
      }
      const donePanel = completed.value.state;
      await manager.update((locked) => ({
        ...locked,
        tasks: locked.tasks.map((task) => applyFindingOutcomes(task, donePanel.decision.outcomes)),
      }));
      return resumeWaveGateFacade(handle, registration);
    }
    const advisoryCount = current.value.facts.findingCounts.kind === "known" ? current.value.facts.findingCounts.value.advisory : 0;
    const advisoryRequestId = waveAdvisoryDecisionRequestId(handle.runId, current.value.waveTasks);
    const decisions = await handle.readEvents();
    const advisoryDecision = decisions.some(({ event }) => {
      if (typeof event !== "object" || event === null) return false;
      const record = event as Record<string, unknown>;
      const decision = record.decision;
      return record.kind === "user-decision-recorded" && record.decisionId === advisoryRequestId &&
        typeof decision === "object" && decision !== null && !Array.isArray(decision) &&
        Object.keys(decision).length === 1 && (decision as Record<string, unknown>).kind === "approve";
    });
    if (advisoryCount > 0 && !advisoryDecision) {
      return { ok: true, action: {
        kind: "await-user", runId: handle.runId,
        request: { kind: "advisory-triage", requestId: advisoryRequestId, advisoryCount },
      } };
    }
    if (current.value.gateDecision.verdict.kind !== "pass") {
      return waveBlocked(handle, current.value.gateDecision.verdict.reason);
    }
    const committed = await manager.commitActiveWaveGateCompletion((locked) => {
      const lockedReadiness = deriveWaveReadiness(locked, waveGateDeps);
      return lockedReadiness.ok ? commitWaveGateCompletion(lockedReadiness.value) : {
        ok: false as const,
        error: { kind: "wave-completion-commit-rejected" as const, message: lockedReadiness.error.reasons.map(({ message }) => message).join("; ") },
      };
    });
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 1, kind: "wave-gate-done", receipt: committed.receipt }));
    return { ok: true, action: { kind: "done", runId: handle.runId, outcome: committed.receipt } };
  } catch (error) {
    return waveBlocked(handle, error instanceof Error ? error.message : String(error));
  }
}

function remediationBlocked(handle: RunDirHandle, message: string): FacadeDriveResult {
  return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: { kind: "remediation-blocked", message } } };
}

function witness(repository: Parameters<typeof snapshotRepositoryWitness>[0]):
  | Readonly<{ ok: true; value: import("../../core/remediation-machine").RepositorySnapshotWitness }>
  | Readonly<{ ok: false; message: string }> {
  const observed = snapshotRepositoryWitness(repository);
  if (!observed.ok) return { ok: false, message: observed.error.message };
  const parsed = parseRepositorySnapshotWitness(observed.value);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, message: parsed.error.message };
}

export async function startRemediationFacade(
  handle: RunDirHandle,
  input: RegisteredRemediationProgram["input"],
): Promise<FacadeDriveResult> {
  const registration: RegisteredRemediationProgram = Object.freeze({ schemaVersion: 1, kind: "remediation", input });
  const registered = await handle.registerProgram(registration);
  if (!registered.ok) return failed(registered.error.message);
  return driveRemediationFacade(handle, registration);
}

export async function resumeRemediationFacade(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgram,
): Promise<FacadeDriveResult> {
  const checkpoint = await handle.readCheckpoint();
  if (checkpoint !== null) {
    let raw: unknown;
    try { raw = JSON.parse(checkpoint); }
    catch { return failed("remediation checkpoint is invalid JSON"); }
    if (typeof raw === "object" && raw !== null) {
      const record = raw as { schemaVersion?: unknown; state?: { state?: unknown; receipt?: unknown } };
      if (record.schemaVersion === 1 && typeof record.state === "object" && record.state !== null && record.state.state === "done") {
        // Validate the stored receipt instead of fabricating one.
        const receipt = record.state.receipt;
        if (typeof receipt !== "object" || receipt === null ||
            (receipt as { kind?: unknown }).kind !== "verified-index-installed" ||
            typeof (receipt as { effectId?: unknown }).effectId !== "string" ||
            typeof (receipt as { runId?: unknown }).runId !== "string" ||
            typeof (receipt as { indexDigest?: unknown }).indexDigest !== "string" ||
            typeof (receipt as { witnessDigest?: unknown }).witnessDigest !== "string") {
          return failed("remediation checkpoint claims done but contains no valid verified-index-installed receipt");
        }
        return { ok: true, action: { kind: "done", runId: handle.runId, outcome: receipt } };
      }
    }
  }
  return driveRemediationFacade(handle, registration);
}

async function driveRemediationFacade(
  handle: RunDirHandle,
  registration: RegisteredRemediationProgram,
): Promise<FacadeDriveResult> {
  try {
    const source = openRunDirectory(registration.input.sourceRunsRoot, registration.input.sourceRun);
    if (!source.ok) return remediationBlocked(handle, source.error.message);
    const sourceCheckpoint = await source.value.readCheckpoint();
    if (sourceCheckpoint === null) return remediationBlocked(handle, "source standalone review checkpoint is missing");
    const sourceStateRaw = JSON.parse(sourceCheckpoint) as unknown;
    const sourceState = parseStandaloneReviewMachineState(sourceStateRaw, publicationResolver(source.value));
    if (!sourceState.ok || sourceState.value.kind !== "done") {
      return remediationBlocked(handle, sourceState.ok ? "source standalone review is not done" : sourceState.error.message);
    }
    let started = startRemediation({
      standaloneResult: sourceState.value.result,
      publicationReceipt: sourceState.value.publicationReceipt,
    });
    if (!started.ok) return remediationBlocked(handle, started.error.message);
    let state: RemediationState = started.value;
    for (const path of registration.input.supportPaths) {
      const next = reduceRemediation(state, { kind: "support-path-registered", path });
      if (!next.ok) return remediationBlocked(handle, next.error.message);
      state = next.value;
    }
    const repository = openGitRepository(process.cwd());
    if (!repository.ok) return remediationBlocked(handle, repository.error.message);
    const dirty = observeDirtyPaths(repository.value);
    const preexisting = observeStagedPaths(repository.value);
    const initialWitness = witness(repository.value);
    if (!dirty.ok) return remediationBlocked(handle, dirty.error.message);
    if (!preexisting.ok) return remediationBlocked(handle, preexisting.error.message);
    if (!initialWitness.ok) return remediationBlocked(handle, initialWitness.message);
    const actualPaths = dirty.value.map(({ path }) => path);
    const audited = auditRemediationPaths(state.authority, {
      expectedDirtyPaths: actualPaths,
      actualDirtyPaths: dirty.value,
      preexistingStagedPaths: preexisting.value,
      repositoryWitness: initialWitness.value,
    });
    if (!audited.ok) return remediationBlocked(handle, audited.error.message);
    let next = reduceRemediation(state, { kind: "audit-succeeded", audited: audited.value });
    if (!next.ok || next.value.state !== "audited") return remediationBlocked(handle, next.ok ? "audit transition failed" : next.error.message);
    state = next.value;

    const pathspec = prepareLiteralGitPathspec(state.audited);
    if (!pathspec.ok) return remediationBlocked(handle, pathspec.error.message);
    const temporary = createTemporaryIndex(repository.value);
    if (!temporary.ok) return remediationBlocked(handle, temporary.error.message);
    const stagedPaths = stageAuditedPaths(repository.value, temporary.value, pathspec.value);
    if (!stagedPaths.ok) return remediationBlocked(handle, stagedPaths.error.message);
    const indexDigest = digestTemporaryIndex(repository.value, temporary.value);
    const stagingWitness = witness(repository.value);
    if (!indexDigest.ok) return remediationBlocked(handle, indexDigest.error.message);
    if (!stagingWitness.ok) return remediationBlocked(handle, stagingWitness.message);
    const staged = stageTemporaryIndex(state.audited, indexDigest.value, stagingWitness.value);
    if (!staged.ok) return remediationBlocked(handle, staged.error.message);
    next = reduceRemediation(state, { kind: "temporary-index-staged", staged: staged.value });
    if (!next.ok || next.value.state !== "staged-temporary-index") return remediationBlocked(handle, next.ok ? "staging transition failed" : next.error.message);
    state = next.value;

    const observedStaged = readStagedPaths(repository.value, temporary.value);
    const verifiedDigest = digestTemporaryIndex(repository.value, temporary.value);
    const verificationWitness = witness(repository.value);
    if (!observedStaged.ok) return remediationBlocked(handle, observedStaged.error.message);
    if (!verifiedDigest.ok) return remediationBlocked(handle, verifiedDigest.error.message);
    if (!verificationWitness.ok) return remediationBlocked(handle, verificationWitness.message);
    const verified = verifyTemporaryIndex(state.staged, {
      actualTemporaryIndexStagedPaths: observedStaged.value,
      actualIndexDigest: verifiedDigest.value,
      currentRepositoryWitness: verificationWitness.value,
    });
    if (!verified.ok) return remediationBlocked(handle, verified.error.message);
    next = reduceRemediation(state, { kind: "staged-set-verified", verified: verified.value });
    if (!next.ok || next.value.state !== "verified") return remediationBlocked(handle, next.ok ? "verification transition failed" : next.error.message);
    state = next.value;

    const effectId = parseEffectId(`effect:remediation-install:${verified.value.digest}`);
    if (!effectId.ok) return remediationBlocked(handle, effectId.error.message);
    const installation = prepareVerifiedIndexInstallation(verified.value, effectId.value, verificationWitness.value);
    if (!installation.ok) return remediationBlocked(handle, installation.error.message);
    const installed = installVerifiedIndex(repository.value, temporary.value, verificationWitness.value);
    if (!installed.ok) return remediationBlocked(handle, installed.error.message);
    const receipt = {
      kind: "verified-index-installed" as const,
      effectId: installation.value.intent.effectId,
      runId: installation.value.intent.runId,
      indexDigest: installation.value.intent.indexDigest,
      witnessDigest: installation.value.intent.witnessDigest,
    };
    next = reduceRemediation(state, { kind: "index-installed", installation: installation.value, receipt });
    if (!next.ok || next.value.state !== "done") return remediationBlocked(handle, next.ok ? "installation transition failed" : next.error.message);
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 1, state: next.value }));
    return { ok: true, action: { kind: "done", runId: handle.runId, outcome: receipt } };
  } catch (error) {
    return remediationBlocked(handle, error instanceof Error ? error.message : String(error));
  }
}

function standaloneRefutationPreparation(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  aggregate: import("../../core/standalone-review").StandaloneReviewAggregate,
) {
  const brief = buildStandaloneFindingBrief(aggregate);
  const selected = selectReviewLenses(reviewSignals(brief.findings), 3);
  if (!selected.ok) throw new Error(selected.errors.join("; "));
  const lenses = selected.value;
  const slots = [];
  const packets: ContextPacket[] = [];
  const inputs: InitialSpawnRequestInput[] = [];
  const retryInputs: Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[] = [];
  const profile = resolveModelProfile("refutation");
  if (!profile.ok) throw new Error(profile.error.message);
  for (let index = 0; index < lenses.length; index += 1) {
    const lens = lenses[index]!;
    const [firstFinding, ...otherFindings] = brief.findings;
    if (firstFinding === undefined) throw new Error("standalone refutation requires a non-empty critical Finding set");
    const binding = deriveRefutationVerifierBinding(
      handle.runId,
      lens,
      [firstFinding.id, ...otherFindings.map(({ id }) => id)],
    );
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = binding.value.requestIds[attempt - 1];
      const section = encodeByteSection("refutation-authority", JSON.stringify({
        runId: handle.runId, lens, findings: brief.findings, attempt,
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId,
        role: "review-verifier-agent",
        requiredSkill: "none",
        outputContract: `Adjudicate every Finding through lens '${lens}' and emit the exact refutation verdict JSON contract.`,
        fixedContext: Object.freeze([section.value]), variableContext: Object.freeze([]),
      });
      if (!packet.ok) throw new Error(packet.error.message);
      if (attempt === 1) packets.push(packet.value);
      const parsed = parseAgentRequestAuthority({
        runId: handle.runId, requestId, slotId: binding.value.slotId,
        program: "refutation-panel", role: "review-verifier-agent", attempt,
        modelProfile: profile.value.id,
        harnessBinding: { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") },
        requiredSkill: null, contextDigest: packet.value.digest,
        outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw`,
      });
      if (!parsed.ok) throw new Error(parsed.error.violations.map(({ message }) => message).join("; "));
      const input = { authority: parsed.value, context: {
        digest: packet.value.digest,
        slot: { kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` },
      } };
      if (attempt === 1) inputs.push(input);
      else retryInputs.push(Object.freeze({ input: Object.freeze(input), packet: packet.value }));
      return parsed.value;
    });
    slots.push({ slotId: binding.value.slotId, attempts });
  }
  const panel = parseRefutationPanelAuthority({ runId: handle.runId, findings: brief.findings, lenses, verifierSlots: slots });
  if (!panel.ok) throw new Error(panel.error.message);
  const threshold = defaultRefutationThreshold(lenses.length);
  const frozen = freezeStandaloneRefutationPanelAuthority({ standaloneAuthority: authority, aggregate, panelAuthority: panel.value, threshold });
  if (!frozen.ok) throw new Error(frozen.error.message);
  return { brief, lenses, panel: panel.value, frozen: frozen.value, threshold, packets, inputs, retryInputs };
}

function executableRefutationRequests(
  requests: readonly SpawnRequest[],
  standalone: boolean,
): readonly Readonly<SpawnRequest & { task: string }>[] {
  const standaloneMarker = standalone ? "LOOM_REVIEW_CONTEXT: standalone\n" : "";
  return requests.map((request) => Object.freeze({
    ...request,
    task: `${standaloneMarker}LOOM_REQUEST_ID: ${request.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${request.context.digest}\nComplete the exact pending Refutation Panel request.`,
  }));
}

function durableRefutationRequests(
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

async function durableCaptureRejection(
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
  if (rejected === undefined || typeof rejected.event !== "object" || rejected.event === null) return null;
  const diagnostic = (rejected.event as Record<string, unknown>).diagnostic;
  return typeof diagnostic === "string" ? diagnostic : "capture was rejected without a diagnostic";
}

async function recoverOrPublishRefutationRetry(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  retryInputs: readonly Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[],
  resolver: PublicationAuthorityResolver,
  label: string,
): Promise<Readonly<{ ok: true; request: SpawnRequest }> | Readonly<{ ok: false; message: string }>> {
  const rejection = await durableCaptureRejection(handle, authority);
  if (rejection !== null) {
    return { ok: false, message: `refutation attempt 2 exhausted after capture rejection: ${rejection}` };
  }
  const prepared = retryInputs.find(({ input }) =>
    (input.authority as AgentRequestAuthority).requestId === authority.requestId);
  if (prepared === undefined || JSON.stringify(prepared.input.authority) !== JSON.stringify(authority)) {
    return { ok: false, message: `refutation retry ${authority.requestId} is not exact prepared attempt-2 authority` };
  }
  const retryLabel = `${label}-retry:${authority.slotId}`;
  const recovered = durableRefutationRequests(handle, [prepared.input], resolver, retryLabel);
  if (recovered.kind === "corrupt") return { ok: false, message: recovered.message };
  if (recovered.kind === "found") return { ok: true, request: recovered.requests[0]! };
  const published = await publishInitialBatch(handle, [prepared.input], [prepared.packet], retryLabel);
  return published.ok
    ? { ok: true, request: published.requests[0]! }
    : { ok: false, message: published.message };
}

async function finalizeStandaloneState(
  handle: RunDirHandle,
  ready: Extract<StandaloneReviewMachineState, { kind: "ready-to-finalize" }>,
): Promise<FacadeDriveResult> {
  const json = serializeAdjudicatedStandaloneReview(ready.result);
  const artifact = canonicalStandaloneResultArtifact(ready.result);
  if (!artifact.ok) return failed(artifact.error.message);
  const resultBytes = Buffer.from(json, "utf8");
  try { writeRunBytesExclusiveNoFollow(`${handle.runDirectory}/result.json`, resultBytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readRunBytesNoFollow(`${handle.runDirectory}/result.json`).equals(resultBytes)) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
  const receipt = { kind: "artifact-set-published" as const, effectId: ready.publicationIntent.effectId,
    runId: handle.runId, artifacts: Object.freeze([artifact.value]) as readonly [typeof artifact.value] };
  const recorded = await handle.recordReceipt(receipt);
  if (!recorded.ok) return failed(`cannot durably record publication receipt: ${recorded.error.message}`);
  const done = reduceStandaloneReviewMachine(ready, { kind: "result-published", result: JSON.parse(json), receipt });
  if (!done.ok || done.value.kind !== "done") return failed(done.ok ? "standalone result did not reach done" : done.error.message);
  await handle.writeCheckpoint(serializeStandaloneReviewMachineState(done.value));
  return { ok: true, action: { kind: "done", runId: handle.runId, outcome: done.value.outcome } };
}

export async function resumeStandaloneFacade(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram,
): Promise<FacadeDriveResult> {
  try {
    const authorityResult = parsedAuthority(registration);
    if (!authorityResult.ok) return failed(authorityResult.message);
    const resolver = publicationResolver(handle);
    const checkpoint = await handle.readCheckpoint();
    if (checkpoint === null) return failed("standalone review checkpoint is missing");
    let rawState: unknown;
    try { rawState = JSON.parse(checkpoint); } catch { return failed("standalone review checkpoint is invalid JSON"); }
    const state = parseStandaloneReviewMachineState(rawState, resolver);
    if (!state.ok) return failed(state.error.message);
    if (state.value.kind === "done") return { ok: true, action: { kind: "done", runId: handle.runId, outcome: state.value.outcome } };
    if (state.value.kind === "terminal-blocked" || state.value.kind === "recoverable-blocked") {
      return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: state.value } };
    }
    if (state.value.kind === "ready-to-finalize") return finalizeStandaloneState(handle, state.value);
    if (state.value.kind === "awaiting-refutation") {
      const preparation = standaloneRefutationPreparation(handle, state.value.authority, state.value.aggregate);
      const recovered = durableRefutationRequests(handle, preparation.inputs, resolver);
      if (recovered.kind === "corrupt") return failed(recovered.message);
      if (recovered.kind === "absent") {
        const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "standalone-refutation");
        return published.ok ? { ok: true, action: published.action } : failed(published.message);
      }
      const panelRequests = recovered.requests;
      const captured = handle.readCapturedAttempts();
      if (!captured.ok) return failed(captured.error.message);
      const missing = panelRequests.filter((request) => !captured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
      if (missing.length > 0) {
        return {
          ok: true,
          action: { kind: "spawn-batch", runId: handle.runId, requests: executableRefutationRequests(missing, true) },
        };
      }
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      for (const request of panelRequests) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return failed(bytes.error.message);
        let submitted = submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), Buffer.from(bytes.value).toString("utf8"));
        if (!submitted.ok) return failed(submitted.error.message);
        panelState = submitted.value.state;
        if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
          const retryAuthority = submitted.value.action.requests[0];
          const retry = await recoverOrPublishRefutationRetry(
            handle, retryAuthority, preparation.retryInputs, resolver, "standalone-refutation",
          );
          if (!retry.ok) return failed(retry.message);
          const attempts = handle.readCapturedAttempts();
          if (!attempts.ok) return failed(attempts.error.message);
          if (!attempts.value.has(captureKey(retry.request.authority.slotId, retry.request.authority.attempt))) {
            return { ok: true, action: {
              kind: "spawn-batch", runId: handle.runId,
              requests: executableRefutationRequests([retry.request], true),
            } };
          }
          const retryBytes = handle.readTranscriptBytes(retry.request.authority);
          if (!retryBytes.ok) return failed(retryBytes.error.message);
          submitted = submitRefutationVerdict(
            panelState, resolver, panelRequestIdentity(retry.request), Buffer.from(retryBytes.value).toString("utf8"),
          );
          if (!submitted.ok) return failed(submitted.error.message);
          panelState = submitted.value.state;
          if (submitted.value.action?.kind === "refutation-blocked") {
            return failed(submitted.value.action.diagnostic.message);
          }
        }
      }
      const completed = completePersistentRefutationPanel(panelState, resolver, preparation.threshold);
      if (!completed.ok || completed.value.state.stage !== "done") return failed(completed.ok ? "refutation did not reach done" : completed.error.message);
      const completion = parseStandaloneRefutationCompletion({
        panelAuthority: preparation.frozen,
        aggregate: state.value.aggregate,
        completedPanelState: completed.value.state,
      });
      if (!completion.ok) return failed(completion.error.message);
      const ready = reduceStandaloneReviewMachine(state.value, { kind: "refutation-completed", completion: completion.value });
      if (!ready.ok || ready.value.kind !== "ready-to-finalize") return failed(ready.ok ? "refutation did not unlock finalization" : ready.error.message);
      return finalizeStandaloneState(handle, ready.value);
    }
    if (state.value.kind !== "awaiting-results") return failed(`unsupported standalone resume state ${state.value.kind}`);

    const activeAuthority = state.value.authority;
    const recovered = durableRequests(handle, activeAuthority, resolver);
    if (recovered.kind !== "found") {
      return failed(recovered.kind === "absent"
        ? "standalone publication authority is absent"
        : recovered.message);
    }
    const issued = recovered.requests;
    const captured = handle.readCapturedAttempts();
    if (!captured.ok) return failed(captured.error.message);
    const captureAuthority = bindStandaloneCaptureAuthority(activeAuthority, issued);
    if (!captureAuthority.ok) return failed(captureAuthority.error.message);
    const accepted = [];
    for (const request of issued) {
      if (!captured.value.has(captureKey(request.authority.slotId, request.authority.attempt))) continue;
      const bytes = handle.readTranscriptBytes(request.authority);
      if (!bytes.ok) return failed(bytes.error.message);
      const prepared = captureStandaloneReviewerBytes(captureAuthority.value, request.authority.requestId, bytes.value);
      if (!prepared.ok) return failed(prepared.error.message);
      const completed = completeStandaloneReviewerCapture(prepared.value, {
        kind: "raw-transcript-captured",
        effectId: prepared.value.intent.effectId,
        runId: handle.runId,
        requestId: request.authority.requestId,
        artifact: prepared.value.expectedArtifact,
      });
      if (!completed.ok) return failed(completed.error.message);
      accepted.push(completed.value);
    }
    if (accepted.length !== issued.length) {
      const effectId = standalonePublicationEffectId(activeAuthority);
      if (!effectId.ok) return failed(effectId.error.message);
      const receipt = JSON.parse(readRunBytesNoFollow(
        `${handle.runDirectory}/artifacts/${publicationFile(effectId.value)}`,
      ).toString("utf8")) as Record<string, unknown>;
      return { ok: true, action: {
        kind: "spawn-batch",
        runId: handle.runId,
        publicationIdentity: {
          schemaVersion: 1,
          kind: "batch-publication-identity",
          runId: handle.runId,
          effectId: effectId.value,
          publicationDigest: receipt.publicationDigest,
        },
        idempotencyKey: { runId: handle.runId, effectId: effectId.value },
        receipt,
        requests: issued.filter((request) => !captured.value.has(captureKey(request.authority.slotId, request.authority.attempt))).map((request) => ({
          ...request,
          task: `LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: ${request.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${request.context.digest}\nReview the immutable context packet and emit only the required reviewer result.`,
        })),
      } };
    }
    const completion = proveStandaloneRosterCompletion(activeAuthority, resolver, accepted);
    if (!completion.ok) return failed(completion.error.violations.map((entry) => JSON.stringify(entry)).join("; "));
    let reduced = reduceStandaloneReviewMachine(state.value, { kind: "complete-roster-proved", completion: completion.value });
    if (!reduced.ok) return failed(reduced.error.message);
    if (reduced.value.kind !== "aggregating") return failed("standalone roster did not reach aggregation");
    const aggregate = aggregateStandaloneReview({ authority: activeAuthority, completion: completion.value });
    if (!aggregate.ok) return failed(aggregate.errors.join("; "));
    if (aggregate.value.kind !== "clean") {
      const preparation = standaloneRefutationPreparation(handle, activeAuthority, aggregate.value.aggregate);
      reduced = reduceStandaloneReviewMachine(reduced.value, {
        kind: "aggregate-has-criticals",
        aggregate: aggregate.value.aggregate,
        panelAuthority: preparation.frozen,
        refutationAuthority: preparation.panel,
      });
      if (!reduced.ok || reduced.value.kind !== "awaiting-refutation") return failed(reduced.ok ? "critical route did not reach refutation" : reduced.error.message);
      await handle.writeCheckpoint(serializeStandaloneReviewMachineState(reduced.value));
      const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "standalone-refutation");
      return published.ok ? { ok: true, action: published.action } : failed(published.message);
    }
    reduced = reduceStandaloneReviewMachine(reduced.value, { kind: "aggregate-clean", aggregate: aggregate.value.aggregate });
    if (!reduced.ok || reduced.value.kind !== "ready-to-finalize") return failed(reduced.ok ? "standalone finalization did not become ready" : reduced.error.message);
    return finalizeStandaloneState(handle, reduced.value);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
