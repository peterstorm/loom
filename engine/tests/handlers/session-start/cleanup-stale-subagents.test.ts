/**
 * Session-GROUP staleness for the SessionStart sweep: only `.machine` has
 * its mtime refreshed by refreshBindingActivity, so judging each file by
 * its OWN mtime would delete a live session's `.active` roster or
 * `.evidence.jsonl` ledger out from under it. A session's files are stale
 * only when the MAX mtime across the whole group exceeds the TTL.
 *
 * The fs test drives sweepStaleSessions against a temp dir directly —
 * SUBAGENT_DIR freezes at first config import, so the handler wrapper
 * cannot be re-pointed in a shared-process test run.
 */

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cleanup, {
  sessionOfEntry,
  staleEntries,
  sweepStaleSessions,
} from "../../../src/handlers/session-start/cleanup-stale-subagents";
import { SESSION_SUFFIXES } from "../../../src/machine";

const subDir = mkdtempSync(join(tmpdir(), "loom-sweep-"));

afterAll(() => {
  rmSync(subDir, { recursive: true, force: true });
});

describe("sessionOfEntry (pure)", () => {
  it("maps every per-session suffix (single-sourced SESSION_SUFFIXES) to its session id", () => {
    // Driven by the shared machine/evidence tuple — a suffix added to the
    // ledger's path helpers is automatically covered here.
    for (const suffix of SESSION_SUFFIXES) {
      expect(sessionOfEntry(`s-1${suffix}`), suffix).toBe("s-1");
      expect(sessionOfEntry(suffix), `bare ${suffix}`).toBeNull();
    }
  });

  it("returns null for unknown names", () => {
    expect(sessionOfEntry("random.txt")).toBeNull();
  });
});

describe("staleEntries (pure) — group max mtime governs", () => {
  const cutoff = 1_000_000;

  it("one fresh file keeps the WHOLE session group alive", () => {
    const mtimes = new Map([
      ["live.machine", cutoff + 500], // refreshed by refreshBindingActivity
      ["live.active", cutoff - 900_000], // old on its own mtime
      ["live.evidence.jsonl", cutoff - 900_000],
      ["live.cleanup", cutoff - 900_000],
    ]);
    expect(staleEntries(mtimes, cutoff)).toEqual([]);
  });

  it("a fully-idle group is stale in its entirety", () => {
    const mtimes = new Map([
      ["dead.machine", cutoff - 10],
      ["dead.active", cutoff - 900_000],
      ["dead.evidence.jsonl", cutoff - 900_000],
    ]);
    expect(staleEntries(mtimes, cutoff).sort()).toEqual([
      "dead.active",
      "dead.evidence.jsonl",
      "dead.machine",
    ]);
  });

  it("groups are independent, and ungrouped entries stand on their own mtime", () => {
    const mtimes = new Map([
      ["live.machine", cutoff + 1],
      ["live.active", cutoff - 5],
      ["dead.active", cutoff - 5],
      ["stray-old", cutoff - 5],
      ["stray-new", cutoff + 5],
    ]);
    expect(staleEntries(mtimes, cutoff).sort()).toEqual(["dead.active", "stray-old"]);
  });

  it("a file exactly at the cutoff is kept (strict less-than)", () => {
    expect(staleEntries(new Map([["s.machine", cutoff]]), cutoff)).toEqual([]);
  });
});

describe("sweepStaleSessions (fs)", () => {
  it("sweeps whole stale groups, spares live groups whose roster/ledger mtimes lag", () => {
    const old = new Date(Date.now() - 3_600_000);
    const oldms = (path: string) => utimesSync(path, old, old);

    // Live session: .machine fresh (activity anchor), everything else old.
    for (const suffix of ["active", "evidence.jsonl"]) {
      const p = join(subDir, `live.${suffix}`);
      writeFileSync(p, "x\n");
      oldms(p);
    }
    writeFileSync(join(subDir, "live.machine"), "a-1\tcode-implementer-agent\t1\n"); // fresh mtime

    // Dead session: every file old, including the mkdir-lock directory.
    for (const suffix of ["machine", "active", "evidence.jsonl", "task_graph"]) {
      const p = join(subDir, `dead.${suffix}`);
      writeFileSync(p, "x\n");
      oldms(p);
    }
    mkdirSync(join(subDir, "dead.cleanup"));
    oldms(join(subDir, "dead.cleanup"));

    // Ungrouped strays: judged individually.
    writeFileSync(join(subDir, "stray-old.txt"), "x\n");
    oldms(join(subDir, "stray-old.txt"));
    writeFileSync(join(subDir, "stray-new.txt"), "x\n");

    sweepStaleSessions(subDir, Date.now() - 1_800_000);

    // Live group survives ENTIRELY — the fresh .machine anchors the group.
    expect(existsSync(join(subDir, "live.machine"))).toBe(true);
    expect(existsSync(join(subDir, "live.active"))).toBe(true);
    expect(existsSync(join(subDir, "live.evidence.jsonl"))).toBe(true);

    // Dead group is gone ENTIRELY, lock dir included.
    for (const suffix of ["machine", "active", "evidence.jsonl", "task_graph", "cleanup"]) {
      expect(existsSync(join(subDir, `dead.${suffix}`)), `dead.${suffix} should be swept`).toBe(false);
    }

    // Strays: own mtime.
    expect(existsSync(join(subDir, "stray-old.txt"))).toBe(false);
    expect(existsSync(join(subDir, "stray-new.txt"))).toBe(true);
  });

  it("a missing dir is a no-op, and the handler wrapper passes through", async () => {
    expect(() => sweepStaleSessions(join(subDir, "nope"), Date.now())).not.toThrow();
    expect((await cleanup("", [])).kind).toBe("passthrough");
  });
});
