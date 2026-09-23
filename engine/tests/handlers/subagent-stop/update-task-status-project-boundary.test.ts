import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
