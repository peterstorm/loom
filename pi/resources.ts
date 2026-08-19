import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { renderMarkdownForPi } from "../engine/src/core/harness-resources";

const RESOURCE_FORMAT_VERSION = "loom-pi-resources-v2";
const SOURCE_TREES = ["skills", "commands", "references", "rules"] as const;
const READY_FILE = ".ready.json";
const PUBLISH_ATTEMPTS = 8;
let quarantineOrdinal = 0;

export interface PiResourcePaths {
  readonly root: string;
  readonly promptPaths: readonly string[];
  readonly skillPaths: readonly string[];
}

interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly executable: boolean;
  readonly content: Buffer;
}

function sourceFiles(packageRoot: string): readonly SourceFile[] {
  const files: SourceFile[] = [];

  const visit = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = join(absoluteDir, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Loom Pi resources reject symbolic links: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({
        absolutePath,
        relativePath: relative(packageRoot, absolutePath),
        executable: (stat.mode & 0o111) !== 0,
        content: readFileSync(absolutePath),
      });
    }
  };

  for (const tree of SOURCE_TREES) {
    const treeRoot = join(packageRoot, tree);
    const stat = lstatSync(treeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Loom Pi resource tree must be a regular directory: ${treeRoot}`);
    }
    visit(treeRoot);
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function renderedContent(file: SourceFile, packageRoot: string): Buffer {
  if (!file.relativePath.endsWith(".md")) return file.content;
  const lowered = renderMarkdownForPi(file.content.toString("utf-8"), packageRoot);
  // Core returns the refusal; the shell decides it is fatal, matching the
  // sibling throws in this module's own tree walk.
  if (!lowered.ok) throw new Error(`${file.relativePath}: ${lowered.error.message}`);
  return Buffer.from(lowered.value, "utf-8");
}

function resourceDigest(packageRoot: string, files: readonly SourceFile[]): string {
  const hash = createHash("sha256");
  hash.update(RESOURCE_FORMAT_VERSION).update("\0").update(packageRoot).update("\0");
  for (const file of files) {
    hash.update(file.relativePath).update("\0")
      .update(file.executable ? "executable" : "regular").update("\0")
      .update(renderedContent(file, packageRoot)).update("\0");
  }
  return hash.digest("hex");
}

function readyContent(packageRoot: string, digest: string, files: readonly SourceFile[]): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    digest,
    packageRoot,
    files: files.map((file) => ({
      path: file.relativePath,
      mode: file.executable ? "0700" : "0600",
    })),
  }, null, 2) + "\n", "utf-8");
}

function expectedDirectories(files: readonly SourceFile[]): ReadonlySet<string> {
  const directories = new Set<string>([""]);
  for (const file of files) {
    let current = dirname(file.relativePath);
    while (current !== "." && current !== "") {
      directories.add(current);
      current = dirname(current);
    }
  }
  return directories;
}

function isReadyUnchecked(root: string, packageRoot: string, digest: string, files: readonly SourceFile[]): boolean {
  const expectedFiles = new Map<string, { readonly content: Buffer; readonly mode: number }>(
    files.map((file) => [file.relativePath, {
      content: renderedContent(file, packageRoot),
      mode: file.executable ? 0o700 : 0o600,
    }]),
  );
  expectedFiles.set(READY_FILE, {
    content: readyContent(packageRoot, digest, files),
    mode: 0o600,
  });
  const expectedDirs = expectedDirectories(files);
  const observedFiles = new Set<string>();

  const visit = (dir: string, relativeDir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relativePath = relativeDir === "" ? entry.name : join(relativeDir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if ((stat.mode & 0o777) !== 0o700) return false;
        if (!expectedDirs.has(relativePath) || !visit(path, relativePath)) return false;
        continue;
      }
      if (!stat.isFile()) return false;
      const expected = expectedFiles.get(relativePath);
      if (!expected || (stat.mode & 0o777) !== expected.mode || !readFileSync(path).equals(expected.content)) return false;
      observedFiles.add(relativePath);
    }
    return true;
  };

  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700 || !visit(root, "")) return false;
  return observedFiles.size === expectedFiles.size
    && [...expectedFiles.keys()].every((path) => observedFiles.has(path));
}

export type ResourceReadiness =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "not-ready" }>
  | Readonly<{ kind: "error"; message: string }>;

export function classifyResourceReadinessError(error: unknown, root: string): ResourceReadiness {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "ENOENT") return { kind: "not-ready" };
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: "error", message: `cannot inspect Loom Pi resource cache ${root}: ${detail}` };
}

function resourceReadiness(
  root: string,
  packageRoot: string,
  digest: string,
  files: readonly SourceFile[],
): ResourceReadiness {
  try {
    return isReadyUnchecked(root, packageRoot, digest, files)
      ? { kind: "ready" }
      : { kind: "not-ready" };
  } catch (error) {
    return classifyResourceReadinessError(error, root);
  }
}

function isReady(root: string, packageRoot: string, digest: string, files: readonly SourceFile[]): boolean {
  const readiness = resourceReadiness(root, packageRoot, digest, files);
  if (readiness.kind === "error") throw new Error(readiness.message);
  return readiness.kind === "ready";
}

function writeRenderedTree(
  stage: string,
  packageRoot: string,
  files: readonly SourceFile[],
  digest: string,
): void {
  for (const file of files) {
    const destination = join(stage, file.relativePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, renderedContent(file, packageRoot), {
      mode: file.executable ? 0o700 : 0o600,
      flag: "wx",
    });
  }
  writeFileSync(join(stage, READY_FILE), readyContent(packageRoot, digest, files), {
    mode: 0o600,
    flag: "wx",
  });
}

function directoryEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function quarantineInvalidRoot(root: string, cacheRoot: string): void {
  if (!directoryEntryExists(root)) return;
  const quarantine = join(
    cacheRoot,
    `.corrupt-${process.pid}-${quarantineOrdinal++}`,
  );
  try {
    renameSync(root, quarantine);
  } catch (error) {
    // Interpret the rename result itself. A later exists check races with a
    // sibling publishing a replacement under the same name.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(quarantine, { recursive: true, force: true });
}

function publishRenderedTree(
  stage: string,
  root: string,
  cacheRoot: string,
  packageRoot: string,
  digest: string,
  files: readonly SourceFile[],
): void {
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    if (isReady(root, packageRoot, digest, files)) return;
    quarantineInvalidRoot(root, cacheRoot);
    try {
      renameSync(stage, root);
    } catch (error) {
      if (!directoryEntryExists(root)) throw error;
      continue;
    }
    if (isReady(root, packageRoot, digest, files)) return;
  }
  throw new Error(`Loom Pi resource cache could not be published after ${PUBLISH_ATTEMPTS} attempts: ${root}`);
}

/** Materialize immutable, content-addressed Pi resources for one Loom package. */
export function materializePiResources(rawPackageRoot: string, rawCacheRoot: string): PiResourcePaths {
  const packageRoot = resolve(rawPackageRoot);
  const cacheRoot = resolve(rawCacheRoot);
  const files = sourceFiles(packageRoot);
  const digest = resourceDigest(packageRoot, files);
  const root = join(cacheRoot, digest);

  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const cacheStat = lstatSync(cacheRoot);
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
    throw new Error(`Loom Pi resource cache root must be a regular directory: ${cacheRoot}`);
  }

  if (!isReady(root, packageRoot, digest, files)) {
    const stage = mkdtempSync(join(cacheRoot, ".stage-"));
    try {
      writeRenderedTree(stage, packageRoot, files, digest);
      publishRenderedTree(stage, root, cacheRoot, packageRoot, digest, files);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  if (!isReady(root, packageRoot, digest, files)) {
    throw new Error(`Loom Pi resource cache failed integrity check: ${root}`);
  }

  const promptPaths = Object.freeze([join(root, "commands")]);
  const skillPaths = Object.freeze([
    join(root, "skills"),
    join(root, "commands", "vercel-react-best-practices"),
  ]);
  return Object.freeze({ root, promptPaths, skillPaths });
}
