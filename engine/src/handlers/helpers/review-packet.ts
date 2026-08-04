import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { HookHandler } from "../../types";
import { StateManager } from "../../state-manager";
import { taskGraphPath } from "../../config";
import {
  createReviewPacket,
  parseReviewPacket,
  serializeReviewPacket,
  type ReviewPacketArtifactInput,
} from "../../core/review-packet";
import { canonicalRepositoryPaths, inspectRepositoryPath } from "../../utils/repository-path";

const OPERATIONS = ["create", "verify", "show"] as const;
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

function tryGit(args: readonly string[], cwd: string): string {
  try { return git(args, cwd); } catch { return ""; }
}

function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
}

function artifact(root: string, baseSha: string, path: string): ReviewPacketArtifactInput {
  const inspected = inspectRepositoryPath(root, path, "review packet path", { mustBeFile: true });
  const absolute = inspected.absolute;
  const tracked = tryGit(["ls-files", "--error-unmatch", "--", path], root).trim() !== "";
  const diff = tracked
    ? git(["diff", "--binary", baseSha, "--", path], root)
    : existsSync(absolute)
      ? git(["diff", "--no-index", "--binary", "/dev/null", path], root, true)
      : "";
  return {
    path,
    diff,
    postimage: existsSync(absolute) ? readFileSync(absolute, "utf-8") : null,
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

  try {
    const root = repoRoot();
    const headSha = git(["rev-parse", "HEAD"], root).trim();
    const defaultBranch = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)
      .trim().replace(/^origin\//, "") || "main";
    const baseSha = task.start_sha ?? (
      tryGit(["merge-base", "HEAD", `origin/${defaultBranch}`], root).trim()
      || tryGit(["rev-parse", "HEAD^"], root).trim()
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
    writeFileSync(absoluteOutput, serializeReviewPacket(packet.value), { flag: "wx" });
    process.stdout.write(`${packet.value.packetId}\n`);
    return { kind: "passthrough" };
  } catch (error) {
    return { kind: "error", message: `Review packet creation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

export default handler;
