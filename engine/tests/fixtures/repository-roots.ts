import { fileURLToPath } from "node:url";

/**
 * The engine package root and the repository root, resolved from this file's
 * own location (each with a trailing separator), never from process.cwd():
 * the trusted root-started Vitest form runs with cwd at the repository root,
 * so a cwd-relative path in a test silently points one directory off.
 */
export const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
export const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
