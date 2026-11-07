/**
 * The skeleton core's read of a TaskGraph: the view carrying the G2 fields,
 * and a Task's production files. Both the outcome derivation (`outcomes.ts`,
 * INV-4 owner) and the conformance scope (`scope.ts`, INV-5 owner) depend on
 * this module, never on each other, so each invariant owner stays
 * independent. Pure.
 */

import { frozenRedThenGreenEra } from "../proof-obligations";
import { classifyTaskFiles, ENGINE_DEFAULT_TEST_FILES } from "../test-file-classification";
import type { Task, TaskGraph } from "../../types";
import type { ExportBinding, SkeletonRecord } from "./persisted";

/**
 * The TaskGraph with the G2 fields AD-4 persists: the bindings stamped at
 * population, and the engine-written skeleton records. Optional, because a
 * graph populated before G2 carries neither. Every `TaskGraph` is one, so
 * the skeleton core reads these through this view rather than a cast.
 */
export type SkeletonGraph = TaskGraph & Readonly<{
  export_bindings?: readonly ExportBinding[];
  skeletons?: readonly SkeletonRecord[];
}>;

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
