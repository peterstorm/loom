/**
 * The shared scripted-Git fixture (`tests/fixtures/scripted-git.ts`) is only
 * as faithful as its port fake: every suite that scripts Git hands the code
 * under test `scriptedGitSpawn(...).spawn` as its `GitSpawn` port, so the fake
 * must answer in order, record what each probe asked for, and refuse loudly
 * past its script.
 */
import { describe, expect, it } from "vitest";
import { answered, exited, failedToStart, scriptedGitSpawn } from "../fixtures/scripted-git";

describe("scripted-Git fixture", () => {
  it("builds the production outcomes: the empty transient is a bare status-0 exit, a failed start has no child", () => {
    expect(answered("")).toEqual(exited(0));
    expect(failedToStart("spawn git ENOENT", "ENOENT")).toEqual({ kind: "spawn-failed", code: "ENOENT", message: "spawn git ENOENT" });
  });

  it("answers its port fake in order, records each call, and refuses to run past its script", () => {
    const git = scriptedGitSpawn([answered("one")]);
    expect(git.spawn(["rev-parse", "HEAD"], { maxBuffer: 1024 })).toEqual(answered("one"));
    expect(git.calls).toEqual([{ args: ["rev-parse", "HEAD"], run: { maxBuffer: 1024 } }]);
    expect(() => git.spawn(["status"], { maxBuffer: 1024 })).toThrow("scripted Git ran past its answers at: git status");
  });

  it("gives each fake its own script and call log", () => {
    const first = scriptedGitSpawn([answered("first")]);
    const second = scriptedGitSpawn([answered("second")]);
    expect(second.spawn(["status"], { maxBuffer: 1 })).toEqual(answered("second"));
    expect(first.calls).toEqual([]);
    expect(first.spawn(["status"], { maxBuffer: 1 })).toEqual(answered("first"));
  });
});
