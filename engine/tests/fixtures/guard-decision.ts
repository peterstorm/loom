/**
 * The state-file guard as the vocabulary and coverage suites read it: one
 * verdict per command under the production guarded locations, and the path
 * those suites aim at. One definition, so a change to the guard's signature
 * lands here once rather than in every suite that asks the same question.
 */
import { guardedLocations } from "../../src/config";
import { guardStateFileDecision } from "../../src/core/guard-state-file";

/** The protected task-graph state file, repository-relative. */
export const GUARDED = ".claude/state/active_task_graph.json";

/** Does the guard block `command` under the production guarded locations? */
export const guardDecision = (command: string): "allow" | "block" =>
  guardStateFileDecision(command, guardedLocations()).kind === "block" ? "block" : "allow";
