/**
 * `helper suggest-affected-runner` (loom#198, Cause 3): print the
 * `affectedRunner` to declare in the Verification Manifest, detected from the
 * repository the command runs in (`core/runner-presets.ts`), or the generic
 * shape when no known runner is detected. Usage:
 *   bun cli.ts helper suggest-affected-runner [--preset <id>]
 *
 * Read-only: it reads `package.json` and checks for a Bun lockfile, and writes
 * nothing. `--preset` prints one preset's declaration as is.
 */

import type { HookHandler } from "../../types";
import { VERIFICATION_MANIFEST_SOURCE_PATH } from "../../core/verification-manifest";
import { affectedRunnerHint, affectedRunnerHintFor, RUNNER_PRESET_IDS, type RunnerPresetId } from "../../core/runner-presets";
import { observeRunnerFacts } from "../../utils/repository-runner-facts";
import { resolveCanonicalGitRepositoryRoot } from "../../utils/workspace-digest";
import { argumentValue, unconsumedValueArguments } from "./cli-args";

const FLAGS: ReadonlySet<string> = new Set(["--preset"]);

const isPresetId = (raw: string): raw is RunnerPresetId => (RUNNER_PRESET_IDS as readonly string[]).includes(raw);

export function createSuggestAffectedRunnerHandler(
  write: (text: string) => void = (text) => { process.stdout.write(text); },
  cwd: () => string = () => process.cwd(),
): HookHandler {
  return async (_stdin, args) => {
    const unconsumed = unconsumedValueArguments(args, FLAGS);
    if (unconsumed.length > 0) return { kind: "error", message: `suggest-affected-runner: unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
    const preset = argumentValue(args, "--preset");
    if (preset !== null) {
      if (!isPresetId(preset)) return { kind: "error", message: `suggest-affected-runner: unknown preset ${preset}; one of ${RUNNER_PRESET_IDS.join(", ")}` };
      write(`${affectedRunnerHint({ preset, because: "--preset" }, VERIFICATION_MANIFEST_SOURCE_PATH)}\n`);
      return { kind: "passthrough" };
    }
    const root = resolveCanonicalGitRepositoryRoot(cwd());
    if (!root.ok) return { kind: "error", message: "suggest-affected-runner: run it inside the project's Git repository" };
    write(`${affectedRunnerHintFor(observeRunnerFacts(root.value), VERIFICATION_MANIFEST_SOURCE_PATH)}\n`);
    return { kind: "passthrough" };
  };
}

export default createSuggestAffectedRunnerHandler();
