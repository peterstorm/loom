/**
 * The sandbox contract: limits, the command that runs a bounded check, and the
 * receipt that turns "I reproduced it locally" into a recorded fact.
 *
 * `scripts/security-sandbox.sh` is the only executor. This volume owns the
 * grammar around it — the limits an operator may set, the argv a hunter is told
 * to run, and the receipt parser. Nothing here executes anything, and nothing
 * here trusts a hunter-supplied limit: the receipt comes from the script's own
 * stdout, so an agent that claims `--mem-mb 8192` still records what the script
 * enforced.
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

export type SandboxReceipt = Readonly<{
  schemaVersion: 1;
  exit: number | null;
  limits: SandboxLimits;
  allowlistedEnv: readonly string[];
  scratchBytes: number | null;
  networkNamespace: true;
  targetReadOnly: true;
}>;

const RECEIPT_KEYS = ["schemaVersion", "exit", "limits", "allowlistedEnv", "scratchBytes", "networkNamespace", "targetReadOnly"] as const;

/** Strict receipt parse: unknown keys are a violation, not a shrug, because a
 *  receipt is the only evidence that the sandbox enforced anything. */
function parseReceipt(raw: unknown): DomainResult<SandboxReceipt, SandboxError> {
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
  return success(
    Object.freeze({
      schemaVersion: 1 as const,
      exit: exit as number | null,
      limits: limits.value,
      allowlistedEnv: Object.freeze([...allowlistedEnv] as string[]),
      scratchBytes: scratchBytes as number | null,
      networkNamespace: true as const,
      targetReadOnly: true as const,
    }),
  );
}

export type SandboxError = Readonly<{ kind: "invalid-sandbox-receipt" | "invalid-sandbox-limits"; message: string }>;

/** The LAST receipt line wins: a command may print its own log lines before it,
 *  and only the script's own final line is authoritative. */
export function parseSandboxReceipt(stdout: string): DomainResult<SandboxReceipt, SandboxError> {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(SANDBOX_RECEIPT_PREFIX));
  const last = lines.at(-1);
  if (last === undefined) {
    return failure({ kind: "invalid-sandbox-receipt" as const, message: "no sandbox receipt was emitted" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.slice(SANDBOX_RECEIPT_PREFIX.length));
  } catch {
    return failure({ kind: "invalid-sandbox-receipt" as const, message: "sandbox receipt is not JSON" });
  }
  const validated = parseReceipt(parsed);
  return validated.ok
    ? validated
    : failure({ kind: "invalid-sandbox-receipt" as const, message: validated.error.message });
}

export type SandboxRequest = Readonly<{
  target: string;
  scratch: string;
  command: readonly string[];
  limits: SandboxLimits;
}>;

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
    "--",
    ...request.command,
  ]);
}

/** A receipt proves the sandbox ran; it does not prove the run stayed inside its
 *  allowance. Exit zero and a scratch footprint within `scratchMb` are both
 *  required before a local result may be treated as observed. */
export function sandboxWithinLimits(receipt: SandboxReceipt): boolean {
  return receipt.exit === 0 && (receipt.scratchBytes ?? 0) <= receipt.limits.scratchMb * 1024 * 1024;
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
