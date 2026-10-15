/**
 * TaskGraph fixtures for `helper stop-check-plan` tests: a verification
 * manifest frozen by the production freezer (with or without an acceptance
 * runner), frozen Acceptance Contracts over repository-relative acceptance
 * files, and a graph builder that proves the production State File parser
 * admits the graph before a test reads it. A failing test is therefore the
 * plan's behavior, never a fixture no engine could load.
 *
 * Tasks, contracts and the State File writers are reused from
 * `contract-status-fixtures.ts`.
 */

import type {
  AcceptanceContract,
  AcceptanceTestcase,
  ContractAcceptanceFile,
  FrozenPathDigest,
} from "../../src/core/acceptance-contract";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import type { Task, TaskGraph } from "../../src/types";
import { digest } from "./acceptance-fixtures";
import { contract } from "./contract-status-fixtures";
import { graphFixture, protectedGraphFixture } from "./task-lifecycle";

/** The report path the fixture runner writes, beneath the protected report root. */
export const ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.junit.xml";

/** The runner the operator froze for this repository: `npm run test:acceptance -- {files}` from `engine`. */
export const ENGINE_RUNNER = Object.freeze({
  executable: "npm",
  args: Object.freeze(["run", "test:acceptance", "--", "{files}"]),
  cwd: "engine",
  timeoutMs: 120_000,
  report: Object.freeze({ kind: "required-file", path: ACCEPTANCE_REPORT }),
});

/**
 * A schema-2 verification manifest frozen by the production freezer. `null`
 * declares no acceptance runner, so the stop check is off.
 */
export function frozenRunnerManifest(runner: unknown = ENGINE_RUNNER): FrozenVerificationManifest {
  const source = {
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    ...(runner === null ? {} : { acceptanceRunner: runner }),
  };
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify(source)));
  if (!frozen.ok) throw new Error(`fixture manifest refused: ${frozen.error.errors.join("; ")}`);
  return frozen.value;
}

/** A contract's surface: its types file and the acceptance files that decide its Requirements. */
export type ContractFiles = Readonly<{
  id: string;
  /** Defaults to T1. */
  contractTask?: string;
  types: string;
  files: NonEmpty<ContractAcceptanceFile>;
}>;

export type FrozenContractOptions = ContractFiles & Readonly<{
  roster: NonEmpty<AcceptanceTestcase>;
  /** The Wave whose gate froze it; defaults to 1. */
  wave?: number;
}>;

/** Every Requirement the files decide, once each, in file order. */
function distinctAnchors(files: NonEmpty<ContractAcceptanceFile>): NonEmpty<string> {
  const first = files[0].anchors[0];
  return [first, ...new Set(files.flatMap(({ anchors }) => anchors).filter((anchor) => anchor !== first))];
}

const contractOver = ({ id, contractTask = "T1", types, files }: ContractFiles, freeze: AcceptanceContract["freeze"]): AcceptanceContract =>
  contract({ id, contractTask, surface: { types, acceptance: files[0].path }, anchors: distinctAnchors(files), acceptance: files, freeze });

/** A contract whose Acceptance Freeze is recorded: its types file and every
 *  acceptance file digested, and the roster observed red at `wave`. */
export const frozenContract = ({ roster, wave = 1, ...files }: FrozenContractOptions): AcceptanceContract => {
  const digested = (path: string): FrozenPathDigest => ({ path, sha256: digest("a") });
  return contractOver(files, {
    state: "frozen",
    wave,
    paths: [digested(files.types), ...files.files.map(({ path }) => digested(path))],
    roster,
  });
};

/** The same contract before its Wave Gate observed it red. */
export const awaitingRedContract = (files: ContractFiles): AcceptanceContract => contractOver(files, { state: "awaiting-red" });

export type StopCheckGraphInput = Readonly<{
  tasks: readonly Task[];
  contracts?: readonly AcceptanceContract[];
  /** Omitted: the graph carries no verification manifest at all. */
  manifest?: FrozenVerificationManifest;
}>;

/** A TaskGraph the production parser admitted, and the State File text it was parsed from. */
export type ParsedStopCheckGraph = Readonly<{ graph: TaskGraph; json: string }>;

/** A v2 TaskGraph, proven loadable by the production State File parser. */
export function stopCheckGraph({ tasks, contracts, manifest }: StopCheckGraphInput): ParsedStopCheckGraph {
  const json = JSON.stringify({
    spec_trace_version: 2,
    ...graphFixture(tasks),
    ...(contracts === undefined ? {} : { acceptance_contracts: contracts }),
    ...(manifest === undefined ? {} : { verification_manifest: manifest }),
  });
  return Object.freeze({ graph: protectedGraphFixture(JSON.parse(json)), json });
}
