/**
 * Resolve implementation completion into the Task's proof state.
 *
 * 1. Resolve test evidence — the agent's own epoch in the evidence ledger
 *    (execution-time ground truth) first; transcript regex as the labeled,
 *    lower-trust fallback
 * 2. Verify new tests via git diff plus added test-declaration and assertion counts
 * 3. Atomically persist evidence and the derived Proof aggregate
 * 4. Mark implemented only when every obligation is satisfied; otherwise keep
 *    the Task pending, then signal /wave-gate only when the Wave is complete
 */

import { readFileSync, realpathSync } from "node:fs";
import type { HookHandler, HookResult } from "../../types";
import { legacyTestsPassedNote } from "../../types";
import { IMPL_AGENTS, machinesDir } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { extractTaskId } from "../../utils/extract-task-id";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { canonicalRepositoryPaths } from "../../utils/repository-path";
import {
  compareAttemptBaseline,
} from "../../utils/artifact-baseline";
import { parseTranscript } from "../../parsers/parse-transcript";
import { parseFilesModified } from "../../parsers/parse-files-modified";
import { parseBashTestOutput } from "../../parsers/parse-bash-test-output";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import * as git from "../../utils/git";
import {
  epochOf,
  eventsForEpoch,
  foldEvidence,
  loadMachine,
  missingRequirements,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  readEvidence,
} from "../../machine";
import type { EvidenceRecord, LoadedMachine } from "../../machine";
import { TRUSTED_LEDGER_ONLY_POLICY } from "../../core/proof-obligations";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { taskVerificationPolicy } from "../../core/verification-policy";
import type { ImplementationAuthorityObservation } from "../../implementation-attempt-sidecar";
import { parseCompleteClaudeJsonl } from "../../core/claude-transcript-integrity";
import {
  parseIsoInstant,
  type ImplementationAttemptAuthority,
} from "../../core/implementation-completion";
import {
  capVerdictForMachineCompletion,
  resolveTestEvidence,
} from "../../core/implementation-evidence";
import {
  applyCompletionInfrastructureFailure,
  applyUntrustedStopResolution,
  cumulativeModifiedPaths,
  isWaveComplete,
  settleUnavailableImplementation,
  type ImplementationSettlementApplicationResult,
  type NewTestEvidence,
} from "../../core/implementation-application";
import {
  collectNewTestEvidence,
  describeNewTestObservationError,
} from "../helpers/task-local-completion";
import {
  productionExactSettlementPorts,
  settleExactImplementation,
} from "../helpers/exact-implementation-settlement";
// Historical callers import these shell utilities from this handler. Keep the
// surface while the implementation lives in the neutral shared shell module.
export {
  analyzeNewTests,
  collectDiff,
  collectNewTestEvidence,
  type DiffDeps,
} from "../helpers/task-local-completion";

/**
 * Is the agent's machine BOUND for evidence purposes? "invalid" counts as
 * bound: a machine definition exists for this agent — ground truth was
 * expected — so an empty ledger must surface as "degraded", not be
 * mislabeled as an unbound/legacy "fallback" run.
 */
export function isMachineBound(loaded: LoadedMachine): boolean {
  return loaded.kind !== "none";
}

/**
 * The dispatcher's pre-unbind ledger snapshot, as a discriminated union so
 * a FAILED read is never confused with a genuinely empty ledger:
 * - "snapshot"        — the ledger was read; `events` may legitimately be []
 * - "snapshot-failed" — the read THREW; ledger contents are unknown, so the
 *                       verdict is labeled snapshot-read-failed instead of
 *                       minting a misleading "degraded"
 * dispatch.ts builds it; this module consumes it — keep both in sync.
 */
export type EvidenceSnapshot =
  | { readonly kind: "snapshot"; readonly events: readonly EvidenceRecord[] }
  | { readonly kind: "snapshot-failed" };

type LegacyUnreadableTranscriptSettlement =
  | Readonly<{ kind: "quarantined"; taskId: string }>
  | Readonly<{ kind: "preserved"; executingCount: number }>;

async function settleModernTranscriptUnavailable(
  manager: StateManager,
  authority: ImplementationAttemptAuthority,
  reason: string,
): Promise<HookResult> {
  const observedAt = parseIsoInstant(new Date().toISOString(), "Claude transcript failure instant");
  if (!observedAt.ok) {
    return { kind: "error", message: `update-task-status: ${observedAt.error.errors.join("; ")}` };
  }
  const settlement = await manager.updateAndReturn((state) => {
    const applied = settleUnavailableImplementation(state, authority, observedAt.value, reason);
    return { state: applied.kind === "applied" ? applied.state : state, value: applied };
  });
  if (settlement.kind === "error") {
    return {
      kind: "error",
      message: `update-task-status: Oracle transcript infrastructure settlement failed: ${JSON.stringify(settlement.error)}`,
    };
  }
  if (settlement.kind === "ignored") {
    return {
      kind: "error",
      message: `update-task-status: unavailable Claude transcript delivery was ignored as ${settlement.reason}; current authority was preserved`,
    };
  }
  return {
    kind: "error",
    message:
      `update-task-status: ${reason}; ${authority.taskId} received an exact non-consuming ` +
      "infrastructure Oracle receipt and cannot become implemented",
  };
}

/**
 * Handler core. `evidenceSnapshot` lets the dispatcher pass ledger records
 * captured BEFORE cleanup unbound the machine: attribution runs through the
 * live binding, so once cleanup has unbound it this epoch's own records can no
 * longer be told apart from a sibling's by reading the file here. (The bind
 * itself no longer truncates — see `bindMachineAgent` in machine/ledger.ts,
 * which documents why that was removed.) Standalone invocation (no snapshot)
 * reads the ledger directly.
 */
export const runUpdateTaskStatus = async (
  stdin: string,
  _args: string[],
  evidenceSnapshot?: EvidenceSnapshot,
  authorityObservation?: ImplementationAuthorityObservation,
): Promise<HookResult> => {
  // Guard the standalone CLI route: dispatch parses stdin before calling
  // handlers, but this handler is also registered directly (KNOWN_HANDLERS),
  // where a bare JSON.parse throw would surface as an uncontextualized
  // "Hook error" (mirrors cleanup-subagent-flag).
  const parsedInput = parseSubagentStopStdin(stdin);
  if (!parsedInput.ok) {
    return {
      kind: "error",
      message: `update-task-status: invalid SubagentStop input — task status and test evidence NOT updated: ${parsedInput.error}`,
    };
  }
  const input = parsedInput.value;
  // Claude Code does not send agent_type; fall back to the metadata the
  // harness writes beside the transcript. This handler is also registered
  // standalone (KNOWN_HANDLERS), so it cannot assume the dispatcher already
  // resolved it.
  const agentType = stripNamespace(resolveAgentType(input));
  if (agentType === "" && authorityObservation?.kind !== "authority-observed") {
    return {
      kind: "error",
      message: "update-task-status: SubagentStop Agent identity is unavailable — task status and test evidence NOT updated",
    };
  }

  // A parsed sidecar is stronger routing authority than optional Claude
  // agent_type metadata. Dispatch passes the retained snapshot before cleanup;
  // the standalone route still requires a recognized implementation Agent.
  if (!IMPL_AGENTS.has(agentType) && authorityObservation?.kind !== "authority-observed") {
    return { kind: "passthrough" };
  }

  let mgr: StateManager | null;
  try {
    mgr = StateManager.fromSession(input.session_id);
  } catch (error) {
    return {
      kind: "error",
      message: `update-task-status: session TaskGraph authority unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!mgr) {
    return {
      kind: "error",
      message: `update-task-status: no TaskGraph authority for session ${JSON.stringify(input.session_id)} — task status and test evidence NOT updated`,
    };
  }

  const authority = authorityObservation?.kind === "authority-observed"
    ? authorityObservation.sidecar.authority
    : null;
  const graphBeforeTranscript = mgr.load();
  const modernAttempts = graphBeforeTranscript.tasks.filter((task) => task.active_implementation_attempt !== undefined);
  if (authorityObservation?.kind === "authority-unavailable" && modernAttempts.length > 0) {
    return {
      kind: "error",
      message: `update-task-status: ${authorityObservation.failure.kind}: ${authorityObservation.failure.message}; modern implementation authority was preserved`,
    };
  }
  if (authorityObservation === undefined && modernAttempts.length > 0) {
    return {
      kind: "error",
      message: "update-task-status: modern implementation settlement requires a snapshotted Claude authority sidecar; execution authority was preserved",
    };
  }
  if (authorityObservation?.kind === "authority-observed") {
    let managerGraphPath: string;
    try {
      managerGraphPath = realpathSync.native(mgr.getPath());
    } catch (error) {
      return {
        kind: "error",
        message: `update-task-status: cannot canonicalize session TaskGraph path: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (managerGraphPath !== authorityObservation.sidecar.canonicalTaskGraphPath) {
      return {
        kind: "error",
        message: "update-task-status: implementation sidecar belongs to a different canonical TaskGraph; execution authority was preserved",
      };
    }
    const observedAuthority = authorityObservation.sidecar.authority;
    const task = graphBeforeTranscript.tasks.find((candidate) => candidate.id === observedAuthority.taskId);
    const alreadyReceipted = task?.implementation_attempt_history?.some(
      (receipt) => receipt.authorityDigest === observedAuthority.authorityDigest,
    ) === true;
    if (!alreadyReceipted && (
      task?.active_implementation_attempt?.authorityDigest !== observedAuthority.authorityDigest ||
      !(graphBeforeTranscript.executing_tasks ?? []).includes(observedAuthority.taskId)
    )) {
      return {
        kind: "error",
        message: `update-task-status: stale implementation authority for ${observedAuthority.taskId}; late result was ignored without releasing the current attempt`,
      };
    }
  }

  // Parse transcript (read file content, then parse). The path is RESOLVED,
  // not read off the payload: an available supplied `agent_transcript_path`
  // wins; an unavailable or absent supplied path falls back to the derived
  // on-disk location. Exact modern Claude settlement requires this transcript,
  // so an unlocatable path becomes an infrastructure receipt. Legacy compatibility
  // may continue with empty content only to infer and quarantine one exact
  // executing Task — never to grant positive completion authority.
  const transcriptPath = resolveAgentTranscriptPath(input);
  if (authority !== null && transcriptPath === null) {
    return settleModernTranscriptUnavailable(
      mgr,
      authority,
      "Claude transcript unavailable: no resolvable transcript path",
    );
  }
  let transcriptContent = "";
  if (transcriptPath) {
    try {
      transcriptContent = readFileSync(transcriptPath, "utf-8");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (authority !== null) {
        return settleModernTranscriptUnavailable(mgr, authority, `Claude transcript unreadable: ${cause}`);
      }
      const settlement = await mgr.updateAndReturn<LegacyUnreadableTranscriptSettlement>((state) => {
        const executing = state.executing_tasks ?? [];
        const taskId = executing.length === 1 ? executing[0] : undefined;
        const target = taskId === undefined ? undefined : state.tasks.find((task) => task.id === taskId);
        const exactLegacy = taskId !== undefined && target?.active_implementation_attempt === undefined;
        return exactLegacy
          ? {
              state: applyCompletionInfrastructureFailure(state, taskId, true),
              value: { kind: "quarantined", taskId } as const,
            }
          : {
              state,
              value: { kind: "preserved", executingCount: executing.length } as const,
            };
      });
      if (settlement.kind === "quarantined") {
        return {
          kind: "error",
          message: `update-task-status: cannot read transcript at ${transcriptPath}: ${cause}; quarantined ${settlement.taskId} for fresh revalidation`,
        };
      }
      return {
        kind: "error",
        message:
          `update-task-status: cannot read transcript at ${transcriptPath}: ${cause}; ` +
          `${settlement.executingCount} executing Tasks make cleanup attribution ${settlement.executingCount === 0 ? "unavailable" : "ambiguous"}, so execution authority was preserved`,
      };
    }
  }
  // Exact modern settlement cannot consume partial JSONL. Parse the complete
  // transcript before any identity, file, or test evidence extractor runs; a
  // malformed/truncated tail invalidates otherwise-valid earlier records.
  if (authority !== null) {
    const integrity = parseCompleteClaudeJsonl(transcriptContent);
    if (integrity.kind === "malformed") {
      return settleModernTranscriptUnavailable(mgr, authority, integrity.reason);
    }
    transcriptContent = integrity.transcript;
  }

  const transcript = parseTranscript(transcriptContent);
  const rawFilesModified = parseFilesModified(transcriptContent);
  const bashTestOutput = parseBashTestOutput(transcriptContent);

  // Modern identity comes only from the snapshotted sidecar. Transcript and
  // sole-executing inference remain compatibility-only for legacy graphs.
  let taskId: string | null = authority?.taskId ?? extractTaskId(transcript);

  // When transcript parse fails, try to infer task ID from executing_tasks.
  // If exactly one task is executing, it's unambiguous.
  if (!taskId) {
    const state = mgr.load();
    const executing = state.executing_tasks ?? [];
    if (executing.length === 1) {
      process.stderr.write(`WARNING: ${agentType} transcript parse failed, inferred task ${executing[0]} from executing_tasks\n`);
      taskId = executing[0];
      // Fall through with inferred taskId
    } else {
      // Ambiguous or unavailable attribution cannot release any execution
      // reservation: in a parallel Wave every entry may belong to a live
      // sibling. Preserve authority and make the missing settlement explicit.
      if (executing.length > 0) {
        process.stderr.write(`WARNING: ${agentType} completed without task ID, ${executing.length} tasks executing (ambiguous)\n`);
      } else {
        process.stderr.write(
          `WARNING: ${agentType} completed but task status was NOT recorded — no task ID in the transcript ` +
            `(${transcriptPath ? `read ${transcriptPath}` : "no transcript found: the payload named none and none was derivable from session/agent id"}) ` +
            `and executing_tasks is empty, so there is nothing to attribute the run to\n`,
        );
      }
      return {
        kind: "error",
        message:
          `update-task-status: ${agentType} completion has no task identity; ` +
          `${executing.length} executing Tasks make attribution ${executing.length === 0 ? "unavailable" : "ambiguous"}, so execution authority was preserved`,
      };
    }
  }

  const state = mgr.load();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      kind: "error",
      message:
        `update-task-status: transcript named unknown task ${taskId}; ` +
        `known tasks: ${state.tasks.map((candidate) => candidate.id).join(", ") || "<none>"}. ` +
        "Implementation evidence was NOT stored.",
    };
  }

  let filesModified: string[];
  try {
    filesModified = [...canonicalRepositoryPaths(
      git.repositoryRoot() ?? process.cwd(),
      rawFilesModified,
      "transcript files_modified",
    )];
  } catch (error) {
    // Invalid path evidence makes the attempt's byte effects unobservable.
    // Settle under the lock and conservatively invalidate changed-byte
    // authority; clearing only executing_tasks could leave a re-executed
    // implemented Task green on evidence from before this attempt.
    const cause = error instanceof Error ? error.message : String(error);
    if (authority === null) {
      await mgr.update((s) => applyCompletionInfrastructureFailure(s, taskId, true));
    } else {
      const observedAt = parseIsoInstant(new Date().toISOString(), "Claude unsafe-path instant");
      if (!observedAt.ok) return { kind: "error", message: observedAt.error.errors.join("; ") };
      let oracleFailure: string | null = null;
      await mgr.update((state) => {
        const applied = settleUnavailableImplementation(
          state,
          authority,
          observedAt.value,
          `Unsafe Claude modified-file evidence: ${cause}`,
        );
        if (applied.kind === "error") {
          oracleFailure = JSON.stringify(applied.error);
          return state;
        }
        return applied.state;
      });
      if (oracleFailure !== null) {
        return { kind: "error", message: `update-task-status: Oracle infrastructure settlement failed: ${oracleFailure}` };
      }
    }
    return {
      kind: "error",
      message: `update-task-status: unsafe modified-file evidence for ${taskId}: ${cause}`,
    };
  }

  // Pre-refactor graphs carried `tests_passed` on the task (replaced by
  // `test_result`, no compat read — unshipped branch). Explain the
  // otherwise-mystifying "missing evidence" once, where we touch the task.
  const legacyNote = legacyTestsPassedNote(task);
  if (legacyNote) process.stderr.write(`[loom] ${legacyNote}\n`);

  // Section 1: Test evidence — the agent's OWN epoch in the ledger first
  // (execution-time ground truth, attribution via agent_id), transcript
  // regex as explicit labeled fallback. Foreign epochs are never consulted.
  // Identity is PARSED before epoch construction AND before loadMachine: a
  // reserved or path-unsafe character in the hook input could never have been
  // bound/recorded (the bind boundary rejects it) and must never name a machine
  // file. The two parses are independent, so the consequences are too: an
  // unparseable `agent_id` yields no epoch events, and an unparseable
  // `agentType` yields no machine. Either way the lookup is never mis-keyed —
  // the missing half routes to the existing fallback path instead.
  const epochAgentId = input.agent_id ? parseAgentId(input.agent_id) : null;
  const epochAgentType = parseAgentType(agentType);
  // machinesDir() is resolved at call time (not the import-frozen constant)
  // so a re-pointed LOOM_MACHINES_DIR is honored without a module reload —
  // the same dir the gate and recorder consult.
  const loadedMachine: LoadedMachine =
    epochAgentType !== null ? loadMachine(machinesDir(), epochAgentType) : { kind: "none" };
  const machineBound = isMachineBound(loadedMachine);
  // A failed dispatcher snapshot means ledger contents are UNKNOWN — say so
  // and let resolveTestEvidence label the verdict snapshot-read-failed
  // instead of pretending the ledger was empty ("degraded").
  let snapshotFailed = evidenceSnapshot?.kind === "snapshot-failed";
  if (snapshotFailed) {
    process.stderr.write(
      `update-task-status: evidence snapshot for ${input.session_id} failed — ledger unavailable; verdict will be labeled snapshot-read-failed\n`,
    );
  }
  // Standalone route (no dispatcher snapshot): read the ledger directly, but
  // parse the session id at this boundary first — an unparseable id names no
  // ledger file, so it resolves to no evidence rather than throwing.
  const standaloneSessionId =
    evidenceSnapshot === undefined && input.session_id ? parseSessionId(input.session_id) : null;
  // A PRESENT-but-unparseable session id yields no records here, which is
  // indistinguishable from a genuinely empty ledger downstream — the verdict
  // would be mislabeled "degraded"/"fallback" instead of reflecting that the
  // ledger was never read. Say so once, mirroring dispatch.ts.
  if (evidenceSnapshot === undefined && input.session_id && standaloneSessionId === null) {
    snapshotFailed = true;
    process.stderr.write(
      `update-task-status: invalid session id ${input.session_id} — ledger not read; verdict labeled snapshot-read-failed\n`,
    );
  }
  let records: readonly EvidenceRecord[] = [];
  if (evidenceSnapshot === undefined && standaloneSessionId !== null) {
    try {
      records = readEvidence(standaloneSessionId);
    } catch (error) {
      snapshotFailed = true;
      process.stderr.write(
        `update-task-status: evidence ledger read failed for ${standaloneSessionId}: ` +
        `${error instanceof Error ? error.message : String(error)}; verdict labeled snapshot-read-failed\n`,
      );
    }
  } else if (evidenceSnapshot?.kind === "snapshot") {
    records = evidenceSnapshot.events;
  }
  const epochEvents = epochAgentId && epochAgentType
    ? eventsForEpoch(records, epochOf(epochAgentId, epochAgentType))
    : [];
  let testEvidence = resolveTestEvidence(epochEvents, bashTestOutput, machineBound, snapshotFailed);
  // Machine-bound agents don't self-report completion: fold this epoch's
  // evidence through the machine and consult its terminal requirements —
  // unmet requirements cap a trusted-pass at untrusted, labeled with what is
  // missing. Skipped when the snapshot failed (ledger contents unknown — the
  // snapshot-read-failed label already says so) and for invalid machines
  // (nothing to fold; the gate fails closed on those independently).
  if (!snapshotFailed && loadedMachine.kind === "machine") {
    const missing = missingRequirements(
      loadedMachine.machine,
      foldEvidence(loadedMachine.machine, epochEvents),
    );
    const capped = capVerdictForMachineCompletion(testEvidence, missing);
    if (capped !== testEvidence) {
      process.stderr.write(
        `update-task-status: machine ${loadedMachine.machine.agent} reports unmet terminal requirements — capping verdict at untrusted (${capped.result.verdict === "untrusted" ? capped.result.label : ""})\n`,
      );
      testEvidence = capped;
    }
  }

  // Section 3: Atomic state write. Attempt-baseline comparison, cumulative
  // attribution, and new-test evidence are derived from the locked Task below,
  // never the stale pre-lock read; the preserve-evidence guards also run INSIDE
  // the locked update (a pre-lock read can be outdated by a concurrent
  // writer before this write lands — TOCTOU) and are TRUST-aware ON BOTH
  // SIDES: an existing trusted failure is preserved against an UNTRUSTED
  // incoming resolution, while a trusted pass is preserved only if this retry
  // changed no code. Historical green evidence cannot prove newer bytes. An
  // untrusted result — e.g. a helper-reported "pass" from agent-controlled
  // stdin — otherwise cannot preempt ground truth (mirrors
  // store-test-evidence's skippedTrustedVerdict pattern), but NEWER ground
  // truth supersedes older: a re-spawned agent's
  // fresh epoch yielding trusted-pass/trusted-fail must land, or the first
  // real red run would wedge the task forever (the gate treats trusted-fail
  // as missing evidence and store-test-evidence also refuses trusted).
  // A completed task is never reopened, at any trust level.
  const repositoryRoot = git.repositoryRoot() ?? process.cwd();
  if (authority !== null) {
    const observedAt = parseIsoInstant(new Date().toISOString(), "Claude implementation observation instant");
    if (!observedAt.ok) return { kind: "error", message: observedAt.error.errors.join("; ") };
    const modernOutcome: { settlement?: ImplementationSettlementApplicationResult } = {};
    const settlementPorts = productionExactSettlementPorts(repositoryRoot);
    await mgr.update((locked) => {
      const settled = settleExactImplementation(locked, {
        transport: "Claude",
        authority,
        observedAt: observedAt.value,
        parserModifiedPaths: filesModified,
        parserPathLabel: "Claude transcript files_modified",
        taskCompleted: true,
        testResult: testEvidence.result,
        testEvidence: testEvidence.evidence,
        proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
      }, settlementPorts);
      modernOutcome.settlement = settled.application;
      return settled.application.kind === "error" ? locked : settled.application.state;
    });
    const modernSettlement = modernOutcome.settlement;
    if (modernSettlement === undefined) {
      return { kind: "error", message: "update-task-status: modern Oracle settlement produced no transition" };
    }
    if (modernSettlement.kind === "error") {
      return {
        kind: "error",
        message: `update-task-status: modern Oracle settlement failed: ${JSON.stringify(modernSettlement.error)}`,
      };
    }
    if (modernSettlement.kind === "ignored") {
      return passthroughDiagnostic(
        `update-task-status: ${authority.taskId} result ignored (${modernSettlement.reason}); current authority preserved\n`,
      );
    }
    process.stderr.write(`Task ${authority.taskId} settlement: ${modernSettlement.transition.kind}.\n`);
    const updated = modernSettlement.state;
    const currentWave = updated.current_wave ?? 1;
    if (isWaveComplete(updated, currentWave)) {
      process.stderr.write(`\nWave ${currentWave} implementation complete. Run: /wave-gate\n`);
    }
    return modernSettlement.transition.kind === "infrastructure-blocked"
      ? {
          kind: "error",
          message: `update-task-status: ${authority.taskId} completion infrastructure unavailable; exact attempt was released with an Oracle receipt`,
        }
      : { kind: "passthrough" };
  }

  let skippedExistingVerdict = false;
  let comparisonFailure: string | null = null;
  let newTestEvidenceFailure: string | null = null;
  await mgr.update((s) => {
    const target = s.tasks.find((candidate) => candidate.id === taskId);
    if (target === undefined || target.status === "completed") {
      skippedExistingVerdict = true;
      return applyUntrustedStopResolution(s, taskId, {
        taskCompleted: false,
        testResult: testEvidence.result,
        testEvidence: testEvidence.evidence,
        filesModified,
        changedDeclaredArtifacts: [],
        bytesChangedSinceAttempt: false,
        newTestsWritten: false,
        newTestEvidence: "",
      }, TRUSTED_LEDGER_ONLY_POLICY).state;
    }

    // No-authority Claude settlement is compatibility quarantine only. It may
    // compare and invalidate a proven legacy reservation, but never consume a
    // modern attempt or decide positive completion.
    if (target.active_implementation_attempt !== undefined ||
        !(s.executing_tasks ?? []).some((executingTaskId) => executingTaskId === taskId)) {
      skippedExistingVerdict = true;
      return s;
    }
    const comparison = compareAttemptBaseline(
      repositoryRoot,
      target,
      { kind: "repository-or-declared", extraModifiedPaths: filesModified },
    );
    if (comparison.failure !== null) {
      comparisonFailure = comparison.failure;
      return applyCompletionInfrastructureFailure(s, taskId, comparison.bytesChangedSinceAttempt);
    }
    const cumulativeFiles = cumulativeModifiedPaths(target.files_modified, filesModified);
    const verificationPolicy = taskVerificationPolicy(target);
    const newTestObservation = collectNewTestEvidence(
      cumulativeFiles,
      verificationPolicy.newTests,
      target.start_sha,
    );
    if (!newTestObservation.ok) {
      newTestEvidenceFailure = `update-task-status: cannot collect new-test evidence for ${taskId}: ` +
        describeNewTestObservationError(newTestObservation.error);
      return applyCompletionInfrastructureFailure(s, taskId, comparison.bytesChangedSinceAttempt);
    }
    const currentNewTestEvidence: NewTestEvidence = newTestObservation.value;
    const applied = applyUntrustedStopResolution(s, taskId, {
      taskCompleted: true,
      testResult: testEvidence.result,
      testEvidence: testEvidence.evidence,
      filesModified,
      changedDeclaredArtifacts: comparison.changedDeclaredArtifacts,
      bytesChangedSinceAttempt: comparison.bytesChangedSinceAttempt,
      newTestsWritten: currentNewTestEvidence.written,
      newTestEvidence: currentNewTestEvidence.evidence,
    }, TRUSTED_LEDGER_ONLY_POLICY);
    skippedExistingVerdict = applied.skipped;
    return applied.state;
  });

  if (comparisonFailure !== null) {
    return {
      kind: "error",
      message: `update-task-status: cannot compare declared-artifact baseline for ${taskId}: ${comparisonFailure}`,
    };
  }
  if (newTestEvidenceFailure !== null) {
    return { kind: "error", message: newTestEvidenceFailure };
  }

  if (skippedExistingVerdict) {
    return passthroughDiagnostic(`update-task-status: ${taskId} is completed or missing — leaving task evidence untouched\n`);
  }

  const persistedTask = mgr.load().tasks.find((candidate) => candidate.id === taskId);
  const failures = persistedTask?.proof?.state === "failed"
    ? persistedTask.proof.failures.map((failure) => failure.kind).join(", ")
    : "positive Proof unavailable without exact attempt authority";
  process.stderr.write(
    `Task ${taskId} legacy completion quarantined pending fresh revalidation: ${failures}.\n`,
  );

  // The same locked update that landed the resolution reconciled the wave's
  // implementation bit in both directions. Report completion from that state.
  const updated = mgr.load();
  const currentWave = updated.current_wave ?? 1;
  if (isWaveComplete(updated, currentWave)) {
    process.stderr.write(`\nWave ${currentWave} implementation complete. Run: /wave-gate\n`);
  }

  return { kind: "passthrough" };
};

const handler: HookHandler = (stdin, args) => runUpdateTaskStatus(stdin, args);

export default handler;
