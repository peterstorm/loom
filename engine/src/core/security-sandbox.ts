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
 * What a receipt does and does not prove. `sandboxNonce` BINDS a receipt to the
 * artifact path it was produced for; it does not AUTHENTICATE it. The nonce is
 * derived from a path the hunter knows and is printed into the hunter's own
 * prompt, so a hunter that writes the artifact itself can forge a receipt the
 * engine will accept. A `SandboxRun` fact is therefore evidence against an
 * accidental receipt, a receipt line the command printed, or one copied from
 * another check — not against a dishonest hunter.
 *
 * The judgement — "does this artifact prove a bounded run, and if not, why" —
 * lives here (`judgeLocalReceipt`), beside the gate it applies, so a shell
 * reads the artifact and nothing else.
 *
 * Pure module: no I/O, no clock, no randomness — and no `node:crypto`: it sits
 * inside the guarded machine's source closure, which must stay free of Node
 * builtins. The nonce below therefore uses a local deterministic hash.
 */

import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { SECURITY_AUDIT_LIMITS, isSafeSourcePath, isVisibleText } from "./security-audit-contract";

/** The exact environment names a sandboxed child receives, in the order the
 *  script's `ENV_ASSIGNMENTS` passes them. Everything else is dropped, so an
 *  ambient credential cannot ride along. A receipt must report exactly this
 *  list, so the receipt's fact and the enforced fact are one fact. */
export const SANDBOX_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "TMPDIR", "LANG", "TERM"] as const);

export type SandboxEnvAllowlist = typeof SANDBOX_ENV_ALLOWLIST;

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

const SANDBOX_NONCE = /^[0-9a-f]{16,64}$/;

/** The nonce a receipt is bound to, derived from the things the engine and the
 *  hunter already agree on (the artifact path the ledger records). Deterministic
 *  on purpose: a replay re-reads the same artifact and must reach the same
 *  verdict, so a random nonce would make the gate unrepayable. 32 hex chars is
 *  inside the script's own grammar.
 *
 *  This is a BINDING marker, not a security primitive: the hunter is told the
 *  value and copies it, so the defence is that a command printing a receipt line
 *  of its own, or a receipt copied from another check, cannot carry the marker
 *  this artifact's engine will look for. Four FNV-1a rounds supply the 128 bits
 *  without pulling `node:crypto` into the machine closure. */
export function sandboxNonce(...parts: readonly string[]): string {
  const seed = `sandbox-nonce\u0000${parts.join("\u0000")}`;
  return ["", "#1", "#2", "#3"]
    .map((round) => fnv1a32(`${seed}${round}`).toString(16).padStart(8, "0"))
    .join("");
}

/** 32-bit FNV-1a: deterministic, dependency-free, and enough to bind a marker. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The nonce a bash call bound into its own receipt, read back from its argv: a
 *  receipt whose marker does not carry the nonce of the call that produced it is
 *  text, not evidence. */
export function sandboxNonceInCommand(command: string): string | null {
  const bound = /--nonce[ =]+["']?([0-9a-f]{16,64})["']?/.exec(command);
  return bound === null ? null : bound[1];
}

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
  /** Always `SANDBOX_ENV_ALLOWLIST`: a receipt naming any other list is refused. */
  allowlistedEnv: SandboxEnvAllowlist;
  /** Measured AFTER the run; nothing capped the scratch while it ran. */
  scratchBytes: number | null;
  networkNamespace: true;
  targetReadOnly: true;
  readOnlyRoot: boolean;
  /** A write to the operator's home FAILED inside the sandbox — observed by the
   *  script's probe, not inferred from a remount that returned zero; an unknown
   *  home reads as `false`. Unlike the root remount, the home bind-remount
   *  succeeds in a user namespace, and home is the one surface the uid mapping
   *  otherwise leaves writable — so it is required, not merely recorded. */
  homeReadOnly: boolean;
  /** Mountpoints that could not be remounted read-only: the residual exposure a
   *  report states instead of claiming a closed filesystem. */
  unremountedMounts: number;
  /** Which limits the kernel really applied. A refused `ulimit` is `false`, so
   *  "within limits" never rests on an unapplied one. */
  enforced: SandboxEnforcement;
}>;

const RECEIPT_KEYS = [
  "schemaVersion", "exit", "limits", "allowlistedEnv", "scratchBytes", "networkNamespace", "targetReadOnly",
  "readOnlyRoot", "homeReadOnly", "unremountedMounts", "enforced",
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
  if (
    !Array.isArray(allowlistedEnv) ||
    allowlistedEnv.length !== SANDBOX_ENV_ALLOWLIST.length ||
    allowlistedEnv.some((name, index) => name !== SANDBOX_ENV_ALLOWLIST[index])
  ) {
    return invalid(`allowlistedEnv must be exactly [${SANDBOX_ENV_ALLOWLIST.join(", ")}]`);
  }
  const scratchBytes = record.scratchBytes;
  if (scratchBytes !== null && (typeof scratchBytes !== "number" || !Number.isInteger(scratchBytes) || scratchBytes < 0)) {
    return invalid("scratchBytes must be null or a non-negative integer");
  }
  if (record.networkNamespace !== true) return invalid("networkNamespace must be true");
  if (record.targetReadOnly !== true) return invalid("targetReadOnly must be true");
  if (typeof record.readOnlyRoot !== "boolean") return invalid("readOnlyRoot must be a boolean");
  if (typeof record.homeReadOnly !== "boolean") return invalid("homeReadOnly must be a boolean");
  const unremountedMounts = record.unremountedMounts;
  if (typeof unremountedMounts !== "number" || !Number.isInteger(unremountedMounts) || unremountedMounts < 0) {
    return invalid("unremountedMounts must be a non-negative integer");
  }
  const enforced = parseEnforcement(record.enforced);
  if ("message" in enforced) return invalid(enforced.message);
  return success(
    Object.freeze({
      schemaVersion: 1 as const,
      exit: exit as number | null,
      limits: limits.value,
      allowlistedEnv: SANDBOX_ENV_ALLOWLIST,
      scratchBytes: scratchBytes as number | null,
      networkNamespace: true as const,
      targetReadOnly: true as const,
      readOnlyRoot: record.readOnlyRoot as boolean,
      homeReadOnly: record.homeReadOnly as boolean,
      unremountedMounts,
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
 *  it. The nonce is REQUIRED: only a line carrying the caller's nonce is even
 *  considered, so a caller cannot forget the binding that makes the receipt
 *  evidence rather than a string that happened to appear in the output. */
export function parseSandboxReceipt(stdout: string, nonce: string): DomainResult<SandboxReceipt, SandboxError> {
  if (!SANDBOX_NONCE.test(nonce)) {
    return failure({ kind: "invalid-sandbox-receipt" as const, message: "nonce must be 16-64 lowercase hex characters" });
  }
  const prefix = sandboxReceiptPrefix(nonce);
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
  return parseSandboxReceiptValue(parsed);
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
 *   - the scratch footprint was MEASURED and is within `scratchMb`. This is a
 *     POST-RUN footprint check: nothing caps the scratch while the command runs
 *     (`--file-mb` bounds each single file, not the directory), so it proves
 *     what was left behind, not the peak. An unmeasured footprint is not a
 *     passing one;
 *   - the target was really remounted read-only — the script exits 127 when the
 *     bind remount fails, so `targetReadOnly: true` is proven, not asserted;
 *   - home is closed (`homeReadOnly`): the script sets it only after a write to
 *     home actually FAILED inside the sandbox, so a remount that silently
 *     missed, or an unknown home, reads as open;
 *   - every ulimit was really applied.
 *
 *  `readOnlyRoot` and `unremountedMounts` are RECORDED residual exposure, not
 *  gated: a user namespace cannot remount a superblock it does not own
 *  (`mount -o remount,ro /` is denied on ext4), so gating on them would refuse
 *  every run. A report states that exposure instead of claiming a closed
 *  filesystem. `describeUnboundedRun` names which gated condition failed.
 */
export function sandboxWithinLimits(receipt: SandboxReceipt): boolean {
  return (
    receipt.exit === 0 &&
    receipt.scratchBytes !== null &&
    receipt.scratchBytes <= receipt.limits.scratchMb * 1024 * 1024 &&
    receipt.targetReadOnly &&
    receipt.homeReadOnly &&
    receipt.enforced.cpu &&
    receipt.enforced.memory &&
    receipt.enforced.processes &&
    receipt.enforced.fileSize
  );
}

/** Why a receipt does not prove a bounded run, in one line a hunter can act
 *  on: one reason per gated condition of `sandboxWithinLimits` that failed. */
export function describeUnboundedRun(receipt: SandboxReceipt): string {
  const failed = [
    ...(receipt.exit === 0 ? [] : [`exit ${String(receipt.exit)}`]),
    ...(receipt.scratchBytes === null ? ["scratch footprint unmeasured"] : []),
    ...(receipt.scratchBytes !== null && receipt.scratchBytes > receipt.limits.scratchMb * 1024 * 1024
      ? [`scratch ${receipt.scratchBytes} B over its ${receipt.limits.scratchMb} MB allowance`]
      : []),
    ...(receipt.enforced.cpu ? [] : ["cpu limit not applied"]),
    ...(receipt.enforced.memory ? [] : ["memory limit not applied"]),
    ...(receipt.enforced.processes ? [] : ["process limit not applied"]),
    ...(receipt.enforced.fileSize ? [] : ["file-size limit not applied"]),
    ...(receipt.homeReadOnly ? [] : ["home directory not remounted read-only"]),
  ];
  return failed.join("; ") || "unknown";
}

/** The judgement on one `local` check: the artifact's text must hold a receipt
 *  bound to the nonce derived from the artifact path, and that receipt must
 *  prove a bounded run. The failure is the one line the hunter is shown. The
 *  binding defeats a command-printed or copied receipt, not a hunter that
 *  writes the artifact itself (see the module doc). */
export function judgeLocalReceipt(text: string, artifact: string): DomainResult<SandboxReceipt, string> {
  const receipt = parseSandboxReceipt(text, sandboxNonce(artifact));
  if (!receipt.ok) return failure(`local check ${artifact} is not a sandbox receipt — ${receipt.error.message}`);
  if (!sandboxWithinLimits(receipt.value)) {
    return failure(`local check ${artifact} does not prove a bounded run: ${describeUnboundedRun(receipt.value)}`);
  }
  return success(receipt.value);
}

/** The block a hunter prompt carries verbatim: what it may run and how. The
 *  nonce is supplied by the engine because the receipt is bound to the artifact
 *  path the hunter itself names, and a receipt without it is refused. */
export function renderSandboxInstructions(limits: SandboxLimits, nonce: string): string {
  return [
    "Bounded local execution (the only way to claim an observed result):",
    `  scripts/security-sandbox.sh --target <repo> --scratch <run>/agents/<your-agent-id>/scratch \\`,
    `    --cpu ${limits.cpuSeconds} --mem-mb ${limits.addressSpaceMb} --procs ${limits.processes} \\`,
    `    --file-mb ${limits.fileSizeMb} --wall ${limits.wallClockSeconds} --scratch-mb ${limits.scratchMb} \\`,
    `    --nonce ${nonce} -- <command> [args...]`,
    "No external network, no writable target or home, no inherited environment, no dependency installation.",
    "A receipt without that --nonce is refused: redirect the script's stdout to the artifact your ledger entry names, and keep the flag exactly as printed.",
    "If the sandbox cannot start, record needs_validation naming the missing capability — do not run the command anyway.",
  ].join("\n");
}
