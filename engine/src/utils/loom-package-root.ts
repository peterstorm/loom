import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of the Loom package that owns the executing engine module.
 * Package identity comes from import.meta.url, never cwd or another harness's
 * installation cache.
 */
export const LOOM_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
