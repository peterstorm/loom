import { dirname, join, resolve } from "node:path";
import { taskGraphPath } from "../../config";
import {
  VERIFICATION_MANIFEST_SOURCE_PATH,
  parseVerificationManifest,
} from "../../core/verification-manifest";
import {
  ensureDirectoryNoFollow,
  readRunFileNoFollow,
  writeRunFileExclusiveNoFollow,
} from "../../orchestration/no-follow-fs";
import { StateManager } from "../../state-manager";
import type { HookHandler } from "../../types";

const MAX_SOURCE_BYTES = 1_048_576;
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

function parseSource(stdin: string):
  | Readonly<{ ok: true; canonical: string }>
  | Readonly<{ ok: false; error: string }> {
  if (Buffer.byteLength(stdin, "utf-8") > MAX_SOURCE_BYTES) {
    return { ok: false, error: `source exceeds ${MAX_SOURCE_BYTES} bytes` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch (cause) {
    return {
      ok: false,
      error: `source must be JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const parsed = parseVerificationManifest(raw);
  return parsed.ok
    ? { ok: true, canonical: `${JSON.stringify(parsed.value, null, 2)}\n` }
    : { ok: false, error: parsed.error.errors.join("; ") };
}

const handler: HookHandler = async (stdin) => {
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

  const source = parseSource(stdin);
  if (!source.ok) return { kind: "error", message: `Invalid verification manifest: ${source.error}` };
  const projectRoot = projectRootFromStatePath(statePath);
  if (!projectRoot.ok) return { kind: "error", message: projectRoot.error };

  const target = join(projectRoot.value, VERIFICATION_MANIFEST_SOURCE_PATH);
  try {
    ensureDirectoryNoFollow(dirname(target));
    try {
      writeRunFileExclusiveNoFollow(target, source.canonical);
      return { kind: "passthrough" };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const existing = readRunFileNoFollow(target);
      return existing === source.canonical
        ? { kind: "passthrough" }
        : {
            kind: "error",
            message: `${VERIFICATION_MANIFEST_SOURCE_PATH} already exists with different authority; refusing overwrite`,
          };
    }
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
