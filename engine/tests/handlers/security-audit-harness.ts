/**
 * The one harness the security-audit handler tests drive the CLI through: a
 * real temporary run directory and the handler invoked the way `cli.ts` invokes
 * it (`<op> --out <dir> …` with a stdin payload). A real directory, because the
 * run directory IS the contract — a later invocation reads back what an earlier
 * one wrote, so a stubbed store would not exercise what breaks in production.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 *  by `removeRuns`, which each test file registers in `afterEach`. */
export function aRun(prefix = "loom-security-audit-"): Run {
  const out = mkdtempSync(join(tmpdir(), prefix));
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
