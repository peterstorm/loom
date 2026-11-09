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
export const renderResolutionProblem = (problem: ResolutionProblem): string =>
  match(problem)
    .with({ kind: "missing-alias" }, ({ path, alias, typesFile }) =>
      `${path} binds ${alias}, but the frozen types file ${typesFile} declares no ${alias}`)
    .with({ kind: "not-a-function" }, ({ path, alias, typesFile }) =>
      `${path} binds ${alias}, but ${alias} in the frozen types file ${typesFile} is not a function type`)
    .with({ kind: "generic-alias" }, ({ path, alias, typesFile }) =>
      `${path} binds ${alias}, but ${alias} in the frozen types file ${typesFile} is a generic function type, which no skeleton can bind`)
    .with({ kind: "unsupported-holder-shape" }, ({ typesFile, detail }) =>
      `the frozen types file ${typesFile} has an unsupported holder shape (${detail})`)
    .with({ kind: "types-unparseable" }, ({ typesFile, detail }) =>
      `the frozen types file ${typesFile} cannot be read as a types surface (${detail})`)
    .with({ kind: "types-drifted" }, ({ typesFile }) =>
      `the frozen types file ${typesFile} no longer matches its Acceptance Freeze stamp`)
    .exhaustive();

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
