import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseAgentRequestAuthority,
  parseEffectId,
  parseIssuedSpawnRequest,
  parseRequestId,
  parseSlotId,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  AGENT_REQUIRED_SKILLS,
  type AgentRequestAuthority,
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

function deriveChangedPaths(): Readonly<{
  unstaged: readonly string[];
  staged: readonly string[];
  committed: readonly string[];
  base_revision: string | null;
  head_revision: string;
}> {
  const head = gitText(["rev-parse", "HEAD"]);
  let base: string | null = null;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const probe = spawnSync("git", ["merge-base", candidate, "HEAD"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim() !== "") { base = probe.stdout.trim(); break; }
  }
  return Object.freeze({
    unstaged: gitPaths(["diff", "--name-only", "-z", "--"]),
    staged: gitPaths(["diff", "--cached", "--name-only", "-z", "--"]),
    committed: base === null ? Object.freeze([]) : gitPaths(["diff", "--name-only", "-z", `${base}...HEAD`, "--"]),
    base_revision: base,
    head_revision: head,
  });
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".java", ".rs", ".py", ".go", ".c", ".cpp"]);
const TYPE_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".java", ".rs"]);

function metadata(kind: StandaloneReviewKind, scope: readonly string[]): StandaloneReviewMetadata {
  const extensions = scope.map((path) => extname(path).toLowerCase());
  const docsOnly = scope.every((path) => /(^|\/)(docs?|README)|\.(md|mdx|txt)$/.test(path));
  const languages = [...new Set(extensions.filter(Boolean).map((extension) => extension.slice(1)))].sort();
  const additionsResult = spawnSync("git", ["diff", "--numstat", "HEAD", "--", ...scope], { encoding: "utf8" });
  const additions = additionsResult.status === 0
    ? additionsResult.stdout.split("\n").reduce((sum, line) => sum + (Number.parseInt(line.split("\t")[0] ?? "", 10) || 0), 0)
    : 0;
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
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`review scope path is a symlink: ${path}`);
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

function standalonePackets(
  runId: string,
  reviewMetadata: StandaloneReviewMetadata,
  scope: readonly string[],
): Readonly<{ contexts: readonly Readonly<{ attempts: readonly [string, string] }>[]; packets: readonly ContextPacket[] }> {
  const reviewers = selectStandaloneReviewers(reviewMetadata);
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
        fixedContext: Object.freeze([section.value]),
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
  return { ok: true, requests: action.value.requests, action: Object.freeze({
    ...action.value,
    requests: Object.freeze(action.value.requests.map((request) => Object.freeze({
      ...request,
      task: `LOOM_REQUEST_ID: ${request.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${request.context.digest}\nReview the immutable context packet and emit only the required reviewer result.`,
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

function durableRequests(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  resolver: PublicationAuthorityResolver,
): readonly SpawnRequest[] | null {
  const requests: SpawnRequest[] = [];
  const effectId = standalonePublicationEffectId(authority);
  if (!effectId.ok) return null;
  let publicationDigest: string;
  try {
    const receipt = JSON.parse(readRunBytesNoFollow(
      `${handle.runDirectory}/artifacts/${publicationFile(effectId.value)}`,
    ).toString("utf8")) as { publicationDigest?: unknown };
    if (typeof receipt.publicationDigest !== "string") return null;
    publicationDigest = receipt.publicationDigest;
  } catch { return null; }
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
        publicationDigest,
        batchIndex: requests.length,
      },
    });
    if (!parsed.ok) return null;
    requests.push(parsed.value);
  }
  return Object.freeze(requests);
}

export async function startStandaloneFacade(
  handle: RunDirHandle,
  input: RegisteredStandaloneProgram["input"],
): Promise<FacadeDriveResult> {
  try {
    const changed = deriveChangedPaths();
    const union = [...new Set([...changed.unstaged, ...changed.staged, ...changed.committed])].sort();
    const scope = input.files ?? union;
    if (scope.length === 0) return failed("standalone review has no explicit or changed-path scope");
    const reviewMetadata = metadata(input.kind, scope);
    const packetSet = standalonePackets(handle.runId, reviewMetadata, scope);
    const prepared = prepareFreshStandaloneReview({
      runId: handle.runId,
      ...(input.files === null ? {} : { explicitScope: input.files }),
      changedPaths: changed,
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

function waveBlocked(handle: RunDirHandle, message: string): FacadeDriveResult {
  return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: { kind: "wave-gate-blocked", message } } };
}

function waveRequests(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  graph: ReturnType<StateManager["load"]>,
  attempt: 1 | 2,
): Readonly<{ requests: readonly InitialSpawnRequestInput[]; packets: readonly ContextPacket[] }> {
  const tasks = graph.tasks.filter((task) => registration.taskIds.includes(task.id));
  const subjects = [
    { role: "spec-check-invoker" as const, taskId: null as string | null },
    ...tasks.flatMap((task) => WAVE_REVIEW_AGENTS.map((role) => ({ role, taskId: task.id as string | null }))),
  ];
  const requests: InitialSpawnRequestInput[] = [];
  const packets: ContextPacket[] = [];
  for (const subject of subjects) {
    const identity = JSON.stringify({ runId: handle.runId, registration, subject });
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
      subject,
      task: subject.taskId === null ? null : tasks.find(({ id }) => id === subject.taskId),
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
  return Object.freeze({ requests: Object.freeze(requests), packets: Object.freeze(packets) });
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
  for (const lens of plan.value.lenses) {
    const hash = createHash("sha256").update(`${handle.runId}|wave-refutation|${lens}|${plan.value.findings.map(({ id }) => id).join("|")}`).digest("hex");
    const slotId = parseSlotId(`wave-refutation-slot:${hash.slice(0, 32)}`);
    if (!slotId.ok) throw new Error(slotId.error.message);
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = parseRequestId(`wave-refutation-request:${hash.slice(0, 32)}:${attempt}`);
      if (!requestId.ok) throw new Error(requestId.error.message);
      const section = encodeByteSection("wave-refutation-authority", JSON.stringify({ lens, findings: plan.value.findings, attempt }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({ requestId: requestId.value, role: "review-verifier-agent", requiredSkill: "none",
        outputContract: `Adjudicate every Wave Finding through lens '${lens}' and emit exact refutation verdict JSON.`,
        fixedContext: [section.value], variableContext: [] });
      if (!packet.ok) throw new Error(packet.error.message);
      if (attempt === 1) packets.push(packet.value);
      const authority = parseAgentRequestAuthority({ runId: handle.runId, requestId: requestId.value, slotId: slotId.value,
        program: "refutation-panel", role: "review-verifier-agent", attempt, modelProfile: profile.value.id,
        harnessBinding: { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") },
        requiredSkill: null, contextDigest: packet.value.digest, outputSlot: `transcripts/${slotId.value}/attempt-${attempt}.raw` });
      if (!authority.ok) throw new Error(authority.error.violations.map(({ message }) => message).join("; "));
      if (attempt === 1) inputs.push({ authority: authority.value, context: { digest: packet.value.digest,
        slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.value.digest}.json` } } });
      return authority.value;
    });
    slots.push({ slotId: slotId.value, attempts });
  }
  const panel = parseRefutationPanelAuthority({ runId: handle.runId, findings: plan.value.findings,
    lenses: plan.value.lenses, verifierSlots: slots });
  if (!panel.ok) throw new Error(panel.error.message);
  return { panel: panel.value, inputs, packets, threshold: defaultRefutationThreshold(plan.value.lenses.length) };
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
      wave?: unknown; subject?: { role?: unknown; taskId?: unknown };
    };
    const manager = new StateManager(TASK_GRAPH_PATH);
    if (authority.role === "spec-check-invoker") {
      const parsed = parseSpecCheckOutput(raw);
      const graph = manager.load();
      const wave = typeof context.wave === "number" ? context.wave : graph.current_wave ?? 1;
      const resolution = reconcileSpecCheck(parsed, wave, new Date().toISOString());
      await manager.update((locked) => ({ ...locked, spec_check: resolution.specCheck }));
      return { ok: true };
    }
    const taskId = context.subject?.taskId;
    if (typeof taskId !== "string") return { ok: false, message: "Wave reviewer request lacks Task identity" };
    await manager.update((locked) => ({
      ...locked,
      tasks: locked.tasks.map((task) => {
        if (task.id !== taskId) return task;
        const resolution = constrainReviewResolutionToScope(
          resolveTaskReviewFindings(raw, authority.role, task.review_run, task.review_generation),
          [...(task.file_list ?? []), ...(task.files_modified ?? [])],
        );
        return applyReviewResolution(task, resolution);
      }),
    }));
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
      const reviewAuthorities = batch.requests.slice(1).map(({ authority }) => authority as AgentRequestAuthority);
      await manager.update((locked) => ({
        ...locked,
        tasks: locked.tasks.map((task) => {
          const taskIndex = registration.taskIds.indexOf(task.id);
          if (taskIndex < 0) return task;
          const authorities = reviewAuthorities.slice(taskIndex * WAVE_REVIEW_AGENTS.length, (taskIndex + 1) * WAVE_REVIEW_AGENTS.length);
          const generation = task.review_generation ?? 0;
          const packetId = createHash("sha256").update(`${handle.runId}|${task.id}|${registration.authorityDigest}`).digest("hex");
          return {
            ...task,
            review_status: "pending" as const,
            review_run: {
              generation,
              packet_id: packetId,
              head_sha: registration.authorityDigest,
              expected_agents: WAVE_REVIEW_AGENTS,
              prior_finding_ids: (task.findings ?? []).map(({ id }) => id),
              evidence: [],
              slot_authority: authorities.map((authority) => ({ agent: authority.role, slot_id: authority.slotId, attempted: 1 })) as never,
            },
          };
        }),
      }));
      const published = await publishInitialBatch(handle, batch.requests, batch.packets, "wave-gate-initial");
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
    const uncaptured = issued.value.filter((request) => !captured.value.has(captureKey(request.slotId, request.attempt)));
    if (uncaptured.length > 0) {
      return { ok: true, action: {
        kind: "spawn-batch", runId: handle.runId,
        requests: uncaptured.map((authority) => ({
          authority,
          context: { digest: authority.contextDigest, slot: { kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` } },
          task: `LOOM_REQUEST_ID: ${authority.requestId}\nLOOM_CONTEXT_DIGEST: ${authority.contextDigest}\nComplete the exact Wave review request.`,
        })),
      } };
    }

    const refreshed = manager.load();
    const current = deriveWaveReadiness(refreshed, waveGateDeps);
    if (!current.ok) return waveBlocked(handle, current.error.reasons.map(({ message }) => message).join("; "));
    if (current.value.facts.findingCounts.kind === "known" && current.value.facts.findingCounts.value.activeCritical > 0) {
      const preparation = waveRefutationPreparation(handle, current.value);
      const resolver = publicationResolver(handle);
      const requests = durableRefutationRequests(handle, preparation.inputs, resolver, "wave-refutation");
      if (requests === null) {
        const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "wave-refutation");
        return published.ok ? { ok: true, action: published.action } : failed(published.message);
      }
      const panelCaptured = handle.readCapturedAttempts();
      if (!panelCaptured.ok) return waveBlocked(handle, panelCaptured.error.message);
      const missing = requests.filter((request) => !panelCaptured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
      if (missing.length > 0) return { ok: true, action: { kind: "spawn-batch", runId: handle.runId, requests: missing } };
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      for (const request of requests) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return waveBlocked(handle, bytes.error.message);
        const submitted = submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), Buffer.from(bytes.value).toString("utf8"));
        if (!submitted.ok) return waveBlocked(handle, submitted.error.message);
        panelState = submitted.value.state;
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
    const decisions = await handle.readEvents();
    const advisoryDecision = decisions.some(({ event }) => typeof event === "object" && event !== null &&
      (event as Record<string, unknown>).kind === "user-decision-recorded");
    if (advisoryCount > 0 && !advisoryDecision) {
      return { ok: true, action: {
        kind: "await-user", runId: handle.runId,
        request: { kind: "advisory-triage", requestId: `wave-advisory:${handle.runId}`, advisoryCount },
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
    try {
      const raw = JSON.parse(checkpoint) as { state?: unknown };
      if (typeof raw === "object" && raw !== null && (raw.state as { state?: unknown } | undefined)?.state === "done") {
        return { ok: true, action: { kind: "done", runId: handle.runId, outcome: { kind: "verified-index-installed" } } };
      }
    } catch { return failed("remediation checkpoint is invalid JSON"); }
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
  const profile = resolveModelProfile("refutation");
  if (!profile.ok) throw new Error(profile.error.message);
  for (let index = 0; index < lenses.length; index += 1) {
    const lens = lenses[index]!;
    const hash = createHash("sha256").update(`${handle.runId}|${lens}|${brief.findings.map(({ id }) => id).join("|")}`).digest("hex");
    const slotId = parseSlotId(`refutation-slot:${hash.slice(0, 32)}`);
    if (!slotId.ok) throw new Error(slotId.error.message);
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = parseRequestId(`refutation-request:${hash.slice(0, 32)}:${attempt}`);
      if (!requestId.ok) throw new Error(requestId.error.message);
      const section = encodeByteSection("refutation-authority", JSON.stringify({
        runId: handle.runId, lens, findings: brief.findings, attempt,
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId: requestId.value,
        role: "review-verifier-agent",
        requiredSkill: "none",
        outputContract: `Adjudicate every Finding through lens '${lens}' and emit the exact refutation verdict JSON contract.`,
        fixedContext: Object.freeze([section.value]), variableContext: Object.freeze([]),
      });
      if (!packet.ok) throw new Error(packet.error.message);
      if (attempt === 1) packets.push(packet.value);
      const parsed = parseAgentRequestAuthority({
        runId: handle.runId, requestId: requestId.value, slotId: slotId.value,
        program: "refutation-panel", role: "review-verifier-agent", attempt,
        modelProfile: profile.value.id,
        harnessBinding: { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") },
        requiredSkill: null, contextDigest: packet.value.digest,
        outputSlot: `transcripts/${slotId.value}/attempt-${attempt}.raw`,
      });
      if (!parsed.ok) throw new Error(parsed.error.violations.map(({ message }) => message).join("; "));
      if (attempt === 1) inputs.push({ authority: parsed.value, context: {
        digest: packet.value.digest,
        slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.value.digest}.json` },
      } });
      return parsed.value;
    });
    slots.push({ slotId: slotId.value, attempts });
  }
  const panel = parseRefutationPanelAuthority({ runId: handle.runId, findings: brief.findings, lenses, verifierSlots: slots });
  if (!panel.ok) throw new Error(panel.error.message);
  const threshold = defaultRefutationThreshold(lenses.length);
  const frozen = freezeStandaloneRefutationPanelAuthority({ standaloneAuthority: authority, aggregate, panelAuthority: panel.value, threshold });
  if (!frozen.ok) throw new Error(frozen.error.message);
  return { brief, lenses, panel: panel.value, frozen: frozen.value, threshold, packets, inputs };
}

function durableRefutationRequests(
  handle: RunDirHandle,
  inputs: readonly InitialSpawnRequestInput[],
  resolver: PublicationAuthorityResolver,
  label = "standalone-refutation",
): readonly SpawnRequest[] | null {
  const effectId = parseEffectId(`effect:${label}:${createHash("sha256").update(inputs.map((input) =>
    (input.authority as AgentRequestAuthority).requestId).join("|")).digest("hex")}`);
  if (!effectId.ok) return null;
  try {
    const receipt = JSON.parse(readRunBytesNoFollow(`${handle.runDirectory}/artifacts/${publicationFile(effectId.value)}`).toString("utf8")) as { publicationDigest: string };
    return inputs.map((input, batchIndex) => {
      const parsed = parseIssuedSpawnRequest(resolver, {
        ...input,
        issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof", runId: handle.runId,
          effectId: effectId.value, publicationDigest: receipt.publicationDigest, batchIndex },
      });
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.value;
    });
  } catch { return null; }
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
  await handle.recordReceipt(receipt);
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
      const panelRequests = durableRefutationRequests(handle, preparation.inputs, resolver);
      if (panelRequests === null) {
        const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "standalone-refutation");
        return published.ok ? { ok: true, action: published.action } : failed(published.message);
      }
      const captured = handle.readCapturedAttempts();
      if (!captured.ok) return failed(captured.error.message);
      const missing = panelRequests.filter((request) => !captured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
      if (missing.length > 0) return { ok: true, action: { kind: "spawn-batch", runId: handle.runId, requests: missing } };
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      for (const request of panelRequests) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return failed(bytes.error.message);
        const submitted = submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), Buffer.from(bytes.value).toString("utf8"));
        if (!submitted.ok) return failed(submitted.error.message);
        panelState = submitted.value.state;
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
    const issued = durableRequests(handle, activeAuthority, resolver);
    if (issued === null) return failed("standalone publication authority could not be rehydrated");
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
          task: `LOOM_REQUEST_ID: ${request.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${request.context.digest}\nReview the immutable context packet and emit only the required reviewer result.`,
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
