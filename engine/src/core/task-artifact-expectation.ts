/**
 * Which byte comparison a Task's Proof uses over its declared artifacts, and
 * which observed changes that comparison judges. Population, the State File
 * load boundary, settlement and reconcile all ask here, so a Task's stored
 * obligations and the evidence they are evaluated against cannot disagree.
 * Pure.
 */
import { taskRolePolicy } from "./distill-task";
import type { ArtifactScopeInput, DeclaredArtifactExpectation, TestsOnlyScope } from "./proof-obligations";

/** What the choice reads of a Task; a raw State File record qualifies before it is proven. */
export type ArtifactExpectationSource = Readonly<{ agent?: unknown; implementation_attestation?: unknown }>;

/**
 * A Task's `DeclaredArtifactExpectation`: `preserved` for a Distill Task
 * (ADR-0068), `attested` for a Task in attestation mode, `changed` otherwise.
 *
 * A Distill Task in attestation mode is illegal. The State File load boundary
 * refuses it and `armImplementationAttestation` never produces it, so the
 * order of the two tests is unobservable on a loaded Task.
 */
export function taskArtifactExpectation(task: ArtifactExpectationSource): DeclaredArtifactExpectation {
  if (taskRolePolicy(task).declaredArtifacts === "preserved") return "preserved";
  return task.implementation_attestation === true ? "attested" : "changed";
}

/** What `taskArtifactScope` reads: the expectation's fields and a parsed reopen scope. */
export type ArtifactScopeSource = ArtifactExpectationSource & Readonly<{ reopen_scope?: TestsOnlyScope }>;

/**
 * What a Task's declared artifacts owe, as the Proof derivation takes it: a
 * tests-only reopening's scope while one is in force (ADR-0093), its
 * `DeclaredArtifactExpectation` otherwise. Every derivation of a Task's
 * obligations spreads this, so none can derive a tests-only Task's Proof as a
 * full re-implementation's. Task Reopening and the State File refuse a
 * tests-only scope on a Distill Task or an attesting one.
 */
export function taskArtifactScope(task: ArtifactScopeSource): ArtifactScopeInput {
  return task.reopen_scope === undefined
    ? { declaredArtifactExpectation: taskArtifactExpectation(task) }
    : { testsOnly: task.reopen_scope };
}

/** The observations of changed declared artifacts a settlement holds. */
export type ObservedArtifactChanges<Path extends string> = Readonly<{
  /** Every declared path whose bytes differ from the attempt baseline, reported or not. */
  attemptScope: readonly Path[];
  /** Declared paths whose bytes differ from the first Task baseline. */
  cumulative: readonly Path[];
  /** Declared paths whose bytes differ from a tests-only reopening's baseline; empty without one. */
  sinceReopen: readonly Path[];
}>;

/**
 * The changed paths a Proof under `scope` is evaluated against.
 *
 * - `changed` reads the cumulative delta against the first Task baseline, so
 *   an earlier attempt's production still counts on a verify-only retry.
 * - `attested` reads the attempt's own raw delta: the work predates the
 *   attempt, and an unreported write must surface as drift.
 * - `preserved` reads the attempt's own raw delta too. `behaviour-preserved`
 *   asks what THIS attempt changed: the cumulative delta is the siblings'
 *   implementation, which would make every distill pass owe tests for code it
 *   never touched, and a transcript-attributed set would let an unreported
 *   write settle as `unchanged`.
 * - a tests-only scope (ADR-0093) reads the raw delta against the reopening's
 *   baseline: the cumulative delta holds the original implementation, which
 *   would read as a production write, and the attempt's own delta would let a
 *   retry hide its predecessor's production write.
 */
export function proofArtifactChanges<Path extends string>(
  scope: ArtifactScopeInput,
  changes: ObservedArtifactChanges<Path>,
): readonly Path[] {
  if (scope.testsOnly !== undefined) return changes.sinceReopen;
  const expectation = scope.declaredArtifactExpectation;
  switch (expectation) {
    case "changed":
      return changes.cumulative;
    case "attested":
    case "preserved":
      return changes.attemptScope;
    default: {
      const unreachable: never = expectation;
      return unreachable;
    }
  }
}
