/**
 * Emission readiness: the in-child half of the launcher barrier (AD-4/FR-008).
 *
 * Registers the readiness command an emission-enabled child's launcher
 * invokes, and the awaited `before_agent_start` hold that wedges any prompt
 * delivered without that exchange. The registration decision and readiness
 * report are pure (`pi/emission-tool.ts`); this module is their Pi shell and
 * owns the child's process-local registration and hold state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundedThrownCause } from "../engine/src/core/orchestration-contract/identity";
import {
  decideEmissionToolRegistration,
  describeEmissionRegistrationContradiction,
  emissionReadinessReport,
  emissionToolDefinition,
  EMISSION_HOLD_ENTRY_TYPE,
  EMISSION_READINESS_COMMAND,
  EMISSION_READINESS_ENTRY_TYPE,
  LOOM_EMISSION_BINDING_ENV,
  parseEmissionChildProvisioning,
  type EmissionHoldPhase,
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
  // The one transition a child's registration takes, wrapping the side
  // effect that makes it true (pi.registerTool): unregistered → registered.
  // The transition DECISION is pure (pi/emission-tool.ts); the shell applies
  // it — this field is the child's process-local aggregate, the same posture
  // as the parent session runtimes in `pi/spawn-reservation.ts`.
  const emissionRegistrationState: { state: EmissionToolRegistration } = { state: { kind: "unregistered" } };
  type EmissionHold =
    | Readonly<{ kind: "unprovisioned" }>
    | Readonly<{ kind: "armed"; wait: Promise<void>; release: () => void }>
    | Readonly<{ kind: "released" }>;
  const armEmissionHold = (): EmissionHold => {
    const deferred = Promise.withResolvers<void>();
    return Object.freeze({ kind: "armed" as const, wait: deferred.promise, release: () => deferred.resolve() });
  };
  const emissionHoldState: { current: EmissionHold } = {
    current: emissionChild.kind === "not-provisioned"
      ? Object.freeze({ kind: "unprovisioned" as const })
      : armEmissionHold(),
  };
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

  pi.registerCommand(EMISSION_READINESS_COMMAND, {
    description: "Emission readiness: register the issued emission tool, verify it active, report the bound readiness payload.",
    handler: async () => {
      // Local narrowed copy of the once-parsed provisioning: the handler
      // narrows its own view (closure narrowing of the outer const is not
      // assumed).
      const provisioned = emissionChild;
      if (provisioned.kind === "not-provisioned") {
        throw new Error(
          "loom-emission-readiness is only for emission-enabled children: no LOOM_EMISSION_BINDING is provisioned in this child. " +
            "Remediation: the launcher barrier provisions the issued emission binding before readiness.",
        );
      }
      if (provisioned.kind === "provisioning-refused") {
        throw new Error(
          `the provisioned LOOM_EMISSION_BINDING is unusable [${provisioned.code}]: ${provisioned.reason}. ` +
            "Remediation: respawn the child with the issued emission binding.",
        );
      }
      const registration = decideEmissionToolRegistration(emissionRegistrationState.state, provisioned.binding);
      if (registration.kind === "contradictory") {
        throw new Error(
          `${describeEmissionRegistrationContradiction(registration)}. ` +
            "Remediation: spawn a fresh child for each issued request — a child holds exactly one binding.",
        );
      }
      if (registration.kind === "register") {
        const definition = emissionToolDefinition(provisioned.binding);
        // THE confined TypeBox claim at the ONE pi registration surface: the
        // parameters ARE the frozen bytes parsed once (one schema, no second
        // contract — FR-021/SC-006); pi's registerTool types them as a
        // TypeBox schema, and the byte-match guard is the contract suite's.
        pi.registerTool(definition as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
        emissionRegistrationState.state = { kind: "registered", binding: provisioned.binding };
      }
      const active = pi.getActiveTools().includes(provisioned.binding.toolName);
      const report = emissionReadinessReport(provisioned, {
        revision: runtimeRevision,
        active,
        childPid: process.pid,
        registeredTools: pi.getAllTools().map((tool) => tool.name),
      });
      pi.appendEntry(EMISSION_READINESS_ENTRY_TYPE, report);
      // The hold releases only when the registered tool is in the ACTUAL
      // active set: an honestly-inactive tool is reported (the gate refuses)
      // and its prompts stay wedged — fail-closed, never silently degraded.
      const hold = emissionHoldState.current;
      if (active && hold.kind === "armed") {
        emissionHoldState.current = Object.freeze({ kind: "released" as const });
        hold.release();
      }
      return undefined;
    },
  });

  pi.on("before_agent_start", async () => {
    const hold = emissionHoldState.current;
    if (hold.kind !== "armed") return undefined;
    appendEmissionHoldDiagnostic("entered");
    await hold.wait;
    appendEmissionHoldDiagnostic("resolved");
    return undefined;
  });

  // Fail-safe hold resolution (AD-4's cleanup arm): a provisioned child whose
  // hold is still ARMED at session shutdown must not leave its awaited
  // before_agent_start handler pending forever — the wedged coroutine cannot
  // outlive the session it gates. Releasing at shutdown admits no model
  // request (the session is ending), so the barrier stays fail-closed for
  // every prompt; the shutdown-released entry is the honest forensic marker
  // that readiness never opened on this child. An already-released (or
  // never-armed) hold is inert here.
  pi.on("session_shutdown", async () => {
    const hold = emissionHoldState.current;
    if (hold.kind !== "armed") return;
    emissionHoldState.current = Object.freeze({ kind: "released" as const });
    hold.release();
    appendEmissionHoldDiagnostic("shutdown-released");
  });
}
