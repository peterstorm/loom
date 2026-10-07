import type { IssuedEmissionBinding } from "../../src/core/emission-tool";
import type { EmissionCallFrame } from "../../src/core/emission-observation";

/**
 * One complete emission call frame bound to `binding`'s request, kind and
 * version — the single fixture definition of the observed-call shape, so a
 * change to `EmissionToolCall` is a one-place edit for the successor suites.
 */
export const emissionCallFrame = (
  binding: IssuedEmissionBinding,
  toolCallId: string,
  arguments_: unknown,
): Extract<EmissionCallFrame, { kind: "complete" }> => ({
  kind: "complete",
  call: { requestId: binding.requestId, toolCallId, kind: binding.kind, version: binding.version, arguments: arguments_ },
});
