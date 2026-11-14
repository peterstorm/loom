/**
 * Every command and path the engine prints that names the Loom package, for
 * someone working in ANOTHER repository to run or read.
 *
 * No `loom` binary is installed (neither `package.json` declares a `bin`), and
 * whoever runs a printed line — an operator, a parent session, an implementer,
 * a hunter — is working in the repository under orchestration or audit, never
 * in the Loom package. So a printed command names the executing package's own
 * `cli.ts` by absolute path, as one shell-quoted word, and runs unchanged from
 * any directory; a printed path (the sandbox script, a lens document) is
 * absolute for the same reason.
 *
 * The package root is parsed once (`parseLoomPackageRoot`), and `loomCommands`
 * is the one place a spelling is built from it: a renderer receives the
 * `LoomCommands` value and prints what it holds, so a change to how a helper
 * command is spelled is made here and nowhere else. The shell supplies the
 * running package's value (`utils/loom-package-root`); nothing here reads the
 * filesystem.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { SECURITY_VERIFICATION_PROGRAM } from "./orchestration-contract/programs";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import type { SecurityLens } from "./security-lenses";
import { quoteShellArgument } from "./shell-quoting";

declare const loomPackageRoot: unique symbol;

/** The absolute root of a Loom package, as `parseLoomPackageRoot` admitted it. */
export type LoomPackageRoot = string & Readonly<{ [loomPackageRoot]: true }>;

/** Why a string is not a package root every printed spelling can be built on. */
export type LoomPackageRootRefusal =
  /** A relative root names a different package from every other directory. */
  | Readonly<{ kind: "relative"; message: string }>
  /** Each spelling appends `/<path>`, so a trailing separator would double it. */
  | Readonly<{ kind: "trailing-separator"; message: string }>
  /** A printed command is one line, and a lens path one prompt line. */
  | Readonly<{ kind: "control-character"; message: string }>;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The brand's minting step. Only `parseLoomPackageRoot` calls it, after every check passed. */
const asLoomPackageRoot = (raw: string): LoomPackageRoot => raw as LoomPackageRoot;

/** `raw` as a package root, or the refusal naming why no printed spelling may be built on it. */
export function parseLoomPackageRoot(raw: string): DomainResult<LoomPackageRoot, LoomPackageRootRefusal> {
  const named = JSON.stringify(raw);
  if (!raw.startsWith("/")) {
    return failure({ kind: "relative", message: `the Loom package root ${named} must be an absolute path` });
  }
  if (raw.endsWith("/")) {
    return failure({ kind: "trailing-separator", message: `the Loom package root ${named} must not end in a path separator` });
  }
  if (CONTROL_CHARACTER.test(raw)) {
    return failure({ kind: "control-character", message: `the Loom package root ${named} must not hold a control character` });
  }
  return success(asLoomPackageRoot(raw));
}

declare const sandboxScript: unique symbol;

/** The sandbox executor of one Loom package: only `loomCommands` builds one,
 *  so a sandbox run cannot name any other executable. */
export type SandboxScript = string & Readonly<{ [sandboxScript]: true }>;

/** The programs whose start command the engine prints: the audit's verifier
 *  spawns, and the disposition handoff to `/review-and-fix`. */
export type PrintedStartProgram = typeof SECURITY_VERIFICATION_PROGRAM | "standalone-disposition";

/** The brand's minting step. Only `loomCommands` calls it, on a path built from a parsed root. */
const asSandboxScript = (path: string): SandboxScript => path as SandboxScript;

/** Every spelling that names one Loom package. Each member is a plain value or
 *  a function closed over the root, so it can be passed on its own. */
export type LoomCommands = Readonly<{
  /** The Task mutation check for `taskId`, run from the repository the
   *  TaskGraph lives in. The brief and a stop's block both print it, so an
   *  implementer is never told two forms. */
  mutationCheck: (taskId: string) => string;
  /** How the parent obtains the receipt binding for one of `owner`'s artifacts
   *  in the run at `runDir` (a hunter cannot derive the nonce itself): the line
   *  `assign` prints under each minted owner. `<file>` is the one word left for
   *  the parent to fill in, so this line is not run verbatim. */
  auditNonce: (runDir: string, owner: string) => string;
  /** The import of the finished verification run `run` into the audit at
   *  `locator`: the line `status` prints after the start command, and the one
   *  the Pi import gate reads `--out` and `--from` from statically. */
  verificationImport: (locator: string, run: string) => string;
  /** The words a printed `orchestration start` begins with: `program` under
   *  `runsRoot`. Each caller lays out `--run` and the input after them. */
  orchestrationStart: (program: PrintedStartProgram, runsRoot: string) => string;
  /** The one sandbox executor. A hunter works in the audited repository, so
   *  every printed sandbox run names the script by this absolute path. */
  sandboxScript: SandboxScript;
  /** Where `lens` lives in the package: a hunter works in the audited
   *  repository, where a package-relative path names nothing. */
  securityLens: (lens: SecurityLens) => string;
}>;

/** The printed commands and paths of the Loom package at `root`. */
export function loomCommands(root: LoomPackageRoot): LoomCommands {
  const helper = `bun ${quoteShellArgument(`${root}/engine/src/cli.ts`)} helper`;
  return Object.freeze({
    mutationCheck: (taskId: string) => `${helper} mutation-check --task ${quoteShellArgument(taskId)}`,
    auditNonce: (runDir: string, owner: string) =>
      `${helper} security-audit nonce --out ${quoteShellArgument(runDir)} --artifact agents/${owner}/artifacts/<file>`,
    verificationImport: (locator: string, run: string) =>
      `${helper} security-audit verify --out ${quoteShellArgument(locator)} --from ${quoteShellArgument(run)}`,
    orchestrationStart: (program: PrintedStartProgram, runsRoot: string) =>
      `${helper} orchestration start ${program} --runs-root ${quoteShellArgument(runsRoot)}`,
    sandboxScript: asSandboxScript(`${root}/scripts/security-sandbox.sh`),
    securityLens: (lens: SecurityLens) => `${root}/references/security-lenses/${lens}`,
  });
}
