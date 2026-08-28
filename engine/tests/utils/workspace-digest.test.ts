import { execFileSync } from "node:child_process";
import {
  realpathSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewPath, type ReviewPath } from "../../src/core/review-packet";
import {
  digestObservedWorkspaceEntries,
  observeWorkspaceDigest,
  resolveCanonicalGitRepositoryRoot,
  type ObservedWorkspaceEntry,
} from "../../src/utils/workspace-digest";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

function write(root: string, path: string, bytes: string): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
}

function repository(): string {
  const root = canonicalTempDir("loom-workspace-digest-");
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "loom-tests@example.invalid");
  git(root, "config", "user.name", "Loom Tests");
  return root;
}

function commitAll(root: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
}

function digest(root: string, completionReportPaths: readonly string[] = []): string {
  const observed = observeWorkspaceDigest(root, { completionReportPaths });
  if (!observed.ok) throw new Error(`${observed.error.kind}: ${"message" in observed.error ? observed.error.message : "drift"}`);
  return observed.value.digest;
}

function reviewPath(raw: string): ReviewPath {
  const parsed = parseReviewPath(raw, "workspace digest test path");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}

function observeWithDriftingGit(root: string, drift: "list" | "file") {
  const bin = canonicalTempDir("loom-fake-git-");
  roots.push(bin);
  const executable = join(bin, "git");
  const counter = join(bin, "list-count");
  writeFileSync(executable, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const root = ${JSON.stringify(root)};
const counter = ${JSON.stringify(counter)};
const operation = args.at(-2) === "rev-parse" ? "resolve" : args.includes("ls-files") ? "list" : "unknown";
if (operation === "resolve") {
  process.stdout.write(root + "\\n");
  process.exit(0);
}
if (operation !== "list") process.exit(64);
let count = 0;
try {
  count = Number(readFileSync(counter, "utf8"));
} catch (cause) {
  if (cause?.code !== "ENOENT") throw new Error(\`cannot read fake Git counter ${counter}\`, { cause });
}
count += 1;
writeFileSync(counter, String(count));
if (count === 2 && ${JSON.stringify(drift)} === "file") {
  writeFileSync(root + "/tracked.txt", "changed-during-second-list");
}
const paths = count === 2 && ${JSON.stringify(drift)} === "list"
  ? ["tracked.txt", "added.txt"]
  : ["tracked.txt"];
process.stdout.write(Buffer.from(paths.join("\\0") + "\\0"));
`);
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    return observeWorkspaceDigest(root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace digest shell", () => {
  it("includes tracked and non-ignored untracked bytes", () => {
    const root = repository();
    write(root, "tracked.txt", "tracked-v1");
    commitAll(root);
    write(root, "untracked.txt", "untracked-v1");

    const baseline = digest(root);
    write(root, "tracked.txt", "tracked-v2");
    const trackedChanged = digest(root);
    write(root, "untracked.txt", "untracked-v2");
    const untrackedChanged = digest(root);

    expect(trackedChanged).not.toBe(baseline);
    expect(untrackedChanged).not.toBe(trackedChanged);
    const canonical = resolveCanonicalGitRepositoryRoot(join(root, "nested", ".."));
    expect(canonical).toMatchObject({ ok: true, value: root });
  });

  it("excludes ignored files, Git internals, TaskGraph state, Run Directory artifacts, and reports", () => {
    const root = repository();
    write(root, ".gitignore", "ignored.log\n");
    write(root, "source.ts", "export const value = 1;\n");
    write(root, ".claude/state/active_task_graph.json", "state-1");
    write(root, ".pi/state/active_task_graph.json", "pi-state-1");
    write(root, ".claude/reviews/run.example/result.json", "review-1");
    write(root, ".loom/completion-reports/completion.json", "report-1");
    commitAll(root);
    write(root, "ignored.log", "ignored-1");

    const baseline = digest(root, [".loom/completion-reports/completion.json"]);
    write(root, "ignored.log", "ignored-2");
    write(root, ".claude/state/active_task_graph.json", "state-2");
    write(root, ".pi/state/active_task_graph.json", "pi-state-2");
    write(root, ".claude/reviews/run.example/result.json", "review-2");
    write(root, ".loom/completion-reports/completion.json", "report-2");
    write(root, ".git/loom-volatile", "git-internal");

    expect(digest(root, [".loom/completion-reports/completion.json"])).toBe(baseline);
  });

  it("changes for byte, path, executable-mode, and symlink-target observations", () => {
    const root = repository();
    write(root, "file.txt", "one");
    write(root, "target-a.txt", "same-target-bytes");
    write(root, "target-b.txt", "same-target-bytes");
    symlinkSync("target-a.txt", join(root, "link.txt"));
    commitAll(root);

    const baseline = digest(root);
    write(root, "file.txt", "two");
    const bytesChanged = digest(root);
    write(root, "file.txt", "one");
    renameSync(join(root, "file.txt"), join(root, "renamed.txt"));
    const pathChanged = digest(root);
    renameSync(join(root, "renamed.txt"), join(root, "file.txt"));
    chmodSync(join(root, "file.txt"), 0o755);
    const modeChanged = digest(root);
    chmodSync(join(root, "file.txt"), 0o644);
    unlinkSync(join(root, "link.txt"));
    symlinkSync("target-b.txt", join(root, "link.txt"));
    const symlinkChanged = digest(root);

    expect(new Set([baseline, bytesChanged, pathChanged, modeChanged, symlinkChanged]).size).toBe(5);
  });

  it.each([
    ["list", "workspace-list-drift"],
    ["file", "workspace-file-drift"],
  ] as const)("returns typed %s drift without minting a digest", (drift, expectedKind) => {
    const root = repository();
    write(root, "tracked.txt", "stable-before-observation");
    write(root, "added.txt", "appears-only-in-the-second-list");

    const observed = observeWithDriftingGit(root, drift);

    expect(observed).toMatchObject({ ok: false, error: { kind: expectedKind } });
  });

  it("returns typed Git and read failures rather than an empty workspace", () => {
    const outside = canonicalTempDir("loom-not-git-");
    roots.push(outside);
    expect(observeWorkspaceDigest(outside)).toMatchObject({
      ok: false,
      error: { kind: "git-command-failed", operation: "resolve-root" },
    });

    const root = repository();
    write(root, "tracked.txt", "bytes");
    commitAll(root);
    unlinkSync(join(root, "tracked.txt"));
    execFileSync("mkfifo", [join(root, "tracked.txt")]);
    expect(observeWorkspaceDigest(root)).toMatchObject({
      ok: false,
      error: { kind: "workspace-read-failed", path: "tracked.txt" },
    });
  });
});

describe("pure observed-entry digest", () => {
  it("is ordering-independent and binds path, lstat mode/type, and exact bytes", () => {
    const entry = (
      path: ReviewPath,
      mode: bigint,
      type: ObservedWorkspaceEntry["type"],
      bytes: readonly number[],
    ): ObservedWorkspaceEntry => ({ path, mode, type, bytes: Uint8Array.from(bytes) });
    const left = entry(reviewPath("a"), 0o100644n, "regular-file", [0, 255]);
    const right = entry(reviewPath("b"), 0o120777n, "symbolic-link", [0x61]);
    const baseline = digestObservedWorkspaceEntries([left, right]);

    expect(digestObservedWorkspaceEntries([right, left])).toBe(baseline);
    for (const changed of [
      [entry(reviewPath("c"), left.mode, left.type, [...left.bytes]), right],
      [entry(left.path, 0o100755n, left.type, [...left.bytes]), right],
      [entry(left.path, left.mode, "symbolic-link", [...left.bytes]), right],
      [entry(left.path, left.mode, left.type, [0, 254]), right],
    ] as const) {
      expect(digestObservedWorkspaceEntries(changed)).not.toBe(baseline);
    }
  });
});
