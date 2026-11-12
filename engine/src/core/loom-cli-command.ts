/**
 * The ONE spelling of a helper command the engine prints for someone to run.
 *
 * No `loom` binary is installed (neither `package.json` declares a `bin`), and
 * whoever runs a printed line — an operator, a parent session, a hunter — is
 * working in the repository under orchestration or audit, never in the Loom
 * package. So a printed command names the executing package's own `cli.ts` by
 * absolute path, as one shell-quoted word, and runs unchanged from any
 * directory. The shell supplies `packageRoot` (`utils/loom-package-root`);
 * nothing here reads the filesystem.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { quoteShellArgument } from "./shell-quoting";

/** `bun '<packageRoot>/engine/src/cli.ts' helper` — the words every printed
 *  helper command starts with; the helper's name and flags follow. */
export const loomHelperCommand = (packageRoot: string): string =>
  `bun ${quoteShellArgument(`${packageRoot}/engine/src/cli.ts`)} helper`;
