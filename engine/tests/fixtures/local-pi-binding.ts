/**
 * The catalog's local Pi binding as fixtures and assertions spell it, derived
 * from `DESKTOP_VLLM_ROUTE` so a requalified local route changes the catalog
 * alone. Every catalog profile lowers its Pi binding to this one route at
 * thinking `high`.
 *
 * The one deliberate literal spelling is the golden-bytes assertion in
 * `tests/handlers/complete-wave-gate.test.ts`, which pins the serialized
 * authority bytes themselves.
 */
import { DESKTOP_VLLM_ROUTE } from "../../src/core/model-profiles";

/** The issued Pi harness binding of every catalog profile. */
export const LOCAL_PI_BINDING = Object.freeze({ harness: "pi", ...DESKTOP_VLLM_ROUTE, thinking: "high" } as const);

/** The same binding as a rendered Pi agent's `model:` value and `--model` argument: `provider/model:thinking`. */
export const LOCAL_PI_MODEL_ARGUMENT = `${LOCAL_PI_BINDING.provider}/${LOCAL_PI_BINDING.model}:${LOCAL_PI_BINDING.thinking}` as const;
