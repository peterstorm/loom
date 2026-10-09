/**
 * The catalog's Pi bindings as fixtures and assertions spell them — the one
 * local binding and the retired cloud bindings — all derived from the
 * catalog itself, so a requalified local route or an edited history changes
 * the catalog alone. Every catalog profile lowers its Pi binding to the one
 * local route at thinking `high`.
 *
 * The deliberate literal spellings are the specifications of the bytes
 * themselves: the golden-bytes assertion in
 * `tests/handlers/helpers/programs/refutation-verifiers.test.ts`, which pins
 * the serialized authority bytes, and the catalog's own suite
 * `tests/core/model-profiles.test.ts`, which pins the catalog table and its
 * recorded history.
 *
 * The retired cloud bindings are read from the catalog's own history, so each
 * is always a binding its profile really issued before local-only routing
 * (ADR-0023). `retiredPiCatalog` replays such history: it is the catalog as it
 * stood when the named profiles still lowered to their retired binding, which
 * a drive passes to the engine (`resumeStandaloneFacade`,
 * `resumeWaveGateFacade`) as the catalog it mints under.
 */
import {
  DESKTOP_VLLM_ROUTE,
  RECORDED_LLM_PROFILE_IDS,
  piCatalogAsOf,
  piModelPattern,
  recordedProfileBindings,
  type LlmProfileId,
  type PiBinding,
  type PiCatalog,
} from "../../src/core/model-profiles";

/** The issued Pi harness binding of every catalog profile. */
export const LOCAL_PI_BINDING = Object.freeze({ harness: "pi", ...DESKTOP_VLLM_ROUTE, thinking: "high" } as const);

/** The same binding as a rendered Pi agent's `model:` value and `--model` argument: `provider/model:thinking`. */
export const LOCAL_PI_MODEL_ARGUMENT = `${LOCAL_PI_BINDING.provider}/${LOCAL_PI_BINDING.model}:${LOCAL_PI_BINDING.thinking}` as const;

/** The local binding's route name, `provider/model`, as the route gate reports it. */
export const LOCAL_PI_ROUTE = `${LOCAL_PI_BINDING.provider}/${LOCAL_PI_BINDING.model}` as const;

/** The cloud Pi binding `profile` issued before local-only routing: recorded history, never launchable. */
export function retiredCloudPiBinding(profile: LlmProfileId): PiBinding {
  const retired = recordedProfileBindings(profile).pi.find(({ provider }) => provider !== DESKTOP_VLLM_ROUTE.provider);
  if (retired === undefined) throw new Error(`profile '${profile}' records no retired cloud Pi binding`);
  return retired;
}

/**
 * Every Pi binding any recorded profile — catalog or retired — has issued,
 * once each by model pattern, in first-recorded order: the vocabulary a stored
 * authority may carry and a replay may name. Properties sample it to pair a
 * profile with a binding it did or never issued.
 */
export const RECORDED_PI_VOCABULARY: readonly PiBinding[] = Object.freeze([
  ...new Map(RECORDED_LLM_PROFILE_IDS.flatMap((id) => recordedProfileBindings(id).pi)
    .map((binding) => [piModelPattern(binding), binding] as const)).values(),
]);

/** The catalog profile whose retired cloud binding the route suites record. */
export const RETIRED_CLOUD_PROFILE = "general-review" as const;

/** A cloud Pi binding `RETIRED_CLOUD_PROFILE` issued before local-only routing. */
export const RETIRED_CLOUD_PI_BINDING: PiBinding = retiredCloudPiBinding(RETIRED_CLOUD_PROFILE);

/** The retired cloud binding's route name, `provider/model`. */
export const RETIRED_CLOUD_ROUTE = `${RETIRED_CLOUD_PI_BINDING.provider}/${RETIRED_CLOUD_PI_BINDING.model}`;

/** The cloud Pi binding the `refutation` profile issued before local-only routing. */
export const RETIRED_REFUTATION_PI_BINDING: PiBinding = retiredCloudPiBinding("refutation");

/**
 * The catalog as it stood BEFORE the 2026-10-08 retargeting, for the profiles
 * `retired` names: each lowers its Pi binding to the retired binding the map
 * gives it. The catalog builds it (`piCatalogAsOf`) and refuses a binding the
 * profile never recorded, so a replay is history, never an invented binding.
 * A drive given it as the catalog it mints under writes, through the engine
 * itself, a run whose recorded authorities carry the retired binding.
 */
export function retiredPiCatalog(retired: Readonly<Partial<Record<LlmProfileId, PiBinding>>>): PiCatalog {
  const catalog = piCatalogAsOf(retired);
  if (!catalog.ok) throw new Error(catalog.error.message);
  return catalog.value;
}
