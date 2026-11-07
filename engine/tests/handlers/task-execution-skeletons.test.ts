/**
 * Skeleton materialization through the registration shell's callers (AD-1):
 * the Claude Code `validate-task-execution` PreToolUse handler, and the exact
 * call Pi's spawn lifecycle makes (`spawnCwd`, a pre-roster observation,
 * sequential mode). Plus the shell's refusals as values — drift, a refused
 * write that leaves the State File untouched and is adopted by content on the
 * next registration — a graph populated before G2, and the NFR-001 budget.
 */

import { mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import type { ExportBinding, Identifier } from "../../src/core/skeleton/types";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { createValidateTaskExecutionHandler } from "../../src/handlers/pre-tool-use/validate-task-execution";
import { materializeTaskSkeletons } from "../../src/orchestration/skeleton-materialization";
import { StateManager } from "../../src/state-manager";
import type { TaskGraph } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { contentDigest } from "../fixtures/acceptance-fixtures";
import {
  canonicalSkeletonOf,
  cleanupSkeletonRepos,
  JAVA_EXISTING_TEXT,
  PATHS,
  recordedOutcomes,
  recordedSkeletons,
  sha256,
  skeletonRepo,
  spawnFor,
  storedTask,
  TS_CONTRACT,
  TS_TYPES_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";

const roots: string[] = [];
afterEach(() => {
  cleanupSkeletonRepos();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STATE = ".claude/state/active_task_graph.json";
const written = { kind: "skeleton-written", origin: "spawn" } as const;

const claudeStdin = (repo: SkeletonRepo, taskId: string): string => {
  const spawn = spawnFor(repo.rawState(), taskId);
  if (spawn.kind !== "implementation") throw new Error("fixture spawn is no implementation spawn");
  return JSON.stringify({
    tool_name: "Agent",
    tool_input: { subagent_type: "loom:code-implementer-agent", description: spawn.description, prompt: spawn.prompt },
    session_id: "skeleton-session",
  });
};

describe("the Claude Code validate-task-execution handler", () => {
  it("writes the Task's skeletons and records them with its outcomes before admitting the spawn", async () => {
    const repo = skeletonRepo();

    const result = await createValidateTaskExecutionHandler([])(claudeStdin(repo, "T4"), []);

    expect(result).toEqual({ kind: "allow" });
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));
    expect([...recordedSkeletons(repo.rawState()).keys()]).toEqual([PATHS.tsPricing, PATHS.tsQuotes]);
    expect(recordedOutcomes(repo.rawState(), "T4").get(PATHS.tsPricing)).toEqual(written);
    expect(storedTask(repo.rawState(), "T4").active_implementation_attempt).toBeDefined();
  });

  it("blocks a stage-two problem with the alias, the binding file and the types file, reserving and writing nothing", async () => {
    const repo = skeletonRepo({ tsTypesText: TS_TYPES_TEXT.replace("export type ParseOrderFn = (raw: string) => Order;\n", "") });
    const before = repo.read(STATE);

    const result = await createValidateTaskExecutionHandler([])(claudeStdin(repo, "T4"), []);

    expect(result.kind).toBe("block");
    if (result.kind !== "block") return;
    expect(result.message).toContain(`${PATHS.tsPricing} binds ParseOrderFn, but the frozen types file ${TS_CONTRACT.types} declares no ParseOrderFn`);
    expect(repo.read(PATHS.tsPricing)).toBeNull();
    expect(repo.read(STATE)).toBe(before);
  });
});

describe("the Pi spawn lifecycle's registration call", () => {
  it("materializes at the spawn's repository, in sequential mode with a pre-roster observation", async () => {
    const repo = skeletonRepo();
    const spawns = [spawnFor(repo.rawState(), "T5")];

    const outcome = await registerTaskExecutionBatch(
      spawns,
      "sequential",
      { kind: "pre-roster-current-protocol", anyActiveForGraph: false },
      repo.root,
    );

    expect(outcome.kind).toBe("registered");
    expect(repo.read(PATHS.javaPricing)).toBe(canonicalSkeletonOf(PATHS.javaPricing));
    expect(repo.read(PATHS.javaExisting)).toBe(JAVA_EXISTING_TEXT);
    expect(Object.fromEntries(recordedOutcomes(repo.rawState(), "T5"))).toEqual({
      [PATHS.javaPricing]: written,
      [PATHS.javaExisting]: { kind: "exists-not-skeletonized" },
      [PATHS.javaDiscounts]: { kind: "no-bound-exports" },
    });
  });
});

describe("refusals are values", () => {
  it("blocks a types file whose bytes drifted from the freeze stamp, writing nothing", async () => {
    const repo = skeletonRepo();
    repo.write(TS_CONTRACT.types, `${TS_TYPES_TEXT}// drifted\n`);
    const before = repo.read(STATE);

    const outcome = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")]);

    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.message).toContain(`the frozen types file ${TS_CONTRACT.types} no longer matches its Acceptance Freeze stamp`);
    }
    expect(repo.read(PATHS.tsPricing)).toBeNull();
    expect(repo.read(STATE)).toBe(before);
  });

  it("a refused write blocks the batch with the State File untouched; the next registration adopts what was written, changing 0 bytes", async () => {
    const repo = skeletonRepo();
    // The Java Task's directory is a symlink: the writer refuses its skeletons
    // after the TypeScript Task's were already written.
    const directory = dirname(PATHS.javaPricing);
    const outside = join(repo.root, "outside");
    rmSync(join(repo.root, PATHS.javaExisting));
    renameSync(join(repo.root, directory), outside);
    symlinkSync(outside, join(repo.root, directory));
    const before = repo.read(STATE);

    const refused = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4"), spawnFor(repo.rawState(), "T5")]);

    expect(refused.kind).toBe("block");
    if (refused.kind === "block") expect(refused.message).toContain(`${PATHS.javaPricing}: refused (symlinked-ancestor)`);
    expect(repo.read(STATE)).toBe(before);
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    const inode = statSync(join(repo.root, PATHS.tsPricing)).ino;
    // The operator repairs the directory.
    rmSync(join(repo.root, directory));
    renameSync(outside, join(repo.root, directory));
    repo.write(PATHS.javaExisting, JAVA_EXISTING_TEXT);

    const adopted = await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")]);

    expect(adopted.kind).toBe("registered");
    expect(statSync(join(repo.root, PATHS.tsPricing)).ino).toBe(inode);
    expect(repo.read(PATHS.tsPricing)).toBe(canonicalSkeletonOf(PATHS.tsPricing));
    expect(recordedSkeletons(repo.rawState()).get(PATHS.tsPricing)).toMatchObject({
      origin: "spawn",
      engineSha256: sha256(canonicalSkeletonOf(PATHS.tsPricing)),
      typesSha256: sha256(TS_TYPES_TEXT),
    });
    expect(recordedOutcomes(repo.rawState(), "T4").get(PATHS.tsPricing)).toEqual(written);
  });

  it("a write whose locked record never landed is adopted by content at the next registration", async () => {
    const repo = skeletonRepo();
    const manager = StateManager.fromPath(repo.statePath);
    if (manager === null) throw new Error("fixture State File missing");
    const unrecorded = materializeTaskSkeletons(repo.root, manager.load(), ["T4"]);
    expect(unrecorded.ok).toBe(true);
    expect(recordedSkeletons(repo.rawState()).size).toBe(0);
    const inode = statSync(join(repo.root, PATHS.tsQuotes)).ino;

    expect((await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")])).kind).toBe("registered");

    expect(statSync(join(repo.root, PATHS.tsQuotes)).ino).toBe(inode);
    expect([...recordedSkeletons(repo.rawState()).keys()]).toEqual([PATHS.tsPricing, PATHS.tsQuotes]);
  });
});

describe("a graph populated before G2", () => {
  it("materializes nothing and records no outcome", async () => {
    const repo = skeletonRepo();
    repo.rewriteState(({ export_bindings: _dropped, ...rest }) => rest);

    expect((await registerTaskExecutionBatch([spawnFor(repo.rawState(), "T4")])).kind).toBe("registered");

    expect(repo.read(PATHS.tsPricing)).toBeNull();
    expect(storedTask(repo.rawState(), "T4").skeleton_outcomes).toBeUndefined();
    expect(repo.rawState().skeletons).toBeUndefined();
  });
});

describe("NFR-001: a 20-file Wave", () => {
  it("materializes twenty bound skeletons in under 2 s", () => {
    const root = canonicalTempDir("loom-skeleton-timing-");
    roots.push(root);
    const typesPath = "src/contract/types.ts";
    const acceptancePath = "tests/ct-1.acceptance.test.ts";
    const typesText = "export type PriceOrderFn = (raw: string) => string;\nexport type ParseOrderFn = (raw: string) => number;\n";
    const acceptanceText = "import type { PriceOrderFn } from \"../src/contract/types\";\n";
    for (const [path, text] of [[typesPath, typesText], [acceptancePath, acceptanceText]] as const) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const contract: AcceptanceContract = {
      schemaVersion: 1,
      id: "CT-1",
      title: "CT-1",
      statement: "CT-1 behaves as declared.",
      contractTask: "T1",
      types: { kind: "file", path: typesPath },
      acceptance: [{ path: acceptancePath, anchors: ["FR-001"] }],
      supportedDomain: null,
      freeze: {
        state: "frozen",
        wave: 1,
        paths: [{ path: typesPath, sha256: contentDigest(typesText) }, { path: acceptancePath, sha256: contentDigest(acceptanceText) }],
        roster: [{ file: acceptancePath, name: "FR-001: decides", anchors: ["FR-001"] }],
      },
      revisions: [],
    };
    const taskIds = ["T2", "T3", "T4", "T5"];
    const files = (taskId: string): readonly string[] => Array.from({ length: 5 }, (_, at) => `src/${taskId.toLowerCase()}/module-${at}.ts`);
    const binding = (path: string): ExportBinding => ({
      path,
      contract: "CT-1",
      exports: [
        { name: "priceOrder" as Identifier, alias: "PriceOrderFn" as Identifier },
        { name: "parseOrder" as Identifier, alias: "ParseOrderFn" as Identifier },
      ],
    });
    const graph: TaskGraph = {
      ...graphFixture(taskIds.map((id) => taskFixture({
        id,
        description: id,
        agent: "code-implementer-agent",
        wave: 2,
        depends_on: ["T1"],
        file_list: [...files(id)],
        spec_anchors: [],
        spec_contributions: [],
        new_tests_required: false,
      }))),
      acceptance_contracts: [contract],
      export_bindings: taskIds.flatMap(files).map(binding),
    };

    const started = performance.now();
    const result = materializeTaskSkeletons(root, graph, taskIds);
    const elapsed = performance.now() - started;

    expect(result.ok && result.value.records.length).toBe(20);
    expect(elapsed).toBeLessThan(2000);
  });
});
