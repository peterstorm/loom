import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRequestId } from "../../src/core/orchestration-contract";
import { parseRunDirectoryIdentity } from "../../src/orchestration/run-directory-handle";
import {
  ORCHESTRATION_RUNS_SUFFIX,
  parseSessionRunBindingRegistry,
  readSessionRunBindings,
  registerSessionRunBinding,
  type SessionRunBinding,
} from "../../src/orchestration/session-run-bindings";

const cleanup: string[] = [];
const sessionId = "019ff290-ffee-7e86-8ed0-c834c04b7f6e";

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "loom-session-run-bindings-"));
  cleanup.push(path);
  return path;
}

function requestId(raw: string) {
  const parsed = parseRequestId(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function binding(base: string, suffix: string, requests: readonly string[]): SessionRunBinding {
  const runsRoot = join(base, `runs-${suffix}`);
  const runDirectory = join(runsRoot, `run.${suffix}`);
  mkdirSync(runDirectory, { recursive: true });
  const identity = parseRunDirectoryIdentity(runsRoot, runDirectory);
  if (!identity.ok) throw new Error(identity.error.message);
  return {
    ...identity.value,
    requestIds: requests.map(requestId),
    resultDigest: null,
  };
}

describe("Pi session run bindings", () => {
  it("merges repeated publication for one run without losing another active run", async () => {
    const base = root();
    const directory = join(base, "bindings");
    const first = binding(base, "first", ["request:first:1"]);
    const second = binding(base, "second", ["request:second:1"]);

    expect((await registerSessionRunBinding(directory, sessionId, first)).ok).toBe(true);
    expect((await registerSessionRunBinding(directory, sessionId, second)).ok).toBe(true);
    expect((await registerSessionRunBinding(directory, sessionId, {
      ...first,
      requestIds: [requestId("request:first:2")],
    })).ok).toBe(true);

    const read = readSessionRunBindings(directory, sessionId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toHaveLength(2);
    expect(read.value.find(({ runId }) => runId === first.runId)?.requestIds)
      .toEqual(["request:first:1", "request:first:2"]);
    expect(read.value.find(({ runId }) => runId === second.runId)?.requestIds)
      .toEqual(["request:second:1"]);
  });

  it("serializes concurrent publication without losing run or request authority", async () => {
    const base = root();
    const directory = join(base, "bindings");
    mkdirSync(directory);
    const first = binding(base, "concurrent-first", ["request:concurrent:first:1"]);
    const second = binding(base, "concurrent-second", ["request:concurrent:second:1"]);

    const published = await Promise.all([
      registerSessionRunBinding(directory, sessionId, first),
      registerSessionRunBinding(directory, sessionId, {
        ...first,
        requestIds: [requestId("request:concurrent:first:2")],
      }),
      registerSessionRunBinding(directory, sessionId, second),
    ]);

    expect(published.every(({ ok }) => ok)).toBe(true);
    const read = readSessionRunBindings(directory, sessionId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toHaveLength(2);
    expect(read.value.find(({ runId }) => runId === first.runId)?.requestIds)
      .toEqual(["request:concurrent:first:1", "request:concurrent:first:2"]);
    expect(read.value.find(({ runId }) => runId === second.runId)?.requestIds)
      .toEqual(["request:concurrent:second:1"]);
  });

  it("records one immutable completed-result digest without losing request authority", async () => {
    const base = root();
    const directory = join(base, "bindings");
    const issued = binding(base, "completed", ["request:completed:1"]);
    expect((await registerSessionRunBinding(directory, sessionId, issued)).ok).toBe(true);
    const digest = "a".repeat(64);
    expect((await registerSessionRunBinding(directory, sessionId, { ...issued, resultDigest: digest })).ok).toBe(true);
    expect(readSessionRunBindings(directory, sessionId)).toMatchObject({
      ok: true,
      value: [{ requestIds: ["request:completed:1"], resultDigest: digest }],
    });
    expect((await registerSessionRunBinding(directory, sessionId, {
      ...issued,
      resultDigest: "b".repeat(64),
    }))).toMatchObject({ ok: false, message: expect.stringContaining("conflicts") });
  });

  it("reports failure to remove a staged registry after publication fails", async () => {
    const base = root();
    const directory = join(base, "bindings");
    mkdirSync(directory);
    const random = 0.25;
    vi.spyOn(Math, "random").mockReturnValue(random);
    const token = random.toString(36).slice(2, 10);
    const stagedPath = join(
      directory,
      `${sessionId}${ORCHESTRATION_RUNS_SUFFIX}.staged-${process.pid}-${token}`,
    );
    mkdirSync(stagedPath);

    const result = await registerSessionRunBinding(
      directory,
      sessionId,
      binding(base, "cleanup-failure", ["request:cleanup:1"]),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("cannot publish Pi session run binding");
    expect(result.message).toContain("staged cleanup failed");
    expect(result.message).toContain(`${sessionId}${ORCHESTRATION_RUNS_SUFFIX}.staged-${process.pid}-${token}`);
  });

  it("rejects malformed and cross-session registry authority", () => {
    const valid = {
      schemaVersion: 1,
      kind: "session-run-bindings",
      harness: "pi",
      sessionId,
      bindings: [],
    };

    expect(parseSessionRunBindingRegistry(valid, "other-session").ok).toBe(false);
    expect(parseSessionRunBindingRegistry({ ...valid, extra: true }, sessionId).ok).toBe(false);
  });

  it("carries parsed direct-child run identity and rejects nested path authority", () => {
    const base = root();
    const runsRoot = join(base, "runs");
    const nested = join(runsRoot, "parent", "run.nested");
    mkdirSync(nested, { recursive: true });
    const parsed = parseSessionRunBindingRegistry({
      schemaVersion: 1, kind: "session-run-bindings", harness: "pi", sessionId,
      bindings: [{
        runId: "run.nested", runsRoot, runDirectory: nested, requestIds: ["request:nested:1"], resultDigest: null,
      }],
    }, sessionId);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("direct child");
  });

  it("keeps a deleted historical run as a parsed reference for scoped recovery", async () => {
    const base = root();
    const directory = join(base, "bindings");
    const historical = binding(base, "historical", ["request:historical:1"]);
    expect((await registerSessionRunBinding(directory, sessionId, historical)).ok).toBe(true);
    rmSync(historical.runDirectory, { recursive: true, force: true });

    const read = readSessionRunBindings(directory, sessionId);

    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value[0]).toMatchObject({
      runId: historical.runId,
      runsRoot: historical.runsRoot,
      runDirectory: historical.runDirectory,
    });
  });

  it("fails closed when the registry leaf is a symlink", () => {
    const base = root();
    const directory = join(base, "bindings");
    mkdirSync(directory);
    const target = join(base, "outside.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, join(directory, `${sessionId}${ORCHESTRATION_RUNS_SUFFIX}`));

    const read = readSessionRunBindings(directory, sessionId);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toContain("cannot read Pi session run bindings");
  });
});
