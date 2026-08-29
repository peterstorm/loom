/**
 * Lock liveness at the anchored boundary.
 *
 * The State File lock and its recovery guard are mutual exclusion, not leases:
 * nothing expires them. Before the guard could be reclaimed, one SIGKILLed
 * recovery claimant poisoned the State File for every later process, and a lock
 * observed in the instant between creation and its owner token was treated as
 * corrupt rather than as a claim in flight. These are the two shapes that made
 * that permanent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAnchoredDirectory,
  listDirectoryNamesNoFollow,
  openDirectoryNoFollow,
  recoverStaleDirectoryLock,
  writeDirectoryFileExclusiveNoFollow,
  withAnchoredDirectoryHandleLock,
} from "../../src/orchestration/no-follow-fs";

/** A pid the kernel reports gone, so liveness is decided and not assumed. */
function deadPid(): number {
  for (let candidate = 4_194_303; candidate > 1_000_000; candidate -= 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no provably dead pid available on this host");
}

describe("anchored lock liveness", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-lock-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stands down from a lock whose owner token has not landed yet", async () => {
    // An empty lock is a claim in flight, never a stale lock: recovery stands
    // down instead of deleting it, and the lock survives to be released.
    const anchored = openDirectoryNoFollow(dir);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph", "");
      expect(recoverStaleDirectoryLock(anchored, ".task_graph")).toBe(false);
      expect(listDirectoryNamesNoFollow(anchored)).toContain(".task_graph");
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("reclaims a recovery guard whose claimant is provably gone", async () => {
    const anchored = openDirectoryNoFollow(dir);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph.recovery", `${deadPid()}:1:abandon`);
      expect(await withAnchoredDirectoryHandleLock(anchored, ".task_graph", () => "entered")).toBe("entered");
      expect(listDirectoryNamesNoFollow(anchored)).toEqual([]);
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });

  it("obeys a recovery guard whose claimant is still alive", async () => {
    const anchored = openDirectoryNoFollow(dir);
    try {
      writeDirectoryFileExclusiveNoFollow(anchored, ".task_graph.recovery", `${process.pid}:1:live`);
      await expect(withAnchoredDirectoryHandleLock(anchored, ".task_graph", () => "entered"))
        .rejects.toThrow("Could not acquire anchored lock");
      expect(readFileSync(join(dir, ".task_graph.recovery"), "utf-8")).toContain(String(process.pid));
    } finally {
      closeAnchoredDirectory(anchored);
    }
  });
});
