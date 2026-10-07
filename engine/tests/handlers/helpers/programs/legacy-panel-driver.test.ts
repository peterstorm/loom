/**
 * The legacy panel shell's three entry points — `driveRegisteredPanel`,
 * `submitRegisteredPanelAttempt` and `resumeRegisteredPanel` — at their own
 * interface, over a real Run Directory and no CLI: the façade calls exactly
 * these, so the driver loop, request materialization and the submission scan
 * are pinned where they live.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { parseRegisteredPanelProgram, type RegisteredPanelProgram } from "../../../../src/core/legacy-panel-decisions";
import {
  driveRegisteredPanel,
  resumeRegisteredPanel,
  submitRegisteredPanelAttempt,
} from "../../../../src/handlers/helpers/programs/legacy-panel";
import type { FacadeAction, FacadeDriveResult } from "../../../../src/handlers/helpers/programs/program-result";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true });
});

const input = { criticalFindingIds: ["T1:finding-1"], lenses: ["reproduction"] };
const verdict = JSON.stringify({
  criterion: "reproduction",
  verdicts: [{ finding_id: "T1:finding-1", verdict: "refuted", reasoning: "The current immutable packet does not exhibit the finding" }],
});

function registration(): RegisteredPanelProgram {
  const parsed = parseRegisteredPanelProgram({ schemaVersion: 1, kind: "refutation", input });
  if (parsed === null) throw new Error("fixture registration refused");
  return parsed;
}

async function registeredRun(name: string): Promise<Readonly<{ handle: RunDirHandle; runDir: string; program: RegisteredPanelProgram }>> {
  const root = canonicalTempDir("loom-legacy-panel-driver-");
  cleanup.push(root);
  const runsRoot = join(root, "runs");
  mkdirSync(runsRoot);
  const runDir = join(runsRoot, name);
  const created = createRunDirectory(runsRoot, runDir);
  if (!created.ok) throw new Error(created.error.message);
  const program = registration();
  const registered = await created.value.registerProgram(program);
  if (!registered.ok) throw new Error(registered.error.message);
  return { handle: created.value, runDir, program };
}

function action(result: FacadeDriveResult): FacadeAction {
  if (!result.ok) throw new Error(result.message);
  return result.action;
}

function spawned(result: FacadeDriveResult): readonly AgentRequestAuthority[] {
  const next = action(result);
  if (next.kind !== "spawn-batch") throw new Error(`expected a spawn batch, got ${next.kind}`);
  return next.requests.map(({ authority }) => authority);
}

async function capture(handle: RunDirHandle, request: AgentRequestAuthority, raw: string): Promise<void> {
  const captured = await handle.captureTranscript(request, [...Buffer.from(raw, "utf-8")]);
  if (!captured.ok) throw new Error(captured.error.message);
}

async function spawnOutcomes(handle: RunDirHandle): Promise<readonly unknown[]> {
  return (await handle.readEvents()).map(({ event }) => event).filter((event) => (event as { type?: string }).type === "spawn-outcome");
}

describe("driveRegisteredPanel", () => {
  it("runs the deterministic preparation internally and stops at the reserved verifier batch", async () => {
    const { handle, program } = await registeredRun("run.driver-start");
    const [request, ...rest] = spawned(await driveRegisteredPanel(handle, program));
    expect(rest).toEqual([]);
    expect(request).toMatchObject({ requestId: "refutation:verifier:1", attempt: 1, program: "refutation-panel", role: "review-verifier-agent" });
    const issued = handle.readIssuedRequests();
    expect(issued.ok && issued.value.map(({ requestId }) => requestId)).toEqual(["refutation:verifier:1"]);
    // Driving again re-emits the same pending request instead of reserving a second one.
    expect(spawned(await driveRegisteredPanel(handle, program)).map(({ requestId }) => requestId)).toEqual(["refutation:verifier:1"]);
  });
});

describe("submitRegisteredPanelAttempt", () => {
  it("settles an accepted verdict, records its outcome once, and drives the tally to done", async () => {
    const { handle, runDir, program } = await registeredRun("run.driver-submit");
    const [request] = spawned(await driveRegisteredPanel(handle, program));
    await capture(handle, request!, verdict);
    expect(action(await submitRegisteredPanelAttempt(handle, program, request!, verdict)).kind).toBe("done");
    expect(await spawnOutcomes(handle)).toEqual([{ type: "spawn-outcome", requestId: "refutation:verifier:1", attempt: 1, outcome: "succeeded" }]);
    const result = JSON.parse(readFileSync(join(runDir, "artifacts", "result.json"), "utf-8")) as { outcomes: readonly { finding_id: string; survives: boolean }[] };
    expect(result.outcomes).toMatchObject([{ finding_id: "T1:finding-1", survives: false }]);
  });

  it("records a refused attempt 1 and reserves exactly that slot's attempt 2", async () => {
    const { handle, program } = await registeredRun("run.driver-retry");
    const [request] = spawned(await driveRegisteredPanel(handle, program));
    await capture(handle, request!, "not json");
    const [retry, ...rest] = spawned(await submitRegisteredPanelAttempt(handle, program, request!, "not json"));
    expect(rest).toEqual([]);
    expect(retry).toMatchObject({ requestId: "refutation:verifier:1:attempt-2", slotId: request!.slotId, attempt: 2 });
    expect(await spawnOutcomes(handle)).toEqual([expect.objectContaining({ requestId: "refutation:verifier:1", attempt: 1, outcome: "failed" })]);
  });
});

describe("resumeRegisteredPanel", () => {
  it("settles a captured-but-unsettled attempt exactly once and is idempotent", async () => {
    const { handle, program } = await registeredRun("run.driver-resume");
    const [request] = spawned(await driveRegisteredPanel(handle, program));
    await capture(handle, request!, verdict);
    expect(action(await resumeRegisteredPanel(handle, program)).kind).toBe("done");
    expect(action(await resumeRegisteredPanel(handle, program)).kind).toBe("done");
    expect(await spawnOutcomes(handle)).toHaveLength(1);
  });

  it("re-emits the pending batch when nothing was captured", async () => {
    const { handle, program } = await registeredRun("run.driver-resume-pending");
    const [request] = spawned(await driveRegisteredPanel(handle, program));
    expect(spawned(await resumeRegisteredPanel(handle, program))).toEqual([request]);
    expect(await spawnOutcomes(handle)).toEqual([]);
  });
});
