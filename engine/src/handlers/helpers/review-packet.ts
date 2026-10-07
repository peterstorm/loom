import { execFileSync } from "node:child_process";
import { argumentValue } from "./cli-args";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
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
import { compareStrings } from "../../core/ordering";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";
import {
  diffBinaryFileFromRevision,
  diffBinaryUntrackedFile,
  isTrackedAt,
  type GitDiffResult,
} from "../../utils/git";
import { reviewedDirectoryLeafPaths } from "../../utils/git-leaves";

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


function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function requiredDiff(result: GitDiffResult): string {
  if (!result.ok) throw new Error(result.error);
  return result.diff;
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

/** One file the packet reviews. A scoped path names a regular file; a leaf
 * below a scoped directory may also be a symlink, which a directory artifact
 * snapshot already hashes by its target. */
type PacketLeaf = Readonly<
  | { origin: "scoped-file"; path: string }
  | { origin: "directory-leaf"; path: string }
>;

function nulSeparated(output: string): readonly string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

/** The leaves a scoped directory contributes — see `reviewedDirectoryLeafPaths`
 * for the one leaf-set contract the packet shares with the reviewed-workspace
 * observation — or null when the path names no directory now or at the
 * packet base. */
function directoryLeaves(root: string, baseSha: BaseSha, path: string): readonly string[] | null {
  const inspected = inspectRepositoryPath(root, path, "review packet path");
  const directoryNow = inspected.exists && lstatSync(inspected.absolute).isDirectory();
  const directoryAtBase = nulSeparated(git(["ls-tree", "-z", "--full-tree", baseSha, "--", path], root))
    .some((entry) => entry.split("\t")[0]!.split(" ")[1] === "tree");
  if (!directoryNow && !directoryAtBase) return null;
  return reviewedDirectoryLeafPaths(root, baseSha, path);
}

/** Expand the scope into the files the packet reviews. A file scoped both
 * directly and below a scoped directory keeps its stricter direct origin. */
function packetLeaves(root: string, baseSha: BaseSha, scope: readonly string[]): readonly PacketLeaf[] {
  const leaves = new Map<string, PacketLeaf>();
  for (const path of scope) {
    const below = directoryLeaves(root, baseSha, path);
    if (below === null) leaves.set(path, { origin: "scoped-file", path });
    else for (const leaf of below) {
      if (!leaves.has(leaf)) leaves.set(leaf, { origin: "directory-leaf", path: leaf });
    }
  }
  return [...leaves.values()].sort((left, right) => compareStrings(left.path, right.path));
}

function artifact(root: string, baseSha: BaseSha, leaf: PacketLeaf): ReviewPacketArtifactInput {
  const { path } = leaf;
  const inspected = leaf.origin === "scoped-file"
    ? inspectRepositoryPath(root, path, "review packet path", { mustBeFile: true })
    : inspectRepositoryPath(root, path, "review packet path", { allowLeafSymlink: true });
  const symlink = inspected.exists && lstatSync(inspected.absolute).isSymbolicLink();
  const present = inspected.exists;
  const trackedResult = isTrackedAt(root, path);
  if (!trackedResult.ok) throw new Error(trackedResult.error);
  const tracked = trackedResult.tracked;
  const trackedAtBase = git(["ls-tree", "-z", "--full-tree", baseSha, "--", path], root) !== "";
  if (!trackedAtBase && !tracked && !present) {
    throw new Error(`review packet path is neither tracked nor present at its base: ${path}`);
  }
  let diff = "";
  if (trackedAtBase || tracked) {
    diff = requiredDiff(diffBinaryFileFromRevision(root, baseSha, path));
  } else if (present) {
    diff = requiredDiff(diffBinaryUntrackedFile(root, path));
  }
  return {
    path,
    diff,
    postimage: symlink
      ? readlinkSync(inspected.absolute, { encoding: "buffer" })
      : readReviewPacketPostimage(inspected),
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
    artifacts: packetLeaves(root, baseSha, scope).map((leaf) => artifact(root, baseSha, leaf)),
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
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      root,
      [1],
    );
    const defaultBranch = remoteHead?.trim().replace(/^origin\//, "") ?? null;
    const remoteBranch = defaultBranch === null ? null : `origin/${defaultBranch}`;
    const hasRemoteBranch = remoteBranch !== null && optionalGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteBranch}`],
      root,
      [1],
    ) !== null;
    // Each revision is parsed through its OWN smart constructor: base and head
    // carry distinct brands precisely so the two cannot be transposed here.
    // A one-parent fallback is not authority for a Task that may span several
    // commits: without a persisted start or proven remote base, fail closed.
    let rawBaseSha: string;
    if (task.start_sha !== undefined) {
      rawBaseSha = task.start_sha;
    } else {
      if (remoteBranch === null || !hasRemoteBranch) {
        return {
          kind: "error",
          message: "Review packet creation failed: no task start_sha or remote default branch can authorize the packet base",
        };
      }
      rawBaseSha = git(["merge-base", "HEAD", remoteBranch], root).trim();
    }
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
