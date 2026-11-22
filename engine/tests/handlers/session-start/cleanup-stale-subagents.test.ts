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
import * as fc from "fast-check";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  entriesWithinOpenRunGrace,
  isDeadStatFailure,
  runCleanupStaleSubagents,
  staleEntries,
  startingSessionOf,
  sweepCutoffs,
  sweepStaleSessions,
} from "../../../src/handlers/session-start/cleanup-stale-subagents";
import {
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  parseSessionId,
  STOP_CHECK_NOTE_SUFFIX,
  sessionGroupKey,
  sidecarKey,
  sessionGroupOfTrackingFile,
  SESSION_SUFFIXES,
  TASK_GRAPH_POINTER_BINDING_SUFFIX,
  type SessionId,
} from "../../../src/machine";
import { disposeFixturePiSessions, fixturePiEnvironment } from "../../fixtures/pi-session";
import { OPEN_RUN_GRACE_MS, PERSISTENT_SUBAGENT_DIR_ENTRIES, PERSISTENT_SUBAGENT_STORES } from "../../../src/config";
import type { BoundRunObservation } from "../../../src/orchestration/bound-run-liveness";
import { createRunDirectory } from "../../../src/orchestration/run-directory-handle";
import type { SessionRunBinding } from "../../../src/orchestration/session-run-bindings";

const subDir = mkdtempSync(join(tmpdir(), "loom-sweep-"));

/** Injected operations for a directory holding no readable TaskGraph pointer and binding no run. */
const NO_POINTERS = {
  readText: () => null,
  exists: () => false,
  observeBoundRun: (): BoundRunObservation => ({ kind: "absent" }),
} as const;

const session = (raw: string): SessionId => {
  const parsed = parseSessionId(raw);
  if (parsed === null) throw new Error(`fixture session id ${raw} is unsafe`);
  return parsed;
};

afterAll(() => {
  disposeFixturePiSessions();
  rmSync(subDir, { recursive: true, force: true });
});

describe("sessionGroupOfTrackingFile (pure)", () => {
  it("maps every per-session suffix (single-sourced SESSION_SUFFIXES) to its session group", () => {
    // Driven by the shared machine/evidence tuple — a suffix added to the
    // ledger's path helpers is automatically covered here.
    for (const suffix of SESSION_SUFFIXES) {
      const entry = suffix === IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX || suffix === TASK_GRAPH_POINTER_BINDING_SUFFIX
        ? `s-1.${Buffer.from("agent-1").toString("hex")}${suffix}`
        : `s-1${suffix}`;
      expect(sessionGroupOfTrackingFile(entry), suffix).toBe("s-1");
      expect(sessionGroupOfTrackingFile(suffix), `bare ${suffix}`).toBeNull();
    }
  });

  it("returns null for unknown names", () => {
    expect(sessionGroupOfTrackingFile("random.txt")).toBeNull();
  });

  it("groups a stop-check note sidecar with its session", () => {
    expect(sessionGroupOfTrackingFile(`s-1.aa5f1a5b83ae82b33${STOP_CHECK_NOTE_SUFFIX}`)).toBe("s-1");
    expect(sessionGroupOfTrackingFile(`s-1.${STOP_CHECK_NOTE_SUFFIX}`)).toBeNull();
    expect(sessionGroupOfTrackingFile(`.agent${STOP_CHECK_NOTE_SUFFIX}`)).toBeNull();
    expect(sessionGroupOfTrackingFile(STOP_CHECK_NOTE_SUFFIX)).toBeNull();
  });

  it("classifies every file of one session to ONE key, whatever its spelling", () => {
    const attempt = `s.1.${Buffer.from("agent-1").toString("hex")}${IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX}`;
    const note = `${sidecarKey("s.1")}.agent1${STOP_CHECK_NOTE_SUFFIX}`;
    const groups = ["s.1.evidence.jsonl", "s.1.machine", attempt, note].map(sessionGroupOfTrackingFile);
    expect(new Set(groups)).toEqual(new Set([sessionGroupKey("s.1")]));
    expect(sessionGroupKey("s.1")).toBe("s_1");
  });
});

describe("startingSessionOf (pure)", () => {
  it("reads a usable session_id from SessionStart input", () => {
    expect(startingSessionOf(JSON.stringify({ session_id: "2f935faa-edaa", source: "resume" })))
      .toEqual({ kind: "named", sessionId: "2f935faa-edaa" });
  });

  it("empty input names no session and is not a failure", () => {
    for (const stdin of ["", "  \n"]) expect(startingSessionOf(stdin)).toEqual({ kind: "absent" });
  });

  it("input that names no usable session is unusable, with its cause", () => {
    const cases: readonly (readonly [string, RegExp])[] = [
      ["not json", /not JSON/],
      ["null", /not a JSON object/],
      [JSON.stringify({}), /no string session_id/],
      [JSON.stringify({ session_id: 7 }), /no string session_id/],
      [JSON.stringify({ session_id: "../escape" }), /cannot name session files/],
      [JSON.stringify({ session_id: "" }), /cannot name session files/],
    ];
    for (const [stdin, cause] of cases) {
      const parsed = startingSessionOf(stdin);
      expect(parsed.kind, stdin).toBe("unusable");
      if (parsed.kind === "unusable") expect(parsed.cause, stdin).toMatch(cause);
    }
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
    expect(staleEntries(mtimes, cutoff, new Set([sessionGroupKey("uncertain")]))).toEqual(["dead.machine"]);
  });

  it("never sweeps a persistent store — the run registry and the capture attestations outlive every session", () => {
    const stores = Object.values(PERSISTENT_SUBAGENT_STORES).map(({ entry }) => entry);
    expect(stores.sort()).toEqual(["security-audit-runs", "security-capture-attestations"]);
    const mtimes = new Map([...stores.map((entry) => [entry, 0] as const), ["stray-old", 0]]);
    expect(staleEntries(mtimes, cutoff)).toEqual(["stray-old"]);
    expect([...PERSISTENT_SUBAGENT_DIR_ENTRIES].sort()).toEqual(stores);
  });
});

describe("sweepCutoffs and the open-run grace window (pure)", () => {
  const SESSIONS = ["s-a", "s-b", "s-c"] as const;
  const SUFFIXES = [".machine", ".evidence.jsonl", ".orchestration-runs.json"] as const;
  /** Tracking dirs of a few sessions plus ungrouped strays, at arbitrary mtimes. */
  const anyMtimes = fc.dictionary(
    fc.oneof(
      fc.tuple(fc.constantFrom(...SESSIONS), fc.constantFrom(...SUFFIXES)).map(([name, suffix]) => `${name}${suffix}`),
      fc.constantFrom("stray-a", "stray-b"),
    ),
    fc.integer({ min: 0, max: 1_000 }),
  ).map((record) => new Map(Object.entries(record)));
  const anyCutoffs = fc.tuple(fc.integer({ min: 0, max: 1_000 }), fc.integer({ min: 0, max: 1_000 }))
    .map(([idle, grace]) => sweepCutoffs(idle, grace));
  const anyProtected = fc.subarray([...SESSIONS]).map((names) => new Set(names.map(sessionGroupKey)));

  it("the open-run cutoff is the idle cutoff less the grace, the configured grace by default", () => {
    expect(sweepCutoffs(100, 30)).toMatchObject({ idleMs: 100, openRunMs: 70 });
    expect(sweepCutoffs(100)).toMatchObject({ idleMs: 100, openRunMs: 100 - OPEN_RUN_GRACE_MS });
  });

  it("refuses a grace that would put the open-run cutoff past the idle cutoff, or nowhere", () => {
    for (const grace of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sweepCutoffs(100, grace), String(grace)).toThrow(RangeError);
    }
  });

  it("an entry exactly at the open-run cutoff is inside the window; one exactly at the idle cutoff is outside", () => {
    const cutoffs = sweepCutoffs(100, 30);
    expect(entriesWithinOpenRunGrace(new Map([["s-a.machine", 70]]), cutoffs)).toEqual(["s-a.machine"]);
    expect(entriesWithinOpenRunGrace(new Map([["s-a.machine", 69]]), cutoffs)).toEqual([]);
    expect(entriesWithinOpenRunGrace(new Map([["s-a.machine", 100]]), cutoffs)).toEqual([]);
  });

  it("the window and the entries past the grace partition exactly what the idle cutoff would sweep", () => {
    fc.assert(fc.property(anyMtimes, anyCutoffs, anyProtected, (mtimes, cutoffs, protectedSessions) => {
      const window = entriesWithinOpenRunGrace(mtimes, cutoffs, protectedSessions);
      const pastGrace = staleEntries(mtimes, cutoffs.openRunMs, protectedSessions);
      expect(window.filter((entry) => pastGrace.includes(entry))).toEqual([]);
      expect([...window, ...pastGrace].sort()).toEqual(staleEntries(mtimes, cutoffs.idleMs, protectedSessions).sort());
    }));
  });

  it("never offers a protected session's registry for reading", () => {
    fc.assert(fc.property(anyMtimes, anyCutoffs, anyProtected, (mtimes, cutoffs, protectedSessions) => {
      for (const entry of entriesWithinOpenRunGrace(mtimes, cutoffs, protectedSessions)) {
        const session = sessionGroupOfTrackingFile(entry);
        expect(session === null || !protectedSessions.has(session), entry).toBe(true);
      }
    }));
  });

  it("with no grace, no registry is worth reading", () => {
    fc.assert(fc.property(anyMtimes, fc.integer({ min: 0, max: 1_000 }), (mtimes, idle) => {
      expect(entriesWithinOpenRunGrace(mtimes, sweepCutoffs(idle, 0))).toEqual([]);
    }));
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

    sweepStaleSessions(subDir, sweepCutoffs(Date.now() - 1_800_000));

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
    const diagnostics = sweepStaleSessions("/tracking", sweepCutoffs(100), {
      ...NO_POINTERS,
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
    const diagnostics = sweepStaleSessions("/tracking", sweepCutoffs(100), {
      ...NO_POINTERS,
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
    const diagnostics = sweepStaleSessions("/tracking", sweepCutoffs(100), {
      ...NO_POINTERS,
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
    expect(sweepStaleSessions("/missing", sweepCutoffs(100), {
      ...NO_POINTERS,
      probeDirectory: () => ({ kind: "absent" }),
      mtime: () => { throw new Error("must not stat an absent directory"); },
      remove: () => { throw new Error("must not remove from an absent directory"); },
    })).toEqual([]);

    const diagnostics = sweepStaleSessions("/unreadable", sweepCutoffs(100), {
      ...NO_POINTERS,
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

  // Idle is not dead: an overnight-paused session resumed and its own SessionStart
  // swept its I6 ledger (G4 slice 2 re-pilot, N4).
  describe("live sessions survive however idle they are", () => {
    const old = new Date(Date.now() - 12 * 3_600_000);
    const writeOld = (dir: string, name: string, content = "x\n") => {
      writeFileSync(join(dir, name), content);
      utimesSync(join(dir, name), old, old);
    };
    const freshDir = () => mkdtempSync(join(tmpdir(), "loom-sweep-live-"));

    it("the starting session keeps its whole group, sidecar included", () => {
      const dir = freshDir();
      const kept = ["s-resumed.evidence.jsonl", "s-resumed.active", "s-resumed.orchestration-runs.json",
        `s-resumed.agent1${STOP_CHECK_NOTE_SUFFIX}`];
      for (const name of [...kept, "s-other.evidence.jsonl"]) writeOld(dir, name);

      expect(sweepStaleSessions(dir, sweepCutoffs(Date.now() - 3_600_000), undefined, session("s-resumed"))).toEqual([]);

      for (const name of kept) expect(existsSync(join(dir, name)), name).toBe(true);
      expect(existsSync(join(dir, "s-other.evidence.jsonl"))).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    });

    it("a graph-bound session keeps its sidecars, including under a differing sidecar key", () => {
      const dir = freshDir();
      const graph = join(dir, "active_task_graph.json");
      writeFileSync(graph, "{}");
      const attempt = `s.bound.${Buffer.from("agent-1").toString("hex")}${IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX}`;
      const note = `${sidecarKey("s.bound")}.agent1${STOP_CHECK_NOTE_SUFFIX}`;
      writeOld(dir, "s.bound.task_graph", graph);
      writeOld(dir, "s.bound.machine");
      writeOld(dir, attempt);
      writeOld(dir, note);

      expect(sweepStaleSessions(dir, sweepCutoffs(Date.now() - 3_600_000))).toEqual([]);

      for (const name of ["s.bound.task_graph", "s.bound.machine", attempt, note]) {
        expect(existsSync(join(dir, name)), name).toBe(true);
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it("a session bound to an existing TaskGraph is kept; one whose graph is gone ages out", () => {
      const dir = freshDir();
      const graph = join(dir, "active_task_graph.json");
      writeFileSync(graph, "{}");
      writeOld(dir, "s-bound.evidence.jsonl");
      writeOld(dir, "s-bound.task_graph", graph);
      writeOld(dir, "s-orphan.evidence.jsonl");
      writeOld(dir, "s-orphan.task_graph", join(dir, "removed_task_graph.json"));
      writeOld(dir, "s-garbled.evidence.jsonl");
      writeOld(dir, "s-garbled.task_graph", "relative/not-canonical.json");

      // The malformed pointer binds nothing, and says so.
      expect(sweepStaleSessions(dir, sweepCutoffs(Date.now() - 3_600_000))).toEqual([{
        operation: "parse",
        path: join(dir, "s-garbled.task_graph"),
        cause: "TaskGraph pointer must be one exact canonical absolute path",
      }]);

      expect(existsSync(join(dir, "s-bound.evidence.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "s-bound.task_graph"))).toBe(true);
      for (const name of ["s-orphan.evidence.jsonl", "s-orphan.task_graph", "s-garbled.evidence.jsonl", "s-garbled.task_graph"]) {
        expect(existsSync(join(dir, name)), `${name} should be swept`).toBe(false);
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it("an unreadable pointer protects its session and is reported", () => {
      const removed: string[] = [];
      const diagnostics = sweepStaleSessions("/tracking", sweepCutoffs(100), {
        probeDirectory: () => ({ kind: "present", entries: ["s-maybe.task_graph", "s-maybe.evidence.jsonl", "s-dead.evidence.jsonl"] }),
        mtime: () => 10,
        readText: () => { throw new Error("EACCES read"); },
        exists: () => { throw new Error("must not probe a graph it could not read"); },
        observeBoundRun: () => { throw new Error("no run registry here to observe"); },
        remove: (path) => { removed.push(path); },
      });

      expect(removed).toEqual([join("/tracking", "s-dead.evidence.jsonl")]);
      expect(diagnostics).toEqual([{ operation: "read", path: join("/tracking", "s-maybe.task_graph"), cause: "EACCES read" }]);
    });

    it("the SessionStart handler protects the session named on stdin", async () => {
      const privateDir = mkdtempSync(join(tmpdir(), "loom-handler-resume-"));
      try {
        writeOld(privateDir, "resumed-session.evidence.jsonl");
        writeOld(privateDir, "idle-other.evidence.jsonl");
        const modulePath = fileURLToPath(
          new URL("../../../src/handlers/session-start/cleanup-stale-subagents", import.meta.url),
        );
        const stdin = JSON.stringify({ session_id: "resumed-session", source: "resume" });
        await promisify(execFile)("bun", [
          "-e",
          `import handler from ${JSON.stringify(modulePath)};\nconsole.log(JSON.stringify(await handler(${JSON.stringify(stdin)}, [])));`,
        ], { cwd: privateDir, env: { ...fixturePiEnvironment(privateDir), LOOM_SUBAGENT_DIR: privateDir }, timeout: 15_000 });

        expect(existsSync(join(privateDir, "resumed-session.evidence.jsonl"))).toBe(true);
        expect(existsSync(join(privateDir, "idle-other.evidence.jsonl"))).toBe(false);
      } finally {
        rmSync(privateDir, { recursive: true, force: true });
      }
    });
  });

  // A standalone review's subagents resolve their issuing run through the
  // session's run binding registry; sweeping it an hour into an idle wait
  // refused the run's completion ("cannot bind completed result for
  // unregistered run"). The registry now keeps its session while a run it
  // names is open, for at most OPEN_RUN_GRACE_MS past the idle TTL.
  describe("a session whose run binding names an open run", () => {
    const REGISTRY = "s-run.orchestration-runs.json";
    const LEDGER = "s-run.evidence.jsonl";
    const registryText = (runs: readonly string[], harness = "claude-code"): string => JSON.stringify({
      schemaVersion: 1, kind: "session-run-bindings", harness, sessionId: "s-run",
      bindings: runs.map((run) => ({
        runId: run, runsRoot: "/runs", runDirectory: join("/runs", run), requestIds: ["req-1"], resultDigest: null,
      })),
    });
    const sweepWith = (
      text: string | Error,
      observe: (binding: SessionRunBinding) => BoundRunObservation,
      mtime = 10,
    ) => {
      const removed: string[] = [];
      const observed: string[] = [];
      const diagnostics = sweepStaleSessions("/tracking", sweepCutoffs(100), {
        probeDirectory: () => ({ kind: "present", entries: [REGISTRY, LEDGER, "s-idle.evidence.jsonl"] }),
        mtime: () => mtime,
        readText: (path) => {
          if (!path.endsWith(REGISTRY)) return null;
          if (text instanceof Error) throw text;
          return text;
        },
        exists: () => false,
        observeBoundRun: (binding) => { observed.push(binding.runId); return observe(binding); },
        remove: (path) => { removed.push(path); },
      });
      return { removed: removed.map((path) => path.slice("/tracking/".length)).sort(), observed, diagnostics };
    };
    const OPEN: BoundRunObservation = { kind: "observed", liveness: { kind: "open" } };
    const FINISHED: BoundRunObservation = { kind: "observed", liveness: { kind: "finished", because: "terminal-state" } };

    it("keeps the whole session while any run it names is open", () => {
      const swept = sweepWith(registryText(["run-a", "run-b"]), (binding) => binding.runId === "run-b" ? OPEN : FINISHED);
      expect(swept.removed).toEqual(["s-idle.evidence.jsonl"]);
      expect(swept.observed).toEqual(["run-a", "run-b"]);
      expect(swept.diagnostics).toEqual([]);
    });

    it("reads a registry either harness published", () => {
      expect(sweepWith(registryText(["run-a"], "pi"), () => OPEN).removed).toEqual(["s-idle.evidence.jsonl"]);
    });

    it("releases the session once every run is finished or gone", () => {
      const swept = sweepWith(registryText(["run-a", "run-b"]), (binding) => binding.runId === "run-a" ? FINISHED : { kind: "absent" });
      expect(swept.removed).toEqual([LEDGER, REGISTRY, "s-idle.evidence.jsonl"].sort());
      expect(swept.diagnostics).toEqual([]);
    });

    it("an unreadable run keeps the session and is reported; every binding is still observed", () => {
      const swept = sweepWith(registryText(["run-a", "run-b"]), () => ({ kind: "unreadable", cause: "EACCES checkpoint" }));
      expect(swept.removed).toEqual(["s-idle.evidence.jsonl"]);
      expect(swept.diagnostics).toEqual([
        { operation: "read", path: join("/runs", "run-a"), cause: "EACCES checkpoint" },
        { operation: "read", path: join("/runs", "run-b"), cause: "EACCES checkpoint" },
      ]);
    });

    it("an unreadable registry keeps the session and is reported", () => {
      const swept = sweepWith(new Error("EACCES read"), () => { throw new Error("must not observe an unread registry"); });
      expect(swept.removed).toEqual(["s-idle.evidence.jsonl"]);
      expect(swept.diagnostics).toEqual([{ operation: "read", path: join("/tracking", REGISTRY), cause: "EACCES read" }]);
    });

    it("a malformed registry binds nothing and is reported", () => {
      for (const text of ["x\n", JSON.stringify({ kind: "session-run-bindings", harness: "emacs" })]) {
        const swept = sweepWith(text, () => { throw new Error("must not observe a malformed registry"); });
        expect(swept.removed, text).toEqual([LEDGER, REGISTRY, "s-idle.evidence.jsonl"].sort());
        expect(swept.diagnostics, text).toHaveLength(1);
        expect(swept.diagnostics[0]).toMatchObject({ operation: "parse", path: join("/tracking", REGISTRY) });
      }
    });

    it("an open run keeps its session no longer than the grace bound", () => {
      const swept = sweepWith(registryText(["run-a"]), () => { throw new Error("must not observe past the grace"); }, 100 - OPEN_RUN_GRACE_MS - 1);
      expect(swept.removed).toEqual([LEDGER, REGISTRY, "s-idle.evidence.jsonl"].sort());
    });

    it("an open run still keeps its session idle exactly at the grace cutoff", () => {
      const swept = sweepWith(registryText(["run-a"]), () => OPEN, 100 - OPEN_RUN_GRACE_MS);
      expect(swept.observed).toEqual(["run-a"]);
      expect(swept.removed).toEqual(["s-idle.evidence.jsonl"]);
      expect(swept.diagnostics).toEqual([]);
    });

    it("never reads the registry of a session the idle cutoff keeps anyway", () => {
      const removed: string[] = [];
      const diagnostics = sweepStaleSessions("/tracking", sweepCutoffs(100), {
        probeDirectory: () => ({
          kind: "present",
          entries: ["s-fresh.orchestration-runs.json", "s-start.orchestration-runs.json", "s-idle.evidence.jsonl"],
        }),
        // s-fresh is idle exactly at the idle cutoff, so it is not stale.
        mtime: (path) => path.endsWith("s-fresh.orchestration-runs.json") ? 100 : 10,
        readText: (path) => { throw new Error(`must not read ${path}`); },
        exists: () => false,
        observeBoundRun: () => { throw new Error("must not observe a run of a kept session"); },
        remove: (path) => { removed.push(path); },
      }, session("s-start"));
      expect(diagnostics).toEqual([]);
      expect(removed).toEqual([join("/tracking", "s-idle.evidence.jsonl")]);
    });

    it("on real files: the open run's session survives, the finished run's is swept", async () => {
      const dir = mkdtempSync(join(tmpdir(), "loom-sweep-runs-"));
      const runs = mkdtempSync(join(tmpdir(), "loom-sweep-runs-root-"));
      try {
        const open = createRunDirectory(runs, "run-open");
        const done = createRunDirectory(runs, "run-done");
        if (!open.ok || !done.ok) throw new Error("fixture runs did not open");
        await open.value.registerProgram({ kind: "standalone-review" });
        await done.value.registerProgram({ kind: "standalone-review" });
        await done.value.writeCheckpoint(JSON.stringify({ kind: "done" }));
        const old = new Date(Date.now() - 12 * 3_600_000);
        for (const [session, run] of [["s-open", "run-open"], ["s-done", "run-done"]] as const) {
          writeFileSync(join(dir, `${session}.orchestration-runs.json`), JSON.stringify({
            schemaVersion: 1, kind: "session-run-bindings", harness: "claude-code", sessionId: session,
            bindings: [{ runId: run, runsRoot: runs, runDirectory: join(runs, run), requestIds: ["req-1"], resultDigest: null }],
          }));
          writeFileSync(join(dir, `${session}.evidence.jsonl`), "x\n");
          for (const name of [`${session}.orchestration-runs.json`, `${session}.evidence.jsonl`]) utimesSync(join(dir, name), old, old);
        }

        expect(sweepStaleSessions(dir, sweepCutoffs(Date.now() - 3_600_000))).toEqual([]);

        expect(existsSync(join(dir, "s-open.orchestration-runs.json"))).toBe(true);
        expect(existsSync(join(dir, "s-open.evidence.jsonl"))).toBe(true);
        expect(existsSync(join(dir, "s-done.orchestration-runs.json"))).toBe(false);
        expect(existsSync(join(dir, "s-done.evidence.jsonl"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(runs, { recursive: true, force: true });
      }
    });
  });

  it("SessionStart input that names no usable session is reported, and the sweep still runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-sweep-unusable-"));
    try {
      const result = runCleanupStaleSubagents(dir, Date.now(), undefined, startingSessionOf("{\"source\":\"resume\"}"));
      expect(result.kind).toBe("passthrough");
      if (result.kind === "passthrough") {
        expect(result.systemMessage).toBe(
          "cleanup-stale-subagents: parse failed for SessionStart input: input carries no string session_id",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing dir is a no-op, and a clean injected handler wrapper passes through without diagnostics", () => {
    expect(sweepStaleSessions(join(subDir, "nope"), sweepCutoffs(Date.now()))).toEqual([]);
    const cleanDir = join(subDir, "clean-wrapper");
    mkdirSync(cleanDir);
    const result = runCleanupStaleSubagents(cleanDir, Date.now());
    expect(result.kind).toBe("passthrough");
    if (result.kind === "passthrough") expect(result.systemMessage).toBeUndefined();
  });
});
