import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  TASK_GRAPH_LOCK_NAME,
  isEngineOwnedRuntimePath,
  isStateWriteCompanion,
} from "../../src/core/engine-runtime-paths";

const STATE = ".claude/state/active_task_graph.json";

const segment = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,11}$/u)
  .filter((s) => s !== "." && s !== "..");
const directory = fc.array(segment, { minLength: 0, maxLength: 3 }).map((parts) => parts.join("/"));
const join = (dir: string, leaf: string): string => (dir === "" ? leaf : `${dir}/${leaf}`);
const stateFile = fc.tuple(directory, segment).map(([dir, leaf]) => join(dir, leaf));
/** The `<pid>-<epoch ms>-<base36>` token the no-follow writers append to a staged leaf. */
const stagingToken = fc.tuple(fc.nat(), fc.nat(), fc.stringMatching(/^[0-9a-z]{0,10}$/u))
  .map(([pid, ms, random]) => `${pid}-${ms}-${random}`);

describe("State File write companions", () => {
  it("claims the lock and its recovery and tomb leaves beside the State File", () => {
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph", STATE)).toBe(true);
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph.recovery", STATE)).toBe(true);
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph.recovery.tomb-1-2-abc", STATE)).toBe(true);
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph.tomb-1-2-abc", STATE)).toBe(true);
  });

  it("claims the State File's own staging leaves", () => {
    expect(isEngineOwnedRuntimePath(`${STATE}.tmp-123-456-abcdefgh`, STATE)).toBe(true);
    expect(isEngineOwnedRuntimePath(`${STATE}.claim-123-456-abcdefgh`, STATE)).toBe(true);
  });

  it("claims nothing when no State File is inside the repository", () => {
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph", null)).toBe(false);
    expect(isEngineOwnedRuntimePath(STATE, null)).toBe(false);
  });

  it("never claims a lock-shaped leaf outside the State File's directory", () => {
    expect(isEngineOwnedRuntimePath(".task_graph", STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath("src/.task_graph", STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/state/nested/.task_graph", STATE)).toBe(false);
  });

  it("claims the recovery guard's prepared claim leaf", () => {
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph.recovery.claim-1-2-abc", STATE)).toBe(true);
  });

  it("never claims unrelated leaves beside the State File", () => {
    expect(isEngineOwnedRuntimePath(".claude/state/other.json", STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graphs", STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/state/active_task_graph.jsonx", STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath(".loom/completion-reports/affected.junit.xml", STATE)).toBe(false);
  });

  it("never claims a Task-chosen leaf that merely shares the lock's or the State File's prefix", () => {
    expect(isEngineOwnedRuntimePath(`${STATE}.bak`, STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath(`${STATE}.tmp-notes`, STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph.notes", STATE)).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/state/.task_graph.recovery.bak", STATE)).toBe(false);
  });

  it("the State File is never its own companion, but is always engine-owned", () => {
    fc.assert(fc.property(stateFile, (statePath) => {
      expect(isStateWriteCompanion(statePath, statePath)).toBe(false);
      expect(isEngineOwnedRuntimePath(statePath, statePath)).toBe(true);
    }));
  });

  it("every leaf the write boundary derives from the lock or the State File, beside it, is owned", () => {
    fc.assert(fc.property(stateFile, stagingToken, (statePath, token) => {
      const dir = statePath.includes("/") ? statePath.slice(0, statePath.lastIndexOf("/")) : "";
      const leaf = statePath.slice(statePath.lastIndexOf("/") + 1);
      for (const companion of [
        TASK_GRAPH_LOCK_NAME,
        `${TASK_GRAPH_LOCK_NAME}.tomb-${token}`,
        `${TASK_GRAPH_LOCK_NAME}.recovery`,
        `${TASK_GRAPH_LOCK_NAME}.recovery.claim-${token}`,
        `${TASK_GRAPH_LOCK_NAME}.recovery.tomb-${token}`,
        `${leaf}.tmp-${token}`,
        `${leaf}.claim-${token}`,
      ]) {
        expect(isEngineOwnedRuntimePath(join(dir, companion), statePath)).toBe(true);
      }
    }));
  });

  it("no leaf outside the write boundary's grammar is owned, even beside the State File", () => {
    fc.assert(fc.property(stateFile, segment, (statePath, suffix) => {
      fc.pre(!/^(?:tmp|claim)-[0-9]+-[0-9]+-[0-9a-z]*$/u.test(suffix));
      const dir = statePath.includes("/") ? statePath.slice(0, statePath.lastIndexOf("/")) : "";
      const leaf = statePath.slice(statePath.lastIndexOf("/") + 1);
      fc.pre(`${leaf}.${suffix}` !== TASK_GRAPH_LOCK_NAME && !`${leaf}.${suffix}`.startsWith(`${TASK_GRAPH_LOCK_NAME}.`));
      expect(isEngineOwnedRuntimePath(join(dir, `${leaf}.${suffix}`), statePath)).toBe(false);
    }));
  });

  it("no path in another directory is ever owned, whatever its leaf", () => {
    fc.assert(fc.property(stateFile, directory, segment, (statePath, otherDir, leaf) => {
      const stateDir = statePath.includes("/") ? statePath.slice(0, statePath.lastIndexOf("/")) : "";
      fc.pre(otherDir !== stateDir);
      expect(isEngineOwnedRuntimePath(join(otherDir, leaf), statePath)).toBe(false);
    }));
  });
});
