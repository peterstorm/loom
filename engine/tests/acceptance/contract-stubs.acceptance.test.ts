/**
 * CT-3 acceptance: the engine writes the contract stubs at the contract Task's
 * stop (plan AD-9), through `runDispatch` — the Claude Code SubagentStop shell —
 * before the stop checks run.
 *
 * The fixture starts in the contract Wave: CT-1's contract Task T1 is
 * registered through `registerTaskExecutionBatch`, its agent writes the
 * contract's types file and acceptance test, and the agent stops. The
 * dispatcher resolves the attempt through the published sidecar. Its stop
 * check ports record whether the stubs already existed when the check first
 * reached for the repository. Afterwards the contract Wave is frozen and Wave 2
 * starts, so the stub is seen at its owning Wave.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { UNKEPT_BLOCK_COUNTERS, type StopCheckShellPorts } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { publishImplementationAttemptSidecar } from "../../src/implementation-attempt-sidecar";
import type { ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import {
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  contractViolations,
  PATHS,
  recordedOutcomes,
  recordedSkeletons,
  settleAttempt,
  sha256,
  skeletonRepo,
  spawnFor,
  subjectAndReason,
  TS_TYPES_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

afterEach(cleanupSkeletonRepos);

const SESSION = "contract-stub-session";
const AGENT = "contract-stub-agent";

/** CT-1's bound files that have a skeleton language. */
const CT1_STUBS = [PATHS.tsPricing, PATHS.tsQuotes, PATHS.tsLegacy] as const;

async function registered(repo: SkeletonRepo, taskId: string): Promise<ImplementationAttemptAuthority> {
  const outcome = await registerTaskExecutionBatch([spawnFor(repo.rawState(), taskId)]);
  if (outcome.kind !== "registered") throw new Error(`registration refused: ${outcome.message}`);
  const [authority] = outcome.authorities;
  if (authority === undefined) throw new Error(`no authority for ${taskId}`);
  return authority;
}

type StopObservation = { checkReachedRepository: boolean; stubsAtCheck: Readonly<Record<string, boolean>> | null };

/** Ports that never decide, but record which stubs existed when the stop
 *  check first reached for the repository root. */
function observingPorts(repo: SkeletonRepo, observation: StopObservation): StopCheckShellPorts {
  return {
    repositoryRoot: () => {
      if (!observation.checkReachedRepository) {
        observation.checkReachedRepository = true;
        observation.stubsAtCheck = Object.fromEntries(CT1_STUBS.map((path) => [path, existsSync(join(repo.root, path))]));
      }
      return { ok: false, reason: "the fixture's stop check does not decide" };
    },
    acquireRunner: () => ({ kind: "acquired", release: () => null }),
    runCheck: async () => { throw new Error("the fixture's stop check never runs a check"); },
    readReport: () => new Uint8Array(),
    blocks: UNKEPT_BLOCK_COUNTERS,
    pathExists: () => true,
    now: () => Date.now(),
  };
}

/** Register T1 in the contract Wave, let its agent write the contract's
 *  frozen sources, and stop it through the SubagentStop dispatcher. */
async function stopContractTask(repo: SkeletonRepo): Promise<StopObservation> {
  const authority = await registered(repo, "T1");
  repo.writeContractSources();
  publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: repo.statePath, authority });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), repo.statePath);
  const observation: StopObservation = { checkReachedRepository: false, stubsAtCheck: null };
  const stdin = JSON.stringify({ session_id: SESSION, agent_id: AGENT, agent_type: "code-implementer-agent", hook_event_name: "SubagentStop" });
  await runDispatch(stdin, [], async () => ({ kind: "passthrough" }), observingPorts(repo, observation));
  return observation;
}

describe("contract stubs at the contract Task's stop (CT-3)", () => {
  it("FR-023: the contract Task's stop writes every bound stub of its contract in the skeleton format, and records it, without the contract Task writing it", async () => {
    const repo = skeletonRepo({ stage: "contract-wave" });
    for (const path of CT1_STUBS) expect(repo.read(path), path).toBeNull();

    await stopContractTask(repo);

    for (const path of CT1_STUBS) expect(repo.read(path), path).toBe(canonicalSkeletonOf(path));
    // No skeleton language, no stub.
    expect(repo.read(PATHS.pythonRates)).toBeNull();
    const records = recordedSkeletons(repo.rawState());
    for (const path of CT1_STUBS) {
      expect(records.get(path), path).toEqual({
        path,
        contract: "CT-1",
        language: "typescript",
        origin: "contract-stub",
        engineSha256: sha256(canonicalSkeletonOf(path)),
        typesSha256: sha256(TS_TYPES_TEXT),
        stale: null,
      });
    }
  });

  it("AS-043: every stub exists in the US3 skeleton format before the stop's acceptance check runs", async () => {
    const repo = skeletonRepo({ stage: "contract-wave" });

    const observation = await stopContractTask(repo);

    expect(observation.checkReachedRepository).toBe(true);
    expect(observation.stubsAtCheck).toEqual(Object.fromEntries(CT1_STUBS.map((path) => [path, true])));
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
  });

  it("AS-044: a contract stub is a skeleton at the Wave that owns it: recorded as a written contract stub, never rewritten, and judged at completion", async () => {
    const repo = skeletonRepo({ stage: "contract-wave" });
    await stopContractTask(repo);
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));

    // The contract Wave's gate freezes CT-1 (its frozen paths are unchanged:
    // only the types file and the acceptance test), and Wave 2 starts.
    repo.advanceToImplementationWave();
    const attempt = await registered(repo, "T4");

    const stored = repo.rawState();
    const outcomes = recordedOutcomes(stored, "T4");
    expect(outcomes.get(PATHS.tsPricing)).toEqual({ kind: "skeleton-written", origin: "contract-stub" });
    expect(outcomes.get(PATHS.tsLegacy)).toEqual({ kind: "skeleton-written", origin: "contract-stub" });
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(recordedSkeletons(stored).get(PATHS.tsPricing)).toMatchObject({ origin: "contract-stub" });

    // The completion checks of US5 apply to the untouched stub.
    await settleAttempt(repo, attempt, []);
    expect(contractViolations(repo.rawState(), "T4").get(PATHS.tsPricing)?.map(subjectAndReason)).toEqual(
      expect.arrayContaining(["priceOrder: still-unimplemented", "parseOrder: still-unimplemented"]),
    );
  });
});
