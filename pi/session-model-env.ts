/**
 * The live Pi session model projected into the process environment.
 *
 * Loom's shell observations of "which model is the parent running" read
 * `PI_PROVIDER`/`PI_MODEL` (`utils/model-routing-context.ts`), and every
 * routing decision downstream reads that same pair: the generated agent
 * definition's binding check, the spawn render's emission/extraction choice,
 * Pi parent admission, and the capture runtime's expectation. Pi exports the
 * pair once at process start, so a session that switches model mid-run keeps a
 * stale environment: children launch on the model the operator picked while
 * admission still reasons about the model the process started with, and the two
 * disagree about an emission route the operator never touched.
 *
 * The fix is one projection rather than five new signatures: whenever Loom
 * handles a Pi event whose context carries the live model, it writes that model
 * into the environment those readers share — the environment then projects the
 * session instead of a snapshot of its first turn. `sessionModelEnv` is the pure
 * decision of WHAT to project; `projectSessionModelIntoEnv` is the only writer.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The two fields Loom reads from a Pi session model — nothing else is routing
 *  input, so the projection's interface is exactly that pair. */
export type SessionModel = Readonly<Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">>;

export type SessionModelProjection = Readonly<{ PI_PROVIDER: string; PI_MODEL: string }>;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The environment projection of one session model, or `null` when Pi exposed no
 * usable model (an absent context model, or a blank provider/id). A model Loom
 * cannot describe must never erase the environment it could not read.
 */
export function sessionModelEnv(model: SessionModel | null | undefined): SessionModelProjection | null {
  if (model === null || model === undefined) return null;
  const { provider, id } = model;
  return nonEmpty(provider) && nonEmpty(id)
    ? Object.freeze({ PI_PROVIDER: provider, PI_MODEL: id })
    : null;
}

/**
 * Write the session model into `env` (default: this process) so every later
 * Loom observation of the parent agrees with the session that is running.
 * Idempotent; returns whether it wrote.
 */
export function projectSessionModelIntoEnv(
  model: SessionModel | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const projection = sessionModelEnv(model);
  if (projection === null) return false;
  env.PI_PROVIDER = projection.PI_PROVIDER;
  env.PI_MODEL = projection.PI_MODEL;
  return true;
}
