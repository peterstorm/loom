import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUBAGENT_DIR } from "../../src/config";
import type { ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import type { VerificationPolicy } from "../../src/core/verification-policy";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import {
  publishImplementationAttemptSidecar,
  removeImplementationAttemptSidecar,
  type ImplementationAuthorityObservation,
} from "../../src/implementation-attempt-sidecar";
import type { Task, TaskGraph } from "../../src/types";
import { canonicalTempDir } from "./canonical-temp-dir";
import { graphFixture, taskFixture } from "./task-lifecycle";

/** The one source file every armed repository commits, and the Task declares. */
export const ARMED_ARTIFACT = "src/artifact.ts";

export type ArmedClaudeImplementation = Readonly<{
  /** The Git repository the State File, transcript and artifact live in. */
  root: string;
  statePath: string;
  sessionId: string;
  agentId: string;
  /** The exact attempt authority registration minted for T1. */
  authority: ImplementationAttemptAuthority;
  /** Where the Agent's transcript is written; empty until a test writes it. */
  transcript: string;
  /** The snapshotted sidecar observation dispatch hands update-task-status. */
  observation: ImplementationAuthorityObservation;
  /** The SubagentStop stdin naming this session, Agent and transcript. */
  stopInput: string;
  /** Removes the repository and session pointer, and restores the project env. */
  dispose: () => void;
}>;

export type ArmedClaudeImplementationOptions = Readonly<{
  label: string;
  verificationPolicy: VerificationPolicy;
  /** T1's declared files; the default is the committed artifact. */
  fileList?: readonly string[];
  /** Further pending Tasks of Wave 1 that stay unregistered. */
  siblings?: readonly Task[];
  /** Rewrites the populated graph before registration (spec-check, gates, ...). */
  seed?: (graph: TaskGraph) => TaskGraph;
  /**
   * Publish the attempt's sidecar where SubagentStop dispatch snapshots it,
   * as the Agent's PreToolUse registration does. Without it a test hands
   * update-task-status the observation directly.
   */
  publishSidecar?: boolean;
}>;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A Git repository whose one commit holds the artifact and ignores `.claude/`. */
function committedArtifactRepository(label: string): string {
  const root = canonicalTempDir(`loom-armed-${label}-`);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Loom Test");
  git(root, "config", "user.email", "loom@example.test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".claude/\n");
  writeFileSync(join(root, ARMED_ARTIFACT), "export const value = 1;\n");
  git(root, "add", ".gitignore", ARMED_ARTIFACT);
  git(root, "commit", "-qm", "baseline");
  return root;
}

/** The pending T1 the armed graph holds: `fileList` changed under `policy`. */
function armedTask(fileList: readonly string[], policy: VerificationPolicy): Task {
  return taskFixture({
    id: "T1", description: "change the artifact", agent: "code-implementer-agent",
    wave: 1, depends_on: [], file_list: [...fileList],
    proof: derivePendingTaskProof({ declaredArtifactExpectation: "changed", verificationPolicy: policy, declaredArtifacts: fileList }),
    verification_policy: {
      regression: policy.regression,
      new_tests: policy.newTests,
    } as Task["verification_policy"],
  });
}

/** The sidecar observation SubagentStop dispatch snapshots for this session's Agent. */
function sidecarObservation(
  sessionId: string,
  agentId: string,
  statePath: string,
  authority: ImplementationAttemptAuthority,
): ImplementationAuthorityObservation {
  return {
    kind: "authority-observed",
    sidecar: {
      schemaVersion: 1, kind: "claude-implementation-attempt-sidecar",
      sessionId: sessionId as never, agentId: agentId as never,
      canonicalTaskGraphPath: statePath, authority,
    },
  };
}

/**
 * A Claude implementation attempt registered exactly as the PreToolUse hook
 * registers one: a committed Git repository whose State File holds a pending
 * T1, a real `registerTaskExecutionBatch` reservation, and the session pointer
 * plus sidecar observation a SubagentStop for that attempt carries. Every
 * executing Task of a loadable State File has such authority (ADR-0098).
 */
export async function armedClaudeImplementation(
  options: ArmedClaudeImplementationOptions,
): Promise<ArmedClaudeImplementation> {
  const previousProject = process.env.CLAUDE_PROJECT_DIR;
  const previousState = process.env.LOOM_STATE_PATH;
  const root = committedArtifactRepository(options.label);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = root;
  delete process.env.LOOM_STATE_PATH;

  const task = armedTask(options.fileList ?? [ARMED_ARTIFACT], options.verificationPolicy);
  const graph = graphFixture([task, ...(options.siblings ?? [])]);
  writeFileSync(statePath, JSON.stringify(options.seed?.(graph) ?? graph));
  const registered = await registerTaskExecutionBatch([{
    kind: "implementation", prompt: "Task ID: T1", description: "change the artifact",
  }], "parallel", { kind: "at-registration", anyActiveForGraph: false }, root);
  if (registered.kind !== "registered") throw new Error(registered.message);
  const [authority] = registered.authorities;
  if (authority === undefined) throw new Error("registration minted no implementation attempt authority");

  const sessionId = `claude-armed-${options.label}-${process.pid}-${Date.now()}`;
  const agentId = "a-1";
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const pointer = join(SUBAGENT_DIR, `${sessionId}.task_graph`);
  writeFileSync(pointer, statePath);
  if (options.publishSidecar === true) {
    publishImplementationAttemptSidecar({ sessionId, agentId, taskGraphPath: statePath, authority });
  }
  const transcript = join(root, ".claude", "transcript.jsonl");
  return {
    root, statePath, sessionId, agentId, authority, transcript,
    observation: sidecarObservation(sessionId, agentId, statePath, authority),
    stopInput: JSON.stringify({
      session_id: sessionId, agent_id: agentId, agent_type: "code-implementer-agent",
      agent_transcript_path: transcript,
    }),
    dispose: () => {
      if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProject;
      if (previousState === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previousState;
      rmSync(pointer, { force: true });
      removeImplementationAttemptSidecar(sessionId, agentId);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One assistant transcript line: `text`, then a Write of each path. */
export function writesTranscript(text: string, paths: readonly string[]): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...paths.map((file_path, index) => ({ type: "tool_use", id: `tool-${index}`, name: "Write", input: { file_path } })),
      ],
    },
  }) + "\n";
}
