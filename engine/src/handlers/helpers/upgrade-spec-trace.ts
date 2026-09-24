/**
 * Atomically upgrade one active legacy TaskGraph to Requirement trace v2.
 * Reads exact ownership JSON from stdin and writes only through StateManager.
 */

import { join } from "node:path";
import type { ActiveWaveGateRegistration, HookHandler, TaskGraph } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { anyActiveSubagent } from "../../machine/ledger";
import {
  prepareAbandonedWaveGateSpecTraceUpgrade,
  prepareSpecTraceUpgrade,
  type SpecTraceWaveGateAbandonment,
} from "../../core/spec-trace-migration";
import { inspectRunDirectoryEntry, openRunDirectory, type RunDirHandle } from "../../orchestration/run-directory-handle";
import { parseRegisteredFacadeProgram } from "./programs";

const RETIRE_FLAG = "--retire-abandoned-run";

type RetirementProof = Readonly<{
  active: ActiveWaveGateRegistration;
  abandonment: SpecTraceWaveGateAbandonment;
}>;

type RetirementProofResult =
  | Readonly<{ ok: true; value: RetirementProof }>
  | Readonly<{ ok: false; message: string }>;

const failedProof = (message: string): RetirementProofResult => Object.freeze({ ok: false, message });

type ProofRefusal = Readonly<{ ok: false; message: string }>;

/** Re-prove that the exact protected Run Directory still exists and belongs to the registered run. */
function openProtectedWaveGateRun(
  active: ActiveWaveGateRegistration,
  runsRoot: string,
): Readonly<{ ok: true; handle: RunDirHandle }> | ProofRefusal {
  const opened = openRunDirectory(runsRoot, join(runsRoot, active.runId));
  if (!opened.ok) {
    return { ok: false, message: `Cannot open exact protected Wave Gate run ${active.runId}: ${opened.error.message}` };
  }
  const authority = opened.value.readAuthority();
  if (!authority.ok) {
    return { ok: false, message: `Cannot re-prove protected Wave Gate run authority: ${authority.error.message}` };
  }
  if (authority.value.runId !== active.runId || authority.value.runsRoot !== runsRoot ||
      authority.value.runDirectory !== join(runsRoot, active.runId)) {
    return {
      ok: false,
      message: `Wave Gate Run Directory authority does not match protected ${runsRoot}/${active.runId}`,
    };
  }
  return { ok: true, handle: opened.value };
}

/** Re-prove the registered program authority against the exact locked registration. */
function proveRegisteredWaveGateProgram(
  handle: RunDirHandle,
  active: ActiveWaveGateRegistration,
  waveTaskIds: readonly string[],
): Readonly<{ ok: true }> | ProofRefusal {
  const storedProgram = handle.readProgramRegistration();
  if (!storedProgram.ok) {
    return { ok: false, message: `Cannot read protected Wave Gate program authority: ${storedProgram.error.message}` };
  }
  const parsedProgram = parseRegisteredFacadeProgram(storedProgram.value);
  if (parsedProgram.kind !== "registered" || parsedProgram.program.kind !== "wave-gate") {
    return { ok: false, message: `Run ${active.runId} does not carry readable engine-owned Wave Gate program authority` };
  }
  const program = parsedProgram.program;
  if (program.input.wave !== active.wave || program.authorityDigest !== active.authorityDigest ||
      program.taskIds.length !== waveTaskIds.length || program.taskIds.some((id, index) => id !== waveTaskIds[index])) {
    return {
      ok: false,
      message: `Run ${active.runId} Wave Gate program authority does not match the protected active registration`,
    };
  }
  return { ok: true };
}

/** Re-prove the immutable abandonment marker and its named successor. */
function proveAbandonmentMarker(
  handle: RunDirHandle,
  active: ActiveWaveGateRegistration,
  runsRoot: string,
): Readonly<{ ok: true; value: SpecTraceWaveGateAbandonment }> | ProofRefusal {
  const marker = handle.readAbandonment();
  if (!marker.ok) {
    return { ok: false, message: `Cannot read immutable abandonment marker for run ${active.runId}: ${marker.error.message}` };
  }
  if (marker.value === null) {
    return {
      ok: false,
      message: `Run ${active.runId} is not abandoned; first use engine-owned helper orchestration abandon with a non-empty reason`,
    };
  }
  if (marker.value.runId !== active.runId) {
    return { ok: false, message: `Abandonment marker belongs to foreign run ${marker.value.runId}; expected ${active.runId}` };
  }
  if (marker.value.supersededBy !== null) {
    const successor = inspectRunDirectoryEntry(runsRoot, marker.value.supersededBy);
    if (!successor.ok || successor.value.kind !== "directory" ||
        successor.value.reference.runId !== marker.value.supersededBy) {
      const cause = !successor.ok ? successor.error.message : "the named successor is not an existing Run Directory";
      return { ok: false, message: `Abandonment supersession mismatch for ${marker.value.supersededBy}: ${cause}` };
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      runId: marker.value.runId,
      reason: marker.value.reason,
      supersededBy: marker.value.supersededBy,
    }),
  };
}

function proveAbandonedActiveWaveGate(graph: TaskGraph): RetirementProofResult {
  const active = graph.active_wave_gate;
  if (active === undefined) return failedProof("Spec trace Wave Gate retirement requires protected active_wave_gate authority");
  // A `terminal-abandoned` tombstone is the expected post-`orchestration
  // abandon` shape (the state stamp mirrors the run-directory marker); only
  // legacy done/terminal-blocked outcomes still refuse retirement.
  if (active.terminalOutcome !== null && active.terminalOutcome.kind !== "terminal-abandoned") {
    return failedProof(`Spec trace Wave Gate retirement requires nonterminal active run ${active.runId}`);
  }
  if (active.runsRoot === undefined) {
    return failedProof(`Spec trace Wave Gate retirement requires run ${active.runId} to carry protected runsRoot authority`);
  }
  const opened = openProtectedWaveGateRun(active, active.runsRoot);
  if (!opened.ok) return failedProof(opened.message);
  const waveTaskIds = graph.tasks.filter(({ wave }) => wave === active.wave).map(({ id }) => id);
  const program = proveRegisteredWaveGateProgram(opened.handle, active, waveTaskIds);
  if (!program.ok) return failedProof(program.message);
  const marker = proveAbandonmentMarker(opened.handle, active, active.runsRoot);
  if (!marker.ok) return failedProof(marker.message);
  return Object.freeze({ ok: true, value: Object.freeze({ active, abandonment: marker.value }) });
}

function sameRetirementProof(left: RetirementProof, right: RetirementProof): boolean {
  return left.active.runId === right.active.runId && left.active.wave === right.active.wave &&
    left.active.authorityDigest === right.active.authorityDigest && left.active.revision === right.active.revision &&
    left.active.runsRoot === right.active.runsRoot && left.abandonment.reason === right.abandonment.reason &&
    left.abandonment.supersededBy === right.abandonment.supersededBy;
}

const handler: HookHandler = async (stdin, args) => {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== RETIRE_FLAG)) {
    return { kind: "error", message: `Usage: helper upgrade-spec-trace [${RETIRE_FLAG}]` };
  }
  const retireAbandonedRun = args[0] === RETIRE_FLAG;

  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch (error) {
    return {
      kind: "error",
      message: `Invalid spec trace upgrade JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };
  if (anyActiveSubagent(statePath)) {
    return {
      kind: "error",
      message: "Spec trace upgrade refused while a subagent is active for this TaskGraph; wait for the exact roster to settle and retry",
    };
  }

  try {
    const preRead = manager.load();
    const preProof = retireAbandonedRun && preRead.active_wave_gate !== undefined
      ? proveAbandonedActiveWaveGate(preRead)
      : null;
    if (preProof !== null && !preProof.ok) return { kind: "error", message: preProof.message };

    const outcome = await manager.updateAndReturn((locked) => {
      if (anyActiveSubagent(statePath)) {
        throw new Error("A subagent became active before the spec trace upgrade could commit");
      }
      if (!retireAbandonedRun || locked.active_wave_gate === undefined) {
        const prepared = prepareSpecTraceUpgrade(locked, input);
        if (!prepared.ok) throw new Error(prepared.error.message);
        return { state: prepared.value.graph, value: prepared.value.kind };
      }

      const lockedProof = proveAbandonedActiveWaveGate(locked);
      if (!lockedProof.ok) throw new Error(lockedProof.message);
      if (preProof === null || !sameRetirementProof(preProof.value, lockedProof.value)) {
        throw new Error("Protected Wave Gate authority or abandonment supersession changed before locked retirement proof");
      }
      const prepared = prepareAbandonedWaveGateSpecTraceUpgrade(locked, input, lockedProof.value.abandonment);
      if (!prepared.ok) throw new Error(prepared.error.message);
      return { state: prepared.value.graph, value: prepared.value.kind };
    });
    process.stderr.write(outcome === "already-v2"
      ? "Spec trace graph already uses the exact requested v2 ownership\n"
      : "Spec trace graph upgraded atomically to v2\n");
    return { kind: "passthrough" };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
};

export default handler;
