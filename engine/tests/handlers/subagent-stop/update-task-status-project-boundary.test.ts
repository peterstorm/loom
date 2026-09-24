import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../../../src/config";
import type { ImplementationAttemptAuthority } from "../../../src/core/implementation-completion";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { graphFixture, taskFixture } from "../../fixtures/task-lifecycle";
import { derivePendingTaskProof } from "../../../src/core/proof-obligations";
import { armImplementationAttestation } from "../../../src/core/implementation-lifecycle";
import { deriveImplementationAttestationContext } from "../../../src/core/implementation-retry";
import { registerTaskExecutionBatch } from "../../../src/handlers/task-execution";
import { runUpdateTaskStatus } from "../../../src/handlers/subagent-stop/update-task-status";
import { SUBAGENT_DIR } from "../../../src/config";
import type { ImplementationAuthorityObservation } from "../../../src/implementation-attempt-sidecar";

const roots: string[] = [];
const pointers: string[] = [];
const initialProject = process.env.CLAUDE_PROJECT_DIR;
const initialState = process.env.LOOM_STATE_PATH;

afterEach(() => {
  vi.restoreAllMocks();
  if (initialProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = initialProject;
  if (initialState === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = initialState;
  for (const pointer of pointers.splice(0)) rmSync(pointer, { force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function linkedWorktrees(): { checkout: string; worktree: string; statePath: string } {
  const root = canonicalTempDir("loom-claude-boundary-");
  roots.push(root);
  const checkout = join(root, "checkout-a");
  const worktree = join(root, "worktree-b");
  mkdirSync(checkout);
  git(checkout, "init", "-q");
  git(checkout, "config", "user.name", "Loom Test");
  git(checkout, "config", "user.email", "loom@example.test");
  mkdirSync(join(checkout, "src"));
  writeFileSync(join(checkout, ".gitignore"), ".claude/\n");
  writeFileSync(join(checkout, "src", "artifact.ts"), "export const value = 1;\n");
  git(checkout, "add", ".gitignore", "src/artifact.ts");
  git(checkout, "commit", "-qm", "baseline");
  git(checkout, "worktree", "add", "-qb", "worktree-b", worktree);
  const statePath = join(worktree, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(worktree, ".claude", "state"), { recursive: true });
  return { checkout, worktree, statePath };
}

describe("Claude SubagentStop project boundary", () => {
  it.each(["implementation", "attestation"] as const)(
    "settles %s from the authoritative linked worktree when the ambient checkout has the same HEAD and old bytes",
    async (mode) => {
    const { checkout, worktree, statePath } = linkedWorktrees();
    process.env.CLAUDE_PROJECT_DIR = checkout;
    delete process.env.LOOM_STATE_PATH;
    const verificationPolicy = {
      regression: { kind: "waived" as const, reason: "documentation-only" as const },
      newTests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const },
    };
    const task = taskFixture({
      id: "T1", description: "change the worktree", agent: "code-implementer-agent",
      wave: 1, depends_on: [], file_list: ["src/artifact.ts"],
      proof: derivePendingTaskProof({ verificationPolicy, declaredArtifacts: ["src/artifact.ts"] }),
      verification_policy: {
        regression: verificationPolicy.regression,
        new_tests: verificationPolicy.newTests,
      },
    });
    const attestation = mode === "attestation" ? armImplementationAttestation(task, { executing: false }) : null;
    if (attestation !== null && !attestation.ok) throw new Error(attestation.error.kind);
    writeFileSync(statePath, JSON.stringify(graphFixture([attestation?.ok ? attestation.value.task : task])));
    const attestationContext = attestation?.ok
      ? deriveImplementationAttestationContext(attestation.value.task)
      : null;
    if (attestationContext !== null && !attestationContext.ok) throw new Error(attestationContext.error);
    const registered = await registerTaskExecutionBatch([{
      kind: "implementation",
      prompt: `Task ID: T1${attestationContext?.ok ? `\n${attestationContext.promptAppendix}` : ""}`,
      description: "change the worktree",
    }], "parallel", { kind: "at-registration", anyActiveForGraph: false }, worktree);
    if (registered.kind !== "registered") throw new Error(registered.message);
    const authority = registered.authorities[0]!;
    const sessionId = `claude-linked-${process.pid}-${Date.now()}`;
    mkdirSync(SUBAGENT_DIR, { recursive: true });
    const pointer = join(SUBAGENT_DIR, `${sessionId}.task_graph`);
    writeFileSync(pointer, statePath);
    pointers.push(pointer);

    writeFileSync(join(worktree, "src", "artifact.ts"), "export const value = 2;\n");
    const transcript = join(worktree, ".claude", "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({
      type: "assistant", message: { role: "assistant", content: mode === "implementation" ? [{
        type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "src/artifact.ts" },
      }] : [{ type: "text", text: "Verified T1 without reporting modified files." }] },
    }) + "\n");
    const observation: ImplementationAuthorityObservation = {
      kind: "authority-observed",
      sidecar: {
        schemaVersion: 1, kind: "claude-implementation-attempt-sidecar",
        sessionId: sessionId as never, agentId: "agent-1" as never,
        canonicalTaskGraphPath: statePath, authority,
      },
    };
    const result = await runUpdateTaskStatus(JSON.stringify({
      session_id: sessionId, agent_id: "agent-1", agent_type: "code-implementer-agent",
      agent_transcript_path: transcript,
    }), [], { kind: "snapshot", events: [] }, observation);

    expect(result, JSON.stringify(result)).toMatchObject({ kind: "passthrough" });
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    if (mode === "implementation") {
      expect(persisted.tasks[0]).toMatchObject({
        status: "implemented", files_modified: ["src/artifact.ts"],
        implementation_attempt_history: [expect.objectContaining({ transition: "implemented" })],
      });
    } else {
      expect(persisted.tasks[0].status).not.toBe("implemented");
      expect(persisted.tasks[0].implementation_attempt_history).toContainEqual(expect.objectContaining({
        failureKinds: expect.arrayContaining(["proof:attempt-scope-drifted", "proof:declared-artifact-drifted"]),
      }));
    }
    expect(readFileSync(join(checkout, "src", "artifact.ts"), "utf8")).toBe("export const value = 1;\n");
  }, 30_000);

  /** Arm one implementation registration against a fresh linked worktree and
   *  point a session pointer at the graph. Shared by the boundary-failure pins
   *  below; the attestation variant above stays bespoke. */
  async function armedImplementationWorktree(label: string): Promise<{
    statePath: string;
    sessionId: string;
    authority: ImplementationAttemptAuthority;
    transcript: string;
  }> {
    const { checkout, worktree, statePath } = linkedWorktrees();
    process.env.CLAUDE_PROJECT_DIR = checkout;
    delete process.env.LOOM_STATE_PATH;
    const verificationPolicy = {
      regression: { kind: "waived" as const, reason: "documentation-only" as const },
      newTests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const },
    };
    const task = taskFixture({
      id: "T1", description: "change the worktree", agent: "code-implementer-agent",
      wave: 1, depends_on: [], file_list: ["src/artifact.ts"],
      proof: derivePendingTaskProof({ verificationPolicy, declaredArtifacts: ["src/artifact.ts"] }),
      verification_policy: {
        regression: verificationPolicy.regression,
        new_tests: verificationPolicy.newTests,
      },
    });
    writeFileSync(statePath, JSON.stringify(graphFixture([task])));
    const registered = await registerTaskExecutionBatch([{
      kind: "implementation",
      prompt: "Task ID: T1",
      description: "change the worktree",
    }], "parallel", { kind: "at-registration", anyActiveForGraph: false }, worktree);
    if (registered.kind !== "registered") throw new Error(registered.message);
    const authority = registered.authorities[0]!;
    const sessionId = `claude-boundary-${label}-${process.pid}-${Date.now()}`;
    mkdirSync(SUBAGENT_DIR, { recursive: true });
    const pointer = join(SUBAGENT_DIR, `${sessionId}.task_graph`);
    writeFileSync(pointer, statePath);
    pointers.push(pointer);
    const transcript = join(worktree, ".claude", "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({
      type: "assistant", message: { role: "assistant", content: [{
        type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "src/artifact.ts" },
      }] },
    }) + "\n");
    return { statePath, sessionId, authority, transcript };
  }

  it("preserves the State File byte-for-byte when the boundary observation throws without a bound modern authority", async () => {
    // A LEGACY-shaped graph: the handler refuses an unobserved modern attempt
    // before the boundary observation, so this arm needs a task without an
    // active implementation attempt, attributed by its sole executing entry.
    const dir = canonicalTempDir("loom-boundary-legacy-");
    roots.push(dir);
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1, executing_tasks: ["T1"],
      wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
      tasks: [{
        id: "T1", description: "impl", agent: "code-implementer-agent",
        wave: 1, status: "pending", depends_on: [], new_tests_required: false,
      }],
    }));
    const sessionId = `claude-boundary-legacy-${process.pid}-${Date.now()}`;
    mkdirSync(SUBAGENT_DIR, { recursive: true });
    const pointer = join(SUBAGENT_DIR, `${sessionId}.task_graph`);
    writeFileSync(pointer, statePath);
    pointers.push(pointer);
    const before = readFileSync(statePath);
    vi.spyOn(config, "observeTaskGraphProjectBoundary").mockImplementation(() => {
      throw new Error("git rev-parse could not start: scripted boundary failure");
    });

    const result = await runUpdateTaskStatus(JSON.stringify({
      session_id: sessionId, agent_id: "a-1", agent_type: "code-implementer-agent",
    }), [], { kind: "snapshot", events: [] });

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining(
        "update-task-status: Claude TaskGraph project boundary unavailable: " +
        "git rev-parse could not start: scripted boundary failure; execution authority was preserved",
      ),
    });
    expect(readFileSync(statePath).equals(before)).toBe(true);
  }, 30_000);

  it("settles a bound modern authority with a non-consuming infrastructure receipt when the boundary observation throws", async () => {
    const { statePath, sessionId, authority, transcript } = await armedImplementationWorktree("bound");
    vi.spyOn(config, "observeTaskGraphProjectBoundary").mockImplementation(() => {
      throw new Error("git rev-parse could not start: scripted boundary failure");
    });
    const observation: ImplementationAuthorityObservation = {
      kind: "authority-observed",
      sidecar: {
        schemaVersion: 1, kind: "claude-implementation-attempt-sidecar",
        sessionId: sessionId as never, agentId: "agent-1" as never,
        canonicalTaskGraphPath: statePath, authority,
      },
    };

    const result = await runUpdateTaskStatus(JSON.stringify({
      session_id: sessionId, agent_id: "agent-1", agent_type: "code-implementer-agent",
      agent_transcript_path: transcript,
    }), [], { kind: "snapshot", events: [] }, observation);

    const message = result.kind === "error" ? result.message : JSON.stringify(result);
    expect(message).toContain(
      "Claude TaskGraph project boundary unavailable: git rev-parse could not start: scripted boundary failure",
    );
    expect(message).toContain(
      "received an exact non-consuming infrastructure Oracle receipt and cannot become implemented",
    );
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.tasks[0]).toMatchObject({
      status: "pending",
      revalidation_required: true,
    });
    expect(persisted.tasks[0].implementation_attempt_history).toContainEqual(expect.objectContaining({
      transition: "infrastructure-blocked",
      consumesSemanticAttempt: false,
    }));
    expect(persisted.executing_tasks).toEqual([]);
  }, 30_000);
});
