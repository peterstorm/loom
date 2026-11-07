/**
 * The skeleton core's read of a TaskGraph: a Task's production files. Both
 * the outcome derivation (`outcomes.ts`, INV-4 owner) and the conformance
 * scope (`scope.ts`, INV-5 owner) depend on this module, never on each
 * other, so each invariant owner stays independent. The G2 fields
 * themselves (`export_bindings`, `skeletons`, `skeleton_outcomes`) are
 * declared on the canonical `TaskGraph` and `Task`. Pure.
 */

import { frozenRedThenGreenEra } from "../proof-obligations";
import { classifyTaskFiles, ENGINE_DEFAULT_TEST_FILES } from "../test-file-classification";
import type { Task, TaskGraph } from "../../types";

/**
 * A Task's production files: its non-test file_list paths, in file_list
 * order, under the graph's frozen test-file classification (the engine
 * default for a graph frozen before the classification existed).
 */
export function productionFiles(graph: TaskGraph, task: Task): readonly string[] {
  const era = frozenRedThenGreenEra(graph.verification_manifest);
  const testFiles = era.kind === "owed-if-new-tests" ? era.testFiles : ENGINE_DEFAULT_TEST_FILES;
  return classifyTaskFiles(task.file_list ?? [], testFiles, task.artifact_baseline).implementationFiles;
}
