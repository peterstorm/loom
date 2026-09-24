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
import { remediateOperation } from "../../../src/handlers/helpers/remediate-implementation-escalation";
import { remediateImplementationEscalation } from "../../../src/core/implementation-lifecycle";
import { deriveImplementationRetryDisposition } from "../../../src/core/implementation-retry";
import {
  implementationEscalatedLineage,
  implementationEscalatedTaskFields,
} from "../../fixtures/implementation-escalation";
import { parseTaskGraph } from "../../../src/state-manager";
import type { Task } from "../../../src/types";


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
    const terminalReceiptId = requireReceipt(installState(implementationEscalatedTaskFields()));
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
    const terminalReceiptId = requireReceipt(installState(implementationEscalatedTaskFields()));
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
    installState(implementationEscalatedTaskFields());
    const wrong = await remediateOperation([
      "--task", "T1", "--receipt", "f".repeat(64), "--reason", "typo",
    ]);
    expect(wrong).toMatchObject({ kind: "error" });
    if (wrong.kind !== "error") return;
    expect(wrong.message).toContain("terminal escalation is receipt");
  });

  it("refuses a live attempt, a legacy lineage, and an unknown task", async () => {
    const terminalReceiptId = requireReceipt(installState({
      ...implementationEscalatedTaskFields(),
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
    // load (no compatibility projection) — the aggregate command refuses it too.
    const legacyCommand = remediateImplementationEscalation(
      { id: "T1", status: "pending", implementation_attempt_history: [implementationEscalatedLineage().retry] } as unknown as Task,
      {
        executing: false,
        terminalReceiptId,
        observedAt: "2026-09-01T00:03:00.000Z",
      },
    );
    expect(legacyCommand).toMatchObject({ ok: false, error: { kind: "invalid-lineage" } });

    // Unknown task.
    const unknown = await remediateOperation(["--task", "T9", "--receipt", terminalReceiptId, "--reason", "who"]);
    expect(unknown).toMatchObject({ kind: "error" });
  });

  it("requires the exact argument surface", async () => {
    installState(implementationEscalatedTaskFields());
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

  /**
   * The remaining parser arms the exact-surface sweep does not pin: --task
   * absence, repeated --receipt/--reason, the 512-character --reason
   * boundary, and a non-conforming task id. Every one of these is refused by
   * parseTaskReasonArguments BEFORE any state access — proven by the byte
   * identity of the installed graph across the whole sweep — and the 512
   * boundary itself is accepted.
   */
  it("refuses malformed arguments at the parser, before state access", async () => {
    const terminalReceiptId = requireReceipt(installState(implementationEscalatedTaskFields()));
    const before = readFileSync(statePath, "utf-8");
    const receipt = "a".repeat(64);
    expect(await remediateOperation(["--receipt", receipt, "--reason", "r"]))
      .toMatchObject({ kind: "error", message: "remediate: remediate requires --task <task-id>" });
    expect(await remediateOperation(["--task", "T1", "--receipt", receipt, "--receipt", "b".repeat(64), "--reason", "r"]))
      .toMatchObject({ kind: "error", message: "remediate: remediate requires --receipt exactly once" });
    expect(await remediateOperation(["--task", "T1", "--receipt", receipt, "--reason", "first", "--reason", "second"]))
      .toMatchObject({ kind: "error", message: "remediate: remediate requires --reason exactly once" });
    expect(await remediateOperation(["--task", "T1", "--receipt", receipt, "--reason", "x".repeat(513)]))
      .toMatchObject({ kind: "error", message: "remediate: remediate --reason must be non-empty and at most 512 characters" });
    expect(await remediateOperation(["--task", "t1", "--receipt", receipt, "--reason", "r"]))
      .toMatchObject({ kind: "error", message: "remediate: remediate --task must match T\\d+" });
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    // The 512 boundary is accepted — the fixture's real terminal receipt.
    expect(await remediateOperation(["--task", "T1", "--receipt", terminalReceiptId, "--reason", "x".repeat(512)]))
      .toMatchObject({ kind: "allow" });
  });
});
