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
import { SUBAGENT_DIR } from "../engine/src/config";
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
const grantDirectory = (): string => join(process.env.LOOM_SUBAGENT_DIR ?? SUBAGENT_DIR, "pi-write-grants");

interface StoredWriteGrant {
  readonly version: typeof GRANT_VERSION;
  readonly tokenSha256: string;
  readonly bindingMac: string;
  readonly agent: string;
  readonly taskId: string;
  readonly cwd: string;
  readonly taskGraphPath: string;
  readonly expiresAt: number;
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
}

const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");
const grantPath = (token: string): string => join(grantDirectory(), `${tokenDigest(token)}.json`);

function canonicalDirectory(path: string): string {
  return realpathSync(resolve(path));
}

function parseStoredGrant(raw: unknown): StoredWriteGrant | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const grant = raw as Record<string, unknown>;
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
    }))
    .digest("hex");
}

export function issuePiWriteGrant(input: {
  readonly agent: string;
  readonly taskId: string;
  readonly cwd: string;
  readonly taskGraphPath: string;
  readonly now?: number;
  /** Test seam and explicit bounded lifetime override. */
  readonly ttlMs?: number;
}): IssuedWriteGrant {
  const token = randomBytes(32).toString("hex");
  const ttlMs = input.ttlMs ?? PI_WRITE_GRANT_START_WINDOW_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Pi write grant TTL must be a positive integer");
  const unsigned: Omit<StoredWriteGrant, "bindingMac"> = {
    version: GRANT_VERSION,
    tokenSha256: tokenDigest(token),
    agent: input.agent,
    taskId: input.taskId,
    cwd: canonicalDirectory(input.cwd),
    taskGraphPath: resolve(input.taskGraphPath),
    expiresAt: (input.now ?? Date.now()) + ttlMs,
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
  if (extractTaskId(prompt) !== grant.taskId) throw new Error("write grant Task ID does not match child prompt");
  if (canonicalDirectory(cwd) !== grant.cwd) throw new Error("write grant cwd does not match child process cwd");
  if (!existsSync(grant.taskGraphPath)) throw new Error("write grant task graph no longer exists");
  return Object.freeze({
    agent: grant.agent,
    taskId: grant.taskId,
    taskGraphPath: grant.taskGraphPath,
    agentId: `pi-grant-${token.slice(0, 16)}`,
  });
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
