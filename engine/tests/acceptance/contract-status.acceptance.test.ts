/**
 * CT-1 acceptance: `helper contract-status` through the real entry point.
 *
 * Every testcase spawns `bun engine/src/cli.ts helper contract-status` from the
 * repository root with LOOM_STATE_PATH naming a fixture State File in a
 * canonical temp dir, and asserts stdout, stderr and the exit code. Each
 * fixture graph is first proven loadable by the production State File parser,
 * so a failure here is the helper's behavior, never a fixture no engine could
 * load.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { NO_ACCEPTANCE_CONTRACTS } from "../../src/core/contract-status-types";
import type { Task } from "../../src/types";
import {
  contract,
  frozenPaths as paths,
  gitProject,
  stateFileJson,
  statePathIn,
  surface,
  task,
  writeStateFile,
} from "../fixtures/contract-status-fixtures";

const REPO_ROOT = resolve(__dirname, "../../..");
const CLI = "engine/src/cli.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Run = Readonly<{ stdout: string; stderr: string; status: number | null }>;

/** The real entry point, run exactly as an operator types it. */
function contractStatus(statePath: string): Run {
  const result = spawnSync("bun", [CLI, "helper", "contract-status"], {
    cwd: REPO_ROOT,
    env: { ...process.env, LOOM_STATE_PATH: statePath },
    input: "",
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

const lines = (stdout: string): readonly string[] => stdout.replace(/\n$/, "").split("\n");

/** A fresh Git repository to hold one State File. */
const project = (): string => gitProject("loom-contract-status-", cleanup);

/** Write a TaskGraph the production parser admits; returns its State File path. */
const stateFile = (tasks: readonly Task[], contracts?: readonly AcceptanceContract[]): string =>
  writeStateFile(project(), stateFileJson(tasks, contracts));

describe("helper contract-status (CT-1)", () => {
  it("AS-001: shows each contract's id, title and contract Task, one awaiting RED and one frozen at its Wave", () => {
    const ledger = surface("ledger");
    const payload = surface("payload");
    const statePath = stateFile(
      [
        task("T1", 1, [ledger.types, ledger.acceptance]),
        task("T2", 2, [payload.types, payload.acceptance]),
        task("T3", 3, ["src/ledger.ts"], ["AS-001"]),
        task("T4", 3, ["src/payload.ts"], ["AS-002"]),
      ],
      [
        contract({ id: "CT-1", title: "Ledger balance", surface: ledger, anchors: ["AS-001"], freeze: { state: "awaiting-red" } }),
        contract({
          id: "CT-2",
          title: "Payload shape",
          contractTask: "T2",
          surface: payload,
          anchors: ["AS-002"],
          freeze: {
            state: "frozen",
            wave: 2,
            paths: paths(payload, "a"),
            roster: [{ file: payload.acceptance, name: "payload > AS-002: one call wins", anchors: ["AS-002"] }],
          },
        }),
      ],
    );

    const run = contractStatus(statePath);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const out = lines(run.stdout);
    const first = out.indexOf("CT-1  Ledger balance  (contract Task T1)");
    const second = out.indexOf("CT-2  Payload shape  (contract Task T2)");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(out.slice(first, second)).toContain("awaiting RED");
    expect(out.slice(second)).toContain("frozen at Wave 2");
    expect(out.slice(first, second)).not.toContain("frozen at Wave 2");
  });

  it("AS-002: lists every roster testcase with its anchors and each covered anchor's due Wave or unclaimed", () => {
    const payload = surface("payload");
    const statePath = stateFile(
      [
        task("T1", 1, [payload.types, payload.acceptance]),
        task("T2", 2, ["src/payload-wire.ts"]),
        task("T3", 3, ["src/payload.ts"], ["AS-001"]),
      ],
      [
        contract({
          id: "CT-1",
          title: "Payload shape",
          surface: payload,
          anchors: ["AS-001", "AS-002", "AS-003"],
          freeze: {
            state: "frozen",
            wave: 1,
            paths: paths(payload, "b"),
            roster: [
              { file: payload.acceptance, name: "payload > AS-001: AS-002: one call wins", anchors: ["AS-001", "AS-002"] },
              { file: payload.acceptance, name: "payload > AS-003: a refusal names the field", anchors: ["AS-003"] },
            ],
          },
        }),
      ],
    );

    const run = contractStatus(statePath);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const out = lines(run.stdout);
    expect(out[0]).toBe("CT-1  Payload shape  (contract Task T1)");
    expect(out).toContain("frozen at Wave 1");
    expect(out).toContain(`${payload.acceptance} › payload > AS-001: AS-002: one call wins — AS-001, AS-002`);
    expect(out).toContain(`${payload.acceptance} › payload > AS-003: a refusal names the field — AS-003`);
    // In covered order; a claimed anchor is due at its claiming Task's Wave,
    // never the contract Task's own Wave.
    expect(out.filter((line) => /^AS-00\d (due Wave \d+|unclaimed)$/.test(line))).toEqual([
      "AS-001 due Wave 3",
      "AS-002 unclaimed",
      "AS-003 unclaimed",
    ]);
  });

  it("AS-003: shows a revised contract's freeze state as revised and its number of revisions", () => {
    const payload = surface("payload");
    const original = paths(payload, "c");
    const first = paths(payload, "d");
    const second = paths(payload, "e");
    const statePath = stateFile(
      [
        task("T1", 1, [payload.types, payload.acceptance]),
        task("T2", 2, ["src/payload.ts"], ["AS-001"]),
      ],
      [
        contract({
          id: "CT-1",
          title: "Payload shape",
          surface: payload,
          anchors: ["AS-001"],
          freeze: { state: "revised", paths: second },
          revisions: [
            { revision: 1, reason: "AS-001 asserted the wrong variant", previous: original, paths: first, revalidatedTaskIds: ["T2"] },
            { revision: 2, reason: "AS-001 named the wrong field", previous: first, paths: second, revalidatedTaskIds: ["T2"] },
          ],
        }),
      ],
    );

    const run = contractStatus(statePath);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const out = lines(run.stdout);
    expect(out[0]).toBe("CT-1  Payload shape  (contract Task T1)");
    expect(out).toContain("revised (2 revisions); roster cleared until the next Wave Gate re-records it");
    expect(out).toContain("revisions: 2");
    expect(out).toContain("AS-001 due Wave 2");
    expect(out.some((line) => line.startsWith("frozen at Wave"))).toBe(false);
  });

  it("AS-004: a TaskGraph without contracts prints \"no Acceptance Contracts\" and succeeds", () => {
    const statePath = stateFile([task("T1", 1, ["src/a.ts"])]);

    const run = contractStatus(statePath);

    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`${NO_ACCEPTANCE_CONTRACTS}\n`);
    expect(run.status).toBe(0);
  });

  it("AS-004: with no TaskGraph it refuses with the path it looked for", () => {
    const statePath = statePathIn(project());

    const run = contractStatus(statePath);

    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(statePath);
    expect(run.stderr).not.toContain("Unknown handler");
    expect(run.status).toBe(1);
  });
});
