/**
 * Wave Gate operation DAGs.
 *
 * Two static graphs.
 *
 * The preparation graph is a genuine fan-out/fan-in: readiness, packet set,
 * model bindings, and context digests are derived by four independent nodes
 * that Fugue can run concurrently, then joined before anything is published.
 * The join is the point — publication is all-or-nothing, so the graph must not
 * be able to publish one part of a batch while another part is still being
 * derived. Fan-in gives that ordering structurally rather than by convention.
 *
 * The advisory graph is the ONE place a durable human suspension belongs: an
 * operator triaging advisory findings is a real decision, not a computation to
 * retry. It uses `createHumanReviewNode`, so a run parks at the gate, frees the
 * worker, and resumes from persisted state when the decision arrives.
 * `runResumableDagJob` is the required entry point for it — a synchronous
 * `runDag` treats a suspend as a misuse.
 *
 * Roster-sized work stays a VALUE inside these static nodes. There is no
 * dynamic fan-out, because Fugue 0.4.0 has none and pretending otherwise would
 * mean generating a graph per wave.
 */

import { z } from "zod";
import {
  DAG_INPUT,
  createHumanReviewNode,
  createTransformNode,
  defineDag,
  ok,
  type DagDef,
} from "@fuguejs/framework";

const DERIVE_READINESS = "derive-readiness";
const DERIVE_PACKETS = "derive-review-packets";
const DERIVE_MODELS = "derive-model-bindings";
const DERIVE_CONTEXTS = "derive-context-digests";
const JOIN_PREPARATION = "join-preparation";

const ADVISORY_GATE = "advisory-decision-gate";
const APPLY_ADVISORY = "apply-advisory-decision";

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

declare const WAVE_NUMBER: unique symbol;
export type WaveNumber = number & { readonly [WAVE_NUMBER]: true };

const waveNumberSchema = z.number().int().positive().transform((wave) => wave as WaveNumber);

export function parseWaveNumber(raw: unknown): WaveNumber | null {
  const parsed = waveNumberSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type PreparationInput = Readonly<{
  wave: WaveNumber;
  graph: unknown;
  tasks: readonly string[];
}>;

/**
 * One derived part of the batch. An undeliverable part blocks the join.
 *
 * Two arms rather than `ok: boolean` beside `reason: string | null`, which made
 * the two fields independent: `{ ok: false, reason: null }` and
 * `{ ok: true, reason: "derivation failed" }` both type-checked and both passed
 * the schema, and the join had to paper over the first with a manufactured
 * message. A failure now carries its reason structurally, so there is no state
 * left for a fallback to cover — the same shape the sibling standalone-review
 * DAG already uses for this concept.
 */
export type DerivedPart =
  | Readonly<{ kind: "derived"; part: string; value: unknown }>
  | Readonly<{ kind: "undeliverable"; part: string; reason: string }>;

export type PreparedBatch =
  | Readonly<{ kind: "prepared"; parts: readonly DerivedPart[] }>
  | Readonly<{ kind: "blocked"; reasons: readonly string[] }>;

const preparationInputSchema = z.object({
  wave: waveNumberSchema,
  graph: z.unknown(),
  tasks: z.array(z.string()),
}) as unknown as z.ZodType<PreparationInput>;

const derivedPartSchema = z.union([
  z.object({ kind: z.literal("derived"), part: z.string().min(1), value: z.unknown() }),
  z.object({ kind: z.literal("undeliverable"), part: z.string().min(1), reason: z.string().min(1) }),
]) as unknown as z.ZodType<DerivedPart>;

const preparedBatchSchema = z.union([
  z.object({ kind: z.literal("prepared"), parts: z.array(derivedPartSchema) }),
  z.object({ kind: z.literal("blocked"), reasons: z.array(z.string()) }),
]) as unknown as z.ZodType<PreparedBatch>;

/** How one part of the batch is derived. Pure: it receives the input value. */
export type PreparationPart = Readonly<{
  id: string;
  derive: (input: PreparationInput) => DerivedPart;
}>;

function derivePartNode(id: string, part: PreparationPart) {
  return createTransformNode<PreparationInput, DerivedPart>({
    id,
    inputSchema: preparationInputSchema,
    outputSchema: derivedPartSchema,
    transform: (input) => ok(part.derive(input)),
  });
}

/**
 * Fan-in. Every branch is an unconditional edge from a node the source always
 * reaches, so all four arrive as REQUIRED sources and the join sees an object
 * keyed by node id with no absent members.
 */
const joinSchema = z.object({
  [DERIVE_READINESS]: derivedPartSchema,
  [DERIVE_PACKETS]: derivedPartSchema,
  [DERIVE_MODELS]: derivedPartSchema,
  [DERIVE_CONTEXTS]: derivedPartSchema,
}) as unknown as z.ZodType<Readonly<Record<string, DerivedPart>>>;

const joinNode = createTransformNode<Readonly<Record<string, DerivedPart>>, PreparedBatch>({
  id: JOIN_PREPARATION,
  inputSchema: joinSchema,
  outputSchema: preparedBatchSchema,
  transform: (parts) => {
    const ordered = [DERIVE_READINESS, DERIVE_PACKETS, DERIVE_MODELS, DERIVE_CONTEXTS]
      .map((id) => parts[id])
      .filter((part): part is DerivedPart => part !== undefined);
    const failed = ordered.filter((part) => part.kind === "undeliverable");
    return ok(failed.length > 0
      ? { kind: "blocked", reasons: failed.map((part) => part.reason) }
      : { kind: "prepared", parts: ordered });
  },
});

/**
 * Build the preparation DAG. The four derivations are supplied rather than
 * hardcoded so the graph stays a pure shape and the domain logic stays in the
 * core where it can be tested without a runtime.
 */
export function createWavePreparationDag(parts: Readonly<{
  readiness: PreparationPart;
  packets: PreparationPart;
  models: PreparationPart;
  contexts: PreparationPart;
}>): DagDef {
  return defineDag({
    id: "wave-gate-preparation",
    nodes: {
      [DERIVE_READINESS]: derivePartNode(DERIVE_READINESS, parts.readiness),
      [DERIVE_PACKETS]: derivePartNode(DERIVE_PACKETS, parts.packets),
      [DERIVE_MODELS]: derivePartNode(DERIVE_MODELS, parts.models),
      [DERIVE_CONTEXTS]: derivePartNode(DERIVE_CONTEXTS, parts.contexts),
      [JOIN_PREPARATION]: joinNode,
    },
    edges: [
      { from: DAG_INPUT, to: DERIVE_READINESS },
      { from: DAG_INPUT, to: DERIVE_PACKETS },
      { from: DAG_INPUT, to: DERIVE_MODELS },
      { from: DAG_INPUT, to: DERIVE_CONTEXTS },
      { from: DERIVE_READINESS, to: JOIN_PREPARATION },
      { from: DERIVE_PACKETS, to: JOIN_PREPARATION },
      { from: DERIVE_MODELS, to: JOIN_PREPARATION },
      { from: DERIVE_CONTEXTS, to: JOIN_PREPARATION },
    ],
    outputNodeId: JOIN_PREPARATION,
  });
}

// ---------------------------------------------------------------------------
// Advisory decision (durable HITL)
// ---------------------------------------------------------------------------

export type AdvisoryTriage = Readonly<{
  wave: WaveNumber;
  advisories: readonly Readonly<{ id: string; task: string; text: string }>[];
}>;

const advisoryTriageSchema = z.object({
  wave: waveNumberSchema,
  advisories: z.array(z.object({ id: z.string(), task: z.string(), text: z.string() })),
}) as unknown as z.ZodType<AdvisoryTriage>;

export type AdvisoryOutcome = Readonly<{
  kind: "advisory-decision-accepted";
  wave: WaveNumber;
  advisoryCount: number;
}>;

const advisoryOutcomeSchema = z.object({
  kind: z.literal("advisory-decision-accepted"),
  wave: waveNumberSchema,
  advisoryCount: z.number().int().nonnegative(),
}) as unknown as z.ZodType<AdvisoryOutcome>;

/**
 * The gate forwards its input unchanged and SUSPENDS for a human decision; the
 * reviewer may edit the value, so the applied outcome is derived from what
 * comes back through the gate rather than from what went in.
 */
const advisoryGateNode = createHumanReviewNode<AdvisoryTriage>({
  id: ADVISORY_GATE,
  schema: advisoryTriageSchema,
  prompt: "Triage this wave's advisory findings: fix, defer with a reason, or dismiss with a reason.",
});

const applyAdvisoryNode = createTransformNode<AdvisoryTriage, AdvisoryOutcome>({
  id: APPLY_ADVISORY,
  inputSchema: advisoryTriageSchema,
  outputSchema: advisoryOutcomeSchema,
  transform: (triage) => ok({
    kind: "advisory-decision-accepted",
    wave: triage.wave,
    advisoryCount: triage.advisories.length,
  }),
});

/**
 * `advisory gate (suspends) → apply`. Must be run with `runResumableDagJob`
 * and a durable job: a synchronous `runDag` reports a suspend as an invariant
 * error rather than parking the run.
 */
export const waveAdvisoryDag: DagDef = defineDag({
  id: "wave-gate-advisory-decision",
  nodes: { [ADVISORY_GATE]: advisoryGateNode, [APPLY_ADVISORY]: applyAdvisoryNode },
  edges: [
    { from: DAG_INPUT, to: ADVISORY_GATE },
    { from: ADVISORY_GATE, to: APPLY_ADVISORY },
  ],
  outputNodeId: APPLY_ADVISORY,
});

export const WAVE_GATE_DAG_NODE_IDS = Object.freeze({
  deriveReadiness: DERIVE_READINESS,
  derivePackets: DERIVE_PACKETS,
  deriveModels: DERIVE_MODELS,
  deriveContexts: DERIVE_CONTEXTS,
  joinPreparation: JOIN_PREPARATION,
  advisoryGate: ADVISORY_GATE,
  applyAdvisory: APPLY_ADVISORY,
});
