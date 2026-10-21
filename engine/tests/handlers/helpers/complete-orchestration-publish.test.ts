/**
 * The archive-then-remove ordering of `complete-orchestration`, pinned at the
 * filesystem seam: the archive is published whole before the live graph is
 * removed, so a removal that fails leaves BOTH files and reports the failure,
 * and no publish ever leaves a prepared (partial) name behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completedGraphArchiveLeaf } from "../../../src/core/orchestration-completion";
import { completeOrchestration } from "../../../src/handlers/helpers/complete-orchestration";
import { graphFixture, taskFixture } from "../../fixtures/task-lifecycle";

const removal = vi.hoisted(() => ({ fail: false }));

vi.mock("../../../src/orchestration/no-follow-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/orchestration/no-follow-fs")>();
  return {
    ...actual,
    removeDirectoryRegularFileNoFollow: (...args: Parameters<typeof actual.removeDirectoryRegularFileNoFollow>) => {
      if (removal.fail) throw new Error("EIO: injected live-graph removal failure");
      actual.removeDirectoryRegularFileNoFollow(...args);
    },
  };
});

const NOW_MS = Date.UTC(2026, 9, 21, 9, 2, 7);

describe("complete-orchestration publish ordering", () => {
  let stateDir: string;
  let statePath: string;
  const graph = { ...graphFixture([taskFixture({ id: "T1", description: "T1", wave: 1, depends_on: [], agent: "code-implementer-agent", status: "completed" })]), github_issue: 9 };

  beforeEach(() => {
    stateDir = join(realpathSync(mkdtempSync(join(tmpdir(), "loom-complete-publish-"))), ".claude", "state");
    mkdirSync(stateDir, { recursive: true });
    statePath = join(stateDir, "active_task_graph.json");
    removal.fail = false;
  });

  afterEach(() => {
    rmSync(join(stateDir, "..", ".."), { recursive: true, force: true });
  });

  function install(): string {
    const bytes = JSON.stringify(graph, null, 2);
    writeFileSync(statePath, bytes);
    chmodSync(statePath, 0o444);
    return bytes;
  }

  const prepared = () => readdirSync(stateDir).filter((name) => name.includes(".claim-"));

  it("a removal failure after the archive is published leaves both files and reports it", async () => {
    const bytes = install();
    removal.fail = true;

    await expect(completeOrchestration(statePath, NOW_MS)).rejects.toThrow("injected live-graph removal failure");

    expect(readFileSync(statePath, "utf-8")).toBe(bytes);
    expect(readFileSync(join(stateDir, completedGraphArchiveLeaf(graph, NOW_MS)), "utf-8")).toBe(bytes);
    expect(prepared()).toEqual([]);
  });

  it("a refused publish (existing archive) leaves no prepared name behind", async () => {
    const bytes = install();
    const leaf = completedGraphArchiveLeaf(graph, NOW_MS);
    writeFileSync(join(stateDir, leaf), "earlier archive\n");

    await expect(completeOrchestration(statePath, NOW_MS)).rejects.toThrow(/EEXIST/);

    expect(readFileSync(statePath, "utf-8")).toBe(bytes);
    expect(readFileSync(join(stateDir, leaf), "utf-8")).toBe("earlier archive\n");
    expect(prepared()).toEqual([]);
  });
});
