/**
 * Pi session shutdown releases every capability even when one release fails:
 * the staged-emission-launch removal is one labelled cleanup action among the
 * write-grant revocations, never a step whose throw skips them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { parseSessionId } from "../../src/machine";
import { shutdownPiSession } from "../../../pi/session-shutdown";
import { createPiParentSessions } from "../../../pi/spawn-reservation";
import { createPiChildWriteGrants } from "../../../pi/child-write-grant";
import { issuePiWriteGrant } from "../../../pi/write-grant";
import type { PiEmissionLaunchBridge } from "../../../pi/emission-launch-bridge";
import { createTrustedReviewWitnesses } from "../../../pi/trusted-review-witness";

let root: string;
let priorSubagentDir: string | undefined;

beforeEach(() => {
  root = canonicalTempDir("loom-pi-session-shutdown-");
  priorSubagentDir = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (priorSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = priorSubagentDir;
  rmSync(root, { recursive: true, force: true });
});

const unused = (port: string) => (): never => {
  throw new Error(`${port} is not part of session shutdown`);
};

/** A bridge whose session removal fails: the one capability release under test. */
const failingBridge = (removed: string[]): PiEmissionLaunchBridge => ({
  probe: unused("probe"),
  stage: unused("stage"),
  removeToolCall: unused("removeToolCall"),
  removeSession: (sessionId) => {
    removed.push(sessionId);
    throw new Error("launch bridge unavailable");
  },
});

const grantFiles = (): readonly string[] => {
  const directory = join(root, "subagents", "pi-write-grants");
  return existsSync(directory) ? readdirSync(directory) : [];
};

describe("shutdownPiSession", () => {
  it("still revokes every write grant when removing staged emission launches throws, and reports that failure", async () => {
    const cwd = join(root, "project");
    const graph = join(cwd, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(cwd, ".claude", "state"), { recursive: true });
    writeFileSync(graph, "{}\n");
    const sessionId = parseSessionId("parent-session");
    if (sessionId === null) throw new Error("fixture session id must parse");

    const parentSessions = createPiParentSessions();
    const issue = (slot: number, taskId: string) => Object.freeze({
      slot,
      token: issuePiWriteGrant({ agent: "code-implementer-agent", taskId, cwd, taskGraphPath: graph }).token,
    });
    parentSessions.runtimeFor(sessionId).issuedWriteGrants.set("call-1", Object.freeze([issue(0, "T1"), issue(1, "T2")]));
    expect(grantFiles()).toHaveLength(2);

    const removed: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failure = "remove staged emission launches for parent-session: launch bridge unavailable";

    await expect(shutdownPiSession("parent-session", {
      parentSessions,
      childWriteGrants: createPiChildWriteGrants(),
      emissionLaunchBridge: failingBridge(removed),
      reviewWitnesses: createTrustedReviewWitnesses(),
    })).rejects.toThrow(`Loom Pi session shutdown cleanup failed: ${failure}`);

    expect(removed).toEqual(["parent-session"]);
    // The later revocations ran: both grant files are gone, and the session
    // holds no remaining grant debt.
    expect(grantFiles()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(`loom(pi): shutdown cleanup failed: ${failure}\n`);
  });

  it("prunes exactly this session from the injected review witness aggregate", async () => {
    const forgotten: string[] = [];
    const witnesses = { ...createTrustedReviewWitnesses(), forget: (session: string) => { forgotten.push(session); } };
    await shutdownPiSession("parent-session", {
      parentSessions: createPiParentSessions(),
      childWriteGrants: createPiChildWriteGrants(),
      emissionLaunchBridge: { ...failingBridge([]), removeSession: () => undefined },
      reviewWitnesses: witnesses,
    });
    expect(forgotten).toEqual(["parent-session"]);
  });
});
