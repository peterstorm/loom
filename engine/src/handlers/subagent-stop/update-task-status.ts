/**
 * Resolve implementation completion into the Task's proof state.
 *
 * 1. Resolve test evidence — the agent's own epoch in the evidence ledger
 *    (execution-time ground truth) first; transcript regex as the labeled,
 *    lower-trust fallback
 * 2. Verify new tests written via git diff + assertion density
 * 3. Atomically persist evidence and the derived Proof aggregate
 * 4. Mark implemented only when every obligation is satisfied; otherwise keep
 *    the Task pending, then signal /wave-gate only when the Wave is complete
 */

import { readFileSync, realpathSync } from "node:fs";
import type { HookHandler, HookResult, SubagentStopInput, TaskTestResult } from "../../types";
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
import * as git from "../../utils/git";
import {
  epochOf,
  eventsForEpoch,
  foldEvidence,
  judgeTestRun,
  loadMachine,
  missingRequirements,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  readEvidence,
} from "../../machine";
import type { Evidence, EvidenceRecord, LoadedMachine, Requirement, TrustedTestVerdict } from "../../machine";
import { TRUSTED_LEDGER_ONLY_POLICY } from "../../core/proof-obligations";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { extractTestEvidence } from "../../core/test-evidence";
import { taskVerificationPolicy } from "../../core/verification-policy";
import type { ImplementationAuthorityObservation } from "../../implementation-attempt-sidecar";
import {
  parseCompleteClaudeJsonl,
  parseIsoInstant,
} from "../../core/implementation-completion";
import {
  applyCompletionInfrastructureFailure,
  applyUntrustedStopResolution,
  cumulativeModifiedPaths,
  isWaveComplete,
  settleObservedImplementation,
  settleUnavailableImplementation,
  type ImplementationSettlementApplicationResult,
  type NewTestEvidence,
} from "../../core/implementation-application";
import {
  collectNewTestEvidence,
  observeTaskLocalCompletion,
} from "../helpers/task-local-completion";
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

// --- Pure: resolve test evidence, ledger first ---

export interface ResolvedTestEvidence {
  /** Verdict + trust provenance — exactly what gets persisted on the Task. */
  readonly result: TaskTestResult;
  /** Human-readable provenance line for test_evidence. */
  readonly evidence: string;
}

type TestRunEvidence = Extract<Evidence, { kind: "TestRun" }>;

/**
 * Ground truth beats transcript regex. The agent's own epoch in the
 * evidence ledger decides when it has a trusted TestRun (judgment derived
 * from stored FACTS via judgeTestRun — never read back from the ledger).
 * The verdict comes from the LAST trusted run — except that a trusted
 * FAILURE is considered stale once a later exit-0 run exists (the agent
 * plausibly fixed and re-ran without a report artifact): that case routes
 * to the labeled low-trust fallback, and an untrusted run is NEVER
 * promoted to a trusted pass. The transcript-regex extractor is the
 * explicit lower-trust fallback, labeled by exactly how weak it is:
 * - "low-trust"  — some exit-0 ledger run exists but the verdict could not
 *                  be trusted (no report artifact for the deciding run), OR
 *                  files were modified AFTER the deciding trusted pass (the
 *                  pass vouches for code that no longer exists)
 * - "degraded"   — the machine was bound but the ledger is empty (recorder
 *                  failure: the fallback is running where ground truth was
 *                  expected)
 * - "fallback"   — no machine is bound for this agent type (unbound/legacy
 *                  runs): ground truth was never expected here, so the
 *                  transcript regex is the NORMAL source for the run, not a
 *                  degradation — the label still marks it untrusted
 * - "snapshot-read-failed" — the dispatcher could not READ the ledger
 *                  (`snapshotFailed`): ledger contents are unknown, which is
 *                  distinct from a genuinely-empty ledger — never mislabel
 *                  it "degraded". `ledgerEvents` are ignored in this mode.
 */
function fallbackEvidenceLabel(
  demotionLabel: string | null,
  sawExitZero: boolean,
  machineBound: boolean,
  ledgerEmpty: boolean,
): string {
  if (demotionLabel !== null) return demotionLabel;
  if (sawExitZero) return "low-trust (exit 0, no report artifact; transcript-regex)";
  if (machineBound && ledgerEmpty) {
    return "degraded (machine bound, no ledger evidence; transcript-regex)";
  }
  return "transcript-regex (fallback)";
}

function untrustedTranscriptEvidence(label: string, bashOutput: string): ResolvedTestEvidence {
  const transcript = extractTestEvidence(bashOutput);
  return transcript.passed
    ? {
        result: { verdict: "untrusted", passed: true, label, provenance: "unverified" },
        evidence: `${label}: ${transcript.evidence}`,
      }
    : {
        result: { verdict: "untrusted", passed: false, label, provenance: "unverified" },
        evidence: "",
      };
}

export function resolveTestEvidence(
  ledgerEvents: readonly Evidence[],
  bashOutput: string,
  machineBound: boolean,
  snapshotFailed: boolean = false,
): ResolvedTestEvidence {
  if (snapshotFailed) {
    return untrustedTranscriptEvidence(
      "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      bashOutput,
    );
  }
  // Judge TestRuns keeping their POSITION in the ordered ledger, so later
  // non-TestRun events (FileWrite) can be related to the deciding run.
  const judged = ledgerEvents.flatMap((event, index) =>
    event.kind === "TestRun"
      ? [{ run: event as TestRunEvidence, index, verdict: judgeTestRun(event.exit, event.report) }]
      : [],
  );

  // Last GROUND-TRUTH run (trusted-pass or trusted-fail), with its ledger index.
  const lastTrusted = judged.reduce<
    { index: number; run: TestRunEvidence; verdict: TrustedTestVerdict } | null
  >((acc, { run, index, verdict }) => {
    return verdict.verdict === "untrusted" ? acc : { index, run, verdict };
  }, null);

  let demotionLabel: string | null = null;
  if (lastTrusted !== null) {
    // A trusted PASS is stale once any FileWrite follows it in the ledger:
    // the run vouched for code that has since been modified. Demote to the
    // labeled low-trust fallback — never keep (or re-mint) trusted-pass.
    const laterFileWrite = ledgerEvents
      .slice(lastTrusted.index + 1)
      .some((e) => e.kind === "FileWrite");
    // A stale trusted failure must not outrank a later untrusted exit-0
    // run — but that later run earns only the low-trust fallback below,
    // never a trusted pass.
    const laterExitZero = judged.some((j) => j.index > lastTrusted.index && j.run.exit === 0);

    const keepTrusted =
      lastTrusted.verdict.verdict === "trusted-pass" ? !laterFileWrite : !laterExitZero;
    if (keepTrusted) {
      const report = lastTrusted.run.report
        ? `, report: ${lastTrusted.run.report.total} tests / ${lastTrusted.run.report.failed} failed`
        : "";
      return {
        result: lastTrusted.verdict,
        evidence: `ledger: exit ${lastTrusted.run.exit}${report} (${lastTrusted.run.command})`,
      };
    }
    if (lastTrusted.verdict.verdict === "trusted-pass") {
      demotionLabel = "low-trust (files modified after last trusted pass; transcript-regex)";
    }
  }

  const label = fallbackEvidenceLabel(
    demotionLabel,
    judged.some((judgment) => judgment.run.exit === 0),
    machineBound,
    ledgerEvents.length === 0,
  );
  return untrustedTranscriptEvidence(label, bashOutput);
}

/**
 * The machine's completion judgment, applied to the resolved verdict: when
 * the agent's machine declares terminal requirements the epoch's evidence
 * does not satisfy, a resolution claiming a TRUSTED PASS is capped at
 * untrusted with a "machine-incomplete" label naming exactly what is
 * missing — completion must not be self-reported past the machine. A
 * trusted FAIL is already ground truth of non-completion (the gate treats
 * it as missing evidence) and is kept as-is; untrusted resolutions are
 * already at the floor.
 */
export function capVerdictForMachineCompletion(
  resolved: ResolvedTestEvidence,
  missing: readonly Requirement[],
): ResolvedTestEvidence {
  if (missing.length === 0 || resolved.result.verdict !== "trusted-pass") return resolved;
  const reqs = missing.map((r) => `${r.event} ≥ ${r.min}`).join(", ");
  const label = `machine-incomplete: ${reqs}`;
  return {
    result: { verdict: "untrusted", passed: true, label, provenance: "unverified" },
    evidence: `${label} — ${resolved.evidence}`,
  };
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

type UnreadableTranscriptSettlement =
  | Readonly<{ kind: "quarantined"; taskId: string }>
  | Readonly<{ kind: "preserved"; executingCount: number }>;

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
  let input: SubagentStopInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    return {
      kind: "error",
      message: `update-task-status: malformed SubagentStop input — task status and test evidence NOT updated: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // Claude Code does not send agent_type; fall back to the metadata the
  // harness writes beside the transcript. This handler is also registered
  // standalone (KNOWN_HANDLERS), so it cannot assume the dispatcher already
  // resolved it.
  const agentType = stripNamespace(resolveAgentType(input));

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
  if (!mgr) return { kind: "passthrough" };

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
  // not read off the payload: a supplied `agent_transcript_path` wins, and a
  // harness that sends none falls back to the derived on-disk location. This
  // Claude's SubagentStop settlement requires this transcript, so an
  // unlocatable path costs the whole record — see utils/agent-transcript-path.
  const transcriptPath = resolveAgentTranscriptPath(input);
  let transcriptContent = "";
  if (transcriptPath) {
    try {
      transcriptContent = readFileSync(transcriptPath, "utf-8");
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const observedAt = parseIsoInstant(new Date().toISOString(), "Claude transcript failure instant");
      if (!observedAt.ok) {
        return { kind: "error", message: `update-task-status: ${observedAt.error.errors.join("; ")}` };
      }
      let oracleFailure: string | null = null;
      const settlement = await mgr.updateAndReturn<UnreadableTranscriptSettlement>((state) => {
        const executing = state.executing_tasks ?? [];
        const legacyTaskId = executing.length === 1 ? executing[0] : undefined;
        const taskId = authority?.taskId ?? legacyTaskId;
        const target = taskId === undefined ? undefined : state.tasks.find((task) => task.id === taskId);
        const exactModern = authority !== null &&
          target?.active_implementation_attempt?.authorityDigest === authority.authorityDigest;
        const exactLegacy = authority === null && legacyTaskId !== undefined &&
          target?.active_implementation_attempt === undefined;
        if (taskId !== undefined && exactModern && authority !== null) {
          const applied = settleUnavailableImplementation(
            state,
            authority,
            observedAt.value,
            `Claude transcript unreadable: ${cause}`,
          );
          if (applied.kind === "error") {
            oracleFailure = JSON.stringify(applied.error);
            return { state, value: { kind: "preserved", executingCount: executing.length } as const };
          }
          return {
            state: applied.state,
            value: { kind: "quarantined", taskId } as const,
          };
        }
        return taskId !== undefined && exactLegacy
          ? {
              state: applyCompletionInfrastructureFailure(state, taskId, true),
              value: { kind: "quarantined", taskId } as const,
            }
          : {
              state,
              value: { kind: "preserved", executingCount: executing.length } as const,
            };
      });
      if (oracleFailure !== null) {
        return { kind: "error", message: `update-task-status: Oracle infrastructure settlement failed: ${oracleFailure}` };
      }
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
      const observedAt = parseIsoInstant(new Date().toISOString(), "Claude transcript integrity failure instant");
      if (!observedAt.ok) {
        return { kind: "error", message: `update-task-status: ${observedAt.error.errors.join("; ")}` };
      }
      const settlement = await mgr.updateAndReturn((state) => {
        const applied = settleUnavailableImplementation(
          state,
          authority,
          observedAt.value,
          integrity.reason,
        );
        return {
          state: applied.kind === "applied" ? applied.state : state,
          value: applied,
        };
      });
      if (settlement.kind === "error") {
        return {
          kind: "error",
          message: `update-task-status: Oracle transcript-integrity settlement failed: ${JSON.stringify(settlement.error)}`,
        };
      }
      if (settlement.kind === "ignored") {
        return {
          kind: "error",
          message: `update-task-status: malformed Claude JSONL delivery was ignored as ${settlement.reason}; current authority was preserved`,
        };
      }
      return {
        kind: "error",
        message:
          `update-task-status: ${integrity.reason}; ${authority.taskId} received an exact non-consuming ` +
          "infrastructure Oracle receipt and cannot become implemented",
      };
    }
    transcriptContent = integrity.transcript;
  }

  const transcript = parseTranscript(transcriptContent);
  const rawFilesModified = parseFilesModified(transcriptContent);
  const bashTestOutput = parseBashTestOutput(transcriptContent);

  // Modern identity comes only from the snapshotted sidecar. Transcript and
  // sole-executing inference remain compatibility-only for legacy graphs.
  let taskId = authority?.taskId ?? extractTaskId(transcript);

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
  const snapshotFailed = evidenceSnapshot?.kind === "snapshot-failed";
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
    process.stderr.write(
      `update-task-status: invalid session id ${input.session_id} — ledger not read; verdict may be mislabeled\n`,
    );
  }
  let records: readonly EvidenceRecord[] = [];
  if (evidenceSnapshot === undefined) {
    records = standaloneSessionId === null ? [] : readEvidence(standaloneSessionId);
  } else if (evidenceSnapshot.kind === "snapshot") {
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
    const modernOutcome: {
      settlement?: ImplementationSettlementApplicationResult;
      diagnostic?: string;
    } = {};
    await mgr.update((locked) => {
      const target = locked.tasks.find((candidate) => candidate.id === authority.taskId);
      if (target?.implementation_attempt_history?.some(
        (receipt) => receipt.authorityDigest === authority.authorityDigest,
      )) {
        modernOutcome.settlement = settleUnavailableImplementation(
          locked,
          authority,
          observedAt.value,
          "duplicate Claude result delivery",
        );
        return locked;
      }
      if (target?.active_implementation_attempt?.authorityDigest !== authority.authorityDigest) {
        modernOutcome.diagnostic = `update-task-status: ${authority.taskId} active implementation attempt changed during settlement; late result was ignored`;
        return locked;
      }
      const bytes = observeTaskLocalCompletion({
        repositoryRoot,
        task: target,
        authority,
        parserModifiedPaths: filesModified,
        parserPathLabel: "Claude transcript files_modified",
      });
      const suiteOutcome = bytes.suite.checks[0]?.outcome;
      if (suiteOutcome?.kind === "observation-unavailable") {
        modernOutcome.settlement = settleUnavailableImplementation(
          locked,
          authority,
          observedAt.value,
          suiteOutcome.reason,
          bytes,
        );
      } else {
        const verificationPolicy = taskVerificationPolicy(target);
        let currentNewTestEvidence: NewTestEvidence;
        try {
          currentNewTestEvidence = collectNewTestEvidence(
            bytes.cumulativeModifiedPaths,
            verificationPolicy.newTests,
            target.start_sha,
          );
        } catch (error) {
          const unavailable = settleUnavailableImplementation(
            locked,
            authority,
            observedAt.value,
            `Claude new-test observation unavailable: ${error instanceof Error ? error.message : String(error)}`,
            bytes,
          );
          modernOutcome.settlement = unavailable;
          return unavailable.kind === "error" ? locked : unavailable.state;
        }
        modernOutcome.settlement = settleObservedImplementation(
          locked,
          authority,
          observedAt.value,
          {
            taskCompleted: true,
            testResult: testEvidence.result,
            testEvidence: testEvidence.evidence,
            newTestsWritten: currentNewTestEvidence.written,
            newTestEvidence: currentNewTestEvidence.evidence,
          },
          TRUSTED_LEDGER_ONLY_POLICY,
          bytes,
        );
      }
      const settlement = modernOutcome.settlement;
      return settlement === undefined || settlement.kind === "error" ? locked : settlement.state;
    });
    if (modernOutcome.diagnostic !== undefined) {
      return { kind: "error", message: modernOutcome.diagnostic };
    }
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
        !(s.executing_tasks ?? []).includes(taskId)) {
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
    let currentNewTestEvidence: NewTestEvidence;
    try {
      currentNewTestEvidence = collectNewTestEvidence(
        cumulativeFiles,
        verificationPolicy.newTests,
        target.start_sha,
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      newTestEvidenceFailure = `update-task-status: cannot collect new-test evidence for ${taskId}: ${cause}`;
      return applyCompletionInfrastructureFailure(s, taskId, comparison.bytesChangedSinceAttempt);
    }
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
