/**
 * Façade program driver volume (A14): the imperative shell's program drivers
 * were one 2,900-line module; this volume owns ONE program's driver (or, for
 * helpers, the shared recovery/git/scope machinery). The public surface is
 * re-exported by index.ts so all existing import sites are unchanged.
 */
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAtomicInitialPublicationClaimPort, createInitialBatchPublicationReconciler, createInitialPublicationEffectPort, createPublicationAuthorityResolver, parseBatchPublishedReceipt, parseEffectId, parseIssuedSpawnRequest, prepareInitialBatchPublicationIntent, spawnBatchAction, AGENT_REQUIRED_SKILLS, type AgentRequestAuthority, type EffectId, type InitialSpawnRequestInput, type PublicationAuthorityResolver, type SpawnRequest } from '../../../core/orchestration-contract';
import { parseStandaloneReviewAuthority, selectStandaloneReviewers, type FrozenStandaloneReviewAuthority, type StandaloneReviewKind, type StandaloneReviewMetadata } from '../../../core/standalone-review';
import { buildContextPacket, encodeByteSection, type ContextPacket } from '../../../orchestration/context-packets';
import { readRunBytesNoFollow } from '../../../orchestration/no-follow-fs';
import { type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { isExcludedRemediationPath, parseCanonicalRepositoryRelativePath } from '../../../core/remediation-machine';

export type RegisteredStandaloneProgram = Readonly<{
  schemaVersion: 1;
  kind: "standalone-review";
  input: Readonly<{ kind: StandaloneReviewKind; files: readonly string[] | null; dryRun: boolean }>;
  authority: unknown;
}>;

export type WaveGateRestartAudit = Readonly<{
  previousRunId: string;
  exhaustedSlots: readonly string[];
}>;

export type OrphanedWaveGateRecoveryAudit = Readonly<{
  previousRunId: string;
  previousAuthorityDigest: string;
}>;

export type RegisteredWaveGateProgram = Readonly<{
  schemaVersion: 1;
  kind: "wave-gate";
  input: Readonly<{ wave: number | null }>;
  taskIds: readonly string[];
  authorityDigest: string;
  restart?: WaveGateRestartAudit;
  orphanRecovery?: OrphanedWaveGateRecoveryAudit;
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

export const failed = (message: string): FacadeDriveResult => ({ ok: false, message });

export function exactObject(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
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

export function gitPaths(args: readonly string[]): readonly string[] {
  const result = spawnSync("git", args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr ?? Buffer.alloc(0)).toString("utf8").trim() || `git ${args[0]} failed`);
  return Object.freeze((result.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0").filter(Boolean).sort());
}

export function gitText(args: readonly string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || `git ${args[0]} failed`);
  return (result.stdout ?? "").trim();
}

export type CanonicalChangedPaths = Readonly<{
  /** Worktree paths not represented by HEAD, including untracked non-ignored files. */
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
}>;

export function reviewablePath(path: string): boolean {
  const parsed = parseCanonicalRepositoryRelativePath(path, "standalone review scope path");
  return !parsed.ok || !isExcludedRemediationPath(parsed.value);
}

export function deriveChangedPaths(): DerivedChangedPaths {
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

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".java", ".rs", ".py", ".go", ".c", ".cpp"]);
export const TYPE_EXTENSIONS = new Set([".ts", ".tsx", ".d.ts", ".java", ".rs"]);

export function parseNumstatAdditions(output: string): number {
  return output.split("\n").reduce((sum, line) => {
    const additions = Number.parseInt(line.split("\t", 1)[0] ?? "", 10);
    return sum + (Number.isFinite(additions) ? additions : 0);
  }, 0);
}

export function trackedAdditions(baseline: string, paths: readonly string[]): number {
  if (paths.length === 0) return 0;
  const result = spawnSync("git", ["diff", "--numstat", baseline, "--", ...paths], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || "git diff --numstat failed");
  return parseNumstatAdditions(result.stdout ?? "");
}

export function untrackedAdditions(paths: readonly string[]): number {
  return paths.reduce((sum, path) => {
    const result = spawnSync("git", ["diff", "--no-index", "--numstat", "--", devNull, path], { encoding: "utf8" });
    const diagnostic = (result.stderr ?? "").trim();
    if ((result.status !== 0 && result.status !== 1) || diagnostic !== "") {
      throw new Error(diagnostic || `cannot measure untracked additions for ${path}`);
    }
    return sum + parseNumstatAdditions(result.stdout ?? "");
  }, 0);
}

export function metadata(
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

export function frozenScopeSection(scope: readonly string[]) {
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

export function standalonePackets(
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

export function publicationFile(effectId: string): string {
  return `publications/${createHash("sha256").update(effectId).digest("hex")}.json`;
}

export function publicationResolver(handle: RunDirHandle): PublicationAuthorityResolver {
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

export async function publishInitialBatch(
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
      task: `${standaloneMarker}LOOM_REQUEST_ID: ${request.authority.requestId}\nLOOM_CONTEXT_DIGEST: ${request.context.digest}\n${contextPacketPathMarker(handle, request.context.digest)}Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.`,
    }))),
  }) };
}

/**
 * The deterministic per-task resolver for the frozen ContextPacket: the exact
 * absolute path to the immutable `contexts/<digest>.json` artifact, delivered
 * to the child as a LOOM_CONTEXT_PATH marker. A spawned reviewer must be able
 * to read the packet it is instructed to review without inferring run-directory
 * layout out of band.
 */
export function contextPacketPathMarker(handle: RunDirHandle, digest: string): string {
  return `LOOM_CONTEXT_PATH: ${join(handle.runDirectory, "contexts", `${digest}.json`)}\n`;
}

export function parseRegistration(raw: unknown): RegisteredStandaloneProgram | null {
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
  const waveKeys = Object.hasOwn(raw as object, "restart")
    ? ["schemaVersion", "kind", "input", "taskIds", "authorityDigest", "restart"]
    : Object.hasOwn(raw as object, "orphanRecovery")
      ? ["schemaVersion", "kind", "input", "taskIds", "authorityDigest", "orphanRecovery"]
      : ["schemaVersion", "kind", "input", "taskIds", "authorityDigest"];
  if (!exactObject(raw, waveKeys) || raw.schemaVersion !== 1 || raw.kind !== "wave-gate" || !Array.isArray(raw.taskIds) ||
      raw.taskIds.some((id) => typeof id !== "string") || typeof raw.authorityDigest !== "string") return null;
  let restart: WaveGateRestartAudit | undefined;
  if (Object.hasOwn(raw, "restart")) {
    if (!exactObject(raw.restart, ["previousRunId", "exhaustedSlots"]) ||
        typeof raw.restart.previousRunId !== "string" || !Array.isArray(raw.restart.exhaustedSlots) ||
        raw.restart.exhaustedSlots.length === 0 || raw.restart.exhaustedSlots.some((slot) => typeof slot !== "string" || slot.length === 0)) return null;
    restart = Object.freeze({
      previousRunId: raw.restart.previousRunId,
      exhaustedSlots: Object.freeze([...(raw.restart.exhaustedSlots as string[])]),
    });
  }
  let orphanRecovery: OrphanedWaveGateRecoveryAudit | undefined;
  if (Object.hasOwn(raw, "orphanRecovery")) {
    if (!exactObject(raw.orphanRecovery, ["previousRunId", "previousAuthorityDigest"]) ||
        typeof raw.orphanRecovery.previousRunId !== "string" ||
        typeof raw.orphanRecovery.previousAuthorityDigest !== "string") return null;
    orphanRecovery = Object.freeze({
      previousRunId: raw.orphanRecovery.previousRunId,
      previousAuthorityDigest: raw.orphanRecovery.previousAuthorityDigest,
    });
  }
  const input = parseWaveGateStartInput(raw.input);
  return input.ok ? Object.freeze({
    schemaVersion: 1, kind: "wave-gate", input: input.value,
    taskIds: Object.freeze([...(raw.taskIds as string[])]), authorityDigest: raw.authorityDigest,
    ...(restart === undefined ? {} : { restart }),
    ...(orphanRecovery === undefined ? {} : { orphanRecovery }),
  }) : null;
}

export function parsedAuthority(registration: RegisteredStandaloneProgram): Readonly<{ ok: true; value: FrozenStandaloneReviewAuthority }> | Readonly<{ ok: false; message: string }> {
  const result = parseStandaloneReviewAuthority(registration.authority);
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.errors.join("; ") };
}

export function standalonePublicationEffectId(authority: FrozenStandaloneReviewAuthority) {
  return parseEffectId(`effect:standalone-review:${createHash("sha256").update(authority.roster.orderedSlots.map((entry) =>
    entry.attempts[0].requestId).join("|")).digest("hex")}`);
}

export type DurableRequestRecovery =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "found"; requests: readonly SpawnRequest[] }>
  | Readonly<{ kind: "corrupt"; message: string }>;

export function durablePublicationDigest(
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
export function standaloneRetryEffectId(slotId: string, requestId: string): Readonly<{ ok: true; value: EffectId }> | Readonly<{ ok: false; message: string }> {
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
    const rebuilt = buildContextPacket({
      requestId: retryAuthority.requestId as never,
      role: retryAuthority.role,
      requiredSkill: attemptOne.value.requiredSkill,
      outputContract: attemptOne.value.outputContract,
      fixedContext: Object.freeze([authoritySection.value, frozenSource]),
      variableContext: Object.freeze([]),
    });
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
export function refutationRetryTask(task: string, diagnostic: string | null): string {
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
export function standaloneRetryTask(task: string, diagnostic: string | null): string {
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

/**
 * Fatal UTF-8 decode like the engine's transcript boundary. A decode failure
 * is a TYPED failure naming the decoder's cause — never prose fed through the
 * semantic validator, which would launder "transcript bytes were not valid
 * UTF-8" into a misleading "CRITICAL_COUNT marker not found" diagnostic. The
 * caller routes the failure to the slot directly.
 */
export function decodeReviewerTranscript(
  bytes: Uint8Array,
  role: string,
): Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; message: string }> {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch (error) {
    return { ok: false, message: `${role}: transcript is not valid UTF-8 (${error instanceof Error ? error.message : String(error)})` };
  }
}

