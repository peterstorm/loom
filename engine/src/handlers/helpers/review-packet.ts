import { execFileSync } from "node:child_process";
import { argumentValue } from "./cli-args";
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { HookHandler, Task } from "../../types";
import { StateManager } from "../../state-manager";
import { taskGraphPath, WAVE_REVIEW_AGENTS } from "../../config";
import {
  createReviewPacket,
  parseBaseSha,
  parseHeadSha,
  parseReviewPacket,
  parseReviewPath,
  serializeReviewPacket,
  type BaseSha,
  type HeadSha,
  type ReviewPacketArtifactInput,
} from "../../core/review-packet";
import { reviewRunPriorFindings, startReviewRun } from "../../core/findings";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";

const OPERATIONS = ["create", "verify", "show"] as const;

export interface ReviewPacketAuthority {
  readonly taskStartSha: string | undefined;
  readonly packetId: string;
}

/** Pure lock-time authority comparison. The packet id commits to every packet
 * input; startSha is checked separately because it selects the packet base. */
export function reviewPacketAuthorityError(
  expected: ReviewPacketAuthority,
  current: ReviewPacketAuthority,
  taskId: string,
): string | null {
  return expected.taskStartSha === current.taskStartSha && expected.packetId === current.packetId
    ? null
    : `Task ${taskId}, repository HEAD, or review artifacts changed while its Review Packet was being created`;
}

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


function git(args: readonly string[], cwd: string, allowDiffExit = false): string {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowDiffExit && error && typeof error === "object" && "status" in error &&
        (error as { status?: number }).status === 1) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      if (/^diff --git /m.test(stdout)) return stdout;
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      const detail = stderr || stdout.trim() || "no diagnostic output";
      throw new Error(
        `git ${args.join(" ")} returned status 1 without a valid patch: ${detail}`,
        { cause: error },
      );
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

export function readReviewPacketPostimage(
  inspected: Readonly<{ absolute: string; exists: boolean }>,
  read: (path: string) => Uint8Array = readFileSync,
): Uint8Array | null {
  return inspected.exists ? read(inspected.absolute) : null;
}

function artifact(root: string, baseSha: BaseSha, path: string): ReviewPacketArtifactInput {
  const inspected = inspectRepositoryPath(root, path, "review packet path", { mustBeFile: true });
  const present = inspected.exists;
  const tracked = optionalGit(["ls-files", "--error-unmatch", "--", path], root, [1]) !== null;
  const trackedAtBase = git(["ls-tree", "-z", "--full-tree", baseSha, "--", path], root) !== "";
  if (!trackedAtBase && !tracked && !present) {
    throw new Error(`review packet path is neither tracked nor present at its base: ${path}`);
  }
  let diff = "";
  if (trackedAtBase || tracked) {
    diff = git(["diff", "--binary", baseSha, "--", path], root);
  } else if (present) {
    diff = git(["diff", "--no-index", "--binary", "/dev/null", path], root, true);
  }
  return {
    path,
    diff,
    postimage: readReviewPacketPostimage(inspected),
  };
}

/** Build the complete task-derived packet authority. Rebuilding this under the
 * state lock makes one packet id the comparison for metadata, findings, scope,
 * proof context, git head, diffs, and artifact bytes. */
function prepareTaskReviewPacket(root: string, task: Task, baseSha: BaseSha, headSha: HeadSha) {
  const priorFindings = reviewRunPriorFindings(task);
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
  return { packet, scope } as const;
}

const handler: HookHandler = async (_stdin, args) => {
  const operation = args[0];
  if (!operation || !(OPERATIONS as readonly string[]).includes(operation)) {
    return { kind: "error", message: USAGE };
  }

  if (operation === "verify" || operation === "show") {
    const packetPath = argumentValue(args, "--packet");
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

  const taskId = argumentValue(args, "--task");
  const output = argumentValue(args, "--output");
  if (!taskId || !output) return { kind: "error", message: `${USAGE}\n--task and --output are required` };
  const manager = StateManager.fromPath(taskGraphPath());
  if (!manager) return { kind: "error", message: `No task graph at ${taskGraphPath()}` };
  const state = manager.load();
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { kind: "error", message: `Task ${taskId} is not in the task graph` };

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
    // Each revision is parsed through its OWN smart constructor: base and head
    // carry distinct brands precisely so the two cannot be transposed here.
    const rawBaseSha = task.start_sha ?? (
      hasRemoteBranch
        ? git(["merge-base", "HEAD", remoteBranch], root).trim()
        : git(["rev-parse", "HEAD^"], root).trim()
    );
    const parsedBaseSha = parseBaseSha(rawBaseSha);
    const parsedHeadSha = parseHeadSha(headSha);
    if (!parsedBaseSha.ok || !parsedHeadSha.ok) {
      return {
        kind: "error",
        message: `could not resolve packet base/head SHA:\n${[...(parsedBaseSha.ok ? [] : parsedBaseSha.errors), ...(parsedHeadSha.ok ? [] : parsedHeadSha.errors)].map((e) => `  - ${e}`).join("\n")}`,
      };
    }
    const baseSha = parsedBaseSha.value;
    // Transcript APIs commonly report absolute paths. Canonicalization and
    // packet identity are rebuilt under the lock before this packet is bound.
    const prepared = prepareTaskReviewPacket(root, task, baseSha, parsedHeadSha.value);
    const { packet } = prepared;
    if (!packet.ok) return { kind: "error", message: `Review packet creation failed:\n${packet.errors.map((e) => `  - ${e}`).join("\n")}` };
    const outputPath = inspectRepositoryPath(root, output, "review packet output");
    const absoluteOutput = outputPath.absolute;
    const packetPath = parseReviewPath(outputPath.relative, "review packet output");
    if (!packetPath.ok) {
      return { kind: "error", message: `Review packet output is invalid: ${packetPath.errors.join("; ")}` };
    }
    const registeredScope = Object.freeze([
      ...new Set([...packet.value.declaredPaths, ...packet.value.modifiedPaths]),
    ].sort());
    const registration = Object.freeze({
      task_id: task.id,
      packet_id: packet.value.packetId,
      packet_path: packetPath.value,
      base_sha: baseSha,
      head_sha: parsedHeadSha.value,
      scope: registeredScope,
    });
    mkdirSync(dirname(absoluteOutput), { recursive: true });
    await persistReviewPacketAndBind(
      absoluteOutput,
      serializeReviewPacket(packet.value),
      async () => manager.update((current) => {
        const currentTask = current.tasks.find((candidate) => candidate.id === taskId);
        if (currentTask === undefined) throw new Error(`Task ${taskId} disappeared before review run start`);
        const lockedHeadSha = parseHeadSha(git(["rev-parse", "HEAD"], root).trim());
        if (!lockedHeadSha.ok) throw new Error(`Task ${taskId} head SHA became unparseable under the state lock`);
        const currentPrepared = prepareTaskReviewPacket(root, currentTask, baseSha, lockedHeadSha.value);
        if (!currentPrepared.packet.ok) {
          throw new Error(`Task ${taskId} became invalid while its Review Packet was being created`);
        }
        const authorityError = reviewPacketAuthorityError(
          { taskStartSha: task.start_sha, packetId: packet.value.packetId },
          { taskStartSha: currentTask.start_sha, packetId: currentPrepared.packet.value.packetId },
          taskId,
        );
        if (authorityError !== null) throw new Error(authorityError);
        const transition = startReviewRun(currentTask, {
          generation: task.review_generation ?? 0,
          packetId: packet.value.packetId,
          // The PARSED head revision, not the raw `rev-parse` string: the
          // binding carries the HeadSha brand so a base/head transposition
          // here is a compile error rather than an inverted review run.
          headSha: parsedHeadSha.value,
          expectedAgents: WAVE_REVIEW_AGENTS,
        });
        if (!transition.ok) throw new Error(transition.error);
        const existingRegistrations = currentTask.issued_review_packets ?? [];
        if (existingRegistrations.some((entry) =>
          entry.packet_id === registration.packet_id || entry.packet_path === registration.packet_path
        )) {
          throw new Error(`Task ${taskId} already registered packet ${registration.packet_id} or path ${registration.packet_path}`);
        }
        return {
          ...current,
          tasks: current.tasks.map((candidate) =>
            candidate.id === taskId
              ? { ...transition.task, issued_review_packets: [...existingRegistrations, registration] }
              : candidate
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
