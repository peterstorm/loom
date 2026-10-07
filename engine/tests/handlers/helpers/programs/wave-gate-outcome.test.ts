import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredWaveGateProgram } from "../../../../src/core/wave-gate-program";
import { waveResumeContext } from "../../../../src/handlers/helpers/programs/wave-gate-outcome";
import { openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { StateManager } from "../../../../src/state-manager";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";

const RUN_ID = "run.wave-resume-context";
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): Readonly<{ handle: RunDirHandle; manager: StateManager }> {
  const root = canonicalTempDir("loom-wave-resume-context-");
  cleanup.push(root);
  const directory = join(root, RUN_ID);
  mkdirSync(directory, { recursive: true });
  const opened = openRunDirectory(root, directory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { handle: opened.value, manager: new StateManager(join(root, "active_task_graph.json")) };
}

const registration = (wave: number | null): RegisteredWaveGateProgram => ({
  schemaVersion: 1, kind: "wave-gate", input: { wave }, taskIds: ["T1"], authorityDigest: "a".repeat(64),
});

describe("waveResumeContext — the reducer's first phase", () => {
  it("settles a registration that lacks an exact Wave as the blocked outcome, building no context", () => {
    const { handle, manager } = fixture();
    expect(waveResumeContext(handle, manager, registration(null), new Set())).toEqual({
      kind: "settled",
      result: { ok: true, action: { kind: "blocked", runId: handle.runId,
        diagnostic: { kind: "wave-gate-blocked", message: "registered Wave Gate authority lacks an exact Wave" } } },
    });
  });

  it("proceeds with a frozen context whose wave is the registration's own exact Wave", () => {
    const { handle, manager } = fixture();
    const registered = registration(3);
    const captured = new Set(["slot:1"]);
    const phase = waveResumeContext(handle, manager, registered, captured);
    if (phase.kind !== "proceed") throw new Error(`expected proceed, got ${phase.kind}`);
    expect(phase.value).toMatchObject({ handle, manager, registration: registered, wave: 3, captured });
    expect(Object.isFrozen(phase.value)).toBe(true);
  });
});
