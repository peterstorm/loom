/**
 * The orchestration surface for implementation re-attestation (D4 option 2).
 *
 * The attest program rewrites exactly the proof surface of ONE pending Task —
 * attested obligations, regression-required/new-tests-waived stored policy,
 * attestation-mode flag — under the TaskGraph lock, and the rewritten graph
 * must parse (the load boundary proves flag/obligation/policy lockstep). The
 * reason is echoed to stdout only; the persisted graph never carries it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import { attestOperation } from "../../../src/handlers/helpers/attest-implementation";
import { renderImplementationLifecycleError } from "../../../src/handlers/helpers/implementation-lifecycle-errors";
import { armImplementationAttestation } from "../../../src/core/implementation-lifecycle";
import {
  deriveImplementationAttestationContext,
  deriveImplementationRetryDisposition,
} from "../../../src/core/implementation-retry";
import { evaluateTaskProof } from "../../../src/core/proof-obligations";
import { parseTaskGraph, StateManager } from "../../../src/state-manager";
import type { Task } from "../../../src/types";
import { implementationEscalatedTaskFields } from "../../fixtures/implementation-escalation";

const cleanup: string[] = [];
let previousLoomStatePath: string | undefined;
let statePath = "";

afterEach(() => {
  if (previousLoomStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousLoomStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const installState = (taskOverrides: Record<string, unknown> = {}, graphOverrides: Record<string, unknown> = {}): void => {
  previousLoomStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-attest-implementation-");
  cleanup.push(root);
  statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  const graph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: [] as string[],
    tasks: [{
      id: "T1",
      description: "pre-existing work",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      file_list: ["src/a.ts"],
      ...taskOverrides,
    }],
    wave_gates: {
      "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false },
    },
    ...graphOverrides,
  };
  const parsed = parseTaskGraph(graph);
  if (!parsed.ok) throw new Error(parsed.error);
  writeFileSync(statePath, JSON.stringify(graph));
  process.env.LOOM_STATE_PATH = statePath;
};

const loadTask = (): Task => {
  const raw = JSON.parse(readFileSync(statePath, "utf-8")) as { tasks: Record<string, unknown>[] };
  const reparsed = parseTaskGraph(raw);
  if (!reparsed.ok) throw new Error(`rewritten graph does not parse: ${reparsed.error}`);
  return reparsed.value.tasks[0]!;
};

describe("orchestration attest arms implementation re-attestation", () => {
  it("rewrites the proof surface and the rewritten graph parses with a derivable context", async () => {
    installState();
    const result = await attestOperation(["--task", "T1", "--reason", "work already committed by wave 0; verify only"]);
    expect(result).toMatchObject({ kind: "allow" });

    const task = loadTask();
    expect(task.implementation_attestation).toBe(true);
    expect(task.status).toBe("pending");
    expect(task.verification_policy).toEqual({
      regression: { kind: "required" },
      new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
    });
    // The legacy boolean is cleared, not flipped: a false would contradict the
    // required regression at the load boundary.
    expect(task.new_tests_required).toBeUndefined();
    expect(task.proof?.obligations.map((obligation) => obligation.kind)).toEqual([
      "task-completed", "regression-test-pass", "attempt-scope-attested", "declared-artifact-attested",
    ]);
    expect(task.proof?.obligations[3]).toEqual({ kind: "declared-artifact-attested", artifact: "src/a.ts" });
    // The lineage is untouched and still derives a fresh attempt 1.
    expect(deriveImplementationRetryDisposition(task)).toEqual({ kind: "initial", semanticAttempt: 1 });
    // The dispatch binding can derive the exact attestation context.
    expect(deriveImplementationAttestationContext(task)).toMatchObject({ ok: true });
  });

  it("echoes the reason to stdout only and never persists it", async () => {
    installState();
    const reason = "secret operator rationale about wave-0 commits";
    const writes: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await attestOperation(["--task", "T1", "--reason", reason])).toMatchObject({ kind: "allow" });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(writes.join("")).toContain(reason);
    expect(readFileSync(statePath, "utf-8")).not.toContain(reason);
  });

  it("refuses a repeat without touching state", async () => {
    installState();
    expect(await attestOperation(["--task", "T1", "--reason", "first"])).toMatchObject({ kind: "allow" });
    const afterFirst = readFileSync(statePath, "utf-8");
    const repeat = await attestOperation(["--task", "T1", "--reason", "second"]);
    expect(repeat).toMatchObject({ kind: "error" });
    if (repeat.kind !== "error") return;
    expect(repeat.message).toContain("already in attestation mode");
    expect(readFileSync(statePath, "utf-8")).toBe(afterFirst);
  });

  it("refuses a live attempt and an unknown task without changing state", async () => {
    installState({}, { executing_tasks: ["T1"] });
    const before = readFileSync(statePath, "utf-8");
    const live = await attestOperation(["--task", "T1", "--reason", "live"]);
    expect(live).toMatchObject({ kind: "error" });
    if (live.kind !== "error") return;
    expect(live.message).toContain("live implementation attempt");
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    const unknown = await attestOperation(["--task", "T9", "--reason", "who"]);
    expect(unknown).toMatchObject({ kind: "error" });
  });

  it("requires the exact argument surface", async () => {
    installState();
    expect(await attestOperation(["--task", "T1"])).toMatchObject({ kind: "error" });
    expect(await attestOperation(["--task", "T1", "--reason", " "])).toMatchObject({ kind: "error" });
    expect(await attestOperation(["--task", "T1", "--reason", "r", "--bogus"])).toMatchObject({ kind: "error" });
    expect(await attestOperation(["--task", "T1", "--reason", "existing", "work", "verified"])).toMatchObject({ kind: "error" });
    expect(await attestOperation(["--task", "T1", "--task", "T2", "--reason", "r"])).toMatchObject({ kind: "error" });
  });

  /**
   * The remaining parser arms the exact-surface sweep does not pin: --task
   * absence, the 512-character --reason boundary, a repeated --reason, and a
   * non-conforming task id. Every one of these is refused by
   * parseTaskReasonArguments BEFORE any state access — proven by the byte
   * identity of the installed graph across the whole sweep — and the 512
   * boundary itself is accepted.
   */
  it("refuses malformed arguments at the parser, before state access", async () => {
    installState();
    const before = readFileSync(statePath, "utf-8");
    const missingTask = await attestOperation(["--reason", "r"]);
    expect(missingTask).toMatchObject({ kind: "error", message: "attest: attest requires --task <task-id>" });
    expect(await attestOperation(["--task", "T1", "--reason", "x".repeat(513)]))
      .toMatchObject({ kind: "error", message: "attest: attest --reason must be non-empty and at most 512 characters" });
    expect(await attestOperation(["--task", "T1", "--reason", "first", "--reason", "second"]))
      .toMatchObject({ kind: "error", message: "attest: attest requires --reason exactly once" });
    expect(await attestOperation(["--task", "t1", "--reason", "r"]))
      .toMatchObject({ kind: "error", message: "attest: attest --task must match T\\d+" });
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(await attestOperation(["--task", "T1", "--reason", "x".repeat(512)])).toMatchObject({ kind: "allow" });
  });

  it("derives one aggregate command and types completed, implemented, satisfied, and escalated refusals", async () => {
    installState();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) throw new Error("fixture state manager missing");
    const pending = manager.load().tasks[0]!;
    // Test-fixture variants of the same stored Task: the invalid states are not
    // representable through the load boundary, so the cast is confined here.
    const variant = (overrides: Record<string, unknown>): Task => ({ ...pending, ...overrides } as unknown as Task);
    const command = armImplementationAttestation(pending, { executing: false });
    expect(command).toMatchObject({ ok: true });
    if (!command.ok) return;
    expect(command.value.plan.obligations).toEqual([
      "task-completed", "regression-test-pass", "attempt-scope-attested", "declared-artifact-attested:src/a.ts",
    ]);
    expect(command.value.plan.attestationProofDigest).toMatch(/^[0-9a-f]{64}$/);

    expect(armImplementationAttestation(variant({ status: "implemented" }), { executing: false })).toMatchObject({
      ok: false,
      error: { kind: "task-not-pending", status: "implemented" },
    });
    expect(armImplementationAttestation(variant({ status: "completed" }), { executing: false }))
      .toMatchObject({ ok: false, error: { kind: "task-not-pending", status: "completed" } });
    expect(armImplementationAttestation(variant({ status: "failed" }), { executing: false }))
      .toMatchObject({ ok: false, error: { kind: "task-not-pending", status: "failed" } });
    expect(armImplementationAttestation(variant({ reserved_at: "2026-09-19T00:00:00.000Z" }), { executing: false }))
      .toMatchObject({ ok: false, error: { kind: "live-attempt", operation: "attestation" } });
    const satisfiedProof = evaluateTaskProof(
      { newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
      { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: ["src/a.ts"], newTestsWritten: true, newTestEvidence: "one focused regression" },
    );
    expect(satisfiedProof.state).toBe("satisfied");
    expect(armImplementationAttestation(variant({ proof: satisfiedProof, revalidation_required: true }), { executing: false }))
      .toMatchObject({ ok: false, error: { kind: "proof-already-satisfied" } });
    expect(armImplementationAttestation(variant({ implementation_attestation: true }), { executing: false }))
      .toMatchObject({ ok: false, error: { kind: "already-attested" } });
    expect(armImplementationAttestation(variant(implementationEscalatedTaskFields()), { executing: false }))
      .toMatchObject({ ok: false, error: { kind: "terminal-escalation" } });

    // pr-test-analyzer-2: the last unasserted attest arms. A corrupt lineage
    // (a history entry the receipt parse refuses) and a history whose stored
    // retry protocol disagrees with it both surface the invalid-lineage
    // refusal before any rewrite.
    const corruptHistory = armImplementationAttestation(
      variant({ implementation_attempt_history: ["not-a-receipt"] }),
      { executing: false },
    );
    expect(corruptHistory).toMatchObject({ ok: false, error: { kind: "invalid-lineage", taskId: "T1" } });
    if (corruptHistory.ok || corruptHistory.error.kind !== "invalid-lineage") {
      throw new Error("expected the invalid-lineage refusal for a corrupt history");
    }
    expect(corruptHistory.error.errors.join("; ")).toContain("implementation_attempt_history[0]");

    const protocolDisagreement = armImplementationAttestation(
      variant({ ...implementationEscalatedTaskFields(), implementation_retry_protocol: 1 }),
      { executing: false },
    );
    expect(protocolDisagreement).toMatchObject({ ok: false, error: { kind: "invalid-lineage", taskId: "T1" } });
    if (protocolDisagreement.ok || protocolDisagreement.error.kind !== "invalid-lineage") {
      throw new Error("expected the invalid-lineage refusal for a protocol disagreement");
    }
    expect(protocolDisagreement.error.errors.join("; ")).toContain("protocol-2 retry lineage");

    // The attestation-context-invalid arm is defensively unreachable through
    // the aggregate: attestedTask overwrites every input the context derivation
    // reads (flag, proof, policy) and the Task id was already proven by the
    // lineage disposition check, so no cast variant can land in it. Its refusal
    // prose is pinned here; the derivation's own refusals are pinned
    // dispatch-side.
    expect(renderImplementationLifecycleError({
      kind: "invalid-lineage", taskId: "T1",
      errors: ["implementation retry protocol 2 requires a valid history start index"],
    })).toBe("Task T1 has invalid attempt lineage: implementation retry protocol 2 requires a valid history start index");
    expect(renderImplementationLifecycleError({
      kind: "attestation-context-invalid", taskId: "T1", detail: "Task T1 carries no attestation proof",
    })).toBe("attestation context derivation failed for T1: Task T1 carries no attestation proof");
  });
});
