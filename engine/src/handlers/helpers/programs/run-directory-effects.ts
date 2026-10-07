/**
 * The effect runner for effects a Run Directory serves ENTIRELY on its own:
 * request reservation and raw transcript capture.
 *
 * All three outside ports are unreachable by construction: an operation routed
 * here that reaches for git or protected wave state is a routing bug, and it
 * fails loudly rather than being served. The façade's transcript capture and
 * the legacy panel driver's request reservation share this one runner, so a
 * change to what "unreachable" means here reaches both run-directory-only
 * paths.
 */
import { createEffectRunner } from "../../../orchestration/effect-runner";
import type { RunDirHandle } from "../../../orchestration/run-directory-handle";

export const runDirectoryEffectRunner = (handle: RunDirHandle) => {
  const unreachablePort = async (): Promise<never> => {
    throw new Error("effect port is unreachable for this run-directory operation");
  };
  return createEffectRunner({
    handle,
    ports: {
      commitProtectedWaveState: unreachablePort,
      inspectGitRemediation: unreachablePort,
      installVerifiedIndex: unreachablePort,
    },
    resolveArtifacts: () => [],
  });
};
