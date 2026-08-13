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
import { basename, dirname, join, resolve } from "node:path";
import { guardedDirs, subagentDir } from "../engine/src/config";
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
}

export interface IssuedWriteGrant {
  readonly token: string;
  readonly marker: string;
}

export interface ConsumedWriteGrant {
  readonly agent: string;
  readonly taskId: string;
  readonly taskGraphPath: string;
  readonly agentId: string;
  /** The spawn cwd the grant was resolved against: scoped-target checks must
   *  resolve relative targets against THIS base (the authorizing one), not
   *  whatever cwd the enforcement site happens to report. */
  readonly cwd: string;
  readonly scopeDirs?: readonly string[];
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
}): IssuedWriteGrant {
  const token = randomBytes(32).toString("hex");
  const ttlMs = input.ttlMs ?? PI_WRITE_GRANT_START_WINDOW_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Pi write grant TTL must be a positive integer");
  let scopeDirs: readonly string[] | undefined;
  if (input.scopeDirs !== undefined && input.scopeDirs.length > 0) {
    const seen = new Set<string>();
    scopeDirs = Object.freeze(input.scopeDirs.map((dir) => {
      if (typeof dir !== "string" || dir === "") throw new Error("Pi write grant scope dirs must be non-empty strings");
      const normalized = normalizeScopeDir(dir, input.cwd);
      if (scopeDirTouchesGuarded(normalized)) {
        throw new Error(`Pi write grant scope dir ${normalized} overlaps loom-guarded state; refusing scoped grant`);
      }
      if (scopeIsCwdOrAncestor(normalized, input.cwd)) {
        throw new Error(`Pi write grant scope dir ${normalized} is the spawn cwd or an ancestor; refusing scoped grant`);
      }
      if (seen.has(normalized)) return normalized;
      seen.add(normalized);
      return normalized;
    }));
  }
  const unsigned: Omit<StoredWriteGrant, "bindingMac"> = {
    version: GRANT_VERSION,
    tokenSha256: tokenDigest(token),
    agent: input.agent,
    taskId: input.taskId,
    cwd: canonicalDirectory(input.cwd),
    taskGraphPath: resolve(input.taskGraphPath),
    expiresAt: (input.now ?? Date.now()) + ttlMs,
    scopeDirs,
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
  return Object.freeze({
    agent: grant.agent,
    taskId: grant.taskId,
    taskGraphPath: grant.taskGraphPath,
    agentId: `pi-grant-${token.slice(0, 16)}`,
    cwd: grant.cwd,
    scopeDirs: grant.scopeDirs,
  });
}

/** Resolve a path and canonicalize it THROUGH symlinks: realpath the deepest
 *  EXISTING ancestor (the target itself may not exist yet — it is about to
 *  be written), then re-append the missing tail. A symlinked directory
 *  inside a scope dir can no longer resolve to a path outside it. */
function canonicalTarget(path: string): string {
  const abs = resolve(path);
  let existing = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...tail.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return abs;
      tail.push(basename(existing));
      existing = parent;
    }
  }
}

/** Pure scope enforcement for a scoped (phase-agent) write grant: is the
 *  absolute target path inside at least one scope dir? Returns a description
 *  of the violation (for the block reason) or null when the write may
 *  proceed. Both sides are canonicalized through symlinks; prefix matching
 *  is on trailing-slash dirs, so `…/specs/` never admits `…/specs-other/x`
 *  or `…/specs2/x`. */
export function writeTargetViolatesScope(
  targetPath: string,
  scopeDirs: readonly string[],
  baseCwd: string = process.cwd(),
): string | null {
  const target = canonicalTarget(resolve(baseCwd, targetPath));
  for (const dir of scopeDirs) {
    const dirNorm = canonicalTarget(dir);
    if (target.startsWith(dirNorm.endsWith("/") ? dirNorm : `${dirNorm}/`)) return null;
  }
  return `write target ${target} is outside the granted artifact scope`;
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
