import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import contractStatus, { createContractStatusHandler } from "../../../src/handlers/helpers/contract-status";
import type { AcceptanceContract } from "../../../src/core/acceptance-contract";
import { NO_ACCEPTANCE_CONTRACTS } from "../../../src/core/contract-status-types";
import { WHITELISTED_HELPERS } from "../../../src/config";
import { KNOWN_HANDLERS, PI_RUNTIME_HANDSHAKE_ROUTES, piRuntimeHandshakeRequired } from "../../../src/handler-routes";
import type { Task } from "../../../src/types";
import { digest } from "../../fixtures/acceptance-fixtures";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { graphFixture, protectedGraphFixture, taskFixture } from "../../fixtures/task-lifecycle";

const cleanup: string[] = [];
let inheritedStatePath: string | undefined;
beforeEach(() => {
  inheritedStatePath = process.env.LOOM_STATE_PATH;
});
afterEach(() => {
  if (inheritedStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = inheritedStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const TYPES = "src/payload-types.ts";
const ACCEPTANCE = "tests/payload.acceptance.test.ts";
/** CT-2's own frozen surface: no path is frozen by two contracts. */
const CT2_TYPES = "src/ledger-types.ts";
const CT2_ACCEPTANCE = "tests/ledger.acceptance.test.ts";

const task = (id: string, wave: number, files: readonly string[], anchors: readonly string[] = []): Task =>
  taskFixture({
    id, description: id, agent: "code-implementer-agent", wave, depends_on: [],
    file_list: [...files], spec_anchors: [...anchors], spec_contributions: [],
  });

const contract = (
  id: string,
  anchors: readonly [string, ...string[]],
  freeze: AcceptanceContract["freeze"],
  revisions: AcceptanceContract["revisions"] = [],
  surface: Readonly<{ types: string; acceptance: string }> = { types: TYPES, acceptance: ACCEPTANCE },
): AcceptanceContract => ({
  schemaVersion: 1,
  id,
  title: `${id} title`,
  statement: `${id} behaves as declared.`,
  contractTask: "T1",
  types: { kind: "file", path: surface.types },
  acceptance: [{ path: surface.acceptance, anchors }],
  supportedDomain: null,
  freeze,
  revisions,
});

const PATHS = [{ path: TYPES, sha256: digest("a") }, { path: ACCEPTANCE, sha256: digest("a") }] as const;
const CT2_PATHS = [{ path: CT2_TYPES, sha256: digest("b") }, { path: CT2_ACCEPTANCE, sha256: digest("b") }] as const;

function project(): string {
  const root = canonicalTempDir("loom-contract-status-handler-");
  cleanup.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** Writes raw State File text; returns its path and points LOOM_STATE_PATH at it. */
function stateFileText(text: string): string {
  const statePath = join(project(), ".loom", "active_task_graph.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, text);
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}

function stateFile(tasks: readonly Task[], contracts?: readonly AcceptanceContract[]): string {
  const raw = {
    spec_trace_version: 2,
    ...graphFixture(tasks),
    ...(contracts === undefined ? {} : { acceptance_contracts: contracts }),
  };
  protectedGraphFixture(JSON.parse(JSON.stringify(raw)));
  return stateFileText(JSON.stringify(raw));
}

type Captured = { readonly writes: string[]; readonly write: (text: string) => void };
const captured = (): Captured => {
  const writes: string[] = [];
  return { writes, write: (text) => { writes.push(text); } };
};

const run = async (sink: Captured) => createContractStatusHandler(sink.write)("", []);

const TASKS = [
  task("T1", 1, [TYPES, ACCEPTANCE, CT2_TYPES, CT2_ACCEPTANCE]),
  task("T2", 2, ["src/payload.ts"], ["AS-001"]),
];

describe("contract-status helper", () => {
  it("is routed only as a read-only helper: not whitelisted in the guard, no Pi runtime handshake", () => {
    expect(KNOWN_HANDLERS.helper?.has("contract-status")).toBe(true);
    expect(WHITELISTED_HELPERS).not.toContain("contract-status");
    expect(PI_RUNTIME_HANDSHAKE_ROUTES.has("helper/contract-status")).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "contract-status")).toBe(false);
  });

  it("exports a default handler bound to stdout", () => {
    expect(typeof contractStatus).toBe("function");
  });

  it("AS-001: writes each contract's header and freeze state, awaiting RED or frozen at its Wave", async () => {
    stateFile(TASKS, [
      contract("CT-1", ["AS-001"], { state: "awaiting-red" }),
      contract("CT-2", ["AS-002"], {
        state: "frozen", wave: 1, paths: CT2_PATHS,
        roster: [{ file: CT2_ACCEPTANCE, name: "ledger > AS-002: wins", anchors: ["AS-002"] }],
      }, [], { types: CT2_TYPES, acceptance: CT2_ACCEPTANCE }),
    ]);
    const sink = captured();

    const result = await run(sink);

    expect(result).toEqual({ kind: "passthrough" });
    expect(sink.writes).toHaveLength(1);
    const out = sink.writes[0]!.split("\n");
    expect(out.at(-1)).toBe("");
    expect(out).toContain("CT-1  CT-1 title  (contract Task T1)");
    expect(out).toContain("awaiting RED");
    expect(out).toContain("CT-2  CT-2 title  (contract Task T1)");
    expect(out).toContain("frozen at Wave 1");
  });

  it("AS-002: writes each roster testcase with its anchors and each covered anchor's due Wave or unclaimed", async () => {
    stateFile(TASKS, [
      contract("CT-1", ["AS-001", "AS-002"], {
        state: "frozen", wave: 1, paths: PATHS,
        roster: [{ file: ACCEPTANCE, name: "payload > AS-001: AS-002: wins", anchors: ["AS-001", "AS-002"] }],
      }),
    ]);
    const sink = captured();

    await run(sink);

    const out = sink.writes.join("").split("\n");
    expect(out).toContain(`${ACCEPTANCE} › payload > AS-001: AS-002: wins — AS-001, AS-002`);
    expect(out).toContain("AS-001 due Wave 2");
    expect(out).toContain("AS-002 unclaimed");
  });

  it("AS-003: writes a revised contract's freeze state and revision count", async () => {
    stateFile(TASKS, [
      contract("CT-1", ["AS-001"], { state: "revised", paths: PATHS }, [
        { revision: 1, reason: "wrong variant", previous: PATHS, paths: PATHS, revalidatedTaskIds: ["T2"] },
      ]),
    ]);
    const sink = captured();

    await run(sink);

    const out = sink.writes.join("").split("\n");
    expect(out).toContain("revised (1 revision); roster cleared until the next Wave Gate re-records it");
    expect(out).toContain("revisions: 1");
  });

  it("AS-004: a TaskGraph without contracts writes the single no-contracts line and succeeds", async () => {
    stateFile(TASKS);
    const sink = captured();

    const result = await run(sink);

    expect(result).toEqual({ kind: "passthrough" });
    expect(sink.writes).toEqual([`${NO_ACCEPTANCE_CONTRACTS}\n`]);
  });

  it("AS-004: a missing TaskGraph is refused with the path it looked for and writes nothing", async () => {
    const statePath = join(project(), ".loom", "active_task_graph.json");
    process.env.LOOM_STATE_PATH = statePath;
    const sink = captured();

    const result = await run(sink);

    expect(result).toEqual({ kind: "error", message: `No task graph at ${statePath}` });
    expect(sink.writes).toEqual([]);
  });

  it("a corrupt TaskGraph is not treated as missing: the error carries the parser's message", async () => {
    const statePath = stateFileText("{ not json");
    const sink = captured();

    const result = await run(sink);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("Corrupt state file (invalid JSON)");
    expect(result.message).toContain(statePath);
    expect(result.message).not.toContain("No task graph");
    expect(sink.writes).toEqual([]);
  });

  it("a graph the parser rejects surfaces the parser's error", async () => {
    stateFileText(JSON.stringify({ tasks: "not-a-list" }));
    const sink = captured();

    const result = await run(sink);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toContain("Corrupt state file");
    expect(sink.writes).toEqual([]);
  });

  it("is read-only: the State File bytes are unchanged and no lock is left behind", async () => {
    const statePath = stateFile(TASKS, [contract("CT-1", ["AS-001"], { state: "awaiting-red" })]);
    const before = readFileSync(statePath);
    const entriesBefore = readdirSync(dirname(statePath)).sort();

    await run(captured());
    await run(captured());

    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(readdirSync(dirname(statePath)).sort()).toEqual(entriesBefore);
    expect(entriesBefore).toEqual(["active_task_graph.json"]);
  });
});
