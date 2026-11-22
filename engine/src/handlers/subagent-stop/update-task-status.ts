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
import { machineSource, observeTaskGraphProjectBoundary } from "../../config";
import { IMPL_AGENTS } from "../../core/agent-catalog-projections";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { canonicalRepositoryPaths, partitionWriteEvidence } from "../../utils/repository-path";
import { readSettledJsonl } from "../../utils/read-settled-jsonl";
import { parseFilesModified } from "../../parsers/parse-files-modified";
import { parseBashTestOutput } from "../../parsers/parse-bash-test-output";
import { readPersistedOutput } from "../../utils/persisted-output";
import { parseSubagentLifecycleStdin } from "../../parsers/parse-subagent-lifecycle-input";
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
import type { AgentId, AgentType, EvidenceRecord, LoadedMachine } from "../../machine";
import type { LedgerObservation } from "../../core/red-then-green-types";
import { TRUSTED_LEDGER_ONLY_POLICY } from "../../core/proof-obligations";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import type { ImplementationAuthorityObservation } from "../../implementation-attempt-sidecar";
import { parseCompleteClaudeJsonl } from "../../core/claude-transcript-integrity";
import {
  parseIsoInstant,
  type ImplementationAttemptAuthority,
} from "../../core/implementation-completion";
import {
  attributedTestRunJudge,
  capVerdictForMachineCompletion,
  resolveTestEvidence,
} from "../../core/implementation-evidence";
import {
  describeSettlement,
  isWaveComplete,
  settleUnavailableImplementation,
} from "../../core/implementation-application";
import {
  productionExactSettlementPorts,
  settleAndPersistExactImplementation,
} from "../helpers/exact-implementation-settlement";
import { testEvidencePolicyAt } from "../../utils/test-evidence-policy-at";
import { regressionScope } from "../../core/regression-attribution";
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

/** The session ledger as this handler read it: its records, or why the read
 *  yielded none it can trust (a failed snapshot, a failed or impossible read). */
export type ClaudeLedgerRead =
  | Readonly<{ kind: "read"; records: readonly EvidenceRecord[] }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/**
 * The agent's own attempt epoch, as exact settlement judges it (I6): the
 * epoch's events in ledger order, duplicate deliveries dropped by the same
 * fold `resolveTestEvidence` and the machine read. A ledger that was never
 * read, or an agent identity that names no epoch, is `unreadable` — never an
 * empty epoch, which would read as "the agent ran nothing".
 */
export function claudeEpochLedger(
  read: ClaudeLedgerRead,
  agentId: AgentId | null,
  agentType: AgentType | null,
): LedgerObservation {
  if (read.kind === "unreadable") return Object.freeze({ kind: "unreadable", reason: read.reason });
  if (agentId === null || agentType === null) {
    return Object.freeze({
      kind: "unreadable",
      reason: `the stop names no parseable ${agentId === null ? "agent id" : "agent type"}, so no ledger epoch is its own`,
    });
  }
  return Object.freeze({ kind: "read", events: Object.freeze(eventsForEpoch(read.records, epochOf(agentId, agentType))) });
}

async function settleTranscriptUnavailable(
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
  const parsedInput = parseSubagentLifecycleStdin("SubagentStop", stdin);
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
  const executing = graphBeforeTranscript.tasks.some((task) => task.active_implementation_attempt !== undefined);
  // A sidecar that exists but cannot be read is lost authority whether or not
  // a Task still executes: its attempt may already have been released or
  // reclaimed, so only an error keeps the lost settlement visible. An absent
  // sidecar loses something only while a Task executes.
  if (authorityObservation?.kind === "authority-unavailable" &&
      (executing || authorityObservation.failure.kind !== "missing-sidecar")) {
    return {
      kind: "error",
      message: `update-task-status: ${authorityObservation.failure.kind}: ${authorityObservation.failure.message}; ` +
        (executing ? "implementation authority was preserved" : "no Task is executing and nothing was settled"),
    };
  }
  if (authorityObservation === undefined && executing) {
    return {
      kind: "error",
      message: "update-task-status: implementation settlement requires a snapshotted Claude authority sidecar; execution authority was preserved",
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

  // Every executing Task carries an attempt (the State File refuses any other,
  // ADR-0098), an attempt without this stop's sidecar and an unreadable sidecar
  // were refused above. A stop with no authority therefore found no sidecar and
  // nothing executing: nothing to settle, and the diagnostic names why.
  if (authority === null) {
    const absence = authorityObservation?.kind === "authority-unavailable" ? `: ${authorityObservation.failure.message}` : "";
    return passthroughDiagnostic(
      `update-task-status: ${agentType} stopped without implementation attempt authority and no Task is executing; nothing was settled${absence}\n`,
    );
  }

  // Parse transcript (read file content, then parse). The path is RESOLVED,
  // not read off the payload: an available supplied `agent_transcript_path`
  // wins; an unavailable or absent supplied path falls back to the derived
  // on-disk location. Exact settlement requires this transcript, so an
  // unlocatable or unreadable one becomes an infrastructure receipt.
  const transcriptPath = resolveAgentTranscriptPath(input);
  if (transcriptPath === null) {
    return settleTranscriptUnavailable(
      mgr,
      authority,
      "Claude transcript unavailable: no resolvable transcript path",
    );
  }
  let rawTranscript: string;
  try {
    rawTranscript = await readSettledJsonl(() => readFileSync(transcriptPath, "utf-8"));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return settleTranscriptUnavailable(mgr, authority, `Claude transcript unreadable: ${cause}`);
  }
  // Exact settlement cannot consume partial JSONL. Parse the complete
  // transcript before any file or test evidence extractor runs; a
  // malformed/truncated tail invalidates otherwise-valid earlier records.
  const integrity = parseCompleteClaudeJsonl(rawTranscript);
  if (integrity.kind === "malformed") {
    return settleTranscriptUnavailable(mgr, authority, integrity.reason);
  }
  const transcriptContent = integrity.transcript;
  // A Pi session handed to this Claude reader is refused, not read as an
  // empty write set: a shrunken files_modified shrinks the Wave Gate lint set.
  const writeEvidence = parseFilesModified(transcriptContent);
  if (!writeEvidence.ok) {
    return settleTranscriptUnavailable(mgr, authority, `Claude transcript unusable: ${writeEvidence.error}`);
  }
  const rawFilesModified = writeEvidence.value;
  const bashTestOutput = parseBashTestOutput(transcriptContent, readPersistedOutput);

  // Identity comes only from the snapshotted sidecar.
  const taskId = authority.taskId;
  const state = mgr.load();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      kind: "error",
      message:
        `update-task-status: attempt authority names unknown task ${taskId}; ` +
        `known tasks: ${state.tasks.map((candidate) => candidate.id).join(", ") || "<none>"}. ` +
        "Implementation evidence was NOT stored.",
    };
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = observeTaskGraphProjectBoundary(mgr.getPath()).root;
  } catch (error) {
    const reason = `Claude TaskGraph project boundary unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return settleTranscriptUnavailable(mgr, authority, reason);
  }

  let filesModified: string[];
  try {
    filesModified = [...canonicalRepositoryPaths(
      repositoryRoot,
      partitionWriteEvidence(repositoryRoot, rawFilesModified).repository,
      "transcript files_modified",
    )];
  } catch (error) {
    // Invalid path evidence makes the attempt's byte effects unobservable.
    // Settle under the lock and conservatively invalidate changed-byte
    // authority; clearing only executing_tasks could leave a re-executed
    // implemented Task green on evidence from before this attempt.
    const cause = error instanceof Error ? error.message : String(error);
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
    return {
      kind: "error",
      message: `update-task-status: unsafe modified-file evidence for ${taskId}: ${cause}`,
    };
  }

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
  // machineSource() is resolved at call time (not the import-frozen constant)
  // so a re-pointed LOOM_MACHINES_DIR is honored without a module reload —
  // the same dir and pins the gate and recorder consult.
  const loadedMachine: LoadedMachine =
    epochAgentType !== null ? loadMachine(machineSource(), epochAgentType) : { kind: "none" };
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
  let ledgerRead: ClaudeLedgerRead;
  if (evidenceSnapshot?.kind === "snapshot") {
    ledgerRead = { kind: "read", records: evidenceSnapshot.events };
  } else if (evidenceSnapshot?.kind === "snapshot-failed") {
    ledgerRead = { kind: "unreadable", reason: `the dispatcher's evidence snapshot for ${input.session_id} failed` };
  } else if (standaloneSessionId === null) {
    ledgerRead = { kind: "unreadable", reason: "the stop names no valid session id, so no evidence ledger was read" };
  } else {
    try {
      ledgerRead = { kind: "read", records: readEvidence(standaloneSessionId) };
    } catch (error) {
      snapshotFailed = true;
      const cause = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `update-task-status: evidence ledger read failed for ${standaloneSessionId}: ${cause}; verdict labeled snapshot-read-failed\n`,
      );
      ledgerRead = { kind: "unreadable", reason: `evidence ledger read failed for ${standaloneSessionId}: ${cause}` };
    }
  }
  // The one epoch both the test verdict and exact settlement (I6) read.
  const epochLedger = claudeEpochLedger(ledgerRead, epochAgentId, epochAgentType);
  const epochEvents = epochLedger.kind === "read" ? epochLedger.events : [];
  // A failure in a file only unsettled siblings of this Wave declare is
  // theirs to fix, not this Task's (ADR-0080). The roster comes from the
  // pre-lock graph, so a sibling that settles meanwhile still excuses
  // failures in its files for this settlement; the Wave Gate judges them.
  const scope = regressionScope(state.tasks, task, repositoryRoot);
  let testEvidence = resolveTestEvidence(
    epochEvents,
    testEvidencePolicyAt(state.test_evidence, repositoryRoot),
    bashTestOutput,
    machineBound,
    snapshotFailed,
    scope,
  );
  // Machine-bound agents don't self-report completion: fold this epoch's
  // evidence through the machine and consult its terminal requirements —
  // unmet requirements cap a trusted-pass at untrusted, labeled with what is
  // missing. Skipped when the snapshot failed (ledger contents unknown — the
  // snapshot-read-failed label already says so) and for invalid machines
  // (nothing to fold; the gate fails closed on those independently).
  if (!snapshotFailed && loadedMachine.kind === "machine") {
    const missing = missingRequirements(
      loadedMachine.machine,
      // The same attribution, so an attributed pass satisfies TestRunPassed.
      foldEvidence(loadedMachine.machine, epochEvents, attributedTestRunJudge(scope)),
    );
    const capped = capVerdictForMachineCompletion(testEvidence, missing);
    if (capped !== testEvidence) {
      process.stderr.write(
        `update-task-status: machine ${loadedMachine.machine.agent} reports unmet terminal requirements — capping verdict at untrusted (${capped.result.verdict === "untrusted" ? capped.result.label : ""})\n`,
      );
      testEvidence = capped;
    }
  }

  // Section 3: one exact settlement under the State File lock; the byte
  // observation and new-test evidence are read against the locked Task.
  const observedAt = parseIsoInstant(new Date().toISOString(), "Claude implementation observation instant");
  if (!observedAt.ok) return { kind: "error", message: observedAt.error.errors.join("; ") };
  const { application: settlement } = await settleAndPersistExactImplementation(mgr, {
    transport: "Claude",
    authority,
    observedAt: observedAt.value,
    parserModifiedPaths: filesModified,
    parserPathLabel: "Claude transcript files_modified",
    taskCompleted: true,
    test: testEvidence,
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
    ledger: epochLedger,
  }, productionExactSettlementPorts(repositoryRoot, mgr.getPath()));
  if (settlement.kind === "error") {
    return {
      kind: "error",
      message: `update-task-status: Oracle settlement failed: ${JSON.stringify(settlement.error)}`,
    };
  }
  if (settlement.kind === "ignored") {
    return passthroughDiagnostic(
      `update-task-status: ${authority.taskId} result ignored (${settlement.reason}); current authority preserved\n`,
    );
  }
  process.stderr.write(`Task ${authority.taskId} settlement: ${describeSettlement(settlement.transition)}.\n`);
  const updated = settlement.state;
  const currentWave = updated.current_wave ?? 1;
  if (isWaveComplete(updated, currentWave)) {
    process.stderr.write(`\nWave ${currentWave} implementation complete. Run: /wave-gate\n`);
  }
  return settlement.transition.kind === "infrastructure-blocked"
    ? {
        kind: "error",
        message: `update-task-status: ${authority.taskId} completion infrastructure unavailable; exact attempt was released with an Oracle receipt`,
      }
    : { kind: "passthrough" };
};

const handler: HookHandler = (stdin, args) => runUpdateTaskStatus(stdin, args);

export default handler;
