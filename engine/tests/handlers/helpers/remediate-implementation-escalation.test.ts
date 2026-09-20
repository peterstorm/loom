/**
 * The orchestration surface consumer for `escalate-wave-implementation` (D3).
 *
 * Fixture lineage is the REAL protocol-2 shape: history start 0, no seed
 * predecessor, receipts appended in wire order (attempt-1 retry-required,
 * attempt-2 escalation-required). The remediation appends exactly one
 * `escalation-remediated` receipt under the TaskGraph lock and changes nothing
 * else — the walk past it lands on a fresh attempt 1.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import { remediateOperation, planEscalationRemediation } from "../../../src/handlers/helpers/remediate-implementation-escalation";
import { deriveImplementationRetryDisposition } from "../../../src/core/implementation-retry";
import {
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  settleImplementationAttempt,
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  type ImplementationAttemptSettlementReceipt,
} from "../../../src/core/implementation-completion";
import { TRUSTED_LEDGER_ONLY_POLICY, derivePendingTaskProof } from "../../../src/core/proof-obligations";
import { parseTaskGraph } from "../../../src/state-manager";
import type { Task } from "../../../src/types";

const valueOf = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; error?: { errors?: readonly string[] } | { message: string } }): T => {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
};

const authority = (semanticAttempt: 1 | 2, reservationId: string, second: number) =>
  valueOf(createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 1,
    semanticAttempt,
    reservationId,
    headSha: "a".repeat(40),
    reservedAt: `2026-09-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  }));

const suite = (attempt: ReturnType<typeof authority>) => {
  const authorized = valueOf(createTaskCompletionSuiteAuthority(attempt));
  return {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: authorized.implementationAuthorityDigest,
    suiteDigest: authorized.suiteDigest,
    checks: [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "accepted", changedPaths: [] },
    }],
  };
};

const observation = (observedAt: string, taskCompleted: boolean) => ({
  schemaVersion: 1,
  kind: "implementation-observed",
  observedAt,
  evidence: {
    taskCompleted,
    testResult: { verdict: "trusted-pass" },
    filesModified: [],
    newTestsWritten: false,
    newTestEvidence: "waived",
  },
  proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
});

const settle = (
  attempt: ReturnType<typeof authority>,
  history: readonly ImplementationAttemptSettlementReceipt[],
  observed: unknown,
): ImplementationAttemptSettlementReceipt => {
  const result = settleImplementationAttempt({
    id: "T1",
    status: "pending",
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    active_implementation_attempt: attempt,
    implementation_attempt_history: history,
  }, attempt, attempt, observed, suite(attempt));
  if (!result.ok || result.value.kind === "ignored") throw new Error("settlement fixture failed");
  return result.value.receipt;
};

const escalatedLineage = () => {
  const retry = settle(authority(1, "rsv-retry", 1), [], observation("2026-09-01T00:01:00.000Z", false));
  const attempt2 = authority(2, "rsv-escalate", 2);
  const escalation = settle(attempt2, [retry], observation("2026-09-01T00:02:00.000Z", false));
  return { retry, attempt2, escalation };
};

const escalatedTaskFields = () => {
  const { retry, escalation } = escalatedLineage();
  return {
    implementation_attempt_history: [retry, escalation],
    implementation_retry_protocol: 2,
    implementation_retry_history_start: 0,
    terminal_receipt: escalation.receiptId,
  };
};

const requireReceipt = (receiptId: string | null): string => {
  if (receiptId === null) throw new Error("escalated fixture must carry a terminal escalation receipt");
  return receiptId;
};

const cleanup: string[] = [];
let previousLoomStatePath: string | undefined;
let statePath = "";

afterEach(() => {
  if (previousLoomStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousLoomStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const installState = (taskFields: Record<string, unknown>): string | null => {
  previousLoomStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-remediate-escalation-");
  cleanup.push(root);
  statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  const { terminal_receipt: _terminalReceipt, ...persistedFields } = taskFields;
  const graph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    plan_title: "Remediation plan",
    plan_file: ".claude/plans/remediation.md",
    spec_file: ".claude/specs/remediation.md",
    current_wave: 1,
    executing_tasks: [] as string[],
    tasks: [{
      id: "T1",
      description: "escalated task",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      review_status: "pending",
      ...persistedFields,
    }],
    wave_gates: {
      "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false },
    },
  };
  const parsed = parseTaskGraph(graph);
  if (!parsed.ok) throw new Error(parsed.error);
  writeFileSync(statePath, JSON.stringify(graph));
  process.env.LOOM_STATE_PATH = statePath;
  const record = graph as { tasks: { implementation_attempt_history?: { transition: string; receiptId: string }[] }[] };
  const escalation = (record.tasks[0]?.implementation_attempt_history ?? [])
    .find((receipt) => receipt.transition === "escalation-required");
  return escalation?.receiptId ?? null;
};

describe("orchestration remediate consumes the escalation recovery", () => {
  it("appends one remediation receipt and resets the lineage to a fresh attempt 1", async () => {
    const terminalReceiptId = requireReceipt(installState(escalatedTaskFields()));
    const before = readFileSync(statePath, "utf-8");

    const result = await remediateOperation([
      "--task", "T1", "--receipt", terminalReceiptId, "--reason", "environment repaired; re-prove on the current tree",
    ]);
    expect(result).toMatchObject({ kind: "allow" });

    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as {
      tasks: {
        implementation_attempt_history?: { transition: string; receiptId: string }[];
        implementation_retry_history_start?: number;
        implementation_retry_predecessor_receipt_id?: string;
      }[];
    };
    const task = raw.tasks[0]!;
    expect(task.implementation_attempt_history).toHaveLength(3);
    expect(task.implementation_attempt_history?.[2]?.transition).toBe("escalation-remediated");
    // The lineage prefix is untouched: same history start, same (absent) seed.
    expect(task.implementation_retry_history_start).toBe(0);
    expect(task.implementation_retry_predecessor_receipt_id).toBeUndefined();
    // The reset lineage parses and derives a fresh attempt 1.
    const reparsed = parseTaskGraph(raw);
    expect(reparsed).toMatchObject({ ok: true });
    if (!reparsed.ok) return;
    const remediatedTask = reparsed.value.tasks[0]!;
    expect(deriveImplementationRetryDisposition(remediatedTask)).toEqual({ kind: "initial", semanticAttempt: 1 });
    // Idempotence of the AUDIT: the pre-existing receipts are unchanged.
    const beforeGraph = JSON.parse(before) as typeof raw;
    expect(task.implementation_attempt_history?.slice(0, 2)).toEqual(beforeGraph.tasks[0]?.implementation_attempt_history);
  });

  it("refuses a repeat after the reset without touching state", async () => {
    const terminalReceiptId = requireReceipt(installState(escalatedTaskFields()));
    await remediateOperation(["--task", "T1", "--receipt", terminalReceiptId, "--reason", "first"]);
    const afterFirst = readFileSync(statePath, "utf-8");

    const repeat = await remediateOperation([
      "--task", "T1", "--receipt", terminalReceiptId, "--reason", "second",
    ]);
    expect(repeat).toMatchObject({ kind: "error" });
    if (repeat.kind !== "error") return;
    expect(repeat.message).toContain("no longer escalated");
    expect(readFileSync(statePath, "utf-8")).toBe(afterFirst);
  });

  it("refuses a receipt that is not the task's terminal escalation", async () => {
    installState(escalatedTaskFields());
    const wrong = await remediateOperation([
      "--task", "T1", "--receipt", "f".repeat(64), "--reason", "typo",
    ]);
    expect(wrong).toMatchObject({ kind: "error" });
    if (wrong.kind !== "error") return;
    expect(wrong.message).toContain("terminal escalation is receipt");
  });

  it("refuses a live attempt, a legacy lineage, and an unknown task", async () => {
    const terminalReceiptId = requireReceipt(installState({
      ...escalatedTaskFields(),
    }));
    // Live attempt: the task is still bound to executing_tasks.
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as { executing_tasks: string[] };
    raw.executing_tasks = ["T1"];
    writeFileSync(statePath, JSON.stringify(raw));
    const live = await remediateOperation(["--task", "T1", "--receipt", terminalReceiptId, "--reason", "live"]);
    expect(live).toMatchObject({ kind: "error" });
    if (live.kind !== "error") return;
    expect(live.message).toContain("live implementation attempt");

    // Legacy lineage: attempt-1 history with no protocol fields cannot even
    // load (no compatibility projection) — the plan function refuses it too.
    const legacyPlan = planEscalationRemediation(
      { id: "T1", status: "pending", implementation_attempt_history: [escalatedLineage().retry] } as unknown as Task,
      { executing: false, terminalReceiptId },
    );
    expect(legacyPlan).toMatchObject({ ok: false });
    if (legacyPlan.ok) return;
    expect(legacyPlan.message).toContain("attempt history requires protocol-2 retry lineage");

    // Unknown task.
    const unknown = await remediateOperation(["--task", "T9", "--receipt", terminalReceiptId, "--reason", "who"]);
    expect(unknown).toMatchObject({ kind: "error" });
  });

  it("requires the exact argument surface", async () => {
    installState(escalatedTaskFields());
    expect(await remediateOperation(["--task", "T1"])).toMatchObject({ kind: "error" });
    expect(await remediateOperation(["--task", "T1", "--receipt", "a".repeat(64)]))
      .toMatchObject({ kind: "error" });
    expect(await remediateOperation(["--task", "T1", "--receipt", "a".repeat(64), "--reason", " "]))
      .toMatchObject({ kind: "error" });
    expect(await remediateOperation(["--task", "T1", "--receipt", "a".repeat(64), "--reason", "r", "--bogus"]))
      .toMatchObject({ kind: "error" });
    expect(await remediateOperation(["--task", "T1", "--receipt", "a".repeat(64), "--reason", "environment", "is", "fixed"]))
      .toMatchObject({ kind: "error" });
  });
});
