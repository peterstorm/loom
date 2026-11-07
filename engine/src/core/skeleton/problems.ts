/**
 * Why the engine could not (re)write a skeleton, and the one line that names
 * each reason. Registration, the contract stub step, the Contract Revision's
 * refresh, status and the brief all report these through the renderers
 * here, so one problem reads the same wherever it surfaces. Pure.
 */

import { match } from "ts-pattern";
import type { ResolutionProblem } from "./types";

/**
 * Why the engine could not (re)write one contract's skeleton from its current
 * types: a stage-two resolution problem, a bound path whose language differs
 * from the types file's, or a write or read the shell could not carry out.
 */
export type SkeletonProblem =
  | ResolutionProblem
  | Readonly<{ kind: "language-mismatch"; path: string; contract: string; typesFile: string }>
  | Readonly<{ kind: "write-failed"; path: string; detail: string }>;

/** One diagnostic line per stage-two problem, naming the alias, the binding
 *  file and the types file where the problem has them. */
export function renderResolutionProblem(problem: ResolutionProblem): string {
  switch (problem.kind) {
    case "missing-alias":
      return `${problem.path} binds ${problem.alias}, but the frozen types file ${problem.typesFile} declares no ${problem.alias}`;
    case "not-a-function":
      return `${problem.path} binds ${problem.alias}, but ${problem.alias} in the frozen types file ${problem.typesFile} is not a function type`;
    case "generic-alias":
      return `${problem.path} binds ${problem.alias}, but ${problem.alias} in the frozen types file ${problem.typesFile} is a generic function type, which no skeleton can bind`;
    case "unsupported-holder-shape":
      return `the frozen types file ${problem.typesFile} has an unsupported holder shape (${problem.detail})`;
    case "types-unparseable":
      return `the frozen types file ${problem.typesFile} cannot be read as a types surface (${problem.detail})`;
    case "types-drifted":
      return `the frozen types file ${problem.typesFile} no longer matches its Acceptance Freeze stamp`;
  }
}

/**
 * A prepared name the writer could not remove beside a skeleton `path` after
 * a write: a stray dot-file the operator deletes. Never a blocker — the write
 * it belongs to stands (or was refused) on its own.
 */
export type LeftPreparedName = Readonly<{ path: string; name: string; message: string }>;

/** One note naming the stray prepared name and that it is safe to delete. */
export const renderLeftPreparedName = ({ path, name, message }: LeftPreparedName): string =>
  `${path}: the prepared name ${name} beside it could not be removed (${message}); delete it`;

/** One line naming why the engine could not (re)write a skeleton. */
export const renderSkeletonProblem = (problem: SkeletonProblem): string =>
  match(problem)
    .with({ kind: "language-mismatch" }, ({ path, contract, typesFile }) =>
      `${path} binds ${contract}, whose types file ${typesFile} is in another language`)
    .with({ kind: "write-failed" }, ({ path, detail }) => `${path}: ${detail}`)
    .otherwise(renderResolutionProblem);
