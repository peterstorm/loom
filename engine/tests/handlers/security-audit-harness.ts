/**
 * The one harness the security-audit handler tests drive the CLI through: a
 * real temporary run directory and the handler invoked the way `cli.ts` invokes
 * it (`<op> --out <dir> …` with a stdin payload). A real directory, because the
 * run directory IS the contract — a later invocation reads back what an earlier
 * one wrote, so a stubbed store would not exercise what breaks in production.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";
import { canonicalCoverageId } from "../../src/core/security-audit-contract";
import { nSeeds } from "../security/fixtures";

export type Invocation = Readonly<{ ok: boolean; error: string | null }>;

export type Run = Readonly<{
  out: string;
  /** What the LAST invocation printed. */
  stdout: () => string;
  invoke: (args: readonly string[], stdin?: string) => Promise<Invocation>;
}>;

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
  const handler = createSecurityAuditHandler((text) => { printed += `${text}\n`; });
  return {
    out,
    stdout: () => printed,
    invoke: async (args, stdin = "") => {
      // Each invocation starts a fresh buffer: tests assert on ONE command's
      // output, never on the accumulated transcript.
      printed = "";
      const result = await handler(stdin, [args[0] ?? "", "--out", out, ...args.slice(1)]);
      return { ok: result?.kind !== "error", error: result?.kind === "error" ? String(result.message ?? "") : null };
    },
  };
}

export function removeRuns(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const readJson = <T>(out: string, file: string): T => JSON.parse(readFileSync(join(out, file), "utf8")) as T;

/** The seed a test starts a run with, by index, so a unit id and its cell
 *  cannot drift: `unitIdFor(i)` is derived from exactly `seedFor(i)`. */
export const seedFor = (index: number) => nSeeds(index + 1)[index]!;
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
  const existing = JSON.parse(readFileSync(join(run.out, "verdicts.json"), "utf8")) as unknown[];
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
