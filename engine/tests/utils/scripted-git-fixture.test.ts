/**
 * The shared scripted-Git fixture (`tests/fixtures/scripted-git.ts`) is only
 * as faithful as its raw inverse: a scripted `GitSpawnOutcome` handed to code
 * through the `node:child_process` double must reach that code as exactly the
 * outcome the suite scripted, after the policy's own `parseGitSpawnResult`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseGitSpawnResult, type GitSpawnBounds, type GitSpawnOutcome } from "../../src/utils/git-spawn-outcome";
import { answered, exited, failedToStart, rawSpawnResult, scriptedGitSpawn } from "../fixtures/scripted-git";

const bytes = fc.uint8Array({ maxLength: 16 }).map((array) => Buffer.from(array));
const signal = fc.constantFrom<NodeJS.Signals>("SIGKILL", "SIGTERM", "SIGINT");
const capture = fc.record({ stdout: bytes, stderr: bytes });
/** A spawn error code; the two the parser reads as a bound are their own arms. */
const faultCode = fc.option(fc.constantFrom("ENOENT", "EIO", "EPIPE", "EACCES"), { nil: null });

const outcomes: fc.Arbitrary<GitSpawnOutcome> = fc.oneof(
  fc.record({ kind: fc.constant("spawn-failed" as const), code: faultCode, message: fc.string() }),
  fc.tuple(capture, fc.record({
    kind: fc.constant("faulted" as const),
    code: faultCode,
    message: fc.string(),
    status: fc.option(fc.integer({ min: 0, max: 255 }), { nil: null }),
    signal: fc.option(signal, { nil: null }),
  })).map(([streams, fault]) => ({ ...streams, ...fault })),
  fc.tuple(capture, fc.option(fc.integer({ min: 1, max: 60_000 }), { nil: null }), fc.option(signal, { nil: null }))
    .map(([streams, timeoutMs, ending]) => ({ kind: "timed-out" as const, timeoutMs, signal: ending, ...streams })),
  fc.tuple(capture, fc.integer({ min: 1, max: 1 << 30 })).map(([streams, maxBuffer]) => ({ kind: "over-budget" as const, maxBuffer, ...streams })),
  fc.tuple(capture, signal).map(([streams, ending]) => ({ kind: "signalled" as const, signal: ending, ...streams })),
  fc.tuple(capture, fc.integer({ min: 0, max: 255 })).map(([streams, status]) => ({ kind: "exited" as const, status, ...streams })),
);

/** The bounds the real spawn was given for an outcome that names them. */
function boundsOf(outcome: GitSpawnOutcome): GitSpawnBounds {
  if (outcome.kind === "over-budget") return { maxBuffer: outcome.maxBuffer };
  if (outcome.kind === "timed-out" && outcome.timeoutMs !== null) return { maxBuffer: 1024, timeout: outcome.timeoutMs };
  return { maxBuffer: 1024 };
}

describe("scripted-Git fixture", () => {
  it("hands every scripted outcome back unchanged through the policy's raw-result parser (property)", () => {
    fc.assert(fc.property(outcomes, (outcome) => {
      expect(parseGitSpawnResult(rawSpawnResult(outcome), boundsOf(outcome))).toEqual(outcome);
    }));
  });

  it("starts no child for a spawn that failed to start: no streams, no status", () => {
    expect(rawSpawnResult(failedToStart("spawn git ENOENT"))).toMatchObject({ status: null, signal: null, stdout: null, stderr: null });
    expect(answered("")).toEqual(exited(0));
  });

  it("answers its port fake in order, records each call, and refuses to run past its script", () => {
    const git = scriptedGitSpawn([answered("one")]);
    expect(git.spawn(["rev-parse", "HEAD"], { maxBuffer: 1024 })).toEqual(answered("one"));
    expect(git.calls).toEqual([{ args: ["rev-parse", "HEAD"], run: { maxBuffer: 1024 } }]);
    expect(() => git.spawn(["status"], { maxBuffer: 1024 })).toThrow("scripted Git ran past its answers at: git status");
  });
});
