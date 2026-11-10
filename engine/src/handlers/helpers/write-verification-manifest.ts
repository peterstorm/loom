import { basename, dirname, join, resolve } from "node:path";
import { match } from "ts-pattern";
import { taskGraphPath } from "../../config";
import { VERIFICATION_MANIFEST_SOURCE_PATH } from "../../core/verification-manifest";
import {
  canonicalizeManifestSource,
  parseManifestInstallArgs,
  planManifestInstall,
  type CanonicalManifest,
} from "../../core/verification-manifest-install";
import {
  ensureDirectoryNoFollow,
  publishStagedRunFile,
  readRunFileNoFollow,
  removeRunFileNoFollow,
  writeRunFileExclusiveNoFollow,
} from "../../orchestration/no-follow-fs";
import { StateManager } from "../../state-manager";
import type { HookHandler, HookResult } from "../../types";

const CANONICAL_STATE_PATHS = Object.freeze([
  join(".claude", "state", "active_task_graph.json"),
  join(".pi", "state", "active_task_graph.json"),
]);

type ProjectRootResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; error: string }>;

function projectRootFromStatePath(statePath: string): ProjectRootResult {
  const absoluteStatePath = resolve(statePath);
  const projectRoot = dirname(dirname(dirname(absoluteStatePath)));
  return CANONICAL_STATE_PATHS.some(
    (relativeStatePath) => join(projectRoot, relativeStatePath) === absoluteStatePath,
  )
    ? { ok: true, value: projectRoot }
    : {
        ok: false,
        error:
          `cannot derive verification manifest target from non-canonical State File path ${statePath}; ` +
          "expected <root>/.claude/state/active_task_graph.json or <root>/.pi/state/active_task_graph.json",
      };
}

/** The installed manifest's text, or null when none exists. Never follows a link. */
function readInstalled(target: string): string | null {
  try {
    return readRunFileNoFollow(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/**
 * Replace the manifest atomically: stage the canonical bytes in a fresh
 * sibling, then rename it over the target inside the same anchored directory,
 * so a reader sees the old authority or the new one, never a partial file.
 */
function replaceAtomically(target: string, manifest: CanonicalManifest): void {
  const staged = join(dirname(target), `.${basename(target)}.replace-${process.pid}`);
  writeRunFileExclusiveNoFollow(staged, manifest);
  try {
    publishStagedRunFile(staged, target);
  } catch (cause) {
    try {
      removeRunFileNoFollow(staged);
    } catch {
      // Report the publish failure, not the cleanup's: a leftover staged
      // sibling is inert, since population reads only the target path.
    }
    throw cause;
  }
}

const handler: HookHandler = async (stdin, args): Promise<HookResult> => {
  const mode = parseManifestInstallArgs(args);
  if (!mode.ok) return { kind: "error", message: `write-verification-manifest: ${mode.error}` };

  const statePath = taskGraphPath();
  const manager = StateManager.fromPath(statePath);
  if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };

  let state;
  try {
    state = manager.load();
  } catch (cause) {
    return {
      kind: "error",
      message: `Cannot read task graph at ${statePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (state.tasks.length !== 0) {
    return {
      kind: "error",
      message: "Verification manifest authority is already frozen by task population; refusing mutation",
    };
  }

  const candidate = canonicalizeManifestSource(stdin);
  if (!candidate.ok) return { kind: "error", message: `Invalid verification manifest: ${candidate.error}` };
  const projectRoot = projectRootFromStatePath(statePath);
  if (!projectRoot.ok) return { kind: "error", message: projectRoot.error };

  const target = join(projectRoot.value, VERIFICATION_MANIFEST_SOURCE_PATH);
  try {
    ensureDirectoryNoFollow(dirname(target));
    const plan = planManifestInstall(
      readInstalled(target),
      candidate.value,
      mode.value,
      VERIFICATION_MANIFEST_SOURCE_PATH,
    );
    return match(plan)
      .with({ kind: "create" }, ({ manifest }): HookResult => {
        writeRunFileExclusiveNoFollow(target, manifest);
        return { kind: "passthrough" };
      })
      .with({ kind: "unchanged" }, (): HookResult => ({ kind: "passthrough" }))
      .with({ kind: "replace" }, ({ manifest }): HookResult => {
        replaceAtomically(target, manifest);
        return { kind: "passthrough" };
      })
      .with({ kind: "refuse" }, ({ reason }): HookResult => ({ kind: "error", message: reason }))
      .exhaustive();
  } catch (cause) {
    return {
      kind: "error",
      message:
        `Cannot install ${VERIFICATION_MANIFEST_SOURCE_PATH}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    };
  }
};

export default handler;
