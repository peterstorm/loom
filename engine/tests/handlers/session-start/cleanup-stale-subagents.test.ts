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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  isDeadStatFailure,
  runCleanupStaleSubagents,
  sessionOfEntry,
  staleEntries,
  sweepStaleSessions,
} from "../../../src/handlers/session-start/cleanup-stale-subagents";
import {
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  SESSION_SUFFIXES,
  TASK_GRAPH_POINTER_BINDING_SUFFIX,
} from "../../../src/machine";
import { disposeFixturePiSessions, fixturePiEnvironment } from "../../fixtures/pi-session";

const subDir = mkdtempSync(join(tmpdir(), "loom-sweep-"));

afterAll(() => {
  disposeFixturePiSessions();
  rmSync(subDir, { recursive: true, force: true });
});

describe("sessionOfEntry (pure)", () => {
  it("maps every per-session suffix (single-sourced SESSION_SUFFIXES) to its session id", () => {
    // Driven by the shared machine/evidence tuple — a suffix added to the
    // ledger's path helpers is automatically covered here.
    for (const suffix of SESSION_SUFFIXES) {
      const entry = suffix === IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX || suffix === TASK_GRAPH_POINTER_BINDING_SUFFIX
        ? `s-1.${Buffer.from("agent-1").toString("hex")}${suffix}`
        : `s-1${suffix}`;
      expect(sessionOfEntry(entry), suffix).toBe("s-1");
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

  it("a fresh machine anchor keeps an older implementation sidecar alive", () => {
    const sidecar = `live.${Buffer.from("agent-1").toString("hex")}${IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX}`;
    const mtimes = new Map([
      ["live.machine", cutoff + 1],
      [sidecar, cutoff - 900_000],
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

  it("an unobservable member protects every readable member of its session", () => {
    const mtimes = new Map([
      ["uncertain.machine", cutoff - 10],
      ["dead.machine", cutoff - 10],
    ]);
    expect(staleEntries(mtimes, cutoff, new Set(["uncertain"]))).toEqual(["dead.machine"]);
  });
});

describe("isDeadStatFailure (pure)", () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it("classifies provably-dead link errors as dead", () => {
    expect(isDeadStatFailure(errno("ELOOP"))).toBe(true);
    expect(isDeadStatFailure(errno("ENOENT"))).toBe(true);
    expect(isDeadStatFailure(errno("ENOTDIR"))).toBe(true);
  });

  it("classifies potentially-transient failures as unreadable, not dead", () => {
    expect(isDeadStatFailure(errno("EACCES"))).toBe(false);
    expect(isDeadStatFailure(errno("EPERM"))).toBe(false);
    expect(isDeadStatFailure(errno("EIO"))).toBe(false);
  });

  it("is false for non-errno errors", () => {
    expect(isDeadStatFailure(new Error("EACCES stat"))).toBe(false);
    expect(isDeadStatFailure("string error")).toBe(false);
    expect(isDeadStatFailure(undefined)).toBe(false);
  });
});

describe("sweepStaleSessions (fs)", () => {
  it("sweeps whole stale groups, spares live groups whose roster/ledger mtimes lag", () => {
    const old = new Date(Date.now() - 3_600_000);
    const oldms = (path: string) => utimesSync(path, old, old);

    // Live session: .machine fresh (activity anchor), everything else old.
    for (const suffix of ["active", "evidence.jsonl", "task-graph-pointer-leases.json"]) {
      const p = join(subDir, `live.${suffix}`);
      writeFileSync(p, "x\n");
      oldms(p);
    }
    writeFileSync(join(subDir, "live.machine"), "a-1\tcode-implementer-agent\t1\n"); // fresh mtime

    // Dead session: every file old, including the mkdir-lock directory.
    for (const suffix of ["machine", "active", "evidence.jsonl", "task_graph", "task-graph-pointer-leases.json", "callstart.json"]) {
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
    expect(existsSync(join(subDir, "live.task-graph-pointer-leases.json"))).toBe(true);

    // Dead group is gone ENTIRELY, lock dir included.
    for (const suffix of ["machine", "active", "evidence.jsonl", "task_graph", "task-graph-pointer-leases.json", "callstart.json", "cleanup"]) {
      expect(existsSync(join(subDir, `dead.${suffix}`)), `dead.${suffix} should be swept`).toBe(false);
    }

    // Strays: own mtime.
    expect(existsSync(join(subDir, "stray-old.txt"))).toBe(false);
    expect(existsSync(join(subDir, "stray-new.txt"))).toBe(true);
  });

  it("a stat failure protects readable siblings in the same session while unrelated stale sessions are swept", () => {
    const removed: string[] = [];
    const diagnostics = sweepStaleSessions("/tracking", 100, {
      probeDirectory: () => ({
        kind: "present",
        entries: ["uncertain.active", "uncertain.machine", "dead.active"],
      }),
      mtime: (path) => {
        if (path.endsWith("uncertain.active")) throw new Error("EACCES stat");
        return 10;
      },
      remove: (path) => { removed.push(path); },
    });

    expect(removed).toEqual([join("/tracking", "dead.active")]);
    expect(diagnostics).toEqual([{
      operation: "stat",
      path: join("/tracking", "uncertain.active"),
      cause: "EACCES stat",
    }]);
  });

  it("removes provably-dead entries, surfacing only failed removals", () => {
    const removed: string[] = [];
    const diagnostics = sweepStaleSessions("/tracking", 100, {
      probeDirectory: () => ({
        kind: "present",
        entries: ["looped.active", "dangling.active", "stale.active"],
      }),
      mtime: (path) => {
        if (path.endsWith("looped.active")) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
        if (path.endsWith("dangling.active")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return 10;
      },
      remove: (path) => {
        removed.push(path);
        if (path.endsWith("dangling.active")) throw new Error("EROFS remove");
      },
    });

    // The dead entries were removed (no stat diagnostics for them) and the
    // normally-stale entry swept; only the failed removal surfaced.
    expect(removed.sort()).toEqual([
      join("/tracking", "dangling.active"),
      join("/tracking", "looped.active"),
      join("/tracking", "stale.active"),
    ]);
    expect(diagnostics).toEqual([{
      operation: "remove",
      path: join("/tracking", "dangling.active"),
      cause: "EROFS remove",
    }]);
  });

  it("returns stat and remove diagnostics with operation, exact path, and cause", () => {
    const removed: string[] = [];
    const diagnostics = sweepStaleSessions("/tracking", 100, {
      probeDirectory: () => ({ kind: "present", entries: ["unstatable.active", "stale.active"] }),
      mtime: (path) => {
        if (path.endsWith("unstatable.active")) throw new Error("EACCES stat");
        return 10;
      },
      remove: (path) => {
        removed.push(path);
        throw new Error("EROFS remove");
      },
    });

    expect(removed).toEqual([join("/tracking", "stale.active")]);
    expect(diagnostics).toEqual([
      {
        operation: "stat",
        path: join("/tracking", "unstatable.active"),
        cause: "EACCES stat",
      },
      {
        operation: "remove",
        path: join("/tracking", "stale.active"),
        cause: "EROFS remove",
      },
    ]);
  });

  it("distinguishes ENOENT absence from a directory probe failure", () => {
    expect(sweepStaleSessions("/missing", 100, {
      probeDirectory: () => ({ kind: "absent" }),
      mtime: () => { throw new Error("must not stat an absent directory"); },
      remove: () => { throw new Error("must not remove from an absent directory"); },
    })).toEqual([]);

    const diagnostics = sweepStaleSessions("/unreadable", 100, {
      probeDirectory: () => ({ kind: "unavailable", cause: "EACCES readdir" }),
      mtime: () => { throw new Error("must not stat an unreadable directory"); },
      remove: () => { throw new Error("must not remove from an unreadable directory"); },
    });
    expect(diagnostics).toEqual([{
      operation: "read-directory",
      path: "/unreadable",
      cause: "EACCES readdir",
    }]);
  });

  it("SessionStart heals dead symlink entries and surfaces transient stat failures", async () => {
    // SUBAGENT_DIR freezes at the first config import, so the ACTUAL default
    // handler runs in a fresh disposable child process whose LOOM_SUBAGENT_DIR
    // points at a private owned temp dir — never the real
    // /tmp/claude-subagents.
    const privateDir = mkdtempSync(join(tmpdir(), "loom-handler-"));
    const ambientDir = mkdtempSync(join(tmpdir(), "loom-handler-ambient-"));
    try {
      const staleSentinel = join(privateDir, "stale-sentinel.orchestration-runs.json");
      writeFileSync(staleSentinel, "x\n");
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(staleSentinel, old, old); // older than STALE_SUBAGENT_TTL_MS

      // Transient stat failure → EACCES via a no-exec path component (may be
      // live behind a permission issue): surfaced through systemMessage and
      // kept; only the entry-level stat error, never the link replaced.
      const noexecDir = join(privateDir, "noexec-dir");
      mkdirSync(noexecDir, { mode: 0o755 });
      writeFileSync(join(noexecDir, "target.json"), "x\n");
      const unreadable = join(privateDir, `cleanup-diagnostic-${process.pid}-${Date.now()}.active`);
      symlinkSync(join(noexecDir, "target.json"), unreadable);
      chmodSync(noexecDir, 0o000);

      // Broken self-referential symlink → ELOOP on stat: provably dead, so
      // the sweep must HEAL the directory (remove the link) silently instead
      // of re-reporting the same diagnostic at every session start.
      const looped = join(privateDir, `cleanup-dead-${process.pid}-${Date.now()}.active`);
      symlinkSync(looped, looped);

      // Unrelated owned ambient control directory: outside the child's
      // LOOM_SUBAGENT_DIR, so the actual handler must never touch it.
      const ambientSentinel = join(ambientDir, "stale-sentinel.orchestration-runs.json");
      writeFileSync(ambientSentinel, "x\n");
      utimesSync(ambientSentinel, old, old);

      const modulePath = fileURLToPath(
        new URL("../../../src/handlers/session-start/cleanup-stale-subagents", import.meta.url),
      );
      const childEnv = { ...fixturePiEnvironment(privateDir), LOOM_SUBAGENT_DIR: privateDir };
      const { stdout } = await promisify(execFile)("bun", [
        "-e",
        `import handler from ${JSON.stringify(modulePath)};\nconsole.log(JSON.stringify(await handler("", [])));`,
      ], { cwd: privateDir, env: childEnv, timeout: 15_000 });

      // Actual-run proof: the transient EACCES diagnostic surfaced while the
      // dead ELOOP entry healed WITHOUT a diagnostic.
      const result: { kind: string; systemMessage?: string } = JSON.parse(stdout);
      expect(result.kind).toBe("passthrough");
      expect(result.systemMessage).toContain(`cleanup-stale-subagents: stat failed for ${unreadable}`);
      expect(result.systemMessage).toMatch(/EACCES|permission denied/i);
      expect(result.systemMessage).not.toContain(looped);

      // The stale sentinel was swept in the SELECTED private dir.
      expect(existsSync(staleSentinel)).toBe(false);
      // The dead looped symlink was REMOVED (healed — not protected forever).
      expect(existsSync(looped)).toBe(false);
      // The transiently-unstatable link was preserved for human inspection.
      expect(lstatSync(unreadable).isSymbolicLink()).toBe(true);
      // The unrelated owned ambient control directory was preserved.
      expect(readFileSync(ambientSentinel, "utf8")).toBe("x\n");
    } finally {
      chmodSync(join(privateDir, "noexec-dir"), 0o755); // restore before recursive rm
      rmSync(privateDir, { recursive: true, force: true });
      rmSync(ambientDir, { recursive: true, force: true });
    }
  });

  it("a missing dir is a no-op, and a clean injected handler wrapper passes through without diagnostics", () => {
    expect(sweepStaleSessions(join(subDir, "nope"), Date.now())).toEqual([]);
    const cleanDir = join(subDir, "clean-wrapper");
    mkdirSync(cleanDir);
    const result = runCleanupStaleSubagents(cleanDir, Date.now());
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") expect(result.systemMessage).toBeUndefined();
  });
});
