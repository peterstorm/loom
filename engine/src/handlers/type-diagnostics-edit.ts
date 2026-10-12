/**
 * The edit-to-advisory step both harness adapters share: the Claude Code
 * PostToolUse handler and Pi's post-edit flow. Only reading the harness's
 * input and rendering the result onto its channels stay per-harness.
 *
 * Shell, not core: it awaits an injected advisor and turns its failure into
 * an operator note (fail-open).
 */

import { isAbsolute, resolve } from "node:path";
import { couldNotRun, NO_ADVISORY, type TypeAdvisory } from "../core/type-diagnostics";

/** The advisory for one landed edit of an absolute file path. */
export type AdviseOnEdit = (file: string) => Promise<TypeAdvisory>;

/**
 * The advisory for one landed edit, given the edited path as the harness
 * reported it. Relative paths resolve against `root`.
 */
export async function adviceForEdit(path: string | null, root: string | null, advise: AdviseOnEdit): Promise<TypeAdvisory> {
  if (path === null) return NO_ADVISORY;
  const file = isAbsolute(path) || root === null ? path : resolve(root, path);
  try {
    return await advise(file);
  } catch (error: unknown) {
    return couldNotRun(error);
  }
}
