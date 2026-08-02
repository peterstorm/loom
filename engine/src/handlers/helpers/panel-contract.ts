import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HookHandler } from "../../types";
import {
  parseInterviewDigest,
  parseInterviewDigestJson,
  parseJudgeVerdict,
  parsePanelManifest,
  selectPanelLenses,
  serializeJudgeVerdict,
  type PanelManifest,
} from "../../core/panel-contract";

function argumentValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1]! : null;
}

function contractError(context: string, errors: readonly string[]) {
  return {
    kind: "error" as const,
    message: [`${context} contract failed:`, ...errors.map((error) => `- ${error}`)].join("\n"),
  };
}

type RunBoundary = Readonly<{ runDir: string; manifestPath: string }>;

/** Bind the run to an explicit panel-runs root and reject every symlinked hop. */
function parseRunBoundary(runsRoot: string, manifestPath: string):
  | { readonly ok: true; readonly value: RunBoundary }
  | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const cwd = realpathSync(process.cwd());
  const absoluteRoot = resolve(runsRoot);
  const absoluteManifest = resolve(manifestPath);
  const absoluteRunDir = dirname(absoluteManifest);
  const fromCwd = relative(cwd, absoluteRoot);

  if (isAbsolute(fromCwd) || fromCwd === ".." || fromCwd.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    errors.push("panel-runs root must be inside the current working directory");
  }
  if (dirname(absoluteRunDir) !== absoluteRoot) {
    errors.push("manifest must be directly inside one run directory under --runs-root");
  }
  if (absoluteManifest !== join(absoluteRunDir, "manifest.json")) {
    errors.push("manifest filename must be exactly manifest.json");
  }

  if (errors.length === 0) {
    let cursor = cwd;
    for (const segment of fromCwd.split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, segment);
      try {
        if (lstatSync(cursor).isSymbolicLink()) errors.push(`path component must not be a symbolic link: ${cursor}`);
      } catch (error) {
        errors.push(`cannot inspect path component ${cursor}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }

  for (const [label, path, kind] of [
    ["run directory", absoluteRunDir, "directory"],
    ["manifest", absoluteManifest, "file"],
  ] as const) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) errors.push(`${label} must not be a symbolic link: ${path}`);
      if (kind === "directory" && !stat.isDirectory()) errors.push(`${label} must be a directory: ${path}`);
      if (kind === "file" && (!stat.isFile() || stat.size === 0)) errors.push(`${label} must be a non-empty regular file: ${path}`);
    } catch (error) {
      errors.push(`cannot inspect ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { runDir: dirname(manifestPath), manifestPath } };
}

function artifactErrors(manifest: PanelManifest, runDir: string, includeCandidates: boolean): string[] {
  const errors: string[] = [];
  let realRunDir: string;
  try {
    realRunDir = realpathSync(runDir);
  } catch (error) {
    return [`cannot resolve run directory ${runDir}: ${error instanceof Error ? error.message : String(error)}`];
  }

  const paths = includeCandidates
    ? [manifest.interviewFile, manifest.interviewJson, ...manifest.candidates.map((candidate) => candidate.path)]
    : [manifest.interviewFile, manifest.interviewJson];

  for (const path of paths) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        errors.push(`artifact must not be a symbolic link: ${path}`);
        continue;
      }
      if (!stat.isFile() || stat.size === 0) {
        errors.push(`artifact must be a non-empty regular file: ${path}`);
        continue;
      }
      const expectedParent = path === manifest.interviewFile || path === manifest.interviewJson
        ? realRunDir
        : join(realRunDir, "candidates");
      if (dirname(realpathSync(path)) !== expectedParent) {
        errors.push(`artifact resolves outside its run-scoped directory: ${path}`);
      }
    } catch (error) {
      errors.push(`cannot verify artifact ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

function writeCanonicalOutput(output: string) {
  try {
    writeFileSync(process.stdout.fd, output);
    return { kind: "allow" as const };
  } catch (error) {
    return contractError("canonical output", [
      `stdout write failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

const USAGE = "Usage: helper panel-contract <interview|manifest|verdict> [--runs-root <dir> --manifest <file> --designers <N> --criterion <text>]";

/** Validate untrusted panel handoffs at the imperative filesystem boundary. */
const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];

  if (operation === "interview") {
    const parsed = parseInterviewDigest(stdin);
    if (!parsed.ok) return contractError("interview digest", parsed.errors);
    return writeCanonicalOutput(JSON.stringify(parsed.value, null, 2) + "\n");
  }

  if (operation === "manifest" || operation === "verdict") {
    const criterion = argumentValue(args, "--criterion");
    const manifestPath = argumentValue(args, "--manifest");
    const runsRoot = argumentValue(args, "--runs-root");
    const rawDesigners = argumentValue(args, "--designers");
    if (!manifestPath || !runsRoot || !rawDesigners || !/^\d+$/.test(rawDesigners) || (operation === "verdict" && !criterion)) {
      return { kind: "error", message: USAGE };
    }
    const designerCount = Number(rawDesigners);

    const boundary = parseRunBoundary(runsRoot, manifestPath);
    if (!boundary.ok) return contractError("panel run boundary", boundary.errors);
    const { runDir } = boundary.value;

    let manifestJson: unknown;
    let interviewJson: unknown;
    try {
      manifestJson = JSON.parse(readFileSync(manifestPath, "utf-8"));
      interviewJson = JSON.parse(readFileSync(join(runDir, "interview.json"), "utf-8"));
    } catch (error) {
      return contractError("panel JSON", [
        `cannot read manifest/interview JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    const interview = parseInterviewDigestJson(interviewJson);
    if (!interview.ok) return contractError("canonical interview digest", interview.errors);
    const expectedLenses = selectPanelLenses(interview.value, designerCount);
    if (!expectedLenses.ok) return contractError("panel lens selection", expectedLenses.errors);

    const manifest = parsePanelManifest(manifestJson, runDir, expectedLenses.value);
    if (!manifest.ok) return contractError("panel manifest", manifest.errors);
    const artifacts = artifactErrors(manifest.value, runDir, operation === "verdict");
    if (artifacts.length > 0) return contractError("panel artifacts", artifacts);
    if (operation === "manifest") return { kind: "allow" };
    if (criterion === null) return contractError("judge verdict", ["criterion is required"]);

    const verdict = parseJudgeVerdict(
      stdin,
      criterion,
      manifest.value.candidates.map((candidate) => candidate.filename),
    );
    if (!verdict.ok) return contractError("judge verdict", verdict.errors);

    return writeCanonicalOutput(serializeJudgeVerdict(verdict.value) + "\n");
  }

  return { kind: "error", message: USAGE };
};

export default handler;
