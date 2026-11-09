/**
 * `reportContractStubs`, the Pi stop shell's contract stub step, over a fake
 * `ContractStubStore` and a captured operator channel: no Task says nothing
 * and reads nothing, a Task with nothing to stub says nothing, and whatever
 * the stub step must say is printed to the operator once and returned as the
 * parent model's `StopCheckNote`. The stub writing itself, through a real
 * repository, is covered in `tests/handlers/contract-stubs.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { reportContractStubs } from "../../../pi/subagent-stop";
import type { ContractStubStore } from "../../src/orchestration/contract-stub-materialization";
import type { TaskGraph } from "../../src/types";

/** A store whose loads are counted: `graph` is what it loads, or the fault it throws. */
function fakeStore(graph: TaskGraph | Error): Readonly<{ store: ContractStubStore; loads: () => number }> {
  let loads = 0;
  const store: ContractStubStore = {
    load: () => {
      loads += 1;
      if (graph instanceof Error) throw graph;
      return graph;
    },
    updateAndReturn: async () => { throw new Error("the fake store is never updated"); },
    getPath: () => "/nonexistent/active_task_graph.json",
  };
  return { store, loads: () => loads };
}

/** A graph with no Acceptance Contract: no Task of it stubs anything. */
const NO_CONTRACTS = { tasks: [] } as unknown as TaskGraph;

const captured = (): Readonly<{ lines: string[]; notify: (line: string) => void }> => {
  const lines: string[] = [];
  return { lines, notify: (line) => { lines.push(line); } };
};

describe("reportContractStubs (Pi stop shell)", () => {
  it("returns null for a result with no Task, reading nothing and printing nothing", async () => {
    const { store, loads } = fakeStore(NO_CONTRACTS);
    const operator = captured();

    expect(await reportContractStubs(store, null, operator.notify)).toBeNull();
    expect(loads()).toBe(0);
    expect(operator.lines).toEqual([]);
  });

  it("returns null when the stub step has nothing to say, printing nothing", async () => {
    const { store, loads } = fakeStore(NO_CONTRACTS);
    const operator = captured();

    expect(await reportContractStubs(store, "T1", operator.notify)).toBeNull();
    expect(loads()).toBe(1);
    expect(operator.lines).toEqual([]);
  });

  it("prints what the stub step says once and returns it as the Task's StopCheckNote", async () => {
    const { store } = fakeStore(new Error("the State File is unreadable"));
    const operator = captured();

    const note = await reportContractStubs(store, "T1", operator.notify);

    const message = "contract stubs of T1: the engine could not write them (the State File is unreadable)";
    expect(note).toEqual({ taskId: "T1", message });
    expect(operator.lines).toEqual([message]);
  });
});
