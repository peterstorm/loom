import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { HookHandler } from "../../types";
import { StateManager } from "../../state-manager";
import { taskGraphPath, WAVE_REVIEW_AGENTS } from "../../config";
import {
  createReviewPacket,
  parseReviewPacket,
  serializeReviewPacket,
  type ReviewPacketArtifactInput,
} from "../../core/review-packet";
import { reviewRunPriorFindings, startReviewRun } from "../../core/findings";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";

const OPERATIONS = ["create", "verify", "show"] as const;

export function reviewPacketCleanupFailure(
  original: unknown,
  outputPath: string,
  cleanup: unknown,
): Error {
  return new Error(
    `${original instanceof Error ? original.message : String(original)}; additionally failed to remove ` +
    `unbound review packet ${outputPath}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
    { cause: original },
  );
}

/** Write a packet and bind it to state as one compensating transaction. */
export async function persistReviewPacketAndBind(
  outputPath: string,
  serializedPacket: string,
  bind: () => Promise<void>,
): Promise<void> {
  writeFileSync(outputPath, serializedPacket, { flag: "wx" });
  try {
    await bind();
  } catch (error) {
    let cleanupError: unknown = null;
    try { unlinkSync(outputPath); }
    catch (cleanup) { cleanupError = cleanup; }
    if (cleanupError !== null) throw reviewPacketCleanupFailure(error, outputPath, cleanupError);
    throw error;
  }
}

const USAGE = `Usage: helper review-packet <${OPERATIONS.join("|")}> --task <id> --output <file> | --packet <file>`;

function arg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1]! : null;
}

function git(args: readonly string[], cwd: string, allowDiffExit = false): string {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowDiffExit && error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 1) {
      return String((error as { stdout?: unknown }).stdout ?? "");
    }
    throw error;
  }
}

function optionalGit(
  args: readonly string[],
  cwd: string,
  absentStatuses: readonly number[],
): string | null {
  try {
    return git(args, cwd);
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (typeof status === "number" && absentStatuses.includes(status)) return null;
    throw error;
  }
}

function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
}

function artifact(root: string, baseSha: string, path: string): ReviewPacketArtifactInput {
  const inspected = inspectRepositoryPath(root, path, "review packet path", { mustBeFile: true });
  const absolute = inspected.absolute;
  const present = existsSync(absolute);
  const tracked = optionalGit(["ls-files", "--error-unmatch", "--", path], root, [1]) !== null;
  if (!tracked && !present) {
    throw new Error(`review packet path is neither tracked nor present: ${path}`);
  }
  const diff = tracked
    ? git(["diff", "--binary", baseSha, "--", path], root)
    : present
      ? git(["diff", "--no-index", "--binary", "/dev/null", path], root, true)
      : "";
  return {
    path,
    diff,
    postimage: present ? readFileSync(absolute) : null,
  };
}

const handler: HookHandler = async (_stdin, args) => {
  const operation = args[0];
  if (!operation || !(OPERATIONS as readonly string[]).includes(operation)) {
    return { kind: "error", message: USAGE };
  }

  if (operation === "verify" || operation === "show") {
    const packetPath = arg(args, "--packet");
    if (!packetPath) return { kind: "error", message: `${USAGE}\n--packet is required` };
    let raw: string;
    try { raw = readFileSync(packetPath, "utf-8"); }
    catch (error) { return { kind: "error", message: `Cannot read review packet ${packetPath}: ${error}` }; }
    const packet = parseReviewPacket(raw);
    if (!packet.ok) return { kind: "error", message: `Invalid review packet:\n${packet.errors.map((e) => `  - ${e}`).join("\n")}` };
    if (operation === "show") process.stdout.write(serializeReviewPacket(packet.value));
    else process.stdout.write(`${packet.value.packetId}\n`);
    return { kind: "passthrough" };
  }

  const taskId = arg(args, "--task");
  const output = arg(args, "--output");
  if (!taskId || !output) return { kind: "error", message: `${USAGE}\n--task and --output are required` };
  const manager = StateManager.fromPath(taskGraphPath());
  if (!manager) return { kind: "error", message: `No task graph at ${taskGraphPath()}` };
  const state = manager.load();
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { kind: "error", message: `Task ${taskId} is not in the task graph` };
  const priorFindings = reviewRunPriorFindings(task);

  try {
    const root = repoRoot();
    const headSha = git(["rev-parse", "HEAD"], root).trim();
    const remoteHead = optionalGit(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      root,
      [1],
    );
    const defaultBranch = remoteHead?.trim().replace(/^origin\//, "") || "main";
    const remoteBranch = `origin/${defaultBranch}`;
    const hasRemoteBranch = optionalGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteBranch}`],
      root,
      [1],
    ) !== null;
    const baseSha = task.start_sha ?? (
      hasRemoteBranch
        ? git(["merge-base", "HEAD", remoteBranch], root).trim()
        : git(["rev-parse", "HEAD^"], root).trim()
    );
    if (!baseSha || !headSha) throw new Error("could not resolve packet base/head SHA");
    // Transcript APIs commonly report absolute paths. Canonicalize both current
    // and legacy task state at the packet boundary so packet identity remains
    // repo-relative and deterministic while outside-repository aliases fail.
    const declaredPaths = [...canonicalRepositoryPaths(root, task.file_list ?? [], "task.file_list")];
    const modifiedPaths = [...canonicalRepositoryPaths(root, task.files_modified ?? [], "task.files_modified")];
    const scope = [...new Set([...declaredPaths, ...modifiedPaths])].sort();
    const packet = createReviewPacket({
      task: {
        id: task.id,
        description: task.description,
        agent: task.agent,
        wave: task.wave,
        specAnchors: task.spec_anchors ?? [],
        reviewGeneration: task.review_generation ?? 0,
        priorFindings: priorFindings.map((finding) => ({
          id: finding.id,
          agent: finding.agent,
          severity: finding.severity,
          file: finding.file,
          line: finding.line,
          claim: finding.claim,
          reviewGeneration: finding.review_generation ?? null,
          reviewPacketId: finding.review_packet_id ?? null,
        })),
        expectedReviewers: WAVE_REVIEW_AGENTS,
      },
      baseSha,
      headSha,
      declaredPaths,
      modifiedPaths,
      artifacts: scope.map((path) => artifact(root, baseSha, path)),
      planContext: task.plan_context ?? "",
      proofObligations: task.proof?.obligations ?? [],
    });
    if (!packet.ok) return { kind: "error", message: `Review packet creation failed:\n${packet.errors.map((e) => `  - ${e}`).join("\n")}` };
    const outputPath = inspectRepositoryPath(root, output, "review packet output");
    const absoluteOutput = outputPath.absolute;
    mkdirSync(dirname(absoluteOutput), { recursive: true });
    await persistReviewPacketAndBind(
      absoluteOutput,
      serializeReviewPacket(packet.value),
      async () => manager.update((current) => {
        const currentTask = current.tasks.find((candidate) => candidate.id === taskId);
        if (currentTask === undefined) throw new Error(`Task ${taskId} disappeared before review run start`);
        const packetPriorIds = priorFindings.map((finding) => finding.id);
        const currentPriorIds = reviewRunPriorFindings(currentTask).map((finding) => finding.id);
        if ((currentTask.review_generation ?? 0) !== (task.review_generation ?? 0) ||
            packetPriorIds.length !== currentPriorIds.length ||
            packetPriorIds.some((id, index) => id !== currentPriorIds[index])) {
          throw new Error(`Task ${taskId} changed while its Review Packet was being created`);
        }
        const transition = startReviewRun(currentTask, {
          generation: task.review_generation ?? 0,
          packetId: packet.value.packetId,
          headSha,
          expectedAgents: WAVE_REVIEW_AGENTS,
        });
        if (!transition.ok) throw new Error(transition.error);
        return {
          ...current,
          tasks: current.tasks.map((candidate) =>
            candidate.id === taskId ? transition.task : candidate
          ),
        };
      }),
    );
    process.stdout.write(`${packet.value.packetId}\n`);
    return { kind: "passthrough" };
  } catch (error) {
    return { kind: "error", message: `Review packet creation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

export default handler;
