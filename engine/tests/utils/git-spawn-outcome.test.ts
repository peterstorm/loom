/**
 * The pure Git spawn-outcome core, pinned at its own interface: how a raw
 * `spawnSync` result parses into the closed `GitSpawnOutcome`, how every arm
 * renders, and the status-protocol readings (`gitExitedWith`,
 * `gitCleanNegative`, `gitDiagnosticLost`). No process runs here; the
 * policy-bound spawn that feeds this core is pinned in
 * `git-execution-policy.test.ts`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  describeGitOutcome,
  diagnoseGitOutcome,
  gitCleanNegative,
  gitDiagnosticLost,
  gitExitedWith,
  parseGitSpawnResult,
  type GitExit,
  type GitSpawnOutcome,
  type RawGitSpawnResult,
} from "../../src/utils/git-spawn-outcome";

const error = (message: string, code?: string): Error => Object.assign(new Error(message), code === undefined ? {} : { code });
const run = { maxBuffer: 1024, timeout: 500 };
const exit = (status: number, stdout = "", stderr = ""): GitExit =>
  ({ kind: "exited", status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });

describe("parseGitSpawnResult", () => {
  it.each<[string, RawGitSpawnResult, GitSpawnOutcome]>([
    ["Node's missing executable", { error: error("spawnSync git ENOENT", "ENOENT"), status: null, signal: null, stdout: null, stderr: null },
      { kind: "spawn-failed", code: "ENOENT", message: "spawnSync git ENOENT" }],
    ["Bun's missing executable (no status, no streams)", { error: error('Executable not found in $PATH: "git"', "ENOENT"), signal: null },
      { kind: "spawn-failed", code: "ENOENT", message: 'Executable not found in $PATH: "git"' }],
    ["a code-less spawn error", { error: error("spawn boom"), status: null, signal: null },
      { kind: "spawn-failed", code: null, message: "spawn boom" }],
    ["a timeout, keeping what the child wrote", { error: error("spawnSync git ETIMEDOUT", "ETIMEDOUT"), status: null, signal: "SIGTERM", stdout: Buffer.from("partial"), stderr: Buffer.from("warning") },
      { kind: "timed-out", timeoutMs: 500, signal: "SIGTERM", stdout: Buffer.from("partial"), stderr: Buffer.from("warning") }],
    ["an over-budget capture", { error: error("spawnSync git ENOBUFS", "ENOBUFS"), status: 0, signal: null, stdout: Buffer.alloc(2048), stderr: Buffer.alloc(0) },
      { kind: "over-budget", maxBuffer: 1024, stdout: Buffer.alloc(2048), stderr: Buffer.alloc(0) }],
    ["a pipe fault on a child that exited, keeping its status and streams",
      { error: error("spawnSync git EIO", "EIO"), status: 128, signal: null, stdout: Buffer.from("partial"), stderr: Buffer.from("fatal: x\n") },
      { kind: "faulted", code: "EIO", message: "spawnSync git EIO", status: 128, signal: null, stdout: Buffer.from("partial"), stderr: Buffer.from("fatal: x\n") }],
    ["a fault on a signalled child that wrote nothing",
      { error: error("spawnSync git EPERM", "EPERM"), status: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      { kind: "faulted", code: "EPERM", message: "spawnSync git EPERM", status: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }],
    ["a signal", { status: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.from("killed mid-write") },
      { kind: "signalled", signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.from("killed mid-write") }],
    ["an exit with string captures, as a scripted double hands them back", { error: null, status: 128, signal: null, stdout: "", stderr: "fatal: x\n" },
      { kind: "exited", status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: x\n") }],
    ["a result naming no ending at all", {},
      { kind: "spawn-failed", code: null, message: "the spawn reported no exit status, no signal and no error" }],
    ["a result naming no ending but carrying what a child wrote", { stdout: null, stderr: Buffer.from("fatal: x\n") },
      { kind: "faulted", code: null, message: "the spawn reported no exit status, no signal and no error", status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: x\n") }],
  ])("parses %s", (_label, raw, expected) => {
    expect(parseGitSpawnResult(raw, run)).toEqual(expected);
  });

  const stream = fc.option(fc.oneof(fc.uint8Array({ maxLength: 64 }).map((bytes) => Buffer.from(bytes)), fc.string({ maxLength: 64 })), { nil: null });
  const rawResult: fc.Arbitrary<RawGitSpawnResult> = fc.record({
    error: fc.option(fc.record({
      message: fc.string(),
      code: fc.option(fc.constantFrom("ENOENT", "EACCES", "EIO", "EPIPE", "ETIMEDOUT", "ENOBUFS"), { nil: undefined }),
    }).map(({ message, code }) => error(message, code)), { nil: null }),
    status: fc.option(fc.integer({ min: 0, max: 255 }), { nil: null }),
    signal: fc.option(fc.constantFrom<NodeJS.Signals>("SIGTERM", "SIGKILL"), { nil: null }),
    stdout: stream,
    stderr: stream,
  }, { requiredKeys: [] });

  it("never drops what a child wrote: any captured stream reaches the outcome byte for byte", () => {
    fc.assert(fc.property(rawResult, (raw) => {
      const outcome = parseGitSpawnResult(raw, run);
      const wrote = [raw.stdout, raw.stderr].some((captured) => captured !== null && captured !== undefined);
      if (!wrote) return;
      expect(outcome.kind).not.toBe("spawn-failed");
      if (outcome.kind === "spawn-failed") return;
      expect(outcome.stdout).toEqual(Buffer.from(raw.stdout ?? ""));
      expect(outcome.stderr).toEqual(Buffer.from(raw.stderr ?? ""));
    }));
  });

  it("reads a spawn error only as an error arm, and a child's status only when no error or signal ended it", () => {
    fc.assert(fc.property(rawResult, (raw) => {
      const outcome = parseGitSpawnResult(raw, run);
      const hasError = raw.error !== null && raw.error !== undefined;
      if (hasError) expect(["spawn-failed", "faulted", "timed-out", "over-budget"]).toContain(outcome.kind);
      else expect(["signalled", "exited", "faulted", "spawn-failed"]).toContain(outcome.kind);
      if (!hasError && (outcome.kind === "faulted" || outcome.kind === "spawn-failed")) {
        expect(outcome).toMatchObject({ code: null, message: "the spawn reported no exit status, no signal and no error" });
      }
      if (outcome.kind === "exited") expect(outcome.status).toBe(raw.status);
      if (outcome.kind === "faulted") expect(outcome.status).toBe(raw.status ?? null);
    }));
  });
});

describe("diagnoseGitOutcome and describeGitOutcome", () => {
  it.each<[GitSpawnOutcome, string]>([
    [{ kind: "spawn-failed", code: "ENOENT", message: "spawnSync git ENOENT" }, "could not start: spawnSync git ENOENT"],
    [{ kind: "faulted", code: "EIO", message: "spawnSync git EIO", status: 0, signal: null, stdout: Buffer.from("out"), stderr: Buffer.alloc(0) },
      "exited 0 after a spawn fault (spawnSync git EIO)"],
    [{ kind: "faulted", code: "EPERM", message: "spawnSync git EPERM", status: null, signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.from("fatal: partial\n") },
      "terminated on signal SIGKILL after a spawn fault (spawnSync git EPERM): fatal: partial"],
    [{ kind: "faulted", code: null, message: "boom", status: null, signal: null, stdout: Buffer.from("x"), stderr: Buffer.alloc(0) },
      "ended after a spawn fault (boom)"],
    [{ kind: "timed-out", timeoutMs: null, signal: "SIGTERM", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, "timed out"],
    [{ kind: "timed-out", timeoutMs: 500, signal: "SIGTERM", stdout: Buffer.alloc(0), stderr: Buffer.from("warning\n") }, "timed out after 500 ms: warning"],
    [{ kind: "over-budget", maxBuffer: 1024, stdout: Buffer.alloc(2048), stderr: Buffer.alloc(0) }, "exceeded its 1024-byte output budget"],
    [{ kind: "signalled", signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, "terminated on signal SIGKILL"],
    [exit(0, "out"), "exited 0"],
    [exit(1, "ab"), "exited 1: stderr empty, stdout 2 bytes"],
    [exit(129, "", "usage: git rev-parse\n"), "exited 129: usage: git rev-parse"],
  ])("renders %j as %j", (outcome, expected) => {
    expect(describeGitOutcome(outcome)).toBe(expected);
  });

  it("names a fatal exit with an empty stderr as a lost capture", () => {
    expect(diagnoseGitOutcome(exit(128))).toEqual({
      head: "exited 128",
      detail: "stderr empty, stdout 0 bytes — Git writes a diagnostic for every fatal exit, so the child's stderr was lost before it reached the engine",
    });
  });

  it("carries Git's own diagnostic in every arm a child ran in", () => {
    const diagnostic = fc.string({ minLength: 1, maxLength: 40 }).filter((text) => text.trim() !== "" && !text.includes("\0"));
    const withStderr = (stderr: string): fc.Arbitrary<GitSpawnOutcome> => {
      const capture = { stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) };
      return fc.constantFrom<GitSpawnOutcome>(
        { kind: "faulted", code: "EIO", message: "m", status: 1, signal: null, ...capture },
        { kind: "timed-out", timeoutMs: 5, signal: "SIGTERM", ...capture },
        { kind: "over-budget", maxBuffer: 1, ...capture },
        { kind: "signalled", signal: "SIGKILL", ...capture },
        { kind: "exited", status: 128, ...capture },
      );
    };
    fc.assert(fc.property(diagnostic.chain((text) => withStderr(text).map((outcome) => [text, outcome] as const)), ([text, outcome]) => {
      expect(diagnoseGitOutcome(outcome).detail).toBe(text.trim());
    }));
  });
});

describe("status-protocol readings", () => {
  it("accepts an exit only when its caller's protocol names that status", () => {
    expect([0, 1, 128].map((status) => gitExitedWith(exit(status), [0, 1]))).toEqual([true, true, false]);
    expect(gitExitedWith({ kind: "signalled", signal: "SIGKILL", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, [0, 1])).toBe(false);
    expect(gitExitedWith({ kind: "faulted", code: "EIO", message: "m", status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, [0]))
      .toBe(false);
    expect(gitExitedWith({ kind: "spawn-failed", code: null, message: "boom" }, [0])).toBe(false);
  });

  it("reads only an exit 1 with both streams blank as a 0/1 protocol's clean negative answer", () => {
    expect([
      exit(1), exit(1, "\n", " "), exit(1, "", "fatal: cannot read object"), exit(1, "abc"), exit(0), exit(128),
    ].map(gitCleanNegative)).toEqual([true, true, false, false, false, false]);
    expect(gitCleanNegative({ kind: "spawn-failed", code: "ENOENT", message: "spawn git ENOENT" })).toBe(false);
  });

  it("calls only a blank-stderr FATAL exit a lost diagnostic", () => {
    expect([
      exit(128), exit(129, "", " \n"), exit(128, "", "fatal: x"), exit(1), exit(0),
    ].map(gitDiagnosticLost)).toEqual([true, true, false, false, false]);
  });

  it("agrees with the status and the blank stderr for every exit", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 255 }), fc.string({ maxLength: 8 }), (status, stderr) => {
      const candidate = exit(status, "", stderr);
      expect(gitDiagnosticLost(candidate)).toBe(status >= 128 && stderr.trim() === "");
      expect(gitCleanNegative(candidate)).toBe(status === 1 && stderr.trim() === "");
    }));
  });
});
