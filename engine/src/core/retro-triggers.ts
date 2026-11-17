/**
 * Retro triggers (ADR-0083, loom#200): when a Wave's friction digest is worth
 * a retrospective while it is fresh. A suggestion never blocks; the end of a
 * run is where a retro is enforced (`complete-orchestration`).
 *
 * The thresholds are the shapes behind loom#198 and loom#199: a Task that
 * escalated (remediated or not), a Wave Gate that needed a second run, an
 * operator changing the Wave's plan (a plan edit, a Forward Fix or its
 * withdrawal, a completed Wave reopened), Tasks reopened more than once, and
 * the engine being moved under a live run. One Task reopening is the normal
 * way to act on a Wave Gate Finding, so it alone suggests nothing.
 *
 * Pure.
 */

import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import { gateRunCount, type RetroFacts, type WaveFriction } from "./retro-facts";

/** Why a retro is worth running now. */
export type RetroTrigger =
  | Readonly<{ kind: "escalation"; taskIds: NonEmpty<string> }>
  | Readonly<{ kind: "repeated-wave-gate"; runs: number }>
  | Readonly<{ kind: "plan-changed"; edits: number }>
  | Readonly<{ kind: "repeated-reopening"; reopenings: number }>
  | Readonly<{ kind: "engine-changed"; adoptions: number }>;

/** A suggestion to run `/retro --wave <wave>`, with every trigger behind it. */
export type RetroSuggestion = Readonly<{ wave: number; triggers: NonEmpty<RetroTrigger> }>;

const freeze = Object.freeze;

/** The triggers one Wave's digest crosses, in a fixed order. */
export function waveRetroTriggers(digest: WaveFriction): readonly RetroTrigger[] {
  const escalated = nonEmpty(digest.tasks.filter((task) => task.escalations > 0).map(({ taskId }) => taskId));
  const runs = gateRunCount(digest);
  const edits = digest.planEdits + digest.forwardFixes + digest.forwardFixWithdrawals + digest.waveReopenings;
  return freeze([
    ...(escalated === null ? [] : [freeze({ kind: "escalation" as const, taskIds: escalated })]),
    ...(runs >= 2 ? [freeze({ kind: "repeated-wave-gate" as const, runs })] : []),
    ...(edits > 0 ? [freeze({ kind: "plan-changed" as const, edits })] : []),
    ...(digest.taskReopenings >= 2 ? [freeze({ kind: "repeated-reopening" as const, reopenings: digest.taskReopenings })] : []),
  ]);
}

/**
 * One suggestion per Wave that crossed a threshold, in Wave order. An engine
 * moved under the run has no Wave of its own, so it joins the active Wave's
 * suggestion (or the last Wave's once every Wave completed).
 */
export function retroSuggestions(facts: RetroFacts): readonly RetroSuggestion[] {
  const anchor = facts.waves.find(({ progress }) => progress === "active")?.wave ?? facts.waves.at(-1)?.wave;
  return freeze(facts.waves.flatMap((digest) => {
    const engine = facts.engineRevisionAdoptions > 0 && digest.wave === anchor
      ? [freeze({ kind: "engine-changed" as const, adoptions: facts.engineRevisionAdoptions })]
      : [];
    const triggers = nonEmpty([...waveRetroTriggers(digest), ...engine]);
    return triggers === null ? [] : [freeze({ wave: digest.wave, triggers })];
  }));
}

/**
 * The suggestions still fresh: for the active Wave and the Wave that
 * completed last. Older Waves' friction is the end-of-run retro's to read;
 * `helper retro-facts` reports every Wave's suggestion for that retro.
 */
export function freshRetroSuggestions(facts: RetroFacts): readonly RetroSuggestion[] {
  const lastCompleted = facts.waves.filter(({ progress }) => progress === "completed").at(-1)?.wave;
  const active = facts.waves.find(({ progress }) => progress === "active")?.wave;
  return freeze(retroSuggestions(facts).filter(({ wave }) => wave === lastCompleted || wave === active));
}

/** The operator's sentence for one trigger. */
export function describeRetroTrigger(trigger: RetroTrigger): string {
  switch (trigger.kind) {
    case "escalation":
      return `escalation of ${trigger.taskIds.join(", ")}`;
    case "repeated-wave-gate":
      return `${trigger.runs} Wave Gate runs`;
    case "plan-changed":
      return `${trigger.edits} plan change${trigger.edits === 1 ? "" : "s"} (plan edits, Forward Fixes, Wave reopenings)`;
    case "repeated-reopening":
      return `${trigger.reopenings} Task reopenings`;
    case "engine-changed":
      return `the engine revision moved ${trigger.adoptions} time${trigger.adoptions === 1 ? "" : "s"} under the run`;
    default: {
      const unreachable: never = trigger;
      return unreachable;
    }
  }
}
