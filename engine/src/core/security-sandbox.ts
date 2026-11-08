/**
 * The sandbox contract: limits, the command that runs a bounded check, and the
 * receipt that turns "I reproduced it locally" into a recorded fact.
 *
 * `scripts/security-sandbox.sh` is the only executor. This volume owns the
 * grammar around it — the limits an operator may set, the argv a hunter is told
 * to run, and the receipt parser. Nothing here executes anything, and nothing
 * here trusts a hunter-supplied limit: the receipt comes from the script's own
 * stdout, so an agent that claims `--mem-mb 8192` still records what the script
 * enforced — and what it FAILED to enforce, because a refused `ulimit` is
 * reported as unenforced rather than as applied.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { SECURITY_AUDIT_LIMITS, isSafeSourcePath, isVisibleText } from "./security-audit-contract";

/** The exact environment names a sandboxed child receives. Everything else is
 *  dropped, so an ambient credential cannot ride along. */
export const SANDBOX_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"] as const;

export const SANDBOX_LIMIT_CEILINGS = Object.freeze({
  cpuSeconds: 3_600,
  addressSpaceMb: 65_536,
  processes: 4_096,
  fileSizeMb: 4_096,
  wallClockSeconds: 7_200,
  scratchMb: 4_096,
});

export const DEFAULT_SANDBOX_LIMITS = Object.freeze({
  cpuSeconds: 10,
  addressSpaceMb: 1_024,
  processes: 128,
  fileSizeMb: 32,
  wallClockSeconds: 60,
  scratchMb: 64,
});

export type SandboxLimits = Readonly<{
  cpuSeconds: number;
  addressSpaceMb: number;
  processes: number;
  fileSizeMb: number;
  wallClockSeconds: number;
  scratchMb: number;
}>;

const LIMIT_FLOORS: Readonly<Record<keyof SandboxLimits, number>> = Object.freeze({
  cpuSeconds: 1,
  addressSpaceMb: 16,
  processes: 1,
  fileSizeMb: 1,
  wallClockSeconds: 1,
  scratchMb: 1,
});

const LIMIT_KEYS = Object.keys(LIMIT_FLOORS) as readonly (keyof SandboxLimits)[];

/** Parse one limit set: every key present, no extra key, an integer inside
 *  [floor, ceiling]. Hand-rolled rather than schema-generated so the receipt
 *  grammar and the receipt parser sit in one readable file. */
export function parseSandboxLimits(raw: unknown): DomainResult<SandboxLimits, SandboxError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure({ kind: "invalid-sandbox-limits" as const, message: "limits must be an object" });
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  const unexpected = keys.filter((key) => !LIMIT_KEYS.includes(key as keyof SandboxLimits));
  if (unexpected.length > 0) {
    return failure({ kind: "invalid-sandbox-limits" as const, message: `unexpected limit(s): ${unexpected.join(", ")}` });
  }
  const limits: Partial<Record<keyof SandboxLimits, number>> = {};
  for (const key of LIMIT_KEYS) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < LIMIT_FLOORS[key] || value > SANDBOX_LIMIT_CEILINGS[key]) {
      return failure({ kind: "invalid-sandbox-limits" as const, message: `${key} must be an integer in [${LIMIT_FLOORS[key]}, ${SANDBOX_LIMIT_CEILINGS[key]}]` });
    }
    limits[key] = value;
  }
  return success(Object.freeze(limits as SandboxLimits));
}

/** The one machine-readable line the script prints last. */
export const SANDBOX_RECEIPT_PREFIX = "LOOM-SANDBOX-RECEIPT ";

/** The receipt prefix a caller-bound run uses: the caller's nonce is in the
 *  marker and never in the child's environment, so a command that prints a
 *  receipt line of its own cannot match it. */
export const sandboxReceiptPrefix = (nonce: string): string => `LOOM-SANDBOX-RECEIPT-${nonce} `;

export type SandboxEnforcement = Readonly<{
  cpu: boolean;
  memory: boolean;
  processes: boolean;
  fileSize: boolean;
}>;

export type SandboxReceipt = Readonly<{
  schemaVersion: 1;
  exit: number | null;
  limits: SandboxLimits;
  allowlistedEnv: readonly string[];
  scratchBytes: number | null;
  networkNamespace: true;
  targetReadOnly: true;
  readOnlyRoot: boolean;
  /** Which limits the kernel really applied. A refused `ulimit` is `false`, so
   *  "within limits" never rests on an unapplied one. */
  enforced: SandboxEnforcement;
}>;

const RECEIPT_KEYS = [
  "schemaVersion", "exit", "limits", "allowlistedEnv", "scratchBytes", "networkNamespace", "targetReadOnly",
  "readOnlyRoot", "enforced",
] as const;
const ENFORCEMENT_KEYS = ["cpu", "memory", "processes", "fileSize"] as const;

/** Strict receipt parse: unknown keys are a violation, not a shrug, because a
 *  receipt is the only evidence that the sandbox enforced anything. */
export function parseSandboxReceiptValue(raw: unknown): DomainResult<SandboxReceipt, SandboxError> {
  const invalid = (message: string): DomainResult<SandboxReceipt, SandboxError> =>
    failure({ kind: "invalid-sandbox-receipt" as const, message });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid("receipt must be an object");
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !RECEIPT_KEYS.includes(key as (typeof RECEIPT_KEYS)[number]));
  if (unexpected.length > 0) return invalid(`unexpected field(s): ${unexpected.join(", ")}`);
  if (record.schemaVersion !== 1) return invalid("schemaVersion must be 1");
  const exit = record.exit;
  if (exit !== null && (typeof exit !== "number" || !Number.isInteger(exit) || exit < 0 || exit > 255)) {
    return invalid("exit must be null or an integer in [0, 255]");
  }
  const limits = parseSandboxLimits(record.limits);
  if (!limits.ok) return invalid(limits.error.message);
  const allowlistedEnv = record.allowlistedEnv;
  if (!Array.isArray(allowlistedEnv) || allowlistedEnv.length > 32 || allowlistedEnv.some((name) => typeof name !== "string" || name.length === 0 || name.length > 64)) {
    return invalid("allowlistedEnv must be a list of at most 32 non-empty names");
  }
  const scratchBytes = record.scratchBytes;
  if (scratchBytes !== null && (typeof scratchBytes !== "number" || !Number.isInteger(scratchBytes) || scratchBytes < 0)) {
    return invalid("scratchBytes must be null or a non-negative integer");
  }
  if (record.networkNamespace !== true) return invalid("networkNamespace must be true");
  if (record.targetReadOnly !== true) return invalid("targetReadOnly must be true");
  if (typeof record.readOnlyRoot !== "boolean") return invalid("readOnlyRoot must be a boolean");
  const enforced = parseEnforcement(record.enforced);
  if ("message" in enforced) return invalid(enforced.message);
  return success(
    Object.freeze({
      schemaVersion: 1 as const,
      exit: exit as number | null,
      limits: limits.value,
      allowlistedEnv: Object.freeze([...allowlistedEnv] as string[]),
      scratchBytes: scratchBytes as number | null,
      networkNamespace: true as const,
      targetReadOnly: true as const,
      readOnlyRoot: record.readOnlyRoot as boolean,
      enforced: Object.freeze(enforced),
    }),
  );
}

/** Which limits the kernel actually applied. Strict like every other block: an
 *  unknown key or a non-boolean means the receipt is not trustworthy, because
 *  this block is the difference between "bounded" and "claimed bounded". */
function parseEnforcement(raw: unknown): SandboxEnforcement | Readonly<{ message: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { message: "enforced must be an object" };
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !ENFORCEMENT_KEYS.includes(key as (typeof ENFORCEMENT_KEYS)[number]));
  if (unexpected.length > 0) return { message: `unexpected enforced field(s): ${unexpected.join(", ")}` };
  const missing = ENFORCEMENT_KEYS.find((key) => typeof record[key] !== "boolean");
  if (missing !== undefined) return { message: `enforced.${missing} must be a boolean` };
  return {
    cpu: record.cpu as boolean,
    memory: record.memory as boolean,
    processes: record.processes as boolean,
    fileSize: record.fileSize as boolean,
  };
}

export type SandboxError = Readonly<{ kind: "invalid-sandbox-receipt" | "invalid-sandbox-limits"; message: string }>;

/** The LAST receipt line wins: the script prints the command's output first and
 *  its own receipt last, so a command that prints a receipt line cannot outrank
 *  it. With a nonce, only a line carrying that nonce is even considered. */
export function parseSandboxReceipt(stdout: string, options: Readonly<{ nonce?: string }> = {}): DomainResult<SandboxReceipt, SandboxError> {
  const prefix = options.nonce === undefined ? SANDBOX_RECEIPT_PREFIX : sandboxReceiptPrefix(options.nonce);
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(prefix));
  const last = lines.at(-1);
  if (last === undefined) {
    return failure({ kind: "invalid-sandbox-receipt" as const, message: "no sandbox receipt was emitted" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.slice(prefix.length));
  } catch {
    return failure({ kind: "invalid-sandbox-receipt" as const, message: "sandbox receipt is not JSON" });
  }
  const validated = parseSandboxReceiptValue(parsed);
  return validated.ok
    ? validated
    : failure({ kind: "invalid-sandbox-receipt" as const, message: validated.error.message });
}

export type SandboxRequest = Readonly<{
  target: string;
  scratch: string;
  command: readonly string[];
  limits: SandboxLimits;
  /** Caller-generated lowercase hex; bound into the receipt marker so a
   *  fabricated receipt line cannot match. */
  nonce?: string;
}>;

const SANDBOX_NONCE = /^[0-9a-f]{16,64}$/;

export type SandboxRequestError = Readonly<{ kind: "invalid-sandbox-request"; message: string }>;

/**
 * The argv a hunter runs. Scratch must sit outside the target (a scratch inside
 * the target would be remounted read-only with it), and the command may not be
 * empty.
 */
export function sandboxCommand(request: SandboxRequest): DomainResult<readonly string[], SandboxRequestError> {
  const fail = (message: string): DomainResult<readonly string[], SandboxRequestError> =>
    failure({ kind: "invalid-sandbox-request" as const, message });
  if (!isSafeSourcePath(request.target.replace(/^\.\//, "")) && !request.target.startsWith("/")) {
    return fail("target must be a repository-relative path or an absolute path");
  }
  if (!request.scratch.startsWith("/") && !isSafeSourcePath(request.scratch)) return fail("scratch path is unsafe");
  if (request.command.length === 0) return fail("a command is required");
  if (request.command.some((part) => part.includes("\u0000") || !isVisibleText(part, SECURITY_AUDIT_LIMITS.proseLength))) {
    return fail("command arguments must be visible text");
  }
  if (request.scratch === request.target || request.scratch.startsWith(`${request.target.replace(/\/$/, "")}/`)) {
    return fail("scratch must live outside the target");
  }
  const validated = parseSandboxLimits(request.limits);
  if (!validated.ok) return fail(validated.error.message);
  if (request.nonce !== undefined && !SANDBOX_NONCE.test(request.nonce)) {
    return fail("nonce must be 16-64 lowercase hex characters");
  }

  return success([
    "scripts/security-sandbox.sh",
    "--target",
    request.target,
    "--scratch",
    request.scratch,
    "--cpu",
    String(request.limits.cpuSeconds),
    "--mem-mb",
    String(request.limits.addressSpaceMb),
    "--procs",
    String(request.limits.processes),
    "--file-mb",
    String(request.limits.fileSizeMb),
    "--wall",
    String(request.limits.wallClockSeconds),
    "--scratch-mb",
    String(request.limits.scratchMb),
    ...(request.nonce === undefined ? [] : ["--nonce", request.nonce]),
    "--",
    ...request.command,
  ]);
}

/** A receipt proves the sandbox ran; it does not prove the run stayed inside its
 *  allowance. Every one of these must hold before a local result may be treated
 *  as observed:
 *
 *   - the command exited zero;
 *   - the scratch footprint was MEASURED and is within `scratchMb` (an
 *     unmeasured footprint is not a passing one);
 *   - the target was really remounted read-only — the script exits 127 when the
 *     bind remount fails, so `targetReadOnly: true` is proven, not asserted;
 *   - every ulimit was really applied.
 *
 *  `readOnlyRoot` is recorded but not required: a user namespace cannot remount
 *  a superblock it does not own (`mount -o remount,ro /` is denied on ext4), and
 *  the uid mapping — not that remount — is what protects the rest of the
 *  filesystem. Recording the attempt keeps the report from claiming it.
 */
export function sandboxWithinLimits(receipt: SandboxReceipt): boolean {
  return (
    receipt.exit === 0 &&
    receipt.scratchBytes !== null &&
    receipt.scratchBytes <= receipt.limits.scratchMb * 1024 * 1024 &&
    receipt.targetReadOnly &&
    receipt.enforced.cpu &&
    receipt.enforced.memory &&
    receipt.enforced.processes &&
    receipt.enforced.fileSize
  );
}

/** The block a hunter prompt carries verbatim: what it may run and how. */
export function renderSandboxInstructions(limits: SandboxLimits): string {
  return [
    "Bounded local execution (the only way to claim an observed result):",
    `  scripts/security-sandbox.sh --target <repo> --scratch <run>/agents/<your-agent-id>/scratch \\`,
    `    --cpu ${limits.cpuSeconds} --mem-mb ${limits.addressSpaceMb} --procs ${limits.processes} \\`,
    `    --file-mb ${limits.fileSizeMb} --wall ${limits.wallClockSeconds} --scratch-mb ${limits.scratchMb} -- <command> [args...]`,
    "No external network, no writable target, no inherited environment, no dependency installation.",
    "If the sandbox cannot start, record needs_validation naming the missing capability — do not run the command anyway.",
  ].join("\n");
}
