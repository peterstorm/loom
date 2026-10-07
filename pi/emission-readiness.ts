/**
 * Emission readiness: the in-child half of the launcher barrier (AD-4/FR-008).
 *
 * Registers the readiness command an emission-enabled child's launcher
 * invokes, and the awaited `before_agent_start` hold that wedges any prompt
 * delivered without that exchange. Every decision is pure in
 * `pi/emission-tool.ts` — provisioning, registration, the readiness report and
 * the hold transition law; this module is their Pi shell: it applies those
 * decisions and owns the child's two process-local cells (registration and
 * hold state) plus the one pending promise a wedged prompt awaits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundedThrownCause } from "../engine/src/core/orchestration-contract/identity";
import {
  decideEmissionHoldTransition,
  decideEmissionToolRegistration,
  describeEmissionRegistrationContradiction,
  emissionHoldWedgesPrompt,
  emissionReadinessReport,
  emissionToolDefinition,
  EMISSION_HOLD_ENTRY_TYPE,
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  initialEmissionHold,
  LOOM_EMISSION_BINDING_ENV,
  parseEmissionChildProvisioning,
  type EmissionHoldEvent,
  type EmissionHoldPhase,
  type EmissionHoldState,
  type EmissionToolRegistration,
} from "./emission-tool";

/** Register the readiness command, the readiness hold, and the hold's
 *  shutdown release, in that order. `runtimeRevision` is the loaded runtime
 *  the readiness report binds. */
export function registerPiEmissionReadiness(pi: ExtensionAPI, runtimeRevision: string): void {
  // An emission-enabled child is PROVISIONED by its launcher with the issued
  // binding before any prompt exists (LOOM_EMISSION_BINDING). The child never
  // self-declares readiness: the launcher discovers /loom-emission-readiness
  // via get_commands, invokes it through the RPC prompt command (extension
  // commands execute without a model request — proven by
  // probes/emission-readiness), and receives the bound readiness payload via
  // entry_appended. The in-child awaited before_agent_start hold is the
  // defense-in-depth layer: a prompt delivered without the readiness exchange
  // WEDGES here — holds gate, throws are caught-and-continued by pi and can
  // never carry this barrier. A non-emission child (no provisioning env) has
  // no hold, and the command refuses explicitly when invoked.
  const emissionChild = parseEmissionChildProvisioning(process.env[LOOM_EMISSION_BINDING_ENV]);
  // The child's process-local aggregates. Each moves only through its pure
  // decision in pi/emission-tool.ts; the shell applies the side effect that
  // makes the transition true (pi.registerTool, resolving the hold promise).
  const emissionRegistrationState: { state: EmissionToolRegistration } = { state: { kind: "unregistered" } };
  const emissionHold: { state: EmissionHoldState } = { state: initialEmissionHold(emissionChild) };
  const holdGate = Promise.withResolvers<void>();

  const appendEmissionHoldDiagnostic = (phase: EmissionHoldPhase): void => {
    try {
      pi.appendEntry(EMISSION_HOLD_ENTRY_TYPE, { phase });
    } catch (thrown) {
      // Diagnostics never carry the barrier: append failure is visible, while
      // the armed hold below remains the operation that gates the prompt.
      const cause = boundedThrownCause(thrown, "emission hold diagnostic append");
      process.stderr.write(
        `loom(pi): emission hold ${phase} diagnostic append failed (${cause.name}: ${cause.message}); the hold remains fail-closed\n`,
      );
    }
  };
  const applyHoldEvent = (event: EmissionHoldEvent): void => {
    const transition = decideEmissionHoldTransition(emissionHold.state, event);
    emissionHold.state = transition.next;
    if (transition.release) holdGate.resolve();
    if (transition.diagnostic !== null) appendEmissionHoldDiagnostic(transition.diagnostic);
  };

  pi.registerCommand(EMISSION_READINESS_COMMAND, {
    description: "Emission readiness: register the issued emission tool, verify it active, report the bound readiness payload.",
    handler: async () => {
      if (emissionChild.kind === "not-provisioned") {
        throw new Error(
          "loom-emission-readiness is only for emission-enabled children: no LOOM_EMISSION_BINDING is provisioned in this child. " +
            "Remediation: the launcher barrier provisions the issued emission binding before readiness.",
        );
      }
      if (emissionChild.kind === "provisioning-refused") {
        throw new Error(
          `the provisioned LOOM_EMISSION_BINDING is unusable [${emissionChild.code}]: ${emissionChild.reason}. ` +
            "Remediation: respawn the child with the issued emission binding.",
        );
      }
      const registration = decideEmissionToolRegistration(emissionRegistrationState.state, emissionChild.binding);
      if (registration.kind === "contradictory") {
        throw new Error(
          `${describeEmissionRegistrationContradiction(registration)}. ` +
            "Remediation: spawn a fresh child for each issued request — a child holds exactly one binding.",
        );
      }
      if (registration.kind === "register") {
        const definition = emissionToolDefinition(emissionChild.binding);
        // THE confined TypeBox claim at the ONE pi registration surface: the
        // parameters ARE the frozen bytes parsed once (one schema, no second
        // contract — FR-021/SC-006); pi's registerTool types them as a
        // TypeBox schema, and the byte-match guard is the contract suite's.
        pi.registerTool(definition as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
        emissionRegistrationState.state = { kind: "registered", binding: emissionChild.binding };
      }
      const active = pi.getActiveTools().includes(emissionChild.binding.toolName);
      const report = emissionReadinessReport(emissionChild, {
        revision: runtimeRevision,
        active,
        childPid: process.pid,
        registeredTools: pi.getAllTools().map((tool) => tool.name),
      });
      pi.appendEntry(EMISSION_READINESS_ENTRY_TYPE, report);
      // Report first, then release: the hold opens only for a tool in the
      // ACTUAL active set (decideEmissionHoldTransition).
      applyHoldEvent({ kind: "readiness-reported", active });
      return undefined;
    },
  });

  pi.on("before_agent_start", async () => {
    if (!emissionHoldWedgesPrompt(emissionHold.state)) return undefined;
    appendEmissionHoldDiagnostic("entered");
    await holdGate.promise;
    appendEmissionHoldDiagnostic("resolved");
    return undefined;
  });

  // Fail-safe hold resolution (AD-4's cleanup arm): a still-armed hold must not
  // leave its awaited before_agent_start handler pending past the session it
  // gates. The transition law decides; an already-released or never-armed hold
  // is inert.
  pi.on("session_shutdown", async () => {
    applyHoldEvent({ kind: "session-shutdown" });
  });
}
