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
import { parseRunDirectoryReference, type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { isExcludedRemediationPath, parseCanonicalRepositoryRelativePath } from '../../../core/remediation-machine';
import type { PersistentRefutationPanelEvent } from '../../../core/panel-program';

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

/**
 * The module's shared Either shape for parse/lookup boundaries — the same role
 * PolicyResult/ParseResult play in the core modules. Success carries the
 * parsed value; failure carries the exact operator-facing message.
 */
export type ProgramParse<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

export const failed = (message: string): FacadeDriveResult => ({ ok: false, message });

export function exactObject(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
    Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));
}

export function parseStandaloneStartInput(raw: unknown): ProgramParse<RegisteredStandaloneProgram["input"]> {
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
  /** Tracked files whose worktree content differs from HEAD, plus untracked non-ignored files. */
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
 * Fail CLOSED on a path this repository's own parser cannot canonicalize: a
 * path we cannot name is a path we cannot prove is not run evidence, and
 * admitting it would put a Run Directory's own transcripts into the frozen
 * review scope. Exclusion is the safe answer; the reviewed set only shrinks.
 */
export function reviewablePath(path: string): boolean {
  const parsed = parseCanonicalRepositoryRelativePath(path, "standalone review scope path");
  return parsed.ok && !isExcludedRemediationPath(parsed.value);
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
  const stagedAdded = gitPaths(["diff", "--cached", "--name-only", "--diff-filter=A", "-z", "--"]).filter(reviewablePath);
  const committedAdded = base === null
    ? []
    : gitPaths(["diff", "--name-only", "--diff-filter=A", "-z", `${base}...HEAD`, "--"]).filter(reviewablePath);
  return Object.freeze({
    authority: Object.freeze({
      unstaged: Object.freeze([...new Set([...trackedUnstaged, ...untracked])].sort()),
      staged: gitPaths(["diff", "--cached", "--name-only", "-z", "--"]).filter(reviewablePath),
      committed: base === null ? Object.freeze([]) : gitPaths(["diff", "--name-only", "-z", `${base}...HEAD`, "--"]).filter(reviewablePath),
      base_revision: base,
      head_revision: head,
    }),
    untracked,
    created: Object.freeze(new Set([...untracked, ...stagedAdded, ...committedAdded])),
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
  if (result.error) throw new Error(`git diff could not be spawned: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr ?? "").trim() || "git diff --numstat failed");
  return parseNumstatAdditions(result.stdout ?? "");
}

export function untrackedAdditions(paths: readonly string[]): number {
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
  // `docs_only` MEANS "no source or test file changed", and the load boundary
  // (core/standalone-review) refuses any record where both are true. Matching
  // the documentation shape alone did not carry that meaning: `docs/tests/x.md`
  // satisfies the docs pattern AND the test-path pattern, so this producer
  // could emit a record its own validator would reject. The exclusion is part
  // of the definition, not a check layered on top of it.
  const docsOnly = !sourceOrTestChanged
    && scope.every((path) => /(^|\/)(docs?|README)(\/|\.|$)|\.(md|mdx|txt)$/.test(path));
  return Object.freeze({
    requestedKinds: Object.freeze([kind]) as readonly [StandaloneReviewKind],
    docsOnly,
    sourceOrTestChanged,
    typesChanged: scope.some((_, index) => TYPE_EXTENSIONS.has(extensions[index]!)),
    commentsChanged: docsOnly || scope.some((path) => /\.(md|mdx)$/.test(path)),
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
  authority: Pick<AgentRequestAuthority, "requestId" | "contextDigest" | "requiredSkill">,
  instruction: string,
  options: { standalone?: boolean } = {},
): string {
  return (options.standalone === true ? "LOOM_REVIEW_CONTEXT: standalone\n" : "") +
    `LOOM_REQUEST_ID: ${authority.requestId}\n` +
    `LOOM_CONTEXT_DIGEST: ${authority.contextDigest}\n` +
    `LOOM_CONTEXT_PATH: ${join(handle.runDirectory, "contexts", `${authority.contextDigest}.json`)}\n` +
    requiredSkillMarker(authority.requiredSkill) +
    instruction;
}

export function parseRegistration(raw: unknown): ProgramParse<RegisteredStandaloneProgram> {
  if (!exactObject(raw, ["schemaVersion", "kind", "input", "authority"]) || raw.schemaVersion !== 1) {
    return { ok: false, message: "standalone-review registration must contain exactly schemaVersion 1, kind, input, and authority" };
  }
  const input = parseStandaloneStartInput(raw.input);
  return input.ok
    ? { ok: true, value: Object.freeze({ schemaVersion: 1, kind: "standalone-review", input: input.value, authority: raw.authority }) }
    : input;
}

export function parseWaveGateStartInput(raw: unknown): ProgramParse<RegisteredWaveGateProgram["input"]> {
  if (!exactObject(raw, ["wave"]) || (raw.wave !== null &&
      (typeof raw.wave !== "number" || !Number.isSafeInteger(raw.wave) || raw.wave < 1))) {
    return { ok: false, message: "wave-gate input must contain exactly wave (null or a positive integer)" };
  }
  return { ok: true, value: Object.freeze({ wave: raw.wave as number | null }) };
}

export function parseRemediationStartInput(raw: unknown): ProgramParse<RegisteredRemediationProgram["input"]> {
  if (!exactObject(raw, ["sourceRunsRoot", "sourceRun", "supportPaths"]) ||
      typeof raw.sourceRunsRoot !== "string" || raw.sourceRunsRoot.length === 0 ||
      typeof raw.sourceRun !== "string" || raw.sourceRun.length === 0 ||
      !Array.isArray(raw.supportPaths) || raw.supportPaths.some((path) => typeof path !== "string" || path.length === 0)) {
    return { ok: false, message: "remediation input must contain sourceRunsRoot, sourceRun, and supportPaths" };
  }
  // The source pair names a real Run Directory relation, so hold it to that
  // relation HERE rather than at drive time. Shape-only validation deferred the
  // check until after the new remediation run had been claimed, which turned a
  // one-character payload mistake into a directory the operator had to delete
  // by hand. The strings are stored exactly as authored — resolution belongs to
  // the drive, so a registration stays portable and re-readable.
  const source = parseRunDirectoryReference(raw.sourceRunsRoot, raw.sourceRun);
  if (!source.ok) return { ok: false, message: `remediation input sourceRun: ${source.error.message}` };
  return { ok: true, value: Object.freeze({
    sourceRunsRoot: raw.sourceRunsRoot,
    sourceRun: raw.sourceRun,
    supportPaths: Object.freeze([...(raw.supportPaths as string[])]),
  }) };
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
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Readonly<Record<string, unknown>>
    : null;
  const kind = record?.kind;
  if (kind !== "standalone-review" && kind !== "remediation" && kind !== "wave-gate") {
    return Object.freeze({ kind: "unclaimed" });
  }

  if (kind === "standalone-review") {
    const standalone = parseRegistration(raw);
    return standalone.ok ? registeredProgram(standalone.value) : invalidRegistration(standalone.message);
  }

  if (kind === "remediation") {
    if (!exactObject(raw, ["schemaVersion", "kind", "input"]) || raw.schemaVersion !== 1) {
      return invalidRegistration("remediation registration must contain exactly schemaVersion 1, kind, and input");
    }
    const input = parseRemediationStartInput(raw.input);
    return input.ok
      ? registeredProgram(Object.freeze({ schemaVersion: 1, kind: "remediation", input: input.value }))
      : invalidRegistration(input.message);
  }

  const waveBaseKeys = ["schemaVersion", "kind", "input", "taskIds", "authorityDigest"] as const;
  const waveKeys = Object.hasOwn(raw as object, "restart")
    ? [...waveBaseKeys, "restart"]
    : Object.hasOwn(raw as object, "orphanRecovery")
      ? [...waveBaseKeys, "orphanRecovery"]
      : [...waveBaseKeys];
  if (!exactObject(raw, waveKeys) || raw.schemaVersion !== 1) {
    return invalidRegistration(`wave-gate registration must contain exactly schemaVersion 1, ${waveKeys.slice(1).join(", ")}`);
  }
  if (!Array.isArray(raw.taskIds) || raw.taskIds.some((id) => typeof id !== "string")) {
    return invalidRegistration("wave-gate registration taskIds must be a string array");
  }
  if (typeof raw.authorityDigest !== "string") {
    return invalidRegistration("wave-gate registration authorityDigest must be a string");
  }
  let restart: WaveGateRestartAudit | undefined;
  if (Object.hasOwn(raw, "restart")) {
    if (!exactObject(raw.restart, ["previousRunId", "exhaustedSlots"]) ||
        typeof raw.restart.previousRunId !== "string" || !Array.isArray(raw.restart.exhaustedSlots) ||
        raw.restart.exhaustedSlots.length === 0 || raw.restart.exhaustedSlots.some((slot) => typeof slot !== "string" || slot.length === 0)) {
      return invalidRegistration("wave-gate registration restart audit must contain previousRunId and non-empty exhaustedSlots");
    }
    restart = Object.freeze({
      previousRunId: raw.restart.previousRunId,
      exhaustedSlots: Object.freeze([...(raw.restart.exhaustedSlots as string[])]),
    });
  }
  let orphanRecovery: OrphanedWaveGateRecoveryAudit | undefined;
  if (Object.hasOwn(raw, "orphanRecovery")) {
    if (!exactObject(raw.orphanRecovery, ["previousRunId", "previousAuthorityDigest"]) ||
        typeof raw.orphanRecovery.previousRunId !== "string" ||
        typeof raw.orphanRecovery.previousAuthorityDigest !== "string") {
      return invalidRegistration("wave-gate registration orphanRecovery audit must contain previousRunId and previousAuthorityDigest");
    }
    orphanRecovery = Object.freeze({
      previousRunId: raw.orphanRecovery.previousRunId,
      previousAuthorityDigest: raw.orphanRecovery.previousAuthorityDigest,
    });
  }
  const input = parseWaveGateStartInput(raw.input);
  return input.ok
    ? registeredProgram(Object.freeze({
        schemaVersion: 1, kind: "wave-gate", input: input.value,
        taskIds: Object.freeze([...(raw.taskIds as string[])]), authorityDigest: raw.authorityDigest,
        ...(restart === undefined ? {} : { restart }),
        ...(orphanRecovery === undefined ? {} : { orphanRecovery }),
      }))
    : invalidRegistration(input.message);
}

export function parsedAuthority(registration: RegisteredStandaloneProgram): ProgramParse<FrozenStandaloneReviewAuthority> {
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

export async function recoverOrPublishRefutationRetry(
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

