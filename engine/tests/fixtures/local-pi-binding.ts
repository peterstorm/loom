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
 * (ADR-0023). `underRetiredPiCatalog` replays such history: it runs a drive
 * against the catalog as it stood when the named profiles still lowered to
 * their retired binding.
 */
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import {
  DESKTOP_VLLM_ROUTE,
  piModelPattern,
  recordedProfileBindings,
  type LlmProfileId,
  type PiBinding,
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

/** The catalog profile whose retired cloud binding the route suites record. */
export const RETIRED_CLOUD_PROFILE = "general-review" as const;

/** A cloud Pi binding `RETIRED_CLOUD_PROFILE` issued before local-only routing. */
export const RETIRED_CLOUD_PI_BINDING: PiBinding = retiredCloudPiBinding(RETIRED_CLOUD_PROFILE);

/** The retired cloud binding's route name, `provider/model`. */
export const RETIRED_CLOUD_ROUTE = `${RETIRED_CLOUD_PI_BINDING.provider}/${RETIRED_CLOUD_PI_BINDING.model}`;

/** The cloud Pi binding the `refutation` profile issued before local-only routing. */
export const RETIRED_REFUTATION_PI_BINDING: PiBinding = retiredCloudPiBinding("refutation");

/** Per catalog profile, the retired Pi binding it lowers to in a replayed historical catalog. */
export type RetiredPiCatalog = Readonly<Partial<Record<LlmProfileId, PiBinding>>>;

const MODEL_PROFILES_MODULE = fileURLToPath(new URL("../../src/core/model-profiles.ts", import.meta.url));

/**
 * Run `drive` against the catalog as it stood BEFORE the 2026-10-08
 * retargeting, for the profiles `retired` names: each lowers its Pi binding to
 * the retired binding the map gives it, which must be one that profile really
 * recorded. Everything `drive` imports is loaded fresh under that catalog, so
 * the engine itself writes a run whose recorded authorities carry the retired
 * binding; afterwards today's catalog is back.
 *
 * The catalog's public lowering entries — `currentProfileBindings` and
 * `lowerModelProfile` — are replaced; a caller that asserts the retired
 * binding reached its recorded authorities fails loudly should the catalog
 * gain a lowering path this replay does not cover.
 */
export async function underRetiredPiCatalog<T>(retired: RetiredPiCatalog, drive: () => Promise<T>): Promise<T> {
  for (const [profile, binding] of Object.entries(retired) as [LlmProfileId, PiBinding][]) {
    const history = recordedProfileBindings(profile).pi.slice(1);
    if (!history.some((recorded) => piModelPattern(recorded) === piModelPattern(binding))) {
      throw new Error(`profile '${profile}' never recorded the retired Pi binding ${piModelPattern(binding)}`);
    }
  }
  vi.resetModules();
  vi.doMock(MODEL_PROFILES_MODULE, async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/core/model-profiles")>();
    return {
      ...actual,
      currentProfileBindings: (profileId: LlmProfileId) => {
        const current = actual.currentProfileBindings(profileId);
        const binding = retired[profileId];
        return binding === undefined ? current : Object.freeze({ ...current, pi: binding });
      },
      lowerModelProfile: (profile: Parameters<typeof actual.lowerModelProfile>[0], harness: "pi" | "claude-code") =>
        (harness === "pi" ? retired[profile.id] : undefined) ?? actual.lowerModelProfile(profile, harness),
    };
  });
  try {
    return await drive();
  } finally {
    vi.doUnmock(MODEL_PROFILES_MODULE);
    vi.resetModules();
  }
}
