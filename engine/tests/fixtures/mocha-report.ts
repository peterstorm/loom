/**
 * Mocha-shaped JUnit fixtures. Mocha's xunit reporter writes one
 * `<testsuite>` and each `<testcase>`'s `file` as an absolute path beneath the
 * cwd the runner ran in, the shape `parseJunitTestcasesUnder` reads against a
 * run root.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalRoot } from "./owner-verification-repo";

/** A real, canonical directory to stand for the root a runner ran in. */
export const RUN_ROOT: CanonicalRepositoryRoot = canonicalRoot(realpathSync.native(tmpdir()));

export type MochaCase = Readonly<{ file: string; name: string; failure?: string }>;

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A Mocha xunit report over `cases`; a case with `failure` carries it as its `<failure>` text. */
export function mochaXunit(cases: readonly MochaCase[]): Uint8Array {
  const failing = cases.filter(({ failure }) => failure !== undefined).length;
  return new TextEncoder().encode(
    `<testsuite name="Mocha Tests" tests="${cases.length}" failures="0" errors="${failing}">` +
    cases.map(({ file, name, failure }) => `<testcase classname="suite" name="${escape(name)}" file="${escape(file)}">` +
      (failure === undefined ? "" : `<failure>${escape(failure)}</failure>`) + "</testcase>").join("") +
    "</testsuite>",
  );
}
