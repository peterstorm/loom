/**
 * The catalog's local Pi binding as fixtures and assertions spell it, derived
 * from `DESKTOP_VLLM_ROUTE` so a requalified local route changes the catalog
 * alone. Every catalog profile lowers its Pi binding to this one route at
 * thinking `high`.
 *
 * The one deliberate literal spelling is the golden-bytes assertion in
 * `tests/handlers/complete-wave-gate.test.ts`, which pins the serialized
 * authority bytes themselves.
 *
 * Beside it sits the one retired cloud binding the route suites record: read
 * from the catalog's own history, so it is always a binding some profile
 * really issued before local-only routing (ADR-0023).
 */
import { DESKTOP_VLLM_ROUTE, recordedProfileBindings, type PiBinding } from "../../src/core/model-profiles";

/** The issued Pi harness binding of every catalog profile. */
export const LOCAL_PI_BINDING = Object.freeze({ harness: "pi", ...DESKTOP_VLLM_ROUTE, thinking: "high" } as const);

/** The same binding as a rendered Pi agent's `model:` value and `--model` argument: `provider/model:thinking`. */
export const LOCAL_PI_MODEL_ARGUMENT = `${LOCAL_PI_BINDING.provider}/${LOCAL_PI_BINDING.model}:${LOCAL_PI_BINDING.thinking}` as const;

/** The local binding's route name, `provider/model`, as the route gate reports it. */
export const LOCAL_PI_ROUTE = `${LOCAL_PI_BINDING.provider}/${LOCAL_PI_BINDING.model}` as const;

/** The catalog profile whose retired cloud binding the route suites record. */
export const RETIRED_CLOUD_PROFILE = "general-review" as const;

function retiredCloudBinding(): PiBinding {
  const retired = recordedProfileBindings(RETIRED_CLOUD_PROFILE).pi.find(({ provider }) => provider !== DESKTOP_VLLM_ROUTE.provider);
  if (retired === undefined) throw new Error(`profile '${RETIRED_CLOUD_PROFILE}' records no retired cloud Pi binding`);
  return retired;
}

/** A cloud Pi binding `RETIRED_CLOUD_PROFILE` issued before local-only routing: recorded history, never launchable. */
export const RETIRED_CLOUD_PI_BINDING: PiBinding = retiredCloudBinding();

/** The retired cloud binding's route name, `provider/model`. */
export const RETIRED_CLOUD_ROUTE = `${RETIRED_CLOUD_PI_BINDING.provider}/${RETIRED_CLOUD_PI_BINDING.model}`;
