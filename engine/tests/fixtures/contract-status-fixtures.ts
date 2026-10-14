/**
 * State File fixtures for `helper contract-status` tests: Tasks, Acceptance
 * Contracts, and a TaskGraph proven loadable by the production parser before
 * it is written, so a failing test is the helper's behavior, never a fixture
 * no engine could load.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AcceptanceContract, FrozenPathDigest } from "../../src/core/acceptance-contract";
import type { Task } from "../../src/types";
import { digest } from "./acceptance-fixtures";
import { canonicalTempDir } from "./canonical-temp-dir";
import { graphFixture, protectedGraphFixture, taskFixture } from "./task-lifecycle";

/** A contract's frozen surface: its types file and its one acceptance file. */
export type ContractSurface = Readonly<{ types: string; acceptance: string }>;

export const surface = (slug: string): ContractSurface => ({
  types: `src/${slug}-types.ts`,
  acceptance: `tests/${slug}.acceptance.test.ts`,
});

/** The surface's frozen paths, both digested from one fill byte. */
export const frozenPaths = ({ types, acceptance }: ContractSurface, fill: string): readonly [FrozenPathDigest, FrozenPathDigest] => [
  { path: types, sha256: digest(fill) },
  { path: acceptance, sha256: digest(fill) },
];

export const task = (id: string, wave: number, files: readonly string[], anchors: readonly string[] = []): Task =>
  taskFixture({
    id,
    description: id,
    agent: "code-implementer-agent",
    wave,
    depends_on: [],
    file_list: [...files],
    spec_anchors: [...anchors],
    spec_contributions: [],
  });

export type ContractOptions = Readonly<{
  id: string;
  title?: string;
  contractTask?: string;
  surface: ContractSurface;
  anchors: readonly [string, ...string[]];
  freeze: AcceptanceContract["freeze"];
  revisions?: AcceptanceContract["revisions"];
}>;

export const contract = ({
  id,
  title = `${id} title`,
  contractTask = "T1",
  surface: files,
  anchors,
  freeze,
  revisions = [],
}: ContractOptions): AcceptanceContract => ({
  schemaVersion: 1,
  id,
  title,
  statement: `${title} behaves as declared.`,
  contractTask,
  types: { kind: "file", path: files.types },
  acceptance: [{ path: files.acceptance, anchors }],
  supportedDomain: null,
  freeze,
  revisions,
});

/** A fresh Git repository; its root is pushed onto `cleanup`. */
export function gitProject(prefix: string, cleanup: string[]): string {
  const root = canonicalTempDir(prefix);
  cleanup.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** The State File path under a project root. */
export const statePathIn = (root: string): string => join(root, ".loom", "active_task_graph.json");

/** Writes raw State File text under `root`; returns its path. */
export function writeStateFile(root: string, text: string): string {
  const statePath = statePathIn(root);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, text);
  return statePath;
}

/** A v2 TaskGraph's JSON text, after proving the production parser admits it. */
export function stateFileJson(tasks: readonly Task[], contracts?: readonly AcceptanceContract[]): string {
  const raw = {
    spec_trace_version: 2,
    ...graphFixture(tasks),
    ...(contracts === undefined ? {} : { acceptance_contracts: contracts }),
  };
  protectedGraphFixture(JSON.parse(JSON.stringify(raw)));
  return JSON.stringify(raw);
}
