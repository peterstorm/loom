/**
 * The one harness the security-audit handler tests drive the CLI through: a
 * real temporary run directory and the handler invoked the way `cli.ts` invokes
 * it (`<op> --out <dir> …` with a stdin payload). A real directory, because the
 * run directory IS the contract — a later invocation reads back what an earlier
 * one wrote, so a stubbed store would not exercise what breaks in production.
 *
 * It also owns the run LIFECYCLE every suite starts from — `startRun`,
 * `huntedRun` (one confirmed claim filed) and `publishedRun` — so a change to
 * an operation's flags or payload is made here once, and each test shows only
 * what it varies.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SECURITY_AUDIT_RUN_FILES } from "../../src/core/audit-run-authority";
import type { DomainResult } from "../../src/core/orchestration-contract/identity";
import { parseVerificationVerdicts, type VerificationVerdict } from "../../src/core/security-adjudication";
import { canonicalCoverageId, parseSecurityRunMetadata, type SecurityProfile, type SecurityRunMetadata } from "../../src/core/security-audit-contract";
import { parseLedger, type CoverageLedger } from "../../src/core/security-coverage";
import { parseSecurityFindings, type SecurityFinding } from "../../src/core/security-findings";
import { readRunDocument } from "../../src/handlers/helpers/security-audit-run";
import { isJsonArray } from "../fixtures/json-wire";
import { HUNTER_ENVELOPE, aConfirmedFinding, aUnitResult, nSeeds, ok } from "../security/fixtures";
import { invokeAt, type Run } from "./security-audit-run-seam";
import { verifyWith } from "./security-verification-harness";

const created: string[] = [];

/** A fresh run directory and a handler bound to it. Every directory is removed
 *  by `removeRuns`, which each test file registers in `afterEach`.
 *
 *  `out` is the directory's real path — the one canonical spelling the helper
 *  reports a run under — so assertions on printed paths hold where the temp
 *  root sits behind a symlink (macOS: `/var` → `/private/var`). The aliased
 *  spelling is exercised on its own by the symlinked-base tests. */
export function aRun(prefix = "loom-security-audit-"): Run {
  const out = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(out);
  let printed = "";
  return {
    out,
    stdout: () => printed,
    invoke: async (args, stdin = "") => {
      // Each invocation keeps only its own output: tests assert on ONE
      // command's output, never on the accumulated transcript.
      const invoked = await invokeAt(out, args, stdin);
      printed = invoked.printed;
      return invoked.invocation;
    },
  };
}

export function removeRuns(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** One run document, read the way the audit reads it back (`readRunDocument`):
 *  no-follow, strict JSON, parsed by the core that owns it. A refusal throws,
 *  naming the file: a test never asserts on a document the engine would refuse. */
const readDocument = <T>(out: string, file: string, parse: (raw: unknown) => DomainResult<T, unknown>): T =>
  ok(readRunDocument(out, file, parse));

export const readRunMetadata = (out: string): SecurityRunMetadata => readDocument(out, SECURITY_AUDIT_RUN_FILES.run, parseSecurityRunMetadata);
export const readLedger = (out: string): CoverageLedger => readDocument(out, SECURITY_AUDIT_RUN_FILES.ledger, parseLedger);
/** The claims the hunt filed (`findings.json`). */
export const readClaims = (out: string): readonly SecurityFinding[] => readDocument(out, SECURITY_AUDIT_RUN_FILES.findings, parseSecurityFindings);
/** The adjudicated records `publish` wrote (`security-findings.json`). */
export const readPublished = (out: string): readonly SecurityFinding[] => readDocument(out, SECURITY_AUDIT_RUN_FILES.published, parseSecurityFindings);
export const readVerdicts = (out: string): readonly VerificationVerdict[] => readDocument(out, SECURITY_AUDIT_RUN_FILES.verdicts, parseVerificationVerdicts);

/** A run file the engine writes and never reads back (`disposition.json`), as
 *  the JSON it holds: the caller asserts on its shape. */
export const readJson = (out: string, file: string): unknown => JSON.parse(readFileSync(join(out, file), "utf8"));

/** The seed a test starts a run with, by index, so a unit id and its cell
 *  cannot drift: `unitIdFor(i)` is derived from exactly `seedFor(i)`. */
export const seedFor = (index: number) => nSeeds(index + 1)[index];
export const unitIdFor = (index: number): string => canonicalCoverageId(seedFor(index).refs);

/** Write a file under the run directory, creating its parents — how a test
 *  places the artifact a `local` check names. */
export function writeArtifact(run: Run, relativePath: string, content: string): void {
  const path = join(run.out, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Write ballots straight into `verdicts.json`, as a forger (or a stale cache)
 * would. Such a ballot is NEVER authority (ADR-0067, amended): the audit
 * re-proves every cached ballot against its verification run and capture
 * attestation before counting it. Tests use this only to drive refusals —
 * a countable ballot comes from `verifyWith` (`security-verification-harness`).
 */
export function handWriteBallots(run: Run, ballots: readonly unknown[]): void {
  // Read loosely on purpose: an earlier hand-written ballot may be one the parser refuses.
  const existing = readJson(run.out, SECURITY_AUDIT_RUN_FILES.verdicts);
  if (!isJsonArray(existing)) throw new Error("verdicts.json does not hold a list");
  writeFileSync(join(run.out, "verdicts.json"), `${JSON.stringify([...existing, ...ballots], null, 2)}\n`);
}

/** The run registry `start` writes lives under the protected subagent
 *  directory: point it at a scratch directory for the whole test file. Its
 *  real path, like `aRun`'s: verifier transcripts land beneath it and the
 *  capture path reads them without following symlinks, so an aliased temp root
 *  (macOS `/var` → `/private/var`) would refuse every capture with ELOOP. */
export function isolateSubagentDir(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-security-audit-subagents-")));
  created.push(directory);
  process.env.LOOM_SUBAGENT_DIR = directory;
  return directory;
}

// --- The run lifecycle ---

/** The pinned source revision every test run starts at. */
export const SOURCE = "0".repeat(40);

/** The start argv of a test run at `profile`, short of `--repo` (each run names its own). */
const startArgv = (profile: SecurityProfile): readonly string[] => ["start", "--source", SOURCE, "--profile", profile];

/** The start argv every test run uses unless it names a profile. */
export const STARTED = startArgv("standard");

/** The fingerprint of the one confirmed claim (`aConfirmedFinding`) a hunted run files. */
export const SQLI = "api/login:sqli-email";

/** Invoke a lifecycle step the test is not exercising: a refusal is a broken
 *  arrangement, so it throws, naming the step. */
export async function must(run: Run, args: readonly string[], stdin?: string): Promise<void> {
  const invoked = await run.invoke(args, stdin);
  if (!invoked.ok) throw new Error(`${args[0]}: ${invoked.error}`);
}

export type StartOptions = Readonly<{
  /** The seeded units (default: `seedFor(0)` alone). */
  units?: readonly unknown[];
  /** `--repo` (default: the run directory itself). */
  repo?: string;
  /** Stack signals for lens selection (default: none). */
  signals?: Readonly<Record<string, unknown>>;
  /** The budget profile (default: `standard`). */
  profile?: SecurityProfile;
  /** Extra flags after the start argv (`--force`, `--budget 12`, …). */
  flags?: readonly string[];
}>;

/** The `start` invocation (argv and payload) a test run starts with. */
export const startInvocation = (run: Run, options: StartOptions = {}): Readonly<{ args: readonly string[]; stdin: string }> => ({
  args: [...startArgv(options.profile ?? "standard"), "--repo", options.repo ?? run.out, ...(options.flags ?? [])],
  stdin: JSON.stringify({ units: options.units ?? [seedFor(0)], ...(options.signals === undefined ? {} : { signals: options.signals }) }),
});

/** Start `run`; a refused start throws. */
export async function startRun(run: Run, options: StartOptions = {}): Promise<Run> {
  const { args, stdin } = startInvocation(run, options);
  await must(run, args, stdin);
  return run;
}

/** Give unit `index` to the catalog hunter at wave 1. */
export const assignUnit = (run: Run, index = 0): Promise<void> =>
  must(run, ["assign", "--unit", unitIdFor(index), "--agent", "security-hunter-agent", "--wave", "1"]);

/** The hunter's submit that settles unit `index` as a candidate and files `finding`. */
export const claimPayload = (index = 0, finding: Record<string, unknown> = aConfirmedFinding()): string =>
  JSON.stringify({ ...HUNTER_ENVELOPE,
    units: [aUnitResult({ coverageId: unitIdFor(index), status: "candidate", fingerprints: [String(finding.fingerprint)] })],
    findings: [finding] });

export type HuntOptions = Readonly<{
  run?: Run;
  /** Two units: unit 1 is assigned too and left in flight. */
  units?: 1 | 2;
  signals?: StartOptions["signals"];
}>;

/** A run whose hunt filed ONE confirmed claim (`SQLI`) on unit 0:
 *  start → assign → submit. Nothing is verified yet. */
export async function huntedRun(options: HuntOptions = {}): Promise<Run> {
  const run = options.run ?? aRun();
  const units = options.units ?? 1;
  await startRun(run, { units: [seedFor(0), seedFor(1)].slice(0, units), signals: options.signals });
  await assignUnit(run, 0);
  if (units === 2) await assignUnit(run, 1);
  await must(run, ["submit"], claimPayload(0));
  return run;
}

/** A hunted run whose claim was verified through the real program and
 *  published: the closed, committed end of the lifecycle. */
export async function publishedRun(run: Run = aRun()): Promise<Run> {
  await huntedRun({ run });
  await verifyWith(run);
  await must(run, ["publish"]);
  return run;
}
