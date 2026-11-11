/**
 * The operator's distill-pass switch (ADR-0068): the two values the optional
 * `distillPass` key of a schema-2 verification manifest may hold.
 *
 * A leaf on purpose. The manifest parser reads the setting and the Distill
 * Task planner (`core/distill-task.ts`) consumes it; the planner also reads
 * `Task`, whose module imports the manifest's types, so the vocabulary both
 * share lives beneath them and neither imports the other for it.
 */

/** The operator's `distillPass` manifest setting; absent reads as `on`. */
export const DISTILL_PASS_SETTINGS = ["on", "off"] as const;
export type DistillPassSetting = (typeof DISTILL_PASS_SETTINGS)[number];
