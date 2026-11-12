/**
 * The sandbox contract: limits, the command that runs a bounded check, and the
 * receipt that turns "I reproduced it locally" into a recorded fact.
 *
 * `scripts/security-sandbox.sh` (`sandboxScriptPath`) is the only executor. This volume owns the
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

import { loomHelperCommand } from "./loom-cli-command";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { SECURITY_AUDIT_LIMITS, isSafeSourcePath, isVisibleText, isWireRecord } from "./security-audit-contract";
import { quoteShellArgument } from "./shell-quoting";

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
  if (!isWireRecord(raw)) {
    return failure({ kind: "invalid-sandbox-limits" as const, message: "limits must be an object" });
  }
  const keys = Object.keys(raw);
  const unexpected = keys.filter((key) => !LIMIT_KEYS.includes(key as keyof SandboxLimits));
  if (unexpected.length > 0) {
    return failure({ kind: "invalid-sandbox-limits" as const, message: `unexpected limit(s): ${unexpected.join(", ")}` });
  }
  const limits: Partial<Record<keyof SandboxLimits, number>> = {};
  for (const key of LIMIT_KEYS) {
    const value = raw[key];
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
  /** Whether loopback came up inside the network namespace — OBSERVED by the
   *  script before the command starts. Recorded, not gated: no external network
   *  holds either way, but a dead loopback makes the command's own local-service
   *  checks fail, and the receipt says why instead of reading as a healthy run. */
  loopbackUp: boolean;
  /** A write to the target FAILED inside the sandbox — observed by the script,
   *  which reports it only on a facts line printed after that probe; a missing
   *  line reads as `false`. Gated: a writable target is not a bounded run. */
  targetReadOnly: boolean;
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
  "schemaVersion", "exit", "limits", "allowlistedEnv", "scratchBytes", "networkNamespace", "loopbackUp", "targetReadOnly",
  "readOnlyRoot", "homeReadOnly", "unremountedMounts", "enforced",
] as const;
const ENFORCEMENT_KEYS = ["cpu", "memory", "processes", "fileSize"] as const;

/** Strict receipt parse: unknown keys are a violation, not a shrug, because a
 *  receipt is the only evidence that the sandbox enforced anything. */
export function parseSandboxReceiptValue(raw: unknown): DomainResult<SandboxReceipt, SandboxError> {
  const invalid = (message: string): DomainResult<SandboxReceipt, SandboxError> =>
    failure({ kind: "invalid-sandbox-receipt" as const, message });
  if (!isWireRecord(raw)) return invalid("receipt must be an object");
  const unexpected = Object.keys(raw).filter((key) => !RECEIPT_KEYS.includes(key as (typeof RECEIPT_KEYS)[number]));
  if (unexpected.length > 0) return invalid(`unexpected field(s): ${unexpected.join(", ")}`);
  if (raw.schemaVersion !== 1) return invalid("schemaVersion must be 1");
  const exit = raw.exit;
  if (exit !== null && (typeof exit !== "number" || !Number.isInteger(exit) || exit < 0 || exit > 255)) {
    return invalid("exit must be null or an integer in [0, 255]");
  }
  const limits = parseSandboxLimits(raw.limits);
  if (!limits.ok) return invalid(limits.error.message);
  const allowlistedEnv = raw.allowlistedEnv;
  if (
    !Array.isArray(allowlistedEnv) ||
    allowlistedEnv.length !== SANDBOX_ENV_ALLOWLIST.length ||
    allowlistedEnv.some((name, index) => name !== SANDBOX_ENV_ALLOWLIST[index])
  ) {
    return invalid(`allowlistedEnv must be exactly [${SANDBOX_ENV_ALLOWLIST.join(", ")}]`);
  }
  const scratchBytes = raw.scratchBytes;
  if (scratchBytes !== null && (typeof scratchBytes !== "number" || !Number.isInteger(scratchBytes) || scratchBytes < 0)) {
    return invalid("scratchBytes must be null or a non-negative integer");
  }
  const isolation = parseIsolationFacts(raw);
  if ("message" in isolation) return invalid(isolation.message);
  const unremountedMounts = raw.unremountedMounts;
  if (typeof unremountedMounts !== "number" || !Number.isInteger(unremountedMounts) || unremountedMounts < 0) {
    return invalid("unremountedMounts must be a non-negative integer");
  }
  const enforced = parseEnforcement(raw.enforced);
  if ("message" in enforced) return invalid(enforced.message);
  return success(
    Object.freeze({
      schemaVersion: 1 as const,
      exit: exit as number | null,
      limits: limits.value,
      allowlistedEnv: SANDBOX_ENV_ALLOWLIST,
      scratchBytes: scratchBytes as number | null,
      networkNamespace: true as const,
      ...isolation,
      unremountedMounts,
      enforced: Object.freeze(enforced),
    }),
  );
}

/** The isolation facts the script observed: the network namespace (always
 *  true — a receipt claiming otherwise is refused), whether loopback came up,
 *  and which surfaces a write to failed. Each is a strict boolean. */
function parseIsolationFacts(
  raw: Readonly<Record<string, unknown>>,
): Pick<SandboxReceipt, "loopbackUp" | "targetReadOnly" | "readOnlyRoot" | "homeReadOnly"> | Readonly<{ message: string }> {
  const { networkNamespace, loopbackUp, targetReadOnly, readOnlyRoot, homeReadOnly } = raw;
  if (networkNamespace !== true) return { message: "networkNamespace must be true" };
  if (typeof loopbackUp !== "boolean") return { message: "loopbackUp must be a boolean" };
  if (typeof targetReadOnly !== "boolean") return { message: "targetReadOnly must be a boolean" };
  if (typeof readOnlyRoot !== "boolean") return { message: "readOnlyRoot must be a boolean" };
  if (typeof homeReadOnly !== "boolean") return { message: "homeReadOnly must be a boolean" };
  return { loopbackUp, targetReadOnly, readOnlyRoot, homeReadOnly };
}

/** Which limits the kernel actually applied. Strict like every other block: an
 *  unknown key or a non-boolean means the receipt is not trustworthy, because
 *  this block is the difference between "bounded" and "claimed bounded". */
function parseEnforcement(raw: unknown): SandboxEnforcement | Readonly<{ message: string }> {
  if (!isWireRecord(raw)) return { message: "enforced must be an object" };
  const unexpected = Object.keys(raw).filter((key) => !ENFORCEMENT_KEYS.includes(key as (typeof ENFORCEMENT_KEYS)[number]));
  if (unexpected.length > 0) return { message: `unexpected enforced field(s): ${unexpected.join(", ")}` };
  const missing = ENFORCEMENT_KEYS.find((key) => typeof raw[key] !== "boolean");
  if (missing !== undefined) return { message: `enforced.${missing} must be a boolean` };
  return {
    cpu: raw.cpu as boolean,
    memory: raw.memory as boolean,
    processes: raw.processes as boolean,
    fileSize: raw.fileSize as boolean,
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

/** Where the one executor lives in the Loom package at `packageRoot`. A hunter
 *  works in the audited repository, not in the package, so every printed run
 *  names the script by this absolute path. */
export const sandboxScriptPath = (packageRoot: string): string => `${packageRoot}/scripts/security-sandbox.sh`;

export type SandboxRequest = Readonly<{
  /** The executor: `sandboxScriptPath` of the executing package. */
  script: string;
  target: string;
  scratch: string;
  command: readonly string[];
  limits: SandboxLimits;
  /** Caller-generated lowercase hex; bound into the receipt marker so a
   *  fabricated receipt line cannot match. */
  nonce?: string;
}>;

export type SandboxRequestError = Readonly<{ kind: "invalid-sandbox-request"; message: string }>;

/** Whether `path` is `directory` or lies below it — the script's own
 *  scratch-outside-target rule, compared on the paths as given. */
const liesWithin = (path: string, directory: string): boolean =>
  path === directory || path.startsWith(`${directory.replace(/\/$/, "")}/`);

/** The script and every flag of one sandbox run, before `--` and the command:
 *  the one argv grammar `sandboxCommand` validates and `renderSandboxInstructions`
 *  prints, so the two cannot name different flags. */
function sandboxInvocation(run: Omit<SandboxRequest, "command">): readonly string[] {
  return [
    run.script,
    "--target", run.target,
    "--scratch", run.scratch,
    "--cpu", String(run.limits.cpuSeconds),
    "--mem-mb", String(run.limits.addressSpaceMb),
    "--procs", String(run.limits.processes),
    "--file-mb", String(run.limits.fileSizeMb),
    "--wall", String(run.limits.wallClockSeconds),
    "--scratch-mb", String(run.limits.scratchMb),
    ...(run.nonce === undefined ? [] : ["--nonce", run.nonce]),
  ];
}

/** A word sh reads back unchanged without quoting: no whitespace, quote, glob,
 *  expansion, redirection or control character (shlex's safe set). */
const BARE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** An argv as one shell line that reads back as exactly that argv: a word in
 *  the bare-safe set is printed as itself (so a plain script path and the hex
 *  nonce read as typed), and every other word —
 *  a path with a space or a metacharacter, an empty word — goes through
 *  `quoteShellArgument`. The one renderer of a printed sandbox command. */
export const renderShellWords = (argv: readonly string[]): string =>
  argv.map((word) => (BARE_SHELL_WORD.test(word) ? word : quoteShellArgument(word))).join(" ");

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
  if (liesWithin(request.scratch, request.target)) {
    return fail("scratch must live outside the target");
  }
  const validated = parseSandboxLimits(request.limits);
  if (!validated.ok) return fail(validated.error.message);
  if (request.nonce !== undefined && !SANDBOX_NONCE.test(request.nonce)) {
    return fail("nonce must be 16-64 lowercase hex characters");
  }

  return success([...sandboxInvocation(request), "--", ...request.command]);
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
 *   - the target is closed (`targetReadOnly`): the script reports it only after
 *     a write to the target actually FAILED, and stops before the command when
 *     it did not, so a missing facts line reads as open;
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
  return unboundedRunReasons(receipt).length === 0;
}

/** Why a receipt does not prove a bounded run, in one line a hunter can act
 *  on: one reason per gated condition of `sandboxWithinLimits` that failed. */
export function describeUnboundedRun(receipt: SandboxReceipt): string {
  return unboundedRunReasons(receipt).join("; ") || "unknown";
}

/** The gate itself: one reason per failed condition. `sandboxWithinLimits` and
 *  `describeUnboundedRun` both read THIS list, so the verdict and its
 *  explanation cannot name different conditions. */
function unboundedRunReasons(receipt: SandboxReceipt): readonly string[] {
  return [
    ...(receipt.exit === 0 ? [] : [`exit ${String(receipt.exit)}`]),
    ...(receipt.scratchBytes === null ? ["scratch footprint unmeasured"] : []),
    ...(receipt.scratchBytes !== null && receipt.scratchBytes > receipt.limits.scratchMb * 1024 * 1024
      ? [`scratch ${receipt.scratchBytes} B over its ${receipt.limits.scratchMb} MB allowance`]
      : []),
    ...(receipt.enforced.cpu ? [] : ["cpu limit not applied"]),
    ...(receipt.enforced.memory ? [] : ["memory limit not applied"]),
    ...(receipt.enforced.processes ? [] : ["process limit not applied"]),
    ...(receipt.enforced.fileSize ? [] : ["file-size limit not applied"]),
    ...(receipt.targetReadOnly ? [] : ["target not remounted read-only"]),
    ...(receipt.homeReadOnly ? [] : ["home directory not remounted read-only"]),
  ];
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

/** Everything one sandbox run is bound to: the executor, the nonce derived from
 *  the artifact the receipt will be cited as, where the run reads and writes,
 *  and the file its stdout must land in. */
export type SandboxBinding = Readonly<{
  /** The executor: `sandboxScriptPath` of the executing package. */
  script: string;
  nonce: string;
  /** The frozen target the run audits. */
  target: string;
  /** The owner's scratch directory, `<run>/agents/<owner-id>/scratch`. */
  scratch: string;
  /** The run-relative path the local check cites (`agents/<owner-id>/artifacts/<file>`). */
  artifact: string;
  /** Where that artifact lives on disk: the file stdout is redirected into. */
  artifactFile: string;
}>;

export type SandboxPlacement = Readonly<{
  /** The Loom package whose sandbox script runs the check. */
  packageRoot: string;
  /** The run's frozen target directory. */
  target: string;
  /** The run directory, absolute. */
  runDir: string;
  /** The owner whose scratch the run uses. */
  owner: string;
  /** The run-relative artifact the receipt will be cited as. */
  artifact: string;
}>;

export type SandboxBindingRefusal = Readonly<{ kind: "scratch-inside-target"; scratch: string; target: string; message: string }>;

/**
 * Bind one sandbox run to one artifact of a run directory: the nonce derived
 * from the artifact path (the same derivation `judgeLocalReceipt` checks), the
 * owner's scratch `<run>/agents/<owner>/scratch`, and the file stdout lands in.
 *
 * Refused when that scratch lies inside the target: the script refuses such a
 * scratch, so a binding for it would hand the hunter a run that cannot start —
 * the run directory has to live outside the audited repository.
 */
export function bindSandboxRun(placement: SandboxPlacement): DomainResult<SandboxBinding, SandboxBindingRefusal> {
  const runDir = placement.runDir.replace(/\/+$/, "");
  const scratch = `${runDir}/agents/${placement.owner}/scratch`;
  if (liesWithin(scratch, placement.target)) {
    return failure({
      kind: "scratch-inside-target" as const,
      scratch,
      target: placement.target,
      message: `the scratch ${scratch} lies inside the target ${placement.target}, and the sandbox refuses a scratch inside ` +
        "the target — start the run with an --out directory outside the audited repository",
    });
  }
  return success({
    script: sandboxScriptPath(placement.packageRoot),
    nonce: sandboxNonce(placement.artifact),
    target: placement.target,
    scratch,
    artifact: placement.artifact,
    artifactFile: `${runDir}/${placement.artifact}`,
  });
}

/** The line `assign` prints under each minted owner: how the parent obtains the
 *  receipt binding for one of that owner's artifacts (a hunter cannot derive the
 *  nonce itself). `<file>` is the one word left for the parent to fill in. */
export const renderNonceCommand = (packageRoot: string, runDir: string, owner: string): string =>
  `${loomHelperCommand(packageRoot)} security-audit nonce --out ${quoteShellArgument(runDir)} --artifact agents/${owner}/artifacts/<file>`;

/** The block a hunter is handed verbatim: what it may run and how, bound to one
 *  artifact. The nonce is supplied by the engine because the receipt is bound to
 *  the artifact path, and a receipt in any other file, or without the nonce, is
 *  refused. Every path in the commands is one shell-quoted word
 *  (`renderShellWords`), and the sandbox line IS `sandboxCommand`'s argv up to
 *  `--`, so a run directory or target with a space or a metacharacter runs
 *  exactly as printed and the receipt lands in the bound file. */
export function renderSandboxInstructions(limits: SandboxLimits, binding: SandboxBinding): string {
  const artifactDirectory = binding.artifactFile.slice(0, binding.artifactFile.lastIndexOf("/"));
  const invocation = sandboxInvocation({ ...binding, limits });
  return [
    "Bounded local execution (the only way to claim an observed result):",
    `  ${renderShellWords(["mkdir", "-p", artifactDirectory])}`,
    `  ${renderShellWords(invocation)} -- <command> [args...] > ${renderShellWords([binding.artifactFile])}`,
    "No external network, no writable target or home, no inherited environment, no dependency installation.",
    `Redirect the script's stdout to exactly ${binding.artifactFile} and cite it as the local check's artifact ` +
      `"${binding.artifact}". The receipt is bound to that path: a receipt in any other file, or without that --nonce, is refused.`,
    "If the sandbox cannot start, record needs_validation naming the missing capability — do not run the command anyway.",
  ].join("\n");
}
