import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { guardedDirs, subagentDir } from "../engine/src/config";
import type { WriteGrantScope } from "../engine/src/core/block-direct-edits";
import { nonEmpty } from "../engine/src/core/acceptance-contract/kernel";
import { canonicalWritePath } from "../engine/src/handlers/pre-tool-use/block-direct-edits";
import {
  parseAgentType,
  parseGrantedAgentId,
  parseSessionId,
  WRITE_GRANT_AGENT_NAMESPACE,
  type GrantedAgentId,
} from "../engine/src/machine/evidence";
import type { PiEvidenceLedgerAddress } from "../engine/src/machine/harness-tool-call-types";
import { extractTaskId } from "../engine/src/utils/extract-task-id";

const GRANT_VERSION = 1 as const;
/**
 * Maximum child-start window for a capability issued by a live parent
 * subagent call. Pi exposes no per-child timeout and a queued chain item may
 * start arbitrarily later than its siblings, so this is deliberately not an
 * estimate of execution stages. Normal lifetime is the parent call/session:
 * tool_result, rollback, and session_shutdown revoke every unconsumed token.
 * The fixed ceiling only bounds abandoned capabilities after a parent crash.
 */
export const PI_WRITE_GRANT_START_WINDOW_MS = 24 * 60 * 60_000;
const TOKEN = /^[0-9a-f]{64}$/;
const MARKER = /<!-- LOOM_PI_WRITE_GRANT:([0-9a-f]{64}) -->/g;
const grantDirectory = (): string => join(subagentDir(), "pi-write-grants");

interface StoredWriteGrant {
  readonly version: typeof GRANT_VERSION;
  readonly tokenSha256: string;
  readonly bindingMac: string;
  readonly agent: string;
  readonly taskId: string;
  readonly cwd: string;
  readonly taskGraphPath: string;
  readonly expiresAt: number;
  /** Optional artifact write scope for phase/panel agents: absolute dirs
   *  (trailing-slash normalized) the child may target with Edit/Write.
   *  Absent on implementation-item grants, which stay whole-session like
   *  the original model. Backward compatible: old records lack the key. */
  readonly scopeDirs?: readonly string[];
  /** The PARENT session ledger the child records its evidence into, and the
   *  agent type its epoch is stamped with (AD-8, FR-032). Minted by the parent
   *  at spawn and bound by the MAC. Absent on a record issued without one:
   *  that grant authorizes writes but no evidence. */
  readonly evidenceLedger?: Readonly<{ sessionId: string; agentType: string }>;
}

export interface IssuedWriteGrant {
  readonly token: string;
  readonly marker: string;
}

export interface ConsumedWriteGrant {
  readonly agent: string;
  readonly taskId: string;
  readonly taskGraphPath: string;
  /**
   * The capability identity, typed so it cannot be confused with a
   * harness-reported one. Produced only by `parseGrantedAgentId`, and only
   * after every check in `consumePiWriteGrant` has passed.
   */
  readonly agentId: GrantedAgentId;
  /** The spawn cwd the grant was resolved against: scoped-target checks must
   *  resolve relative targets against THIS base (the authorizing one), not
   *  whatever cwd the enforcement site happens to report. */
  readonly cwd: string;
  readonly scopeDirs?: readonly string[];
  /** Where this child records its ledger facts: the parent session and the
   *  agent type of its epoch. Null when the parent issued no address. */
  readonly evidenceLedger: PiEvidenceLedgerAddress | null;
}

const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");
const grantPath = (token: string): string => join(grantDirectory(), `${tokenDigest(token)}.json`);

function canonicalDirectory(path: string): string {
  return realpathSync(resolve(path));
}

function parseStoredGrant(raw: unknown): StoredWriteGrant | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const grant = raw as Record<string, unknown>;
  const scopeDirs = grant.scopeDirs;
  if (scopeDirs !== undefined &&
      (!Array.isArray(scopeDirs) ||
       scopeDirs.some((d) => typeof d !== "string" || d === ""))) {
    return null;
  }
  const ledger = grant.evidenceLedger;
  if (ledger !== undefined &&
      (typeof ledger !== "object" || ledger === null || Array.isArray(ledger) ||
       typeof (ledger as Record<string, unknown>).sessionId !== "string" ||
       typeof (ledger as Record<string, unknown>).agentType !== "string")) {
    return null;
  }
  return grant.version === GRANT_VERSION &&
    typeof grant.tokenSha256 === "string" && /^[0-9a-f]{64}$/.test(grant.tokenSha256) &&
    typeof grant.bindingMac === "string" && /^[0-9a-f]{64}$/.test(grant.bindingMac) &&
    typeof grant.agent === "string" && grant.agent.trim() !== "" &&
    typeof grant.taskId === "string" && grant.taskId.trim() !== "" &&
    typeof grant.cwd === "string" && grant.cwd !== "" &&
    typeof grant.taskGraphPath === "string" && grant.taskGraphPath !== "" &&
    typeof grant.expiresAt === "number" && Number.isFinite(grant.expiresAt)
    ? grant as unknown as StoredWriteGrant
    : null;
}

function bindingMac(token: string, grant: Omit<StoredWriteGrant, "bindingMac">): string {
  return createHmac("sha256", Buffer.from(token, "hex"))
    .update(JSON.stringify({
      version: grant.version,
      tokenSha256: grant.tokenSha256,
      agent: grant.agent,
      taskId: grant.taskId,
      cwd: grant.cwd,
      taskGraphPath: grant.taskGraphPath,
      expiresAt: grant.expiresAt,
      scopeDirs: grant.scopeDirs,
      evidenceLedger: grant.evidenceLedger,
    }))
    .digest("hex");
}

/** Phase-agent grants are bound to the agent identity + one-time token, not
 *  to a task-graph Task ID (phase prompts carry none). Task IDs are
 *  `T\d+`, so the `phase:` prefix cannot collide with a real binding. */
export const PHASE_GRANT_TASK_ID_PREFIX = "phase:" as const;

export const isPhaseGrantTaskId = (taskId: string): boolean =>
  taskId.startsWith(PHASE_GRANT_TASK_ID_PREFIX);

/** Normalize a scope dir to an absolute trailing-slash path so a prefix test
 *  cannot match a sibling (`…/specs-other/` vs `…/specs/`). */
function normalizeScopeDir(dir: string, cwd: string): string {
  const abs = resolve(cwd, dir);
  return abs.endsWith("/") ? abs : `${abs}/`;
}

/** Reject scope dirs that reach INTO or ENCOMPASS loom-guarded state: a
 *  phase-agent grant must never authorize a write to the task graph, ledger,
 *  machines, or subagent evidence — and a scope that CONTAINS a guarded dir
 *  (e.g. the repo root or `.claude/`) would authorize writes into it.
 *  Prompt-derived scopes only ever name `.claude/specs/…` / `.claude/plans/…`
 *  dirs, so this is defense-in-depth at the capability boundary. */
function scopeDirTouchesGuarded(dir: string): boolean {
  const normalized = dir.endsWith("/") ? dir : `${dir}/`;
  return guardedDirs().some((guarded) => {
    const guardedNorm = resolve(guarded);
    const g = guardedNorm.endsWith("/") ? guardedNorm : `${guardedNorm}/`;
    return normalized.startsWith(g) || g.startsWith(normalized);
  });
}

/** A scope dir that is the grant cwd itself or one of its parents is
 *  equivalent to no scope at all — reject it. */
function scopeIsCwdOrAncestor(dir: string, cwd: string): boolean {
  const resolvedCwd = canonicalDirectory(cwd);
  return resolvedCwd.startsWith(dir) || dir === `${resolvedCwd}/` ||
    resolve(dir) === resolvedCwd;
}

/**
 * The canonical write scope of a scoped grant: each dir normalized against
 * `cwd`, refused when it traverses upward, overlaps loom-guarded state or
 * covers the spawn cwd, and deduplicated after normalization. Undefined (a
 * whole-session capability) when no dirs are given.
 */
function acceptedScopeDirs(dirs: readonly string[] | undefined, cwd: string): readonly string[] | undefined {
  if (dirs === undefined || dirs.length === 0) return undefined;
  const seen = new Set<string>();
  const accepted: string[] = [];
  for (const dir of dirs) {
    if (typeof dir !== "string" || dir === "") throw new Error("Pi write grant scope dirs must be non-empty strings");
    // A `..` segment lets a prompt-derived scope resolve OUTSIDE its intended
    // `.claude/specs|plans` confinement into a non-guarded sibling that the
    // guarded/cwd overlap checks below would not catch. Legitimate artifact
    // scopes never traverse upward, so reject any `..` before resolution.
    if (dir.split(/[/\\]/).includes("..")) {
      throw new Error(`Pi write grant scope dir ${dir} contains a '..' traversal segment; refusing scoped grant`);
    }
    const normalized = normalizeScopeDir(dir, cwd);
    if (scopeDirTouchesGuarded(normalized)) {
      throw new Error(`Pi write grant scope dir ${normalized} overlaps loom-guarded state; refusing scoped grant`);
    }
    if (scopeIsCwdOrAncestor(normalized, cwd)) {
      throw new Error(`Pi write grant scope dir ${normalized} is the spawn cwd or an ancestor; refusing scoped grant`);
    }
    // Deduplicate after normalization so syntactically different inputs that
    // resolve to the same capability scope produce one canonical entry.
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    accepted.push(normalized);
  }
  return Object.freeze(accepted);
}

export function issuePiWriteGrant(input: {
  readonly agent: string;
  readonly taskId: string;
  readonly cwd: string;
  readonly taskGraphPath: string;
  readonly now?: number;
  /** Test seam and explicit bounded lifetime override. */
  readonly ttlMs?: number;
  /** Optional artifact write scope (relative paths resolve against `cwd`).
   *  Absent → whole-session capability (implementation items). */
  readonly scopeDirs?: readonly string[];
  /** The parent session ledger the child records into (AD-8). Its agent type
   *  must be the grant agent: one child process is one agent. */
  readonly evidenceLedger?: PiEvidenceLedgerAddress;
}): IssuedWriteGrant {
  if (input.evidenceLedger !== undefined && input.evidenceLedger.agentType !== input.agent) {
    throw new Error(
      `Pi write grant evidence ledger agent type ${input.evidenceLedger.agentType} does not match grant agent ${input.agent}`,
    );
  }
  const token = randomBytes(32).toString("hex");
  const ttlMs = input.ttlMs ?? PI_WRITE_GRANT_START_WINDOW_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Pi write grant TTL must be a positive integer");
  const scopeDirs = acceptedScopeDirs(input.scopeDirs, input.cwd);
  const unsigned: Omit<StoredWriteGrant, "bindingMac"> = {
    version: GRANT_VERSION,
    tokenSha256: tokenDigest(token),
    agent: input.agent,
    taskId: input.taskId,
    cwd: canonicalDirectory(input.cwd),
    taskGraphPath: resolve(input.taskGraphPath),
    expiresAt: (input.now ?? Date.now()) + ttlMs,
    scopeDirs,
    ...(input.evidenceLedger === undefined
      ? {}
      : { evidenceLedger: { sessionId: input.evidenceLedger.sessionId, agentType: input.evidenceLedger.agentType } }),
  };
  const grant: StoredWriteGrant = Object.freeze({
    ...unsigned,
    bindingMac: bindingMac(token, unsigned),
  });
  mkdirSync(grantDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(grantPath(token), JSON.stringify(grant), { encoding: "utf-8", mode: 0o600, flag: "wx" });
  return Object.freeze({ token, marker: `<!-- LOOM_PI_WRITE_GRANT:${token} -->` });
}

export function injectPiWriteGrant(task: string, grant: IssuedWriteGrant): string {
  MARKER.lastIndex = 0;
  if (MARKER.test(task)) throw new Error("task already contains a Loom Pi write-grant marker");
  return `${task.trimEnd()}\n\n${grant.marker}`;
}

export function revokePiWriteGrant(token: string): void {
  if (!TOKEN.test(token)) return;
  rmSync(grantPath(token), { force: true });
}

export function consumePiWriteGrant(
  prompt: string,
  cwd: string,
  expectedAgent: string,
  now: number = Date.now(),
): ConsumedWriteGrant | null {
  MARKER.lastIndex = 0;
  const matches = [...prompt.matchAll(MARKER)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("prompt contains multiple Loom Pi write-grant markers");
  const token = matches[0]![1]!;
  const path = grantPath(token);
  const claimedPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.claim`;
  // rename(2) is the one-time-capability linearization point: only one child
  // can move the token's record away from its well-known digest path.
  renameSync(path, claimedPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(claimedPath, "utf-8"));
  } finally {
    // Every claimed attempt burns the grant, including malformed or
    // context-mismatched records.
    rmSync(claimedPath, { force: true });
  }
  const grant = parseStoredGrant(raw);
  if (!grant) throw new Error("write grant is malformed");
  if (grant.tokenSha256 !== tokenDigest(token)) throw new Error("write grant token digest mismatch");
  const expectedMac = bindingMac(token, grant);
  if (!timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(grant.bindingMac, "hex"))) {
    throw new Error("write grant binding integrity mismatch");
  }
  if (grant.expiresAt < now) throw new Error("write grant expired");
  if (grant.agent !== expectedAgent) throw new Error("write grant agent does not match child agent identity");
  // Phase grants bind to the agent identity + cwd + one-time token, not to a
  // task-graph Task ID (phase prompts carry none). Everything else must match
  // the exact Task ID extracted from the child prompt.
  if (!isPhaseGrantTaskId(grant.taskId) && extractTaskId(prompt) !== grant.taskId) {
    throw new Error("write grant Task ID does not match child prompt");
  }
  if (canonicalDirectory(cwd) !== grant.cwd) throw new Error("write grant cwd does not match child process cwd");
  if (!existsSync(grant.taskGraphPath)) throw new Error("write grant task graph no longer exists");
  // Mint through the capability constructor rather than string concatenation:
  // this is the ONE producer the write gate accepts, so the id it hands back
  // must be proven to be in the reserved namespace and binding-safe, not merely
  // spelled that way.
  const agentId = piGrantedAgentId(token);
  if (agentId === null) throw new Error("write grant minted an invalid capability identity");
  return Object.freeze({
    agent: grant.agent,
    taskId: grant.taskId,
    taskGraphPath: grant.taskGraphPath,
    agentId,
    cwd: grant.cwd,
    scopeDirs: grant.scopeDirs,
    evidenceLedger: consumedEvidenceLedger(grant),
  });
}

/**
 * The capability identity a grant token mints: `pi-grant-` plus the token's
 * first 16 hex digits. The ONE derivation, shared by consumption (the id the
 * child binds) and the parent's read-back of that child's epoch
 * (`piChildEvidence`). Null for anything but a 64-hex token.
 */
export function piGrantedAgentId(token: string): GrantedAgentId | null {
  return TOKEN.test(token) ? parseGrantedAgentId(`${WRITE_GRANT_AGENT_NAMESPACE}${token.slice(0, 16)}`) : null;
}

/** Parse the stored ledger address into branded ids, re-checking that it
 *  names the grant agent. A MAC-verified record fails this only if its issuer
 *  wrote an inconsistent address, so the grant is refused. */
function consumedEvidenceLedger(grant: StoredWriteGrant): PiEvidenceLedgerAddress | null {
  if (grant.evidenceLedger === undefined) return null;
  const sessionId = parseSessionId(grant.evidenceLedger.sessionId);
  const agentType = parseAgentType(grant.evidenceLedger.agentType);
  if (sessionId === null || agentType === null || agentType !== grant.agent) {
    throw new Error("write grant evidence ledger address is invalid");
  }
  return Object.freeze({ sessionId, agentType });
}

/**
 * The core `WriteGrantScope` of a scoped (phase-agent) grant, for the
 * direct-edit guard's confinement: each scope dir canonicalised through its
 * nearest existing ancestor — the same canonicalisation the guard applies to
 * write targets, so a symlinked scope dir is compared by its real location.
 *
 * Targets are resolved once, against the tool's cwd, for placement and
 * confinement alike. The grant was authorized against `grantCwd`, so the two
 * must be the same directory (consumption already proved it). A grant that
 * recorded no authorizing cwd, a mismatch, or any uncanonicalisable dir
 * answers `unresolved` and the guard refuses every write inside its area.
 * `undefined` for a whole-session (unscoped) grant.
 */
export function grantWriteScope(
  scopeDirs: readonly string[] | undefined,
  grantCwd: string | undefined,
  toolCwd: string,
): WriteGrantScope | undefined {
  const declared = scopeDirs === undefined ? null : nonEmpty(scopeDirs);
  if (declared === null) return undefined;
  const canonicalToolCwd = canonicalWritePath(resolve(toolCwd));
  if (grantCwd === undefined || canonicalToolCwd !== grantCwd) {
    return Object.freeze({
      kind: "unresolved",
      reason: grantCwd === undefined
        ? "the grant recorded no authorizing cwd"
        : `the tool cwd ${toolCwd} is not the grant's authorizing cwd ${grantCwd}`,
    });
  }
  const [first, ...rest] = declared;
  const canonicalFirst = canonicalWritePath(resolve(toolCwd, first));
  if (canonicalFirst === null) return unresolvableScopeDir(first);
  const dirs: [string, ...string[]] = [canonicalFirst];
  for (const dir of rest) {
    const canonical = canonicalWritePath(resolve(toolCwd, dir));
    if (canonical === null) return unresolvableScopeDir(dir);
    dirs.push(canonical);
  }
  return Object.freeze({ kind: "resolved", dirs });
}

function unresolvableScopeDir(dir: string): WriteGrantScope {
  return Object.freeze({ kind: "unresolved", reason: `cannot canonicalize scope dir ${dir}` });
}

export function sweepExpiredPiWriteGrants(now: number = Date.now()): void {
  const directory = grantDirectory();
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".claim"))) continue;
    const path = join(directory, entry.name);
    try {
      const grant = parseStoredGrant(JSON.parse(readFileSync(path, "utf-8")));
      if (!grant) {
        process.stderr.write(`loom(pi): removing malformed write grant ${path}: stored grant schema is invalid\n`);
        unlinkSync(path);
      } else if (grant.expiresAt < now) {
        unlinkSync(path);
      }
    } catch (error) {
      const classification = error instanceof SyntaxError ? "malformed" : "unreadable";
      process.stderr.write(
        `loom(pi): removing ${classification} write grant ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      rmSync(path, { force: true });
    }
  }
}
