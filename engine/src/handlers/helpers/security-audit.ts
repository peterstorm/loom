/**
 * `helper security-audit <operation> …` — the registered security-audit
 * program's CLI (ADR-0064).
 *
 * This file is a SHELL. It reads the run directory, calls one pure core, and
 * writes back; every semantic decision (what a unit may settle as, whether a
 * claim is confirmed, what the report says) belongs to `core/security-*`. The
 * action set is closed: `security-audit-operations.ts` declares each operation's
 * traits, and the dispatcher below matches over it exhaustively, so a new
 * operation cannot be added without the routing layer learning what it does.
 *
 * The run directory is the whole record of a run:
 *
 *   run.json                 run metadata (frozen revision, scope, profile, budget)
 *   ledger.json              the coverage ledger
 *   findings.json            candidate findings as filed (trichotomy records)
 *   verdicts.json            verification ballots
 *   lenses.json              the lens selection this run was given
 *   security-findings.json   published records (publish)
 *   REPORT.md / FINDINGS-DETAIL.md / NEEDS-VALIDATION.md   derived prose (publish)
 *
 * Every read is fail-closed and parsed by the core that owns the document, so a
 * hand-edited or half-written file stops the run with a named violation instead
 * of flowing into a report. Writes go through the no-follow filesystem helpers:
 * a symlinked run file is refused rather than followed.
 */

import { match } from "ts-pattern";
import { runGit } from "../../utils/git-execution-policy";
import { existsSync, lstatSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { HookHandler, HookResult } from "../../types";
import { errorResult, passthroughResult } from "../../types";
import { failure, success, type DomainResult } from "../../core/orchestration-contract/identity";
import { compareStrings } from "../../core/ordering";
import { ensureDirectoryNoFollow, readRunFileNoFollow, writeRunFileExclusiveNoFollow, writeRunFileNoFollow } from "../../orchestration/no-follow-fs";
import {
  SECURITY_PROFILE_LENSES,
  admitWave,
  parseSecurityProfile,
  parseSecurityRunMetadata,
  type SecurityProfile,
  type SecurityRunMetadata,
  type SecurityScope,
} from "../../core/security-audit-contract";
import {
  assignUnits,
  coverageComplete,
  coverageSettled,
  deferPlannedUnits,
  deferUnit,
  mergeCritic,
  parseCoverageSeeds,
  parseCriticResult,
  parseUnitResults,
  recordUnitResult,
  summarizeCoverage,
  validateLedger,
  type CoverageLedger,
} from "../../core/security-coverage";
import { parseSecurityFindings, type SecurityFinding } from "../../core/security-findings";
import { parseVerificationVerdicts, publicationBlockers, publishedFindings, type VerificationVerdict } from "../../core/security-adjudication";
import { renderLensSelection, selectSecurityLenses, type LensSelection, type StackSignals } from "../../core/security-lens-select";
import { renderDispositionHandoff, securityDisposition } from "../../core/security-disposition";
import { renderRunDocuments } from "../../core/security-reports";
import { argumentValue, hasFlag, unconsumedValueArguments } from "./cli-args";
import {
  parseSecurityAuditOperation,
  SECURITY_AUDIT_OPERATIONS,
  type SecurityAuditOperation,
} from "./security-audit-operations";

const OPERATIONS = Object.keys(SECURITY_AUDIT_OPERATIONS).join("|");
const USAGE = `usage: helper security-audit <${OPERATIONS}> [flags]`;

const FILES = Object.freeze({
  run: "run.json",
  ledger: "ledger.json",
  findings: "findings.json",
  verdicts: "verdicts.json",
  lenses: "lenses.json",
  published: "security-findings.json",
  disposition: "disposition.json",
});

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--out", "--repo", "--source", "--profile", "--budget", "--run-id", "--unit", "--agent", "--wave", "--reason",
]);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Render any core error as one readable line: a `message`, a list of
 *  `violations`, or the JSON of whatever else the core refused with. */
function describeRefusal(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (Array.isArray(record.violations)) {
      return (record.violations as readonly { path?: string; message?: string }[])
        .map((violation) => `${violation.path ?? "$"}: ${violation.message ?? "invalid"}`)
        .join("\n");
    }
    if (typeof record.message === "string") return record.message;
  }
  return JSON.stringify(error);
}

// --- The run directory ---

type Store = Readonly<{
  out: string;
  has: (file: string) => boolean;
  readJson: <T>(file: string, parse: (raw: unknown) => DomainResult<T, unknown>) => DomainResult<T, string>;
  write: (file: string, value: string, options?: Readonly<{ exclusive?: boolean }>) => DomainResult<void, string>;
}>;

function openStore(out: string): DomainResult<Store, string> {
  const root = resolve(out);
  const prepare = (): DomainResult<void, string> => {
    try {
      ensureDirectoryNoFollow(root);
      return success(undefined);
    } catch (error) {
      return failure(`cannot prepare run directory ${root}: ${describe(error)}`);
    }
  };
  const store: Store = {
    out: root,
    has: (file) => existsSync(join(root, file)),
    readJson: (file, parse) => {
      const path = join(root, file);
      let text: string;
      try {
        text = readRunFileNoFollow(path);
      } catch (error) {
        return failure(`cannot read ${path}: ${describe(error)}`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        return failure(`${path} is not valid JSON: ${describe(error)}`);
      }
      const parsed = parse(raw);
      return parsed.ok ? parsed : failure(`${path} is malformed —\n${describeRefusal(parsed.error)}`);
    },
    write: (file, value, options) => {
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
    },
  };
  const prepared = prepare();
  return prepared.ok ? success(store) : prepared;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Sort a wire list by fingerprint when it is a list of objects that carry one;
 *  anything else passes through so the parser names the actual violation
 *  rather than a comparator returning NaN. */
function sortByFingerprint(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const fingerprintOf = (entry: unknown): string | null =>
    entry !== null && typeof entry === "object" && typeof (entry as { fingerprint?: unknown }).fingerprint === "string"
      ? (entry as { fingerprint: string }).fingerprint
      : null;
  return [...raw].sort((left, right) => {
    const a = fingerprintOf(left);
    const b = fingerprintOf(right);
    return a === null || b === null ? 0 : compareStrings(a, b);
  });
}

// --- Document parsers, each owned by the core that defines the document ---

const readLedger = (store: Store): DomainResult<CoverageLedger, string> =>
  store.readJson<CoverageLedger>(FILES.ledger, (raw) => {
    if (!Array.isArray(raw as unknown)) return failure({ violations: [{ path: "ledger", message: "expected a top-level array" }] });
    const violations = validateLedger(raw as CoverageLedger);
    return violations.length === 0 ? success(raw as CoverageLedger) : failure({ violations });
  });

const readRun = (store: Store): DomainResult<SecurityRunMetadata, string> =>
  store.readJson<SecurityRunMetadata>(FILES.run, parseSecurityRunMetadata);

const readFindings = (store: Store): DomainResult<readonly SecurityFinding[], string> =>
  store.has(FILES.findings)
    ? store.readJson<readonly SecurityFinding[]>(FILES.findings, parseSecurityFindings)
    : success([]);

const readVerdicts = (store: Store): DomainResult<readonly VerificationVerdict[], string> =>
  store.has(FILES.verdicts) ? store.readJson<readonly VerificationVerdict[]>(FILES.verdicts, parseVerificationVerdicts) : success([]);

/** The published records. `publish` is the only operation that creates them, so
 *  their absence is a refusal rather than an empty list. */
const readPublished = (store: Store): DomainResult<readonly SecurityFinding[], string> =>
  store.readJson<readonly SecurityFinding[]>(FILES.published, parseSecurityFindings);

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

type StartPayload = Readonly<{ units: readonly unknown[]; signals: StackSignals | null; scope: Readonly<{ kind: "tree" | "diff"; baseRef: string | null; headRef: string | null }> | null }>;

const EMPTY_SIGNALS: StackSignals = {
  languages: [], manifests: [], servesHttp: false, rendersClientSide: false, drivesModelsOrTools: false,
  usesQueuesOrRpc: false, isolatesTenants: false, deploysInfrastructure: false, hasNativeMemory: false,
  hasAppOrLocalIpc: false, hasReleasePipelines: false, hasSharedResourcePressure: false,
};

function parseStartPayload(stdin: string): DomainResult<StartPayload, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch (error) {
    return failure(`start input is not valid JSON: ${describe(error)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return failure("start input must be an object");
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.units as unknown)) return failure("start input requires a `units` array");
  const signals = record.signals;
  const scope = record.scope;
  return success({
    units: record.units as readonly unknown[],
    signals: signals !== null && typeof signals === "object" && !Array.isArray(signals)
      ? { ...EMPTY_SIGNALS, ...(signals as Partial<StackSignals>) }
      : null,
    scope: scope !== null && typeof scope === "object" && (scope as { kind?: unknown }).kind !== undefined
      ? {
        kind: (scope as { kind: "tree" | "diff" }).kind === "diff" ? "diff" : "tree",
        baseRef: typeof (scope as { baseRef?: unknown }).baseRef === "string" ? (scope as { baseRef: string }).baseRef : null,
        headRef: typeof (scope as { headRef?: unknown }).headRef === "string" ? (scope as { headRef: string }).headRef : null,
      }
      : null,
  });
}

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

/** Everything `start` derives — run identity, scope, lens selection — assembled
 *  in one pure step so the shell's job is only: read the payload, write files. */
function startMetadata(input: Readonly<{
  out: string;
  repo: string;
  runId: string | undefined;
  metadata: Readonly<{ profile: SecurityProfile; budget: number | null; sourceRef: SecurityRunMetadata["sourceRef"] }>;
  payload: StartPayload;
  ledger: CoverageLedger;
}>): Readonly<{ metadata: SecurityRunMetadata; selection: LensSelection }> {
  const scopePaths = [...new Set(input.ledger.flatMap((unit) => unit.starting_paths))].sort(compareStrings);
  const scope: SecurityScope = {
    paths: scopePaths,
    kind: input.payload.scope?.kind ?? "tree",
    baseRef: input.payload.scope?.baseRef ?? null,
    headRef: input.payload.scope?.headRef ?? null,
  };
  const selection: LensSelection = selectSecurityLenses(input.payload.signals ?? EMPTY_SIGNALS, {
    maxLenses: SECURITY_PROFILE_LENSES[input.metadata.profile],
  });
  return {
    selection,
    metadata: {
      schemaVersion: 1,
      runId: input.runId ?? `${basename(input.out)}-${input.metadata.sourceRef.commit.slice(0, 12)}`,
      repo: input.repo,
      target: input.repo,
      profile: input.metadata.profile,
      scope,
      scopePaths,
      sourceRef: input.metadata.sourceRef,
      budget: input.metadata.budget,
      executionPolicy: "sandboxed-source-and-local-only",
      selectedCompanions: selection.included.map((entry) => entry.lens),
      priorRuns: [],
      runStatus: coverageSettled(input.ledger) ? "complete" : "in_progress",
      incompleteReason: null,
    },
  };
}

/** `start`'s inputs: the flags plus the seeded ledger, or the first refusal.
 *  Separated so `runStart` reads as the three steps it performs — resolve,
 *  derive, write — rather than as nine sequential validations. */
function startInputs(store: Store, args: readonly string[], stdin: string): DomainResult<Readonly<{
  repo: string;
  profile: SecurityProfile;
  budget: number | null;
  payload: StartPayload;
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
  const payload = parseStartPayload(stdin);
  if (!payload.ok) return payload;
  const ledger = parseCoverageSeeds(payload.value.units);
  if (!ledger.ok) return failure(describeRefusal(ledger.error));
  return success({ repo, profile: profile.value, budget: budget.value, payload: payload.value, ledger: ledger.value });
}

/** Write the four documents a fresh run starts with. One place, so a new file
 *  in the run directory is added to exactly one list. */
function writeFreshRun(
  store: Store,
  documents: Readonly<{ metadata: SecurityRunMetadata; ledger: CoverageLedger; selection: LensSelection }>,
): DomainResult<void, string> {
  const { metadata, ledger, selection } = documents;
  for (const write of [
    store.write(FILES.run, json(metadata)),
    store.write(FILES.ledger, json(ledger)),
    store.write(FILES.verdicts, json([])),
    store.write(FILES.lenses, json({
      selected: selection.included.map((entry) => ({ lens: entry.lens, score: entry.score, reasons: entry.reasons })),
      excluded: selection.excluded,
      rendered: renderLensSelection(selection),
    })),
  ]) {
    if (!write.ok) return write;
  }
  return success(undefined);
}

function runStart(store: Store, args: readonly string[], stdin: string): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--repo", "--source", "--profile", "--budget", "--run-id", "--force"]);
  if (!flags.ok) return flags;
  const inputs = startInputs(store, args, stdin);
  if (!inputs.ok) return inputs;
  const { repo, profile, budget, payload, ledger } = inputs.value;

  // Admission before the run exists: a budget that cannot seat the first wave
  // is refused here rather than discovered after the ledger is on disk.
  if (budget !== null) {
    const admission = admitWave({
      profile,
      budget,
      spent: 0,
      plannedHunters: ledger.filter((unit) => unit.status === "planned").length,
      expectedCandidates: null,
    });
    if (!admission.ok) return failure(`${admission.error.reason}: ${admission.error.message}`);
  }

  const revision = readSourceRevision(repo, flags.value["--source"] ?? null);
  if (!revision.ok) return revision;

  const started = startMetadata({
    out: store.out,
    repo,
    runId: flags.value["--run-id"] ?? undefined,
    metadata: { profile, budget, sourceRef: revision.value },
    payload,
    ledger,
  });
  const selfCheck = parseSecurityRunMetadata(started.metadata);
  if (!selfCheck.ok) return failure(`run metadata is malformed —\n${describeRefusal(selfCheck.error)}`);

  const written = writeFreshRun(store, { metadata: started.metadata, ledger, selection: started.selection });
  if (!written.ok) return written;

  const summary = summarizeCoverage(ledger);
  return success([
    `run ${started.metadata.runId} started in ${store.out}`,
    `source ${started.metadata.sourceRef.commit}${started.metadata.sourceRef.worktreeDirty ? " (worktree dirty)" : ""}`,
    `profile ${started.metadata.profile}; budget ${started.metadata.budget ?? "unset"}`,
    `coverage units: ${summary.total} (planned ${summary.byStatus.planned})`,
    `lenses: ${started.metadata.selectedCompanions.join(", ") || "none"}`,
    "",
    renderLensSelection(started.selection),
  ].join("\n"));
}

// --- assign / submit / defer / merge-critic ---

function runAssign(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--unit", "--agent", "--wave"]);
  if (!flags.ok) return flags;
  const unit = required(flags.value, "--unit");
  if (!unit.ok) return unit;
  const agent = required(flags.value, "--agent");
  if (!agent.ok) return agent;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;

  const target = ledger.value.find((candidate) => candidate.coverage_id === unit.value);
  if (target === undefined) return failure(`unknown coverage unit ${JSON.stringify(unit.value)}`);
  const wave = integerFlag(flags.value, "--wave");
  if (!wave.ok) return wave;

  const assigned = assignUnits(ledger.value, [{
    coverageId: unit.value,
    agentId: agent.value,
    wave: wave.value ?? target.wave,
  }]);
  if (!assigned.ok) return failure(describeRefusal(assigned.error));
  const written = store.write(FILES.ledger, json(assigned.value));
  if (!written.ok) return written;
  return success(`assigned ${unit.value} to ${agent.value} at wave ${wave.value ?? target.wave}`);
}

function runSubmit(store: Store, args: readonly string[], stdin: string): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out"]);
  if (!flags.ok) return flags;
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch (error) {
    return failure(`submit input is not valid JSON: ${describe(error)}`);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return failure("submit input must be an object with `units` and optional `findings`");
  }
  const record = payload as Record<string, unknown>;
  const results = parseUnitResults(record.units ?? []);
  if (!results.ok) return failure(describeRefusal(results.error));
  // The DOCUMENT is sorted by fingerprint; a hunter's WIRE is its own filing
  // order. Sort before parsing so a hunter is not refused for formatting, while
  // duplicates still fail: the parser checks uniqueness after the sort.
  const filed = record.findings === undefined
    ? success([] as readonly SecurityFinding[])
    : parseSecurityFindings(sortByFingerprint(record.findings));
  if (!filed.ok) return failure(describeRefusal(filed.error));

  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;
  const existing = readFindings(store);
  if (!existing.ok) return existing;

  let next = ledger.value;
  const settled: string[] = [];
  for (const result of results.value) {
    const recorded = recordUnitResult(next, result);
    if (!recorded.ok) return failure(describeRefusal(recorded.error));
    next = recorded.value;
    settled.push(result.coverageId);
  }
  if (settled.length === 0 && filed.value.length === 0) return failure("submit carried neither unit results nor findings");

  const merged = [...existing.value, ...filed.value].sort((left, right) => compareStrings(left.fingerprint, right.fingerprint));
  const consolidated = parseSecurityFindings(merged);
  if (!consolidated.ok) return failure(`filed findings are malformed —\n${describeRefusal(consolidated.error)}`);

  for (const write of [store.write(FILES.ledger, json(next)), store.write(FILES.findings, json(consolidated.value))]) {
    if (!write.ok) return write;
  }
  return success(`settled ${settled.length} unit(s); run now holds ${consolidated.value.length} finding record(s)`);
}

function runDefer(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--unit", "--reason"]);
  if (!flags.ok) return flags;
  const reason = required(flags.value, "--reason");
  if (!reason.ok) return reason;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;

  const unit = flags.value["--unit"];
  if (unit === null || unit === undefined) {
    const deferred = deferPlannedUnits(ledger.value, reason.value);
    const written = store.write(FILES.ledger, json(deferred));
    if (!written.ok) return written;
    return success(`deferred ${deferred.filter((entry) => entry.status === "deferred").length} planned unit(s): ${reason.value}`);
  }
  const deferred = deferUnit(ledger.value, unit, reason.value);
  if (!deferred.ok) return failure(describeRefusal(deferred.error));
  const written = store.write(FILES.ledger, json(deferred.value));
  if (!written.ok) return written;
  return success(`deferred ${unit}: ${reason.value}`);
}

function runMergeCritic(store: Store, args: readonly string[], stdin: string): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--wave"]);
  if (!flags.ok) return flags;
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch (error) {
    return failure(`merge-critic input is not valid JSON: ${describe(error)}`);
  }
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  // Accept both `{ critic: … }` and a bare critic document.
  const critic = parseCriticResult(record.critic ?? payload);
  if (!critic.ok) return failure(describeRefusal(critic.error));
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;
  const wave = integerFlag(flags.value, "--wave");
  if (!wave.ok) return wave;

  const reasons = record.reassignmentReasons !== null && typeof record.reassignmentReasons === "object"
    ? record.reassignmentReasons as Readonly<Record<string, string>>
    : {};
  const merged = mergeCritic(ledger.value, critic.value, {
    wave: wave.value ?? Math.max(1, ...ledger.value.map((unit) => unit.wave)),
    reassignmentReasons: reasons,
    ...(record.priorLeadOwners !== null && typeof record.priorLeadOwners === "object"
      ? { priorLeadOwners: record.priorLeadOwners as Readonly<Record<string, string>> }
      : {}),
  });
  if (!merged.ok) return failure(describeRefusal(merged.error));
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

function runVerify(store: Store, args: readonly string[], stdin: string): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out"]);
  if (!flags.ok) return flags;
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch (error) {
    return failure(`verify input is not valid JSON: ${describe(error)}`);
  }
  const raw = payload !== null && typeof payload === "object" && !Array.isArray(payload) && "verdicts" in payload
    ? (payload as { verdicts: unknown }).verdicts
    : payload;
  const verdicts = parseVerificationVerdicts(raw);
  if (!verdicts.ok) return failure(describeRefusal(verdicts.error));

  const existing = readVerdicts(store);
  if (!existing.ok) return existing;
  // Ballots accumulate: a later wave adds verdicts without discarding an
  // earlier wave's. Re-parsing the union keeps the accumulation fail-closed.
  const combined = parseVerificationVerdicts([...existing.value, ...verdicts.value]);
  if (!combined.ok) return failure(describeRefusal(combined.error));
  const written = store.write(FILES.verdicts, json(combined.value));
  if (!written.ok) return written;
  return success(`recorded ${verdicts.value.length} verdict(s); run now holds ${combined.value.length}`);
}

/** Adjudicate the run. One call site, so `findings` and `publish` cannot
 *  disagree about what the ballots mean. */
function adjudicate(store: Store, run: SecurityRunMetadata): DomainResult<Readonly<{
  findings: readonly SecurityFinding[];
  blockers: readonly string[];
}>, string> {
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;
  const findings = readFindings(store);
  if (!findings.ok) return findings;
  const verdicts = readVerdicts(store);
  if (!verdicts.ok) return verdicts;

  const input = { findings: findings.value, verdicts: verdicts.value, huntProfile: run.profile };
  return success({
    findings: publishedFindings(input),
    blockers: publicationBlockers({ ...input, ledgerSettled: coverageSettled(ledger.value) }),
  });
}

function runFindings(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--json"]);
  if (!flags.ok) return flags;
  const run = readRun(store);
  if (!run.ok) return run;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;
  const adjudicated = adjudicate(store, run.value);
  if (!adjudicated.ok) return adjudicated;

  const input = { metadata: run.value, ledger: ledger.value, findings: adjudicated.value.findings };
  if (hasFlag(args, "--json")) return success(json(adjudicated.value.findings));
  const documents = renderRunDocuments(input);
  return success([
    documents["REPORT.md"] ?? "",
    ...(adjudicated.value.blockers.length === 0 ? [] : [
      "## Publication blockers",
      ...adjudicated.value.blockers.map((blocker) => `- ${blocker}`),
    ]),
  ].join("\n"));
}

function runPublish(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out"]);
  if (!flags.ok) return flags;
  const run = readRun(store);
  if (!run.ok) return run;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;
  const adjudicated = adjudicate(store, run.value);
  if (!adjudicated.ok) return adjudicated;
  if (adjudicated.value.blockers.length > 0) {
    return failure(["publish refused:", ...adjudicated.value.blockers.map((blocker) => `  - ${blocker}`)].join("\n"));
  }

  const complete = coverageComplete(ledger.value);
  const metadata: SecurityRunMetadata = {
    ...run.value,
    runStatus: complete ? "complete" : "incomplete",
    incompleteReason: complete ? null : run.value.incompleteReason ?? "critic_budget_exhausted",
  };
  const documents = renderRunDocuments({ metadata, ledger: ledger.value, findings: adjudicated.value.findings, locator: store.out });
  for (const write of [
    store.write(FILES.published, json(adjudicated.value.findings)),
    store.write(FILES.run, json(metadata)),
    ...Object.entries(documents).map(([name, content]) => store.write(name, content)),
  ]) {
    if (!write.ok) return write;
  }
  const confirmed = adjudicated.value.findings.filter((finding) => finding.verdict === "confirmed").length;
  const leads = adjudicated.value.findings.filter((finding) => finding.verdict === "needs_validation").length;
  return success([
    `published ${adjudicated.value.findings.length} record(s) to ${store.out}`,
    `confirmed ${confirmed}; needs_validation ${leads}`,
    `coverage ${complete ? "complete" : `incomplete (${metadata.incompleteReason})`}`,
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
  if (!store.has(FILES.published)) {
    return failure(`no published records in ${store.out} — run \`publish\` first`);
  }
  const published = readPublished(store);
  if (!published.ok) return published;

  const disposition = securityDisposition({ metadata: run.value, locator: store.out, findings: published.value });
  if (!disposition.ok) return failure(describeRefusal(disposition.error));
  const written = store.write(FILES.disposition, json(disposition.value));
  if (!written.ok) return written;

  const count = (decision: string): number => disposition.value.entries.filter((entry) => entry.decision === decision).length;
  return success([
    `disposition set written to ${join(store.out, FILES.disposition)}`,
    `${count("accepted")} accepted; ${count("deferred")} deferred; ${count("dismissed")} dismissed`,
    "",
    renderDispositionHandoff(disposition.value),
  ].join("\n"));
}

/** The status document: one projection of (metadata, ledger, findings, verdicts)
 *  so the JSON and the prose cannot describe different runs. */
function statusDocument(input: Readonly<{
  run: SecurityRunMetadata;
  ledger: CoverageLedger;
  findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[];
  adjudicated: Readonly<{ findings: readonly SecurityFinding[]; blockers: readonly string[] }>;
  published: boolean;
}>) {
  const summary = summarizeCoverage(input.ledger);
  const count = (verdict: SecurityFinding["verdict"]): number =>
    input.adjudicated.findings.filter((finding) => finding.verdict === verdict).length;
  return {
    runId: input.run.runId,
    profile: input.run.profile,
    source: input.run.sourceRef,
    runStatus: input.run.runStatus,
    incompleteReason: input.run.incompleteReason,
    lanes: input.run.selectedCompanions,
    coverage: {
      total: summary.total,
      byStatus: summary.byStatus,
      settled: coverageSettled(input.ledger),
      complete: coverageComplete(input.ledger),
    },
    findings: {
      records: input.findings.length,
      verdicts: input.verdicts.length,
      confirmed: count("confirmed"),
      needsValidation: count("needs_validation"),
      rejected: count("rejected"),
    },
    publicationBlockers: input.adjudicated.blockers,
    published: input.published,
  };
}

function runStatus(store: Store, args: readonly string[]): DomainResult<string, string> {
  const flags = parseFlags(args, ["--out", "--json"]);
  if (!flags.ok) return flags;
  const run = readRun(store);
  if (!run.ok) return run;
  const ledger = readLedger(store);
  if (!ledger.ok) return ledger;
  const findings = readFindings(store);
  if (!findings.ok) return findings;
  const verdicts = readVerdicts(store);
  if (!verdicts.ok) return verdicts;
  const adjudicated = adjudicate(store, run.value);
  if (!adjudicated.ok) return adjudicated;

  const status = statusDocument({
    run: run.value,
    ledger: ledger.value,
    findings: findings.value,
    verdicts: verdicts.value,
    adjudicated: adjudicated.value,
    published: store.has(FILES.published),
  });
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
    const store = openStore(outFlag);
    if (!store.ok) return errorResult(store.error);

    const flags = args.slice(1);
    const result = matchOperation(operation, store.value, flags, stdin);
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
): DomainResult<string, string> =>
  match(operation)
    .with("start", () => runStart(store, args, stdin))
    .with("assign", () => runAssign(store, args))
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
