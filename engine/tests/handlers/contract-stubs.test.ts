/**
 * Contract stubs at the contract Task's stop (plan AD-9), through both stop
 * shells and the shared step they call.
 *
 * - Claude Code: `runDispatch` (the SubagentStop dispatcher) writes CT-1's
 *   stubs before the stop checks reach for the repository, and names an
 *   unresolvable binding in the stop's output.
 * - Pi: `reportContractStubs` (called in `pi/subagent-stop.ts` before the
 *   report-only stop checks) writes the same stubs and returns the problems as
 *   the parent model's note.
 * - The step itself, `materializeContractStubs`: idempotent, refreshes an
 *   untouched stub whose canonical bytes changed, never touches a modified
 *   one, writes nothing for a Task that is no contract Task, and stubs Java
 *   contracts too.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportContractStubs } from "../../../pi/subagent-stop";
import type { ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { UNKEPT_BLOCK_COUNTERS, type StopCheckShellPorts } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { publishImplementationAttemptSidecar } from "../../src/implementation-attempt-sidecar";
import {
  contractStubStopNote,
  materializeContractStubs,
  renderContractStubs,
  stubbedContracts,
} from "../../src/orchestration/contract-stub-materialization";
import { StateManager } from "../../src/state-manager";
import type { HookResult } from "../../src/types";
import {
  canonicalSkeletonOf,
  canonicalTsSkeleton,
  cleanupSkeletonRepos,
  JAVA_CONTRACT,
  JAVA_TYPES_TEXT,
  PATHS,
  recordedSkeletons,
  sha256,
  skeletonRepo,
  spawnFor,
  TS_CONTRACT,
  TS_TYPES_TEXT,
  type SkeletonRepo,
} from "../fixtures/skeleton-repo";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupSkeletonRepos();
});

const SESSION = "contract-stubs-session";
const AGENT = "contract-stubs-agent";
const CT1_STUBS = [PATHS.tsPricing, PATHS.tsQuotes, PATHS.tsLegacy] as const;
const CT2_STUBS = [PATHS.javaPricing, PATHS.javaExisting] as const;
const TS_TYPES_WITHOUT_PARSE_ORDER = TS_TYPES_TEXT.replace("export type ParseOrderFn = (raw: string) => Order;\n", "");

const managerOf = (repo: SkeletonRepo): StateManager => {
  const manager = StateManager.fromPath(repo.statePath);
  if (manager === null) throw new Error("fixture State File missing");
  return manager;
};

/** A contract-Wave repository whose contract Task agents have written their sources. */
function contractWave(): SkeletonRepo {
  const repo = skeletonRepo({ stage: "contract-wave" });
  repo.writeContractSources();
  return repo;
}

/** The acceptance file now imports the types file `.js`-style: the canonical specifier follows. */
const importJsStyle = (repo: SkeletonRepo): void =>
  repo.write(TS_CONTRACT.acceptance, (repo.read(TS_CONTRACT.acceptance) ?? "").replace(
    '"../src/order/order-contract"',
    '"../src/order/order-contract.js"',
  ));

async function registered(repo: SkeletonRepo, taskId: string): Promise<ImplementationAttemptAuthority> {
  const outcome = await registerTaskExecutionBatch([spawnFor(repo.rawState(), taskId)]);
  if (outcome.kind !== "registered") throw new Error(`registration refused: ${outcome.message}`);
  const [authority] = outcome.authorities;
  if (authority === undefined) throw new Error(`no authority for ${taskId}`);
  return authority;
}

type Seen = { atCheck: Readonly<Record<string, boolean>> | null };

/** Stop ports that never decide, but record which stubs existed when the stop
 *  check first reached for the repository root. */
function observingPorts(repo: SkeletonRepo, seen: Seen): StopCheckShellPorts {
  return {
    repositoryRoot: () => {
      if (seen.atCheck === null) seen.atCheck = Object.fromEntries(CT1_STUBS.map((path) => [path, existsSync(join(repo.root, path))]));
      return { ok: false, reason: "the test's stop check does not decide" };
    },
    acquireRunner: () => ({ kind: "acquired", release: () => null }),
    runCheck: async () => { throw new Error("the test's stop check never runs a check"); },
    readReport: () => new Uint8Array(),
    blocks: UNKEPT_BLOCK_COUNTERS,
    pathExists: () => true,
    now: () => Date.now(),
  };
}

/** Register T1, let `writeSources` stand in for its agent, and stop it through the Claude dispatcher. */
async function claudeStop(repo: SkeletonRepo, writeSources: () => void): Promise<{ result: HookResult; seen: Seen }> {
  const authority = await registered(repo, "T1");
  writeSources();
  publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: repo.statePath, authority });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), repo.statePath);
  const seen: Seen = { atCheck: null };
  const stdin = JSON.stringify({ session_id: SESSION, agent_id: AGENT, agent_type: "code-implementer-agent", hook_event_name: "SubagentStop" });
  const result = await runDispatch(stdin, [], async () => ({ kind: "passthrough" }), observingPorts(repo, seen));
  return { result, seen };
}

describe("the Claude Code stop shell (dispatch.ts)", () => {
  it("AS-043: writes every CT-1 stub, in the skeleton format, before the stop checks reach the repository", async () => {
    const repo = skeletonRepo({ stage: "contract-wave" });

    const { seen } = await claudeStop(repo, () => repo.writeContractSources());

    expect(seen.atCheck).toEqual(Object.fromEntries(CT1_STUBS.map((path) => [path, true])));
    for (const path of CT1_STUBS) expect(repo.read(path), path).toBe(canonicalSkeletonOf(path));
    expect(repo.read(PATHS.pythonRates)).toBeNull();
    // CT-2 belongs to T2: its stubs wait for T2's own stop.
    for (const path of CT2_STUBS) expect(repo.read(path), path).toBeNull();
  });

  it("FR-023: an unresolvable binding writes no stub and is named in the stop's output; the rest are still written", async () => {
    const repo = skeletonRepo({ stage: "contract-wave" });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { result } = await claudeStop(repo, () => {
      repo.writeContractSources();
      repo.write(TS_CONTRACT.types, TS_TYPES_WITHOUT_PARSE_ORDER);
    });

    expect(repo.read(PATHS.tsPricing)).toBeNull();
    expect(repo.read(PATHS.tsQuotes)).toBe(canonicalSkeletonOf(PATHS.tsQuotes));
    expect(repo.read(PATHS.tsLegacy)).toBe(canonicalSkeletonOf(PATHS.tsLegacy));
    const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(printed).toContain("ParseOrderFn");
    expect(printed).toContain(PATHS.tsPricing);
    const said = JSON.stringify(result);
    expect(said).toContain("ParseOrderFn");
  });
});

describe("the Pi stop shell (pi/subagent-stop.ts)", () => {
  it("FR-023: reportContractStubs writes and records the contract Task's stubs, and has nothing to say when all resolve", async () => {
    const repo = contractWave();
    const lines: string[] = [];

    const note = await reportContractStubs(managerOf(repo), "T1", (line) => lines.push(line));

    expect(note).toBeNull();
    expect(lines).toEqual([]);
    for (const path of CT1_STUBS) expect(repo.read(path), path).toBe(canonicalSkeletonOf(path));
    expect([...recordedSkeletons(repo.rawState()).values()].map(({ path, origin }) => [path, origin])).toEqual(
      [...CT1_STUBS].sort().map((path) => [path, "contract-stub"]),
    );
  });

  it("FR-023: an unresolvable binding becomes the parent model's note and an operator line", async () => {
    const repo = contractWave();
    repo.write(TS_CONTRACT.types, TS_TYPES_WITHOUT_PARSE_ORDER);
    const lines: string[] = [];

    const note = await reportContractStubs(managerOf(repo), "T1", (line) => lines.push(line));

    expect(note?.taskId).toBe("T1");
    expect(note?.message).toContain("ParseOrderFn");
    expect(note?.message).toContain(PATHS.tsPricing);
    expect(lines).toEqual([note?.message]);
    expect(repo.read(PATHS.tsPricing)).toBeNull();
  });

  it("does nothing for a result with no Task", async () => {
    const repo = contractWave();
    expect(await reportContractStubs(managerOf(repo), null, () => undefined)).toBeNull();
    for (const path of CT1_STUBS) expect(repo.read(path), path).toBeNull();
  });
});

describe("materializeContractStubs", () => {
  it("FR-023: records each stub as an origin `contract-stub` skeleton of the contract's current types", async () => {
    const repo = contractWave();

    const result = await materializeContractStubs(repo.root, managerOf(repo), "T1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.problems).toEqual([]);
      expect(result.value.written.map(({ path }) => path)).toEqual([...CT1_STUBS]);
    }
    const records = recordedSkeletons(repo.rawState());
    for (const path of CT1_STUBS) {
      expect(records.get(path)).toEqual({
        path,
        contract: "CT-1",
        language: "typescript",
        origin: "contract-stub",
        engineSha256: sha256(canonicalSkeletonOf(path)),
        typesSha256: sha256(TS_TYPES_TEXT),
        stale: null,
      });
    }
  });

  it("FR-023: is idempotent: a second stop rewrites nothing and records nothing new", async () => {
    const repo = contractWave();
    await materializeContractStubs(repo.root, managerOf(repo), "T1");
    const before = repo.rawState();

    const again = await materializeContractStubs(repo.root, managerOf(repo), "T1");

    expect(again.ok && again.value).toEqual({ written: [], problems: [] });
    expect(repo.rawState()).toEqual(before);
    for (const path of CT1_STUBS) expect(repo.read(path), path).toBe(canonicalSkeletonOf(path));
  });

  it("AS-043: refreshes an untouched stub whose canonical bytes changed after further edits", async () => {
    const repo = contractWave();
    await materializeContractStubs(repo.root, managerOf(repo), "T1");
    importJsStyle(repo);

    const result = await materializeContractStubs(repo.root, managerOf(repo), "T1");

    const refreshed = canonicalTsSkeleton(PATHS.tsQuotes, [{ name: "quote", alias: "PriceOrderFn" }])
      .replace('"./order-contract"', '"./order-contract.js"');
    expect(repo.read(PATHS.tsQuotes)).toBe(refreshed);
    expect(result.ok && result.value.written.map(({ path }) => path)).toEqual([...CT1_STUBS]);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.tsQuotes)).toMatchObject({ origin: "contract-stub", engineSha256: sha256(refreshed) });
  });

  it("never touches a stub the contract Task's agent modified, and leaves its record as it was", async () => {
    const repo = contractWave();
    await materializeContractStubs(repo.root, managerOf(repo), "T1");
    const edited = "export const priceOrder = 1;\n";
    repo.write(PATHS.tsPricing, edited);
    importJsStyle(repo);

    const result = await materializeContractStubs(repo.root, managerOf(repo), "T1");

    expect(repo.read(PATHS.tsPricing)).toBe(edited);
    expect(result.ok && result.value.written.map(({ path }) => path)).toEqual([PATHS.tsQuotes, PATHS.tsLegacy]);
    expect(recordedSkeletons(repo.rawState()).get(PATHS.tsPricing)).toMatchObject({
      engineSha256: sha256(canonicalSkeletonOf(PATHS.tsPricing)),
    });
  });

  it("stubs a Java contract from its holder, for its own contract Task only", async () => {
    const repo = contractWave();

    const result = await materializeContractStubs(repo.root, managerOf(repo), "T2");

    expect(result.ok && result.value.problems).toEqual([]);
    for (const path of CT2_STUBS) expect(repo.read(path), path).toBe(canonicalSkeletonOf(path));
    for (const path of CT1_STUBS) expect(repo.read(path), path).toBeNull();
    expect(recordedSkeletons(repo.rawState()).get(PATHS.javaPricing)).toMatchObject({
      contract: JAVA_CONTRACT.id,
      language: "java",
      origin: "contract-stub",
      typesSha256: sha256(JAVA_TYPES_TEXT),
    });
  });

  it("writes nothing for a Task that is no contract Task, or a contract Task of a contract with no types file", async () => {
    const repo = contractWave();
    const state = repo.rawState();

    for (const taskId of ["T3", "T4", "T9"]) {
      const result = await materializeContractStubs(repo.root, managerOf(repo), taskId);
      expect(result.ok && result.value, taskId).toEqual({ written: [], problems: [] });
    }

    expect(repo.rawState()).toEqual(state);
    for (const path of [...CT1_STUBS, ...CT2_STUBS]) expect(repo.read(path), path).toBeNull();
  });

  it("names an unreadable types file as a problem and writes nothing for that contract", async () => {
    const repo = skeletonRepo({ stage: "contract-wave" });

    const result = await materializeContractStubs(repo.root, managerOf(repo), "T1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.written).toEqual([]);
      expect(result.value.problems).toEqual([expect.objectContaining({ kind: "types-unparseable", typesFile: TS_CONTRACT.types })]);
    }
    for (const path of CT1_STUBS) expect(repo.read(path), path).toBeNull();
  });
});

describe("stubbedContracts", () => {
  it("is exactly the typed contracts with bindings whose contract Task is the stopping Task", () => {
    const repo = contractWave();
    const graph = managerOf(repo).load();
    expect(stubbedContracts(graph, "T1").map(({ id }) => id)).toEqual(["CT-1"]);
    expect(stubbedContracts(graph, "T2").map(({ id }) => id)).toEqual(["CT-2"]);
    expect(stubbedContracts(graph, "T3")).toEqual([]);
    expect(stubbedContracts(graph, "T4")).toEqual([]);
    expect(stubbedContracts({ ...graph, export_bindings: [] } as typeof graph, "T1")).toEqual([]);
  });
});

describe("renderContractStubs and contractStubStopNote", () => {
  it("says nothing when every stub resolved", () => {
    expect(renderContractStubs("T1", { ok: true, value: { written: [], problems: [] } })).toBeNull();
  });

  it("names each problem on its own line, and an infrastructure failure as one line", () => {
    const rendered = renderContractStubs("T1", {
      ok: true,
      value: {
        written: [],
        problems: [
          { kind: "missing-alias", alias: "ParseOrderFn", path: PATHS.tsPricing, typesFile: TS_CONTRACT.types },
          { kind: "language-mismatch", path: PATHS.javaPricing, contract: "CT-1", typesFile: TS_CONTRACT.types },
          { kind: "write-failed", path: PATHS.tsQuotes, detail: "refused (symlinked-ancestor)" },
        ],
      },
    });
    expect(rendered).toBe([
      "contract stubs of T1: not every stub could be written; its acceptance tests cannot import what is missing",
      `- ${PATHS.tsPricing} binds ParseOrderFn, but the frozen types file ${TS_CONTRACT.types} declares no ParseOrderFn`,
      `- ${PATHS.javaPricing} binds CT-1, whose types file ${TS_CONTRACT.types} is in another language`,
      `- ${PATHS.tsQuotes}: refused (symlinked-ancestor)`,
    ].join("\n"));
    expect(renderContractStubs("T1", { ok: false, error: "lock timeout" })).toBe(
      "contract stubs of T1: the engine could not write them (lock timeout)",
    );
  });

  it("contractStubStopNote is total: a store that cannot load becomes a note, never a throw", async () => {
    const note = await contractStubStopNote({
      load: () => { throw new Error("state file is corrupt"); },
      getPath: () => "/nowhere/state.json",
      updateAndReturn: async () => { throw new Error("never reached"); },
    }, "T1");
    expect(note).toBe("contract stubs of T1: the engine could not write them (state file is corrupt)");
  });
});
