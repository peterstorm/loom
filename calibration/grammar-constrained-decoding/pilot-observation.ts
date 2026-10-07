/**
 * The pilot's dispatch-to-ingestion observations — PURE: what the shell
 * records per attempt and per sample (one arm of one scheduled pair), parsed
 * so contradictory observations cannot be represented, and the per-sample
 * derivations every summary reads: the sample's terminal outcome and its
 * retries, each attributed to one cause.
 *
 * Honesty invariants encoded in the types:
 *
 * - An arm's attempts are that arm's attempts: the extraction-only arm has no
 *   readiness barrier, no emission tool and no emission counters, and accepts
 *   only by final-message extraction, never over a refused call.
 * - Provider-enforced structural failures (constraints the route was verified
 *   to enforce) and engine-only refusals are separate retry causes; on a route
 *   that enforces nothing, schema violations are unenforced, never provider
 *   guarantees.
 * - Raw generated argument bytes are not observable through Pi: every sample
 *   records them as unavailable.
 */

import { z } from "zod";
import { match } from "ts-pattern";
import { type Result } from "../kernel";
import type { RouteQualification, ScheduledPair } from "./pilot-preregistration";
import { CELL_KEYS, hex64, parserOf, SPEC_SEMANTIC_ATTEMPT_BUDGET, text, type DeepReadonly } from "./pilot-vocabulary";

/**
 * How one errored emission-tool result is classified. Pi's in-child argument
 * validation (the frozen JSON Schema, before execute) reports
 * "Validation failed for tool …"; the engine's execute refusal throws
 * "<code>: <message>" with the admission's own code (AD-3).
 */
const toolErrorSchema = z.discriminatedUnion("class", [
  z.object({ class: z.literal("harness-schema-validation") }).strict(),
  z.object({ class: z.literal("engine-refusal"), code: text }).strict(),
  z.object({ class: z.literal("unclassified"), excerpt: z.string() }).strict(),
]);
export type ToolError = DeepReadonly<z.infer<typeof toolErrorSchema>>;

export function classifyEmissionToolError(resultText: string): ToolError {
  if (resultText.startsWith("Validation failed for tool ")) return Object.freeze({ class: "harness-schema-validation" as const });
  const engine = /^([a-z][a-z0-9-]*): /.exec(resultText);
  if (engine?.[1] !== undefined) return Object.freeze({ class: "engine-refusal" as const, code: engine[1] });
  return Object.freeze({ class: "unclassified" as const, excerpt: resultText.slice(0, 200) });
}

/** Rejections the extraction-only arm can produce: it observes no emission
 *  call, so only the final message and the frozen parser can refuse. */
const extractionRejectionCauses = [
  /** Zero emission calls (or extraction-only arm) and the final message was unusable. */
  z.object({ kind: z.literal("extraction-failure"), detail: z.string() }).strict(),
  /** A payload was selected but the frozen ingestion parser refused it. */
  z.object({ kind: z.literal("payload-refused"), detail: z.string() }).strict(),
] as const;

const rejectionCauseSchema = z.discriminatedUnion("kind", [
  ...extractionRejectionCauses,
  /** One complete call refused by engine admission with no usable fallback. */
  z.object({ kind: z.literal("refused-call-no-fallback"), detail: z.string() }).strict(),
  /** Two or more distinct emission calls (AD-9 ambiguity). */
  z.object({ kind: z.literal("duplicate-call"), calls: z.number().int().min(2) }).strict(),
  /** Incomplete/failed/misbound observation (an errored tool result lands here on Pi). */
  z.object({ kind: z.literal("observation-refused"), detail: z.string() }).strict(),
]);
export type RejectionCause = DeepReadonly<z.infer<typeof rejectionCauseSchema>>;

const payloadDigestField = { payloadDigest: hex64 };
const infrastructureFailureSchema = z.object({ kind: z.literal("infrastructure-failure"), reason: z.string() }).strict();
const timeoutSchema = z.object({ kind: z.literal("timeout"), afterMs: z.number().nonnegative() }).strict();

/**
 * The emission-enabled arm's outcomes. An accepted source is coherent with
 * its fallback flag by construction: `fallbackOverRefusal` (extraction
 * selected over exactly one engine-refused call, AD-9 row 3) exists only on
 * the extraction source; an accepted emission-tool payload never carries it.
 */
const emissionOutcomeSchema = z.discriminatedUnion("kind", [
  z.discriminatedUnion("source", [
    z.object({ kind: z.literal("accepted"), source: z.literal("emission-tool"), fallbackOverRefusal: z.literal(false), ...payloadDigestField }).strict(),
    z.object({ kind: z.literal("accepted"), source: z.literal("extraction"), fallbackOverRefusal: z.boolean(), ...payloadDigestField }).strict(),
  ]),
  z.object({ kind: z.literal("rejected"), cause: rejectionCauseSchema }).strict(),
  /** The readiness barrier refused before any model request. */
  z.object({ kind: z.literal("startup-refused"), reason: z.string() }).strict(),
  infrastructureFailureSchema,
  timeoutSchema,
]);

/**
 * The extraction-only arm's outcomes: the PR #52-only baseline has no
 * readiness barrier and no emission tool, so it accepts only by final-message
 * extraction (never over a refused call) and rejects only for extraction or
 * ingestion causes.
 */
const extractionOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), source: z.literal("extraction"), fallbackOverRefusal: z.literal(false), ...payloadDigestField }).strict(),
  z.object({ kind: z.literal("rejected"), cause: z.discriminatedUnion("kind", [...extractionRejectionCauses]) }).strict(),
  infrastructureFailureSchema,
  timeoutSchema,
]);

const attemptCounters = {
  attempt: z.number().int().min(1).max(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  /** Wall clock of this attempt from child spawn (startup included). */
  elapsedMs: z.number().nonnegative(),
  modelRequests: z.number().int().nonnegative(),
};

const emissionAttemptSchema = z.object({
  ...attemptCounters,
  /** Readiness-barrier time; null when the barrier never completed. */
  readinessMs: z.number().nonnegative().nullable(),
  /** Distinct emission tool-call identities observed. */
  emissionCalls: z.number().int().nonnegative(),
  /** Every errored emission tool result, in order (each is a Pi in-child re-prompt). */
  toolErrors: z.array(toolErrorSchema),
  toolAcknowledged: z.boolean(),
  /** Model turns after the first successful tool acknowledgment. */
  followUpTurnsAfterAck: z.number().int().nonnegative(),
  outcome: emissionOutcomeSchema,
}).strict();

/** The extraction-only arm is offered no emission tool and passes no
 *  readiness barrier: its emission counters are fixed by the arm. */
const extractionAttemptSchema = z.object({
  ...attemptCounters,
  readinessMs: z.null(),
  emissionCalls: z.literal(0),
  toolErrors: z.tuple([]),
  toolAcknowledged: z.literal(false),
  followUpTurnsAfterAck: z.literal(0),
  outcome: extractionOutcomeSchema,
}).strict();

export type EmissionArmAttempt = DeepReadonly<z.infer<typeof emissionAttemptSchema>>;
export type ExtractionArmAttempt = DeepReadonly<z.infer<typeof extractionAttemptSchema>>;
export type AttemptObservation = EmissionArmAttempt | ExtractionArmAttempt;

const sampleFields = {
  pairId: text,
  cell: z.enum(CELL_KEYS),
  caseId: text,
};
const sampleMeasures = {
  /** Initial producer dispatch → accepted ingestion (or terminal failure),
   *  including startup, readiness, tool acknowledgments, follow-up turns,
   *  in-child re-prompts and the semantic retry. */
  dispatchToIngestionMs: z.number().nonnegative(),
  /** Pi exposes parsed arguments only — never the generated bytes. */
  rawArgumentObservation: z.literal("unavailable"),
};

/** One arm's sample, discriminated by arm: every attempt is that arm's attempt. */
const sampleSchema = z.discriminatedUnion("arm", [
  z.object({
    ...sampleFields,
    arm: z.literal("emission-enabled"),
    ...sampleMeasures,
    attempts: z.array(emissionAttemptSchema).min(1).max(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  }).strict(),
  z.object({
    ...sampleFields,
    arm: z.literal("extraction-only"),
    ...sampleMeasures,
    attempts: z.array(extractionAttemptSchema).min(1).max(SPEC_SEMANTIC_ATTEMPT_BUDGET),
  }).strict(),
]).superRefine((sample, ctx) => {
  sample.attempts.forEach((attempt, index) => {
    if (attempt.attempt !== index + 1) ctx.addIssue({ code: "custom", message: "attempts must be numbered 1..n in order", path: ["attempts", index] });
    const isLast = index === sample.attempts.length - 1;
    if (!isLast && attempt.outcome.kind !== "rejected") {
      ctx.addIssue({ code: "custom", message: "only a semantic rejection may be followed by another attempt", path: ["attempts", index] });
    }
    if (isLast && attempt.outcome.kind === "rejected" && attempt.attempt < SPEC_SEMANTIC_ATTEMPT_BUDGET) {
      ctx.addIssue({ code: "custom", message: "a semantic rejection before the budget's last attempt must be followed by the retry", path: ["attempts", index] });
    }
  });
});
export type SampleObservation = DeepReadonly<z.infer<typeof sampleSchema>>;

export const parseSampleObservation: (raw: unknown) => Result<SampleObservation, readonly string[]> = parserOf(sampleSchema);

/** One scheduled pair observed in both arms. */
export type ObservedPair = Readonly<{ scheduled: ScheduledPair; emission: SampleObservation; extraction: SampleObservation }>;

// ---------------------------------------------------------------------------
// Per-sample derivations (the dispatch-to-ingestion counters)
// ---------------------------------------------------------------------------

export type SampleTerminal =
  | Readonly<{ kind: "accepted"; source: "emission-tool" | "extraction"; fallbackOverRefusal: boolean }>
  | Readonly<{ kind: "terminal-failure"; cause: "semantic-exhausted" | "startup-refused" | "infrastructure" | "timeout" }>;

export function sampleTerminal(sample: SampleObservation): SampleTerminal {
  const last = sample.attempts[sample.attempts.length - 1] as AttemptObservation;
  return match(last.outcome)
    .with({ kind: "accepted" }, (outcome): SampleTerminal =>
      Object.freeze({ kind: "accepted" as const, source: outcome.source, fallbackOverRefusal: outcome.fallbackOverRefusal }))
    .with({ kind: "rejected" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "semantic-exhausted" as const }))
    .with({ kind: "startup-refused" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "startup-refused" as const }))
    .with({ kind: "infrastructure-failure" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "infrastructure" as const }))
    .with({ kind: "timeout" }, (): SampleTerminal => Object.freeze({ kind: "terminal-failure" as const, cause: "timeout" as const }))
    .exhaustive();
}

/** The retry-cause vocabulary: every retry (semantic attempt 2, or a Pi
 *  in-child re-prompt after an errored tool result) is attributed to one. */
export const RETRY_CAUSES = [
  "provider-structural",
  "unenforced-schema-violation",
  "engine-only-refusal",
  "unclassified-tool-error",
  "extraction-failure",
  "duplicate-call",
  "observation-refused",
  "payload-refused",
] as const;
export type RetryCause = (typeof RETRY_CAUSES)[number];

const structuralCause = (qualification: RouteQualification): RetryCause =>
  qualification.kind === "constrained-emission" ? "provider-structural" : "unenforced-schema-violation";

const toolErrorCause = (error: ToolError, qualification: RouteQualification): RetryCause =>
  match(error)
    .with({ class: "harness-schema-validation" }, () => structuralCause(qualification))
    .with({ class: "engine-refusal" }, (): RetryCause => "engine-only-refusal")
    .with({ class: "unclassified" }, (): RetryCause => "unclassified-tool-error")
    .exhaustive();

/** The cause a semantic rejection is attributed to. An observation refusal
 *  caused by an errored tool result is attributed to that error's class: on
 *  Pi every errored result becomes an incomplete frame. */
function rejectionRetryCause(attempt: AttemptObservation, cause: RejectionCause, qualification: RouteQualification): RetryCause {
  const firstError = attempt.toolErrors[0];
  return match(cause)
    .with({ kind: "extraction-failure" }, (): RetryCause => "extraction-failure")
    .with({ kind: "duplicate-call" }, (): RetryCause => "duplicate-call")
    .with({ kind: "payload-refused" }, (): RetryCause => "payload-refused")
    .with({ kind: "refused-call-no-fallback" }, (): RetryCause =>
      firstError === undefined ? "engine-only-refusal" : toolErrorCause(firstError, qualification))
    .with({ kind: "observation-refused" }, (): RetryCause =>
      firstError === undefined ? "observation-refused" : toolErrorCause(firstError, qualification))
    .exhaustive();
}

export type RetryEvent = Readonly<{ kind: "semantic-retry" | "in-child-reprompt"; cause: RetryCause }>;

export function sampleRetries(sample: SampleObservation, qualification: RouteQualification): readonly RetryEvent[] {
  const reprompts = sample.attempts.flatMap((attempt) =>
    attempt.toolErrors.map((error): RetryEvent => Object.freeze({ kind: "in-child-reprompt" as const, cause: toolErrorCause(error, qualification) })));
  const semantic = sample.attempts.slice(0, -1).flatMap((attempt): RetryEvent[] =>
    attempt.outcome.kind === "rejected"
      ? [Object.freeze({ kind: "semantic-retry" as const, cause: rejectionRetryCause(attempt, attempt.outcome.cause, qualification) })]
      : []);
  return Object.freeze([...semantic, ...reprompts]);
}
