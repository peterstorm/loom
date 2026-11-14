import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loomCommands, parseLoomPackageRoot, type LoomCommands, type LoomPackageRoot } from "../core/loom-cli-command";

/**
 * The installed package at `path` (resolved from a module's own URL) as a
 * package root. A resolved path is absolute with no trailing separator, so a
 * refusal here means the installation itself is broken (a control character in
 * its path): there is no running package to print a command for, and the shell
 * stops. The engine and the Pi extension each name their package through it.
 */
export function installedLoomPackageRoot(path: string): LoomPackageRoot {
  const parsed = parseLoomPackageRoot(path);
  if (!parsed.ok) throw new Error(`the executing Loom package cannot name itself in a printed command: ${parsed.error.message}`);
  return parsed.value;
}

/**
 * Root of the Loom package that owns the executing engine module.
 * Package identity comes from import.meta.url, never cwd or another harness's
 * installation cache.
 */
export const LOOM_PACKAGE_ROOT: LoomPackageRoot = installedLoomPackageRoot(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));

/** Every command and path the running package prints that names itself. */
export const LOOM_COMMANDS: LoomCommands = loomCommands(LOOM_PACKAGE_ROOT);
