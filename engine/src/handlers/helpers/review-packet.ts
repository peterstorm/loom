import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HookHandler } from "../../types";
import { StateManager } from "../../state-manager";
import { taskGraphPath } from "../../config";
import {
  createReviewPacket,
  parseReviewPacket,
  serializeReviewPacket,
  type ReviewPacketArtifactInput,
} from "../../core/review-packet";

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

function safeRepoPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`review packet path must be repo-relative: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`review packet path escapes repository: ${path}`);
  }
  if (existsSync(absolute)) {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`review packet path must not be a symlink: ${path}`);
    const real = realpathSync(absolute);
    const realRel = relative(root, real);
    if (realRel.startsWith("..") || isAbsolute(realRel)) throw new Error(`review packet path resolves outside repository: ${path}`);
    if (!lstatSync(absolute).isFile()) throw new Error(`review packet path must be a regular file: ${path}`);
  }
  return absolute;
}

function artifact(root: string, baseSha: string, path: string): ReviewPacketArtifactInput {
  const absolute = safeRepoPath(root, path);
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
    const declaredPaths = [...new Set(task.file_list ?? [])].sort();
    const modifiedPaths = [...new Set(task.files_modified ?? [])].sort();
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
    const absoluteOutput = resolve(output);
    const outputRel = relative(root, absoluteOutput);
    if (outputRel.startsWith("..") || isAbsolute(outputRel)) throw new Error("review packet output must be inside the repository");
    mkdirSync(dirname(absoluteOutput), { recursive: true });
    writeFileSync(absoluteOutput, serializeReviewPacket(packet.value), { flag: "wx" });
    process.stdout.write(`${packet.value.packetId}\n`);
    return { kind: "passthrough" };
  } catch (error) {
    return { kind: "error", message: `Review packet creation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

export default handler;
