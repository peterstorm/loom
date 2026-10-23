/**
 * NFR-002: owner verification is harness-agnostic. Claude Code's and Pi's
 * Wave Gates produce the same verdict from the same workspace.
 *
 * Why this is one path, pinned structurally rather than run twice:
 * - Both harnesses run the one `/wave-gate` command text. Claude Code reads
 *   `commands/wave-gate.md`; Pi materializes the same `commands/` tree as its
 *   prompt path. That text starts the registered program through
 *   `helper orchestration start wave-gate`, which takes no harness argument.
 * - The registered program (`resumeWaveGateFacade`, programs/wave-gate.ts) is
 *   the only production caller of `ensureWaveCompletionSuite`, so the owner
 *   check has no harness-specific entry.
 * - The one input that does differ per harness is where the State File and
 *   the Wave Gate runs root live (`.claude/` or `.pi/`). The parity case runs
 *   the same stamped fixture under each layout through the production suite
 *   and requires the identical observation.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializePiResources } from "../../../pi/resources";
import { ensureWaveCompletionSuite } from "../../src/handlers/helpers/wave-completion-suite";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import {
  cleanupOwnerVerificationRepos,
  ownerVerificationRepo,
  type OwnerVerificationRepoOptions,
} from "../fixtures/owner-verification-repo";

const GATE_TIMEOUT_MS = 90_000;
const START_WAVE_GATE = "helper orchestration start wave-gate";

const temporary: string[] = [];
afterEach(() => {
  cleanupOwnerVerificationRepos();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Every TypeScript source file beneath a package-relative directory. */
function sources(directory: string): readonly string[] {
  return readdirSync(join(LOOM_PACKAGE_ROOT, directory)).flatMap((entry) => {
    const path = `${directory}/${entry}`;
    if (statSync(join(LOOM_PACKAGE_ROOT, path)).isDirectory()) return entry === "node_modules" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** The gate's owner-verification observation and acceptance for one layout of the same stamped fixture. */
async function ownerVerdictUnder(layout: "claude" | "pi", options: Omit<OwnerVerificationRepoOptions, "layout">) {
  const repo = ownerVerificationRepo({ ...options, layout });
  expect(relative(repo.root, repo.manager.getPath())).toBe(`.${layout}/state/active_task_graph.json`);
  const gate = await ensureWaveCompletionSuite({
    handle: repo.handle,
    manager: repo.manager,
    graph: repo.manager.load(),
    registration: repo.registration,
  });
  const observations = repo.publishedResults().map((result) => result.ownerVerification).filter((entry) => entry !== undefined);
  return { accepted: gate.ok, observations, launches: repo.runnerLaunches().length };
}

describe("NFR-002: one owner-verification verdict for both harnesses", () => {
  it("NFR-002: both harnesses' /wave-gate start the one registered program, the only production caller of the completion suite", () => {
    const callers = [...sources("engine/src"), ...sources("pi")].filter((path) =>
      path !== "engine/src/handlers/helpers/wave-completion-suite.ts" &&
      /\bensureWaveCompletionSuite\s*\(/.test(readFileSync(join(LOOM_PACKAGE_ROOT, path), "utf8")));
    expect(callers).toEqual(["engine/src/handlers/helpers/programs/wave-gate.ts"]);

    const claudeCommand = readFileSync(join(LOOM_PACKAGE_ROOT, "commands", "wave-gate.md"), "utf8");
    expect(claudeCommand).toContain(START_WAVE_GATE);
    const cache = mkdtempSync(join(tmpdir(), "loom-pi-parity-"));
    temporary.push(cache);
    const pi = materializePiResources(LOOM_PACKAGE_ROOT, cache);
    const piCommand = readFileSync(join(pi.promptPaths[0]!, "wave-gate.md"), "utf8");
    expect(piCommand).toContain(START_WAVE_GATE);
    const invocation = (text: string) => text.split("\n").filter((line) => line.includes(START_WAVE_GATE));
    expect(invocation(piCommand)).toEqual(invocation(claudeCommand));
  });

  it("NFR-002: a stamped Wave yields the identical owner-verification observation under the Claude and the Pi state layout", async () => {
    const options = { waveChanges: "owner", matrixTest: "vacuous" } as const;
    const claude = await ownerVerdictUnder("claude", options);
    const pi = await ownerVerdictUnder("pi", options);
    expect(claude.accepted).toBe(false);
    expect(claude.observations).toEqual([expect.objectContaining({
      kind: "verified",
      verdicts: [expect.objectContaining({ invariant: "INV-1", mutation: expect.objectContaining({ kind: "verified" }) })],
    })]);
    expect(pi).toEqual(claude);
  }, GATE_TIMEOUT_MS);
});
