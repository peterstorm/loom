/**
 * `helper security-audit <operation> …` — the registered security-audit
 * program's CLI (ADR-0066).
 *
 * This file is a SHELL. It reads the run directory, calls one pure core, and
 * writes back; every semantic decision (what a unit may settle as, whether a
 * claim is confirmed, what the report says) belongs to `core/security-*`. The
 * action set is closed: `security-audit-operations.ts` declares each operation's
 * traits, and the dispatcher below matches over it exhaustively, so a new
 * operation cannot be added without the routing layer learning what it does.
 *
 * The run directory is the whole record of a run. `FILES` below names its
 * documents from their ONE owner, `core/audit-run-authority.ts`, which the
 * subagent write guard protects from — the `--force` reset, the fresh-run
 * writes and every reader name files through it, so a document cannot be added
 * to the directory and forgotten by one of them, or left unprotected:
 *
 *   run.json                 run metadata; its `published` flag is the commit point
 *   ledger.json              the coverage ledger
 *   findings.json            candidate findings as filed (trichotomy records)
 *   verdicts.json            a CACHE of imported ballots, each bound to the verifier spawn that
 *                            cast it and re-proven (run replay + capture attestation) before
 *                            adjudication counts it
 *   verification-runs/       the `security-verification` runs that issue those spawns (ADR-0067);
 *                            `verify --from` imports a finished one
 *   lenses.json              the lens selection this run was given
 *   security-findings.json   published records (publish)
 *   disposition.json         the remediation handoff (disposition)
 *   standalone-disposition.json  the `standalone-disposition` start input (disposition)
 *   disposition-runs/        the runs root the handoff command names for remediation
 *   REPORT.md / FINDINGS-DETAIL.md / NEEDS-VALIDATION.md   derived prose (publish)
 *
 * Every read is fail-closed and parsed by the core that owns the document, so a
 * hand-edited or half-written file stops the run with a named violation instead
 * of flowing into a report. Writes go through the no-follow filesystem helpers:
 * a symlinked run file is refused rather than followed. Only an operation that
 * writes prepares the directory: a read-only projection pointed at a mistyped
 * `--out` reports the missing run instead of creating an empty directory.
 *
 * Publication is a transaction with a commit point: prose first, then the
 * records, then `run.json` with `published: true` LAST. A write that fails
 * part-way leaves `published: false`, so `disposition` and `status` never treat
 * a half-written directory as a published run. A published run is closed:
 * every operation that changes run state refuses it, so the published records
 * can never silently disagree with the ledger and ballots beside them.
 */

import { match } from "ts-pattern";
import { runGit } from "../../utils/git-execution-policy";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HookHandler, HookResult } from "../../types";
import { errorResult, passthroughResult } from "../../types";
import { failure, success, type DomainResult } from "../../core/orchestration-contract/identity";
import { compareStrings } from "../../core/ordering";
import {
  ensureDirectoryNoFollow,
  ensureResolvedBaseDirectory,
  resolveBaseDirectory,
  writeRunFileExclusiveNoFollow,
  writeRunFileNoFollow,
} from "../../orchestration/no-follow-fs";
import {
  admitWave,
  isWireRecord,
  parseSecurityProfile,
  parseSecurityRunMetadata,
  type SecurityProfile,
  type SecurityRunMetadata,
} from "../../core/security-audit-contract";
import { parseSecurityAuditStart, startMetadata, type SecurityAuditStart } from "../../core/security-audit-start";
import {
  HUNTER_RESULT_KIND,
  admitArtifactNonce,
  assignUnits,
  coverageComplete,
  coverageSettled,
  deferPlannedUnits,
  deferUnit,
  mergeCritic,
  parseCoverageSeeds,
  parseCriticMergeMaps,
  parseCriticResult,
  parseHunterResult,
  parseLedger,
  recordUnitResult,
  runStatusOf,
  summarizeCoverage,
  type CoverageLedger,
  type UnitResult,
} from "../../core/security-coverage";
import { fileCandidates, parseSecurityFindings, type SecurityFinding } from "../../core/security-findings";
import { adjudicateRun } from "../../core/security-adjudication";
import {
  importVerificationResult,
  planVerificationStart,
  renderVerificationStart,
  type VerificationStartPlan,
} from "../../core/security-verification";
import { quoteShellArgument } from "../../core/shell-quoting";
import {
  observeVerificationGenerations,
  proveCachedBallots,
  proveVerificationSource,
  readVerificationSource,
} from "./security-verification-proofs";
import {
  describeAuditRefusal,
  readAuditSnapshot,
  readRunDocument,
  readRunText,
  verificationRunsRoot,
  type AuditSnapshot,
} from "./security-audit-run";
import { SECURITY_AUDIT_RUN_FILES } from "../../core/audit-run-authority";
import { registerSecurityAuditRun } from "../../orchestration/security-audit-run-registry";
import { renderLensSelection, type LensSelection } from "../../core/security-lens-select";
import { dispositionHandoffPaths, renderDispositionHandoff, securityDisposition, standaloneDispositionStart } from "../../core/security-disposition";
import { DEFAULT_SANDBOX_LIMITS, bindSandboxRun, judgeLocalReceipt, renderSandboxInstructions } from "../../core/security-sandbox";
import { renderRunDocuments } from "../../core/security-reports";
import { argumentValue, hasFlag, unconsumedValueArguments } from "./cli-args";
import {
  parseSecurityAuditOperation,
  SECURITY_AUDIT_OPERATION_ORDER,
  securityAuditOperationWrites,
  type SecurityAuditOperation,
} from "./security-audit-operations";

const USAGE = `usage: helper security-audit <${SECURITY_AUDIT_OPERATION_ORDER.join("|")}> [flags]`;

/** The run directory's document set, from its one owner (`core/audit-run-authority`). */
const FILES = SECURITY_AUDIT_RUN_FILES;

/** Every document a run directory may hold, from the single list above. */
const RUN_DOCUMENTS: readonly string[] = Object.freeze(Object.values(FILES));

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--out", "--repo", "--source", "--profile", "--budget", "--run-id", "--unit", "--agent", "--wave", "--reason", "--artifact", "--from",
]);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every stdin payload's first step: strict JSON, or a refusal naming the
 *  operation whose input it was. */
function parseJsonInput(label: SecurityAuditOperation, stdin: string): DomainResult<unknown, string> {
  try {
    return success(JSON.parse(stdin));
  } catch (error) {
    return failure(`${label} input is not valid JSON: ${describe(error)}`);
  }
}

// --- The run directory ---

/** The run directory's WRITE side. Reads go through the shared read seam
 *  (`security-audit-run.ts`: `readRunDocument`, `readRunText`,
 *  `readAuditSnapshot`), so a document reads the same here as in the
 *  verification program. */
type Store = Readonly<{
  out: string;
  has: (file: string) => boolean;
  write: (file: string, value: string, options?: Readonly<{ exclusive?: boolean }>) => DomainResult<void, string>;
  /** Remove every document this run directory may hold, for `start --force`. A
   *  new run must not inherit the previous run's records: `findings.json`,
   *  `security-findings.json` and `disposition.json` from an older run would
   *  otherwise enter the new run's adjudication as if this run had filed them. */
  clear: () => DomainResult<readonly string[], string>;
}>;

/** Write one run document through the no-follow helpers: a symlinked run file is
 *  refused rather than written through, and an exclusive write fails when the
 *  file already exists (that is how a fresh run claims its directory). */
function writeAt(
  root: string,
  file: string,
  value: string,
  options?: Readonly<{ exclusive?: boolean }>,
): DomainResult<void, string> {
  const path = join(root, file);
  try {
    ensureDirectoryNoFollow(root);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      return failure(`write target ${path} must not be a symbolic link`);
    }
    if (options?.exclusive === true) writeRunFileExclusiveNoFollow(path, value);
    else writeRunFileNoFollow(path, value);
    return success(undefined);
  } catch (error) {
    return failure(`cannot write ${path}: ${describe(error)}`);
  }
}

/** Remove every document of a previous run, naming what went. */
function clearRunDocuments(root: string): DomainResult<readonly string[], string> {
  const removed: string[] = [];
  try {
    for (const file of RUN_DOCUMENTS) {
      const path = join(root, file);
      if (!existsSync(path)) continue;
      rmSync(path);
      removed.push(file);
    }
    return success(removed);
  } catch (error) {
    return failure(`cannot reset ${root}: ${describe(error)}`);
  }
}

/**
 * The run directory's ONE canonical path. Its parent is the run base, and the
 * base is resolved to its real path exactly the way every Loom run base is
 * (`ensureResolvedBaseDirectory` / `resolveBaseDirectory`): on macOS the temp
 * root `/var/folders/…` sits under the system symlink `/var` → `/private/var`,
 * so a no-follow walk from `/` would refuse every run there. The run directory
 * itself and everything below it stay held to the strict no-follow rule — a
 * symlinked run directory, or a symlink planted inside it, is still refused.
 *
 * The canonical path is also the audit's locator: every invocation names the
 * same run whichever alias the operator typed, so a verification run issued
 * for `/tmp/audit` is the one `/private/tmp/audit` imports.
 *
 * Only a WRITING operation creates a missing base; a read-only projection on a
 * base that does not exist keeps the spelled path, so its read reports the run
 * missing rather than creating anything.
 */
function canonicalRunDirectory(out: string, writes: boolean): DomainResult<string, string> {
  const spelled = resolve(out);
  const base = dirname(spelled);
  if (base === spelled) return failure(`run directory must not be the filesystem root: ${spelled}`);
  try {
    return success(join(writes ? ensureResolvedBaseDirectory(base) : resolveBaseDirectory(base), basename(spelled)));
  } catch (error) {
    if (!writes && (error as NodeJS.ErrnoException).code === "ENOENT") return success(spelled);
    return failure(`cannot resolve the base of run directory ${spelled}: ${describe(error)}`);
  }
}

/** Open the run directory. Only an operation that WRITES prepares it: a
 *  read-only projection must never create the directory it was asked to read,
 *  or a mistyped `--out` would leave an empty run directory behind and the
 *  operator would read "missing run.json" as a damaged run rather than a typo. */
function openStore(out: string, writes: boolean): DomainResult<Store, string> {
  const canonical = canonicalRunDirectory(out, writes);
  if (!canonical.ok) return canonical;
  const root = canonical.value;
  if (writes) {
    try {
      ensureDirectoryNoFollow(root);
    } catch (error) {
      return failure(`cannot prepare run directory ${root}: ${describe(error)}`);
    }
  }
  return success({
    out: root,
    has: (file) => existsSync(join(root, file)),
    write: (file, value, options) => writeAt(root, file, value, options),
    clear: () => clearRunDocuments(root),
  });
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Run writes in the order given, stopping at the first refusal: every
 *  multi-document write here has a commit order, and a later document must not
 *  land after an earlier one failed. */
function writeInOrder(writes: readonly (() => DomainResult<void, string>)[]): DomainResult<void, string> {
  for (const write of writes) {
    const written = write();
    if (!written.ok) return written;
  }
  return success(undefined);
}

// --- Document parsers, each owned by the core that defines the document ---

const readLedger = (store: Store): DomainResult<CoverageLedger, string> =>
  readRunDocument<CoverageLedger>(store.out, FILES.ledger, parseLedger);

const readRun = (store: Store): DomainResult<SecurityRunMetadata, string> =>
  readRunDocument<SecurityRunMetadata>(store.out, FILES.run, parseSecurityRunMetadata);

/** `start` writes the findings document, so an absent one means the file was
 *  lost or removed — not that the run has no findings (`readRunDocument`
 *  refuses it as missing). Treating absence as `[]` would silently reset the
 *  run's candidate set. */
const readFindings = (store: Store): DomainResult<readonly SecurityFinding[], string> =>
  readRunDocument<readonly SecurityFinding[]>(store.out, FILES.findings, parseSecurityFindings);

/** The published records. `publish` is the only operation that creates them, so
 *  their absence is a refusal rather than an empty list. */
const readPublished = (store: Store): DomainResult<readonly SecurityFinding[], string> =>
  readRunDocument<readonly SecurityFinding[]>(store.out, FILES.published, parseSecurityFindings);

/** The four documents adjudication reads, read ONCE through the shared seam:
 *  `findings`, `publish`, `status` and `verify --from` each project this one
 *  snapshot, so no projection reads a document twice or pairs a ledger with
 *  ballots from a different moment. */
type RunSnapshot = AuditSnapshot;

const readSnapshot = (store: Store): DomainResult<RunSnapshot, string> => readAuditSnapshot(store.out);

/**
 * The run metadata of a run that may still change. A published run is CLOSED:
 * its records were adjudicated over the ledger and ballots as they stood, and a
 * later assign, submit, defer, critic merge or ballot would leave
 * `security-findings.json` describing a run that no longer exists — while
 * `status` and `disposition` kept reading it as current.
 */
function openRun(store: Store, operation: SecurityAuditOperation): DomainResult<SecurityRunMetadata, string> {
  const run = readRun(store);
  if (!run.ok) return run;
  return run.value.published
    ? failure(
      `run ${run.value.runId} in ${store.out} is published — \`${operation}\` would change a run whose records are already committed. ` +
        "A published run is not re-opened; start a new run with `start --force`.",
    )
    : run;
}

// --- Flags ---

type Flags = Readonly<Record<string, string | null>>;

function parseFlags(args: readonly string[], allowed: readonly string[]): DomainResult<Flags, string> {
  const allowedSet = new Set(allowed);
  const unknown = unconsumedValueArguments(args, VALUE_FLAGS).filter((argument) => !argument.startsWith("--") || !allowed.includes(argument));
  if (unknown.length > 0) return failure(`unknown argument(s): ${unknown.join(" ")}; ${USAGE}`);
  for (const flag of VALUE_FLAGS) {
    if (args.includes(flag) && argumentValue(args, flag) === null) return failure(`${flag} requires a value; ${USAGE}`);
  }
  const flags: Record<string, string | null> = {};
  for (const flag of allowedSet) flags[flag] = argumentValue(args, flag);
  return success(flags);
}

const required = (flags: Flags, flag: string): DomainResult<string, string> => {
  const value = flags[flag];
  return value === null || value === undefined ? failure(`${flag} is required; ${USAGE}`) : success(value);
};

function integerFlag(flags: Flags, flag: string): DomainResult<number | null, string> {
  const value = flags[flag];
  if (value === null || value === undefined) return success(null);
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? success(parsed) : failure(`${flag} must be a positive integer`);
}

// --- start ---

/** The frozen revision a run pins. `--source` wins; otherwise the repository's
 *  own HEAD, read in the shell because it is I/O. A dirty worktree is recorded,
 *  never hidden: a run over uncommitted bytes must say so. */
function readSourceRevision(repo: string, explicit: string | null): DomainResult<SecurityRunMetadata["sourceRef"], string> {
  if (explicit !== null) {
    return /^[0-9a-f]{40}$/.test(explicit)
      ? success({ commit: explicit, worktreeDirty: false })
      : failure(`--source must be a 40-character commit sha, got ${JSON.stringify(explicit)}`);
  }
  try {
    // The one Git seam: the audit observes the target revision and whether
    // it is dirty, so its spawn is policy-bound like every other Git read.
    const commit = runGit(["rev-parse", "HEAD"], { output: "text", cwd: repo }).trim();
    const status = runGit(["status", "--porcelain"], { output: "text", cwd: repo }).trim();
    return /^[0-9a-f]{40}$/.test(commit)
      ? success({ commit, worktreeDirty: status !== "" })
      : failure(`git in ${repo} returned an unexpected revision ${JSON.stringify(commit)}`);
  } catch (error) {
    return failure(`cannot read the source revision in ${repo}: ${describe(error)} (pass --source to pin it explicitly)`);
  }
}

/** `start`'s inputs: the flags plus the seeded ledger, or the first refusal.
 *  Separated so `runStart` reads as the three steps it performs — resolve,
 *  derive, write — rather than as nine sequential validations. */
function startInputs(store: Store, args: readonly string[], stdin: string): DomainResult<Readonly<{
  repo: string;
  profile: SecurityProfile;
  budget: number | null;
  payload: SecurityAuditStart;
  ledger: CoverageLedger;
}>, string> {
  if (store.has(FILES.run) && !hasFlag(args, "--force")) {
    return failure(`${join(store.out, FILES.run)} already exists — this run directory holds a run; pass --force to start over`);
  }
  const repo = resolve(argumentValue(args, "--repo") ?? process.cwd());
  const profile = parseSecurityProfile(argumentValue(args, "--profile") ?? "standard");
  if (!profile.ok) return failure(profile.error.message);
  const budget = integerFlag({ "--budget": argumentValue(args, "--budget") }, "--budget");
  if (!budget.ok) return budget;
  const raw = parseJsonInput("start", stdin);
  if (!raw.ok) return raw;
  const payload = parseSecurityAuditStart(raw.value);
  if (!payload.ok) return failure(`start input is malformed —\n${describeAuditRefusal(payload.error)}`);
  const ledger = parseCoverageSeeds(payload.value.units);
  if (!ledger.ok) return failure(describeAuditRefusal(ledger.error));
  return success({ repo, profile: profile.value, budget: budget.value, payload: payload.value, ledger: ledger.value });
}

/** Write the five documents a fresh run starts with. One place, so a new file
 *  in the run directory is added to exactly one list (`FILES`). */
function writeFreshRun(
  store: Store,
  documents: Readonly<{ metadata: SecurityRunMetadata; ledger: CoverageLedger; selection: LensSelection }>,
): DomainResult<void, string> {
  const { metadata, ledger, selection } = documents;
  return writeInOrder([
    () => store.write(FILES.run, json(metadata)),
    () => store.write(FILES.ledger, json(ledger)),
    () => store.write(FILES.findings, json([])),
    () => store.write(FILES.verdicts, json([])),
    () => store.write(FILES.lenses, json({
      selected: selection.included.map((entry) => ({ lens: entry.lens, score: entry.score, reasons: entry.reasons })),
      excluded: selection.excluded,
      rendered: renderLensSelection(selection),
    })),
  ]);
}

function runStart(store: Store, args: readonly string[], stdin: string): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--repo", "--source", "--profile", "--budget", "--run-id", "--force"]);
  if (!flags.ok) return flags;
  const inputs = startInputs(store, args, stdin);
  if (!inputs.ok) return inputs;
  const { repo, profile, budget, payload, ledger } = inputs.value;

  const admitted = admitStart(profile, budget, ledger);
  if (!admitted.ok) return admitted;

  const revision = readSourceRevision(repo, flags.value["--source"] ?? null);
  if (!revision.ok) return revision;

  const started = startMetadata({
    directoryName: basename(store.out),
    repo,
    runId: flags.value["--run-id"] ?? null,
    profile,
    budget,
    sourceRef: revision.value,
  }, payload, ledger);
  const selfCheck = parseSecurityRunMetadata(started.metadata);
  if (!selfCheck.ok) return failure(`run metadata is malformed —\n${describeAuditRefusal(selfCheck.error)}`);

  // `--force` starts a NEW run in the same directory, so every document of the
  // previous run goes: its candidate findings, published records and prose would
  // otherwise enter this run's adjudication as if this run had produced them.
  if (hasFlag(args, "--force")) {
    const cleared = store.clear();
    if (!cleared.ok) return cleared;
  }

  const written = writeFreshRun(store, { metadata: started.metadata, ledger, selection: started.selection });
  if (!written.ok) return written;
  const authority = claimRunAuthority(store.out);
  if (!authority.ok) return authority;

  return success(startReport(store.out, started, ledger));
}

/**
 * After the fresh documents land (ADR-0067): create the runs root the
 * audit's verification runs live under — `orchestration start` never creates a
 * runs root — and register the run directory in the protected registry the
 * subagent write guard reads. A start whose run the guard cannot know is
 * refused, not left unprotected.
 */
function claimRunAuthority(out: string): DomainResult<void, string> {
  try {
    ensureDirectoryNoFollow(verificationRunsRoot(out));
  } catch (error) {
    return failure(`cannot prepare ${verificationRunsRoot(out)}: ${describe(error)}`);
  }
  return registerWithGuard(out);
}

/** Register the run directory with the subagent write guard's registry. */
function registerWithGuard(out: string): DomainResult<void, string> {
  const registered = registerSecurityAuditRun(out);
  return registered.ok ? registered : failure(`cannot register audit run ${out} with the subagent write guard: ${registered.error}`);
}

/**
 * Every WRITING operation on an existing run re-registers it BEFORE it writes
 * (ADR-0067 D6). Registration is idempotent, so on a healthy registry this is
 * a no-op; when the registry under the subagent directory was wiped mid-audit
 * (a `/tmp` cleaner, a reboot), the next write rebuilds it before mutating the
 * run, so the guard never stops protecting a run the parent is still writing.
 * A run the guard cannot know is not written. `start` registers after its
 * fresh documents land (`claimRunAuthority`); a directory without `run.json`
 * holds no run, and the operation itself refuses it.
 */
function refreshRunRegistration(store: Store, operation: SecurityAuditOperation): DomainResult<void, string> {
  if (operation === "start" || !securityAuditOperationWrites(operation) || !store.has(FILES.run)) return success(undefined);
  const registered = registerWithGuard(store.out);
  return registered.ok ? registered : failure(`${operation} refused: ${registered.error}`);
}

/** Admission BEFORE the run exists: a budget that cannot seat the first wave is
 *  refused here rather than discovered after the ledger is on disk. */
function admitStart(profile: SecurityProfile, budget: number | null, ledger: CoverageLedger): DomainResult<void, string> {
  if (budget === null) return success(undefined);
  const admission = admitWave({
    profile,
    budget,
    spent: 0,
    plannedHunters: ledger.filter((unit) => unit.status === "planned").length,
    expectedCandidates: null,
  });
  return admission.ok ? success(undefined) : failure(`${admission.error.reason}: ${admission.error.message}`);
}

/** What a start prints: the frozen facts, the coverage shape, and the lens
 *  selection with its reasons. */
function startReport(
  out: string,
  started: Readonly<{ metadata: SecurityRunMetadata; selection: LensSelection }>,
  ledger: CoverageLedger,
): string {
  const summary = summarizeCoverage(ledger);
  return [
    `run ${started.metadata.runId} started in ${out}`,
    `source ${started.metadata.sourceRef.commit}${started.metadata.sourceRef.worktreeDirty ? " (worktree dirty)" : ""}`,
    `profile ${started.metadata.profile}; budget ${started.metadata.budget ?? "unset"}`,
    `coverage units: ${summary.total} (planned ${summary.byStatus.planned})`,
    `lenses: ${started.metadata.selectedCompanions.join(", ") || "none"}`,
    "",
    renderLensSelection(started.selection),
  ].join("\n");
}

// --- assign / nonce / submit / defer / merge-critic ---

function runAssign(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--unit", "--agent", "--wave"]);
  if (!flags.ok) return flags;
  const unit = required(flags.value, "--unit");
  if (!unit.ok) return unit;
  const agent = required(flags.value, "--agent");
  if (!agent.ok) return agent;
  const wave = integerFlag(flags.value, "--wave");
  if (!wave.ok) return wave;
  const run = openRun(store, "assign");
  if (!run.ok) return run;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;

  // No wave given keeps the unit's own wave; `assignUnits` owns that default.
  const assigned = assignUnits(ledger.value, [{
    coverageId: unit.value,
    agentId: agent.value,
    ...(wave.value === null ? {} : { wave: wave.value }),
  }]);
  if (!assigned.ok) return failure(describeAuditRefusal(assigned.error));
  const written = store.write(FILES.ledger, json(assigned.value.ledger));
  if (!written.ok) return written;
  // The owner id is minted by the ledger, not echoed from `--agent`: a reassigned
  // unit runs under `<agent>--<n>`, and the hunter must settle under exactly it.
  // The nonce line is how the parent obtains a receipt binding for that owner: a
  // hunter cannot derive the nonce itself.
  return success(assigned.value.assigned
    .flatMap((entry) => [
      `assigned ${entry.coverageId} to owner ${entry.ownerId} at wave ${entry.wave}`,
      `nonce: loom helper security-audit nonce --out ${quoteShellArgument(store.out)} --artifact agents/${entry.ownerId}/artifacts/<file>`,
    ])
    .join("\n"));
}

/**
 * The sandbox binding for one artifact of a unit in flight: the nonce the
 * receipt must carry and the exact run the hunter is told to make. Whether the
 * artifact may be bound at all — an owned path whose owner is hunting right now,
 * not one an archived attempt already cited — is the coverage core's decision;
 * this reads the ledger and the frozen target, and writes nothing.
 */
function runNonce(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--artifact"]);
  if (!flags.ok) return flags;
  const artifact = required(flags.value, "--artifact");
  if (!artifact.ok) return artifact;
  const run = readRun(store);
  if (!run.ok) return run;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;

  const admitted = admitArtifactNonce(ledger.value, artifact.value);
  if (!admitted.ok) return failure(`nonce refused: ${describeAuditRefusal(admitted.error)}`);
  const { artifact: owned, coverageIds } = admitted.value;
  const binding = bindSandboxRun({ target: run.value.target, runDir: store.out, owner: owned.owner, artifact: owned.path });
  if (!binding.ok) return failure(`nonce refused: ${describeAuditRefusal(binding.error)}`);
  return success([
    `nonce ${binding.value.nonce} for ${owned.path} (owner ${owned.owner}; in flight: ${coverageIds.join(", ")})`,
    "",
    renderSandboxInstructions(DEFAULT_SANDBOX_LIMITS, binding.value),
  ].join("\n"));
}

/** Every `local` check's artifact must be a receipt of a run that stayed inside
 *  its sandbox. The engine reads the receipt file itself; a hunter's prose that
 *  it "ran bounded" is not evidence. Judging the receipt — bound to the nonce
 *  derived from the artifact path, inside every gated limit — is the sandbox
 *  core's; this only reads the bytes. */
function checkLocalReceipts(store: Store, results: readonly UnitResult[]): DomainResult<void, string> {
  for (const result of results) {
    for (const check of result.checks) {
      if (check.method !== "local" || check.artifact === null) continue;
      const text = readRunText(store.out, check.artifact);
      if (!text.ok) return text;
      const judged = judgeLocalReceipt(text.value, check.artifact);
      if (!judged.ok) return judged;
    }
  }
  return success(undefined);
}

/**
 * Settle a hunter's units and file its candidates.
 *
 * Every decision is a core's: the envelope is `parseHunterResult`'s, the receipt
 * judgement the sandbox core's, the merge of filed records `fileCandidates`'s
 * (a verbatim re-file converges; a re-filed fingerprint with different content
 * is REFUSED), and each unit's settlement `recordUnitResult`'s. All of them run
 * before the first write, so a refused submit leaves the run exactly as it was.
 */
function runSubmit(store: Store, args: readonly string[], stdin: string): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out"]);
  if (!flags.ok) return flags;
  const payload = parseJsonInput("submit", stdin);
  if (!payload.ok) return payload;
  const parsed = parseHunterResult(payload.value);
  if (!parsed.ok) return failure(`submit input is not a ${HUNTER_RESULT_KIND} —\n${describeAuditRefusal(parsed.error)}`);
  const { units: results, findings: filed } = parsed.value;
  const run = openRun(store, "submit");
  if (!run.ok) return run;
  // A `local` check claims something OBSERVED, so its receipt is read and
  // judged here: a run recorded as observed must rest on a sandbox that
  // finished zero, stayed inside its scratch allowance, and really applied
  // every limit (INV-S1). Prose is not evidence.
  const receipts = checkLocalReceipts(store, results);
  if (!receipts.ok) return receipts;

  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;
  const existing = readFindings(store);
  if (!existing.ok) return existing;

  const records = fileCandidates(existing.value, filed);
  if (!records.ok) return failure(`filed findings refused —\n${describeAuditRefusal(records.error)}`);
  const settlement = settleUnits(ledger.value, results);
  if (!settlement.ok) return settlement;
  const { ledger: next, settled } = settlement.value;

  // Findings FIRST, the ledger LAST. If the ledger write fails, the units are
  // still in flight and the findings are already on disk; the retried submit
  // settles them and re-files records the merge recognises, so it converges.
  // The other order lost the findings: the units were settled, and the retry
  // was refused because nothing was in flight any more.
  const written = writeInOrder([() => store.write(FILES.findings, json(records.value)), () => store.write(FILES.ledger, json(next))]);
  if (!written.ok) return written;
  return success(`settled ${settled.length} unit(s); run now holds ${records.value.length} finding record(s)`);
}

/** Settle every result against the ledger in memory; the caller persists once.
 *  A refusal names the unit, so a hunter is not left guessing which one broke. */
function settleUnits(
  ledger: CoverageLedger,
  results: readonly UnitResult[],
): DomainResult<Readonly<{ ledger: CoverageLedger; settled: readonly string[] }>, string> {
  let next = ledger;
  const settled: string[] = [];
  for (const result of results) {
    const recorded = recordUnitResult(next, result);
    if (!recorded.ok) return failure(describeAuditRefusal(recorded.error));
    next = recorded.value;
    settled.push(result.coverageId);
  }
  return success({ ledger: next, settled });
}

function runDefer(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--unit", "--reason"]);
  if (!flags.ok) return flags;
  const reason = required(flags.value, "--reason");
  if (!reason.ok) return reason;
  const run = openRun(store, "defer");
  if (!run.ok) return run;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;

  const unit = flags.value["--unit"];
  if (unit === null || unit === undefined) {
    const deferred = deferPlannedUnits(ledger.value, reason.value);
    if (!deferred.ok) return failure(describeAuditRefusal(deferred.error));
    const written = store.write(FILES.ledger, json(deferred.value));
    if (!written.ok) return written;
    return success(`deferred ${deferred.value.filter((entry) => entry.status === "deferred").length} planned unit(s): ${reason.value}`);
  }
  const deferred = deferUnit(ledger.value, unit, reason.value);
  if (!deferred.ok) return failure(describeAuditRefusal(deferred.error));
  const written = store.write(FILES.ledger, json(deferred.value));
  if (!written.ok) return written;
  return success(`deferred ${unit}: ${reason.value}`);
}

/** The keys a WRAPPED critic payload may carry: the critic document and the two
 *  maps the merge reads beside it. */
const CRITIC_WRAPPER_KEYS: readonly string[] = ["critic", "reassignmentReasons", "priorLeadOwners"];

/** A merge-critic payload is either the critic document itself, or a wrapper
 *  `{ critic, reassignmentReasons?, priorLeadOwners? }`. Only the wrapper can
 *  carry the maps (the critic document's own keys are closed), and a wrapper key
 *  the merge does not read is refused rather than ignored. */
function criticPayload(payload: unknown): DomainResult<Readonly<{
  critic: unknown;
  maps: Readonly<{ reassignmentReasons?: unknown; priorLeadOwners?: unknown }>;
}>, string> {
  if (!isWireRecord(payload) || !("critic" in payload)) return success({ critic: payload, maps: {} });
  const unknown = Object.keys(payload).filter((key) => !CRITIC_WRAPPER_KEYS.includes(key)).sort(compareStrings);
  if (unknown.length > 0) {
    return failure(unknown.map((key) => `${key}: unknown field (a wrapped critic payload carries ${CRITIC_WRAPPER_KEYS.join(", ")})`).join("\n"));
  }
  return success({ critic: payload.critic, maps: payload });
}

function runMergeCritic(store: Store, args: readonly string[], stdin: string): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--wave"]);
  if (!flags.ok) return flags;
  const payload = parseJsonInput("merge-critic", stdin);
  if (!payload.ok) return payload;
  const document = criticPayload(payload.value);
  if (!document.ok) return document;
  const critic = parseCriticResult(document.value.critic);
  if (!critic.ok) return failure(describeAuditRefusal(critic.error));
  const maps = parseCriticMergeMaps(document.value.maps);
  if (!maps.ok) return failure(describeAuditRefusal(maps.error));
  const wave = integerFlag(flags.value, "--wave");
  if (!wave.ok) return wave;
  const run = openRun(store, "merge-critic");
  if (!run.ok) return run;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;

  const merged = mergeCritic(ledger.value, critic.value, {
    // No wave given: the critic reviewed the run's latest wave.
    wave: wave.value ?? Math.max(1, ...ledger.value.map((unit) => unit.wave)),
    ...maps.value,
  });
  if (!merged.ok) return failure(describeAuditRefusal(merged.error));
  const written = store.write(FILES.ledger, json(merged.value.ledger));
  if (!written.ok) return written;
  return success([
    `accepted ${merged.value.accepted.length} unit(s)`,
    `reassigned ${merged.value.reassigned.length}`,
    `resolved ${merged.value.resolved.length} prior lead(s)`,
    ...(merged.value.collisions.length === 0 ? [] : [`collisions: ${merged.value.collisions.join(", ")}`]),
    `critic stop: ${critic.value.stop}`,
  ].join("\n"));
}

// --- verify / findings / publish / status ---

/** Why `verify` reads no ballots from stdin (ADR-0067 D4), and what replaces it. */
const STDIN_BALLOTS_REFUSED =
  "verify no longer accepts ballots on stdin: a ballot must come from an issued verifier spawn (ADR-0067). " +
  "Run `status` for the exact `helper orchestration start security-verification …` command, spawn the verifiers it " +
  "issues, then import the finished run with `verify --out <run-dir> --from <verification-run>`";

/**
 * `verify --from <verification-run>` (ADR-0067 D4): import a finished
 * verification run's published ballots. The run must live under this audit's
 * `verification-runs/`, be a registered `security-verification` program, and
 * hold a `result.json` that (1) describes the run as registered, issued for
 * THIS audit against its current ledger and findings, and (2) is byte-identical
 * to the result replayed from the run's own captured evidence — a hand-edited
 * result is refused. Stdin ballots are refused outright.
 */
async function runVerify(store: Store, args: readonly string[], stdin: string): Promise<DomainResult<string, string>> {
  const flags = parseFlags(args, ["--out", "--from"]);
  if (!flags.ok) return flags;
  if (stdin.trim() !== "") return failure(STDIN_BALLOTS_REFUSED);
  const from = flags.value["--from"];
  if (from === null || from === undefined) return failure(STDIN_BALLOTS_REFUSED);
  const run = openRun(store, "verify");
  if (!run.ok) return run;
  const source = readVerificationSource(store.out, from);
  if (!source.ok) return source;
  const snapshot = readSnapshot(store);
  if (!snapshot.ok) return snapshot;
  // The decision first (authentic audit, current digests, exact coverage),
  // then the proof that result.json is what the captured evidence replays.
  const imported = importVerificationResult({ registration: source.value.registration, result: source.value.result,
    audit: snapshot.value.reference, existing: snapshot.value.verdicts });
  if (!imported.ok) return failure(`verify --from ${source.value.registration.runId} refused: ${imported.error}`);
  // The replay hashes every transcript as it lies in the run and must
  // reproduce result.json byte for byte; each ballot's capture digest must
  // also be the one its capturing HARNESS attested. A transcript written into
  // the run by anything else carries no attestation.
  const proven = await proveVerificationSource(source.value);
  if (!proven.ok) return failure(`verify --from ${source.value.registration.runId} refused: ${proven.error}`);
  if (imported.value.added === 0) {
    return success(`verification run ${source.value.registration.runId} is already imported; run holds ${imported.value.verdicts.length} verdict(s)`);
  }
  const written = store.write(FILES.verdicts, json(imported.value.verdicts));
  if (!written.ok) return written;
  return success(`imported ${imported.value.added} bound verdict(s) from ${source.value.registration.runId}; run now holds ${imported.value.verdicts.length}`);
}

type Adjudicated = Readonly<{ findings: readonly SecurityFinding[]; blockers: readonly string[] }>;

/**
 * Adjudicate one snapshot. One call site, so `findings`, `publish` and
 * `status` cannot disagree about what the ballots mean.
 *
 * `verdicts.json` is a CACHE (ADR-0067, amended): before any ballot is
 * counted, every verification run it names is re-proven — registered under
 * this audit, its captured evidence replaying to exactly the cached ballots,
 * each backed by its harness's capture attestation. A ballot that fails is
 * not counted, and its run becomes a named publication blocker, so a ballot
 * written into `verdicts.json` by hand never reaches a report.
 */
async function adjudicate(snapshot: RunSnapshot): Promise<DomainResult<Adjudicated, string>> {
  const cache = await proveCachedBallots(snapshot);
  const decision = adjudicateRun({ ledger: snapshot.ledger, findings: snapshot.findings, verdicts: cache.admitted });
  if (!decision.ok) {
    // Fail closed, not empty: an owner the catalog cannot place means the run
    // cannot say which profile hunted, and an empty set would make every ballot
    // look like an independent model.
    return failure(
      `ledger names hunter ${JSON.stringify(decision.error.agentId)}, which the Agent Catalog cannot place; ` +
        "the run cannot prove verifier independence",
    );
  }
  return success({ findings: decision.value.findings, blockers: [...cache.blockers, ...decision.value.blockers] });
}

async function runFindings(store: Store, args: readonly string[]): Promise<DomainResult<string, string>> {
  const flags = parseFlags(args, ["--out", "--json"]);
  if (!flags.ok) return flags;
  const snapshot = readSnapshot(store);
  if (!snapshot.ok) return snapshot;
  const adjudicated = await adjudicate(snapshot.value);
  if (!adjudicated.ok) return adjudicated;

  if (hasFlag(args, "--json")) {
    // The JSON channel carries the refusal too: a bare array cannot distinguish
    // "no candidates" from "every confirmed claim is unverified", and the
    // second is the fact a machine caller most needs.
    return success(json({ findings: adjudicated.value.findings, publicationBlockers: adjudicated.value.blockers }));
  }
  const documents = renderRunDocuments({
    metadata: snapshot.value.run,
    ledger: snapshot.value.ledger,
    findings: adjudicated.value.findings,
    locator: store.out,
  });
  return success([
    documents["REPORT.md"] ?? "",
    ...(adjudicated.value.blockers.length === 0 ? [] : [
      "## Publication blockers",
      ...adjudicated.value.blockers.map((blocker) => `- ${blocker}`),
    ]),
  ].join("\n"));
}

async function runPublish(store: Store, args: readonly string[]): Promise<DomainResult<string, string>> {
  const flags = parseFlags(args, ["--out"]);
  if (!flags.ok) return flags;
  const snapshot = readSnapshot(store);
  if (!snapshot.ok) return snapshot;
  const adjudicated = await adjudicate(snapshot.value);
  if (!adjudicated.ok) return adjudicated;
  if (adjudicated.value.blockers.length > 0) {
    return failure(["publish refused:", ...adjudicated.value.blockers.map((blocker) => `  - ${blocker}`)].join("\n"));
  }

  // One derivation from the ledger, and no invented reason: `runStatusOf` owns
  // both fields (`start` and `status` read the same function).
  const { run, ledger } = snapshot.value;
  const status = runStatusOf(ledger);
  const metadata: SecurityRunMetadata = { ...run, ...status, published: true };
  // Parse what we are about to write. Every reader parses these records, so a
  // publish that wrote bytes its own reader refuses would report success a step
  // before the failure.
  const records = parseSecurityFindings(adjudicated.value.findings);
  if (!records.ok) return failure(`adjudicated records are malformed —\n${describeAuditRefusal(records.error)}`);

  const documents = renderRunDocuments({ metadata, ledger, findings: records.value, locator: store.out });
  const complete = status.runStatus === "complete";
  // Commit order: prose, then records, then `run.json` LAST. The `published`
  // flag is the commit point, so a write that fails part-way leaves the run
  // visibly unpublished rather than half-published.
  const written = writeInOrder([
    ...Object.entries(documents).map(([name, content]) => () => store.write(name, content)),
    () => store.write(FILES.published, json(records.value)),
    () => store.write(FILES.run, json(metadata)),
  ]);
  if (!written.ok) return written;
  const confirmed = records.value.filter((finding) => finding.verdict === "confirmed").length;
  const leads = records.value.filter((finding) => finding.verdict === "needs_validation").length;
  return success([
    `published ${records.value.length} record(s) to ${store.out}`,
    `confirmed ${confirmed}; needs_validation ${leads}`,
    `coverage ${complete ? "complete" : `incomplete (${status.incompleteReason})`}`,
    ...(complete ? [] : ["", "An incomplete run reports its gaps; it never claims coverage it did not reach."]),
  ].join("\n"));
}

/** The disposition handoff (P6). Reads the PUBLISHED records, not the
 *  candidates: a run that has not published has not adjudicated, and a decision
 *  set built over unadjudicated claims would hand `/review-and-fix` a finding no
 *  verifier ever saw. */
function runDisposition(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out"]);
  if (!flags.ok) return flags;
  const run = readRun(store);
  if (!run.ok) return run;
  if (!run.value.published) {
    return failure(`no published records in ${store.out} — run \`publish\` first`);
  }
  const published = readPublished(store);
  if (!published.ok) return published;

  const disposition = securityDisposition({ metadata: run.value, locator: store.out, findings: published.value });
  if (!disposition.ok) return failure(describeAuditRefusal(disposition.error));
  // The handoff is only a handoff if the next program can load it: the start
  // input is derived here, written beside the record, and validated against the
  // loader's own schema before either file is written.
  const start = standaloneDispositionStart(disposition.value);
  if (!start.ok) return failure(describeAuditRefusal(start.error));
  const written = store.write(FILES.disposition, json(disposition.value));
  if (!written.ok) return written;
  const handoff = store.write(FILES.dispositionHandoff, json(start.value));
  if (!handoff.ok) return handoff;
  const paths = dispositionHandoffPaths(store.out, run.value.runId);

  const count = (decision: string): number => disposition.value.entries.filter((entry) => entry.decision === decision).length;
  return success([
    `disposition set written to ${join(store.out, FILES.disposition)}`,
    `${count("accepted")} accepted; ${count("deferred")} deferred; ${count("dismissed")} dismissed`,
    "",
    renderDispositionHandoff(disposition.value, paths),
  ].join("\n"));
}

/** The verification run the audit owes now (ADR-0067): its runs root, run name
 *  and exact start input, issued for the run's latest wave under the first
 *  generation of its claim set that is not blocked or unimportable — or null
 *  when no confirmed claim awaits a ballot, or the run is already published.
 *  `retiredRuns` names every existing run that is dead to the planner, with
 *  the reason — blocked, unimportable, or unreadable (possibly transient) —
 *  so a new generation is never proposed without saying why. */
type VerificationStatus = Readonly<{
  awaitingBallots: number;
  runsRoot: string;
  run: string;
  input: VerificationStartPlan["input"];
  command: string;
  importCommand: string;
  retiredRuns: readonly Readonly<{ run: string; reason: string }>[];
}> | null;

async function verificationStatus(snapshot: RunSnapshot): Promise<DomainResult<VerificationStatus, string>> {
  if (snapshot.run.published) return success(null);
  const locator = snapshot.reference.locator;
  const generations = await observeVerificationGenerations(locator);
  if (!generations.ok) return generations;
  const plan = planVerificationStart({
    audit: snapshot.reference,
    wave: Math.max(1, ...snapshot.ledger.map((unit) => unit.wave)),
    findings: snapshot.findings,
    verdicts: snapshot.verdicts,
    observe: (run) => generations.value.get(run)?.state ?? "absent",
  });
  if (!plan.ok) return plan;
  if (plan.value === null) return success(null);
  const runsRoot = verificationRunsRoot(locator);
  return success({
    awaitingBallots: plan.value.briefs.reduce((count, brief) => count + brief.fingerprints.length, 0),
    runsRoot,
    run: plan.value.run,
    input: plan.value.input,
    command: renderVerificationStart(plan.value, runsRoot),
    importCommand: `loom helper security-audit verify --out ${quoteShellArgument(locator)} --from ${quoteShellArgument(plan.value.run)}`,
    retiredRuns: [...generations.value].flatMap(([run, observed]) => observed.state === "dead" ? [{ run, reason: observed.reason }] : []),
  });
}

/** The status document: one projection of the snapshot and its adjudication, so
 *  the JSON and the prose cannot describe different runs. The run's status is
 *  DERIVED from the ledger (`runStatusOf`), never read back from `run.json`'s
 *  copy, which is only as current as the last `start` or `publish`. */
function statusDocument(snapshot: RunSnapshot, adjudicated: Adjudicated, verification: VerificationStatus) {
  const { run, ledger } = snapshot;
  const summary = summarizeCoverage(ledger);
  const status = runStatusOf(ledger);
  const count = (verdict: SecurityFinding["verdict"]): number =>
    adjudicated.findings.filter((finding) => finding.verdict === verdict).length;
  return {
    runId: run.runId,
    profile: run.profile,
    source: run.sourceRef,
    runStatus: status.runStatus,
    incompleteReason: status.incompleteReason,
    lanes: run.selectedCompanions,
    coverage: {
      total: summary.total,
      byStatus: summary.byStatus,
      settled: coverageSettled(ledger),
      complete: coverageComplete(ledger),
    },
    findings: {
      records: snapshot.findings.length,
      verdicts: snapshot.verdicts.length,
      confirmed: count("confirmed"),
      needsValidation: count("needs_validation"),
      rejected: count("rejected"),
    },
    publicationBlockers: adjudicated.blockers,
    published: run.published,
    verification,
  };
}

async function runStatus(store: Store, args: readonly string[]): Promise<DomainResult<string, string>> {
  const flags = parseFlags(args, ["--out", "--json"]);
  if (!flags.ok) return flags;
  const snapshot = readSnapshot(store);
  if (!snapshot.ok) return snapshot;
  const adjudicated = await adjudicate(snapshot.value);
  if (!adjudicated.ok) return adjudicated;
  const verification = await verificationStatus(snapshot.value);
  if (!verification.ok) return verification;

  const status = statusDocument(snapshot.value, adjudicated.value, verification.value);
  if (hasFlag(args, "--json")) return success(json(status));
  return success([
    `run ${status.runId} (${status.profile}) — ${status.runStatus}`,
    `source ${status.source.commit}${status.source.worktreeDirty ? " (worktree dirty)" : ""}`,
    `coverage: ${status.coverage.total} unit(s), settled ${status.coverage.settled ? "yes" : "NO"}, complete ${status.coverage.complete ? "yes" : "NO"}`,
    ...Object.entries(status.coverage.byStatus)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `  ${name}: ${count}`),
    `findings: ${status.findings.records} record(s), ${status.findings.verdicts} verdict(s)`,
    `  confirmed ${status.findings.confirmed}; needs_validation ${status.findings.needsValidation}; rejected ${status.findings.rejected}`,
    ...(status.publicationBlockers.length === 0
      ? ["publication: ready"]
      : ["publication: blocked", ...status.publicationBlockers.map((blocker) => `  - ${blocker}`)]),
    ...(status.verification === null ? [] : [
      ...status.verification.retiredRuns.map(({ run, reason }) => `verification run ${run} is retired: ${reason}`),
      `verification: ${status.verification.awaitingBallots} confirmed claim(s) await a bound ballot; start their verification run with`,
      status.verification.command,
      `then spawn the verifiers it issues and import it: ${status.verification.importCommand}`,
    ]),
  ].join("\n"));
}

// --- Dispatch ---

export function createSecurityAuditHandler(
  writeText: (text: string) => void = (text) => { process.stdout.write(text.endsWith("\n") ? text : `${text}\n`); },
): HookHandler {
  return async (stdin, args): Promise<HookResult> => {
    const operation: SecurityAuditOperation | null = parseSecurityAuditOperation(args[0]);
    if (operation === null) return errorResult(`${USAGE}\nunknown operation ${JSON.stringify(args[0] ?? "")}`);

    const outFlag = argumentValue(args.slice(1), "--out");
    if (outFlag === null) return errorResult(`--out <run-dir> is required; ${USAGE}`);
    const store = openStore(outFlag, securityAuditOperationWrites(operation));
    if (!store.ok) return errorResult(store.error);
    const registered = refreshRunRegistration(store.value, operation);
    if (!registered.ok) return errorResult(registered.error);

    const flags = args.slice(1);
    const result = await matchOperation(operation, store.value, flags, stdin);
    if (!result.ok) return errorResult(result.error);
    writeText(result.value);
    return passthroughResult();
  };
}

const matchOperation = (
  operation: SecurityAuditOperation,
  store: Store,
  args: readonly string[],
  stdin: string,
): DomainResult<string, string> | Promise<DomainResult<string, string>> =>
  match(operation)
    .returnType<DomainResult<string, string> | Promise<DomainResult<string, string>>>()
    .with("start", () => runStart(store, args, stdin))
    .with("assign", () => runAssign(store, args))
    .with("nonce", () => runNonce(store, args))
    .with("submit", () => runSubmit(store, args, stdin))
    .with("defer", () => runDefer(store, args))
    .with("merge-critic", () => runMergeCritic(store, args, stdin))
    .with("verify", () => runVerify(store, args, stdin))
    .with("findings", () => runFindings(store, args))
    .with("publish", () => runPublish(store, args))
    .with("disposition", () => runDisposition(store, args))
    .with("status", () => runStatus(store, args))
    .exhaustive();

export default createSecurityAuditHandler();
