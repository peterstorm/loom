/**
 * `helper orchestration adopt-engine-run-tests` as a shell (loom#198), over an
 * injected subagent probe and a real State File: what it refuses before it
 * touches state, that a first adoption persists the mode with its reason, and
 * that a repeat changes nothing.
 */

import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../../../src/core/plain-record";
import { createAdoptEngineRunTestsOperation } from "../../../src/handlers/helpers/adopt-engine-run-tests";
import { StateManager } from "../../../src/state-manager";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { stateFileJson, task, writeStateFile } from "../../fixtures/contract-status-fixtures";
import { mutationManifest } from "../../fixtures/task-mutation";

const savedStatePath = process.env.LOOM_STATE_PATH;
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (savedStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = savedStatePath;
  vi.restoreAllMocks();
});

const MANIFEST = mutationManifest();

/** A populated execute graph whose frozen manifest declares an affectedRunner; its State File path is the helper's. */
function graph(): string {
  const root = canonicalTempDir("loom-adopt-engine-run-");
  temporary.push(root);
  const raw: unknown = JSON.parse(stateFileJson([task("T1", 1, ["src/a.ts", "src/a.test.ts"])]));
  if (!isRecord(raw)) throw new Error("a State File is a JSON object");
  const statePath = writeStateFile(root, JSON.stringify({ ...raw, verification_manifest: MANIFEST }));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

const quiet = () => vi.spyOn(process.stdout, "write").mockImplementation(() => true);

describe("adopt-engine-run-tests: what it refuses without touching state", () => {
  it.each<[string, readonly string[], RegExp]>([
    ["no --reason", [], /requires --reason/],
    ["an unknown argument", ["--reason", "mocha", "--force"], /unknown or unconsumed argument\(s\): --force/],
    ["a blank reason", ["--reason", " padded "], /non-blank trimmed text/],
  ])("refuses %s", async (_label, args, message) => {
    const statePath = graph();
    const before = readFileSync(statePath, "utf8");
    quiet();
    const result = await createAdoptEngineRunTestsOperation(() => false)(args);
    expect(result).toMatchObject({ kind: "error", message: expect.stringMatching(message) });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses while a subagent is active for the TaskGraph", async () => {
    const statePath = graph();
    const before = readFileSync(statePath, "utf8");
    const result = await createAdoptEngineRunTestsOperation(() => true)(["--reason", "mocha runner"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("refused while a subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses when a subagent becomes active before the commit", async () => {
    const statePath = graph();
    let calls = 0;
    quiet();
    const result = await createAdoptEngineRunTestsOperation(() => ++calls > 1)(["--reason", "mocha runner"]);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("refused without changing state") });
    expect(new StateManager(statePath).load().test_evidence).toBeUndefined();
  });
});

describe("adopt-engine-run-tests: the adoption", () => {
  it("persists the mode with the operator's reason, and a repeat changes nothing", async () => {
    const statePath = graph();
    quiet();
    const adopt = createAdoptEngineRunTestsOperation(() => false);
    expect(await adopt(["--reason", "the runner writes no report the recorder reads"])).toEqual({ kind: "allow" });
    const adopted = new StateManager(statePath).load().test_evidence;
    expect(adopted).toEqual({
      kind: "engine-run",
      manifestDigest: MANIFEST.manifestDigest,
      adoptedBy: "operator",
      reason: "the runner writes no report the recorder reads",
    });
    const after = readFileSync(statePath, "utf8");
    expect(await adopt(["--reason", "again"])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(after);
  });
});
