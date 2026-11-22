/**
 * The sweep's view of one bound run, read off a real Run Directory: absent,
 * observed (open or finished), or unreadable. Each read is synchronous, so Pi
 * can run the sweep as a synchronous startup sweep.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequestId } from "../../src/core/orchestration-contract";
import { observeBoundRun } from "../../src/orchestration/bound-run-liveness";
import { createRunDirectory, parseRunDirectoryReference, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import type { SessionRunBinding } from "../../src/orchestration/session-run-bindings";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runsRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "loom-bound-run-"));
  cleanup.push(path);
  return path;
}

function bindingTo(root: string, run: string, resultDigest: string | null = null): SessionRunBinding {
  const reference = parseRunDirectoryReference(root, join(root, run));
  const requestId = parseRequestId("req-1");
  if (!reference.ok || !requestId.ok) throw new Error("fixture binding does not parse");
  return Object.freeze({ ...reference.value, requestIds: Object.freeze([requestId.value]), resultDigest });
}

async function createdRun(root: string, run: string, program: unknown): Promise<RunDirHandle> {
  const handle = createRunDirectory(root, run);
  if (!handle.ok) throw new Error(handle.error.message);
  const registered = await handle.value.registerProgram(program);
  if (!registered.ok) throw new Error(registered.error.message);
  return handle.value;
}

describe("observeBoundRun", () => {
  it("a binding that recorded its result is finished without reading the run", () => {
    // No Run Directory exists: a read would have answered absent.
    expect(observeBoundRun(bindingTo(runsRoot(), "run-gone", "a".repeat(64))))
      .toEqual({ kind: "observed", liveness: { kind: "finished", because: "result-published" } });
  });

  it("a Run Directory that is gone binds nothing", () => {
    expect(observeBoundRun(bindingTo(runsRoot(), "run-gone"))).toEqual({ kind: "absent" });
  });

  it("a registered run with no terminal checkpoint is open", async () => {
    const root = runsRoot();
    await createdRun(root, "run-open", { kind: "standalone-review" });
    expect(observeBoundRun(bindingTo(root, "run-open"))).toEqual({ kind: "observed", liveness: { kind: "open" } });
  });

  it("a run whose checkpoint holds a terminal state is finished", async () => {
    const root = runsRoot();
    const handle = await createdRun(root, "run-done", { kind: "remediation" });
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 2, state: { state: "done" } }));
    expect(observeBoundRun(bindingTo(root, "run-done")))
      .toEqual({ kind: "observed", liveness: { kind: "finished", because: "terminal-state" } });
  });

  it("an abandoned run is finished whatever its checkpoint says", async () => {
    const root = runsRoot();
    const handle = await createdRun(root, "run-abandoned", { kind: "remediation" });
    await handle.writeCheckpoint("not json");
    const abandoned = await handle.abandonRun({ supersededBy: null, reason: "superseded by hand" });
    if (!abandoned.ok) throw new Error(abandoned.error.message);
    expect(observeBoundRun(bindingTo(root, "run-abandoned")))
      .toEqual({ kind: "observed", liveness: { kind: "finished", because: "abandoned" } });
  });

  it("a checkpoint that is not JSON makes the run unreadable, not finished", async () => {
    const root = runsRoot();
    const handle = await createdRun(root, "run-garbled", { kind: "remediation" });
    await handle.writeCheckpoint("{not json");
    const observation = observeBoundRun(bindingTo(root, "run-garbled"));
    expect(observation.kind).toBe("unreadable");
    if (observation.kind === "unreadable") expect(observation.cause).toMatch(/checkpoint is invalid JSON/);
  });

  it("a symlink where the Run Directory should be is unreadable, never followed", () => {
    const root = runsRoot();
    const elsewhere = runsRoot();
    symlinkSync(elsewhere, join(root, "run-link"));
    const observation = observeBoundRun(bindingTo(root, "run-link"));
    expect(observation).toEqual({ kind: "unreadable", cause: `run directory entry ${join(root, "run-link")} is a symlink, not a directory` });
  });

  it("a Run Directory without its authority is unreadable", () => {
    const root = runsRoot();
    const created = createRunDirectory(root, "run-bare");
    if (!created.ok) throw new Error(created.error.message);
    rmSync(join(root, "run-bare", "authority.json"));
    const observation = observeBoundRun(bindingTo(root, "run-bare"));
    expect(observation.kind).toBe("unreadable");
    if (observation.kind === "unreadable") expect(observation.cause).toMatch(/registered Run is unavailable|authority/);
  });
});
