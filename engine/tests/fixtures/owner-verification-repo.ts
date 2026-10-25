/**
 * The owner-verification fixture repository (CT-1): a real temp Git
 * repository carrying one owned family and everything the Wave Gate's
 * `loom:owner-verification` check reads.
 *
 * - The family of INV-1: the owner `src/rules/owner.ts`, two siblings that
 *   import it, a re-export barrel over one sibling, and a root tsconfig whose
 *   `paths` alias `@rules/*` resolves to `src/rules/*`.
 * - Three matrix tests over it: discriminating (fails whenever the owner's
 *   bytes differ from the Wave's), vacuous (always passes) and
 *   sibling-omitting (discriminating, but never imports sibling-b).
 * - A plan at `.claude/plans/owner-fixture.md` declaring INV-1 over that
 *   family, and a TaskGraph stamped with the matching `owner_obligations`,
 *   registered at Wave 1's gate. Its one Task's `start_sha` is the fixture's
 *   base commit; the Wave's change is left uncommitted in the workspace.
 * - A frozen manifest whose `affectedRunner` is `node scripts/matrix-runner.mjs
 *   {files}`: a deterministic stand-in for Vitest that reads each matrix
 *   test's `fixture-runner:` marker, writes a JUnit report and appends one
 *   JSON line per launch to a log OUTSIDE the repository, so a test can see
 *   every launch, where it ran and which owner bytes it saw.
 *
 * Options select the Wave's change, the matrix test the plan names, an
 * exemption, a plan defect, a runner defect, or a blocked isolated copy.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MutationPolicy, OwnerObligation } from "../../src/core/owner-verification/types";
import { redThenGreenEra } from "../../src/core/proof-obligations";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import type { RegisteredWaveGateProgram } from "../../src/core/wave-gate-program";
import { observeCurrentWaveWorkspace } from "../../src/handlers/helpers/wave-completion-suite";
import { createRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { StateManager } from "../../src/state-manager";
import { parseNewTestEvidence, type ActiveWaveGateRegistration, type Task, type TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "./canonical-temp-dir";
import { ownerObligation } from "./owner-obligation";
import { satisfiedProof } from "./task-lifecycle";

export type MatrixTestKind = "discriminating" | "vacuous" | "sibling-omitting";

/** The paths of the fixture's family, all repository-relative. */
export const OWNER_FIXTURE = Object.freeze({
  owner: "src/rules/owner.ts",
  siblings: Object.freeze(["src/rules/sibling-a.ts", "src/rules/sibling-b.ts"] as const),
  barrel: "src/rules/index.ts",
  matrixTests: Object.freeze({
    discriminating: "tests/rules.matrix.test.ts",
    vacuous: "tests/rules-vacuous.matrix.test.ts",
    "sibling-omitting": "tests/rules-omitting.matrix.test.ts",
  } satisfies Record<MatrixTestKind, string>),
  unrelated: "src/other.ts",
  runner: "scripts/matrix-runner.mjs",
  report: ".loom/completion-reports/owner-matrix.junit.xml",
  plan: ".claude/plans/owner-fixture.md",
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: "Every entry point admits through decide().",
});

export type OwnerVerificationRepoOptions = Readonly<{
  /** The one file the Wave's Task changed (uncommitted), and so lists. */
  waveChanges: "owner" | "sibling" | "matrix-test" | "unrelated";
  /** The matrix test the plan and the stamp name. */
  matrixTest: MatrixTestKind;
  /** A reasoned mutation exemption on INV-1, in the plan and the stamp. */
  exemption?: string;
  /**
   * The plan the gate re-reads. `agreeing` (default) matches the stamp;
   * `unnamed` sets `plan_file: null`; `missing` names a file that does not
   * exist; `malformed` declares an exemption without a reason; `drift` gains
   * an owned INV-2 the stamp lacks.
   */
  plan?: "agreeing" | "unnamed" | "missing" | "malformed" | "drift";
  /**
   * The runner stand-in. `faithful` (default) decides by marker; `red` fails
   * every testcase; `no-report` exits 0 without a report; `unstartable`
   * freezes an executable that does not exist.
   */
  runner?: "faithful" | "red" | "no-report" | "unstartable";
  /** `blocked` makes `git worktree add` fail: `.git/worktrees` is a file. */
  worktree?: "available" | "blocked";
  /**
   * The harness state layout: `claude` (default) keeps the State File and the
   * Wave Gate runs root under `.claude/`, `pi` under `.pi/`, exactly where
   * each harness's Wave Gate finds them.
   */
  layout?: "claude" | "pi";
}>;

/** One launch of the runner stand-in, as it logged itself. */
export type RunnerLaunch = Readonly<{
  /** The directory it ran in. */
  cwd: string;
  /** The matrix-test arguments it received. */
  files: readonly string[];
  /** sha256 of the owner bytes it saw, or null when there was no owner. */
  owner: string | null;
}>;

export type OwnerVerificationRepo = Readonly<{
  root: string;
  manager: StateManager;
  handle: RunDirHandle;
  registration: RegisteredWaveGateProgram;
  /** sha256 of the owner bytes the Wave left in the real workspace. */
  ownerDigest: string;
  /** Every runner launch so far, in launch order. */
  runnerLaunches: () => readonly RunnerLaunch[];
  /** Every completion result the suite published in the Run Directory. */
  publishedResults: () => readonly Record<string, unknown>[];
  /** sha256 of every workspace file, excluding `.git` and the protected
   *  `.claude/state` and `.claude/reviews` trees the gate itself writes. */
  workspaceBytes: () => Readonly<Record<string, string>>;
  /** The Git-visible workspace digest the completion suite binds to. */
  workspaceDigest: () => string;
  /** The repository's worktree paths, the main one first. */
  worktrees: () => readonly string[];
}>;

/** A TaskGraph carrying the `owner_obligations` stamp, as every fixture graph does. */
export type StampedGraph = TaskGraph & Readonly<{ owner_obligations: readonly OwnerObligation[] }>;

/** A fixture root as the canonical repository root the shells take; throws when it is not canonical. */
export function canonicalRoot(root: string): CanonicalRepositoryRoot {
  const parsed = parseCanonicalRepositoryRoot(root);
  if (!parsed.ok) throw new Error(`fixture root is not canonical: ${root}`);
  return parsed.value;
}

const created: string[] = [];

/** Remove every fixture repository and launch log built so far. */
export function cleanupOwnerVerificationRepos(): void {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
}

const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

function write(root: string, path: string, contents: string): void {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

const BASE_OWNER = [
  "export function decide(age: number, member: boolean): boolean {",
  "  return false;",
  "}",
  "",
].join("\n");

/** The owner the Wave writes: lines 2-4 are its changed lines against the base. */
const WAVE_OWNER = [
  "export function decide(age: number, member: boolean): boolean {",
  "  if (age >= 18 && member) {",
  "    return true;",
  "  }",
  "  return false;",
  "}",
  "",
].join("\n");

const SIBLING_A = 'import { decide } from "./owner";\nexport const admitMember = (age: number): boolean => decide(age, true);\n';
const SIBLING_B = 'import { decide } from "./owner";\nexport const admitGuest = (age: number): boolean => decide(age, false);\n';
const BARREL = 'export { admitGuest } from "./sibling-b";\n';
const TSCONFIG = `${JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@rules/*": ["src/rules/*"] } } }, null, 2)}\n`;

function matrixTestText(kind: MatrixTestKind): string {
  const marker = kind === "vacuous" ? "vacuous" : "discriminating";
  const imports = [
    'import { describe, expect, it } from "vitest";',
    'import { decide } from "../src/rules/owner";',
    'import { admitMember } from "@rules/sibling-a";',
    ...(kind === "sibling-omitting" ? [] : ['import { admitGuest } from "../src/rules/index";']),
  ];
  const body = kind === "vacuous"
    ? ["    expect(true).toBe(true);"]
    : [
        "    expect(decide(18, true)).toBe(true);",
        "    expect(decide(17, true)).toBe(false);",
        "    expect(admitMember(18)).toBe(true);",
        ...(kind === "sibling-omitting" ? [] : ["    expect(admitGuest(18)).toBe(false);"]),
      ];
  return [
    `// fixture-runner: ${marker}`,
    ...imports,
    "",
    'describe("matrix", () => {',
    '  it("decides admission through every entry point", () => {',
    ...body,
    "  });",
    "});",
    "",
  ].join("\n");
}

/**
 * The runner stand-in. `faithful`: a matrix test marked discriminating fails
 * whenever the owner's bytes differ from `original` (the Wave's), one marked
 * vacuous always passes. `red`: every testcase fails. `no-report`: exit 0
 * with no report. Every launch is logged first.
 */
function runnerScript(log: string, original: string, mode: "faithful" | "red" | "no-report"): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const LOG = ${JSON.stringify(log)};
const OWNER = ${JSON.stringify(OWNER_FIXTURE.owner)};
const ORIGINAL = ${JSON.stringify(original)};
const MODE = ${JSON.stringify(mode)};
const REPORT = ${JSON.stringify(OWNER_FIXTURE.report)};

const files = process.argv.slice(2);
const owner = existsSync(OWNER) ? createHash("sha256").update(readFileSync(OWNER)).digest("hex") : null;
appendFileSync(LOG, JSON.stringify({ cwd: process.cwd(), files, owner }) + "\\n");
if (MODE === "no-report") process.exit(0);

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cases = files.map((file) => {
  const marker = /fixture-runner: ([a-z-]+)/.exec(readFileSync(file, "utf8"))?.[1] ?? "vacuous";
  return { file, fails: MODE === "red" || (marker === "discriminating" && owner !== ORIGINAL) };
});
const failures = cases.filter((testcase) => testcase.fails).length;
const suites = cases.map(({ file, fails }) => [
  '<testsuite name="' + escape(file) + '" tests="1" failures="' + (fails ? 1 : 0) + '" errors="0" skipped="0">',
  '<testcase classname="' + escape(file) + '" name="matrix &gt; decides admission through every entry point">' +
    (fails ? '<failure message="expected true to be false" type="AssertionError">expected true to be false</failure>' : "") +
    "</testcase>",
  "</testsuite>",
].join("\\n"));
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, [
  '<?xml version="1.0" encoding="UTF-8" ?>',
  '<testsuites name="vitest tests" tests="' + cases.length + '" failures="' + failures + '" errors="0">',
  ...suites,
  "</testsuites>",
].join("\\n"));
process.exit(failures > 0 ? 1 : 0);
`;
}

function invariantBlock(heading: string, fields: readonly string[]): readonly string[] {
  return [`### ${heading}`, "", ...fields, ""];
}

function planText(options: OwnerVerificationRepoOptions): string {
  const exemption = options.plan === "malformed"
    ? ["**Mutation exemption:**"]
    : options.exemption === undefined ? [] : [`**Mutation exemption:** ${options.exemption}`];
  const owned = invariantBlock(`${OWNER_FIXTURE.invariant}: ${OWNER_FIXTURE.title}`, [
    "**Tier:** advisory",
    `**Owner module:** \`${OWNER_FIXTURE.owner}\``,
    "**Sibling entry points:**",
    `- \`${OWNER_FIXTURE.siblings[0]}\` — admits members`,
    `- \`${OWNER_FIXTURE.siblings[1]}\` — admits guests`,
    `**Matrix test:** \`${OWNER_FIXTURE.matrixTests[options.matrixTest]}\``,
    `**Statement:** ${OWNER_FIXTURE.statement}`,
    ...exemption,
  ]);
  const drifted = options.plan === "drift"
    ? invariantBlock("INV-2: Other values come only from other.ts", [
        "**Tier:** advisory",
        `**Owner module:** \`${OWNER_FIXTURE.unrelated}\``,
        "**Sibling entry points:** none",
        "**Matrix test:** `tests/other.matrix.test.ts`",
        "**Statement:** Every other value is read from other.ts.",
      ])
    : [];
  return ["# Plan: owner-verification fixture", "", "## Invariants", "", ...owned, ...drifted].join("\n");
}

/** INV-1's mutation policy in the stamp: the exemption's reason exactly as the plan declares it. */
function mutationPolicyOf(options: OwnerVerificationRepoOptions): MutationPolicy {
  return options.exemption === undefined
    ? { kind: "verify" }
    : { kind: "exempt", reason: options.exemption };
}

function obligationOf(options: OwnerVerificationRepoOptions): OwnerObligation {
  return ownerObligation({
    invariant: OWNER_FIXTURE.invariant,
    title: OWNER_FIXTURE.title,
    statement: OWNER_FIXTURE.statement,
    owner: OWNER_FIXTURE.owner,
    siblings: [
      { path: OWNER_FIXTURE.siblings[0], note: "admits members" },
      { path: OWNER_FIXTURE.siblings[1], note: "admits guests" },
    ],
    matrixTest: OWNER_FIXTURE.matrixTests[options.matrixTest],
    mutation: mutationPolicyOf(options),
  });
}

/** The file the Wave's Task lists and the bytes the Wave leaves in it. */
function waveChange(options: OwnerVerificationRepoOptions): Readonly<{ path: string; text: string }> {
  switch (options.waveChanges) {
    case "owner":
      return { path: OWNER_FIXTURE.owner, text: WAVE_OWNER };
    case "sibling":
      return { path: OWNER_FIXTURE.siblings[0], text: `${SIBLING_A}export const memberAge = 18;\n` };
    case "matrix-test":
      return { path: OWNER_FIXTURE.matrixTests[options.matrixTest], text: `${matrixTestText(options.matrixTest)}// reviewed\n` };
    case "unrelated":
      return { path: OWNER_FIXTURE.unrelated, text: "export const other = 2;\n" };
  }
}

function manifestOf(runner: OwnerVerificationRepoOptions["runner"]): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    affectedRunner: {
      // `.loom/bin/` is ignored and never created: an allowlisted basename that cannot start.
      executable: runner === "unstartable" ? ".loom/bin/node" : "node",
      args: [OWNER_FIXTURE.runner, "{files}"],
      cwd: ".",
      timeoutMs: 30_000,
      report: { kind: "required-file", path: OWNER_FIXTURE.report },
    },
  })));
  if (!frozen.ok) throw new Error(`fixture manifest refused: ${frozen.error.errors.join("; ")}`);
  return frozen.value;
}

function filesBeneath(root: string, directory: string, skip: (path: string) => boolean): readonly string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (skip(path)) return [];
    return entry.isDirectory() ? filesBeneath(root, path, skip) : [path];
  });
}

const PROTECTED = [".git", ".claude/state", ".claude/reviews", ".pi/state", ".pi/reviews"];

type WaveChange = ReturnType<typeof waveChange>;
type RunnerMode = NonNullable<OwnerVerificationRepoOptions["runner"]>;

const AUTHORITY_DIGEST = "a".repeat(64) as ActiveWaveGateRegistration["authorityDigest"];
type Layout = NonNullable<OwnerVerificationRepoOptions["layout"]>;
const stateFile = (layout: Layout): string => `.${layout}/state/active_task_graph.json`;

/** An empty launch log in its own temp directory, outside the repository. */
function freshLaunchLog(): string {
  const logDirectory = canonicalTempDir("loom-owner-runner-log-");
  created.push(logDirectory);
  const log = join(logDirectory, "launches.jsonl");
  writeFileSync(log, "");
  return log;
}

/** Commit the base: the family, its matrix tests, the runner and the agreeing plan. */
function commitBase(
  root: string,
  log: string,
  options: OwnerVerificationRepoOptions,
  ownerAfterWave: string,
  runner: RunnerMode,
): string {
  git(root, "init", "-q");
  git(root, "config", "user.email", "loom-tests@example.invalid");
  git(root, "config", "user.name", "Loom Tests");
  write(root, ".gitignore", ".loom/bin/\n.loom/completion-reports/\n");
  write(root, "tsconfig.json", TSCONFIG);
  write(root, OWNER_FIXTURE.owner, BASE_OWNER);
  write(root, OWNER_FIXTURE.siblings[0], SIBLING_A);
  write(root, OWNER_FIXTURE.siblings[1], SIBLING_B);
  write(root, OWNER_FIXTURE.barrel, BARREL);
  write(root, OWNER_FIXTURE.unrelated, "export const other = 1;\n");
  for (const kind of Object.keys(OWNER_FIXTURE.matrixTests) as MatrixTestKind[]) {
    write(root, OWNER_FIXTURE.matrixTests[kind], matrixTestText(kind));
  }
  write(root, OWNER_FIXTURE.runner, runnerScript(log, sha256(ownerAfterWave), runner === "unstartable" ? "faithful" : runner));
  write(root, OWNER_FIXTURE.plan, planText({ ...options, plan: "agreeing" }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture base");
  return git(root, "rev-parse", "HEAD");
}

/** The Wave's work and any plan or worktree defect, uncommitted as at a real gate. */
function applyWave(root: string, options: OwnerVerificationRepoOptions, change: WaveChange): void {
  write(root, change.path, change.text);
  if (options.plan === "malformed" || options.plan === "drift") write(root, OWNER_FIXTURE.plan, planText(options));
  if (options.worktree === "blocked") writeFileSync(join(root, ".git", "worktrees"), "");
}

/** The Wave's one implemented Task: it lists the changed file and starts at the base. */
function waveTask(change: WaveChange, manifest: FrozenVerificationManifest, base: string): Task {
  return {
    id: "T1",
    description: "change the admission family",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    proof: satisfiedProof([change.path], redThenGreenEra(manifest)),
    depends_on: [],
    file_list: [change.path],
    start_sha: base,
    test_result: { verdict: "trusted-pass" },
    new_test_observation: parseNewTestEvidence(true, "fixture new-test evidence"),
    review_status: "pending",
    critical_findings: [],
    advisory_findings: [],
  };
}

function activeGate(root: string, layout: Layout): ActiveWaveGateRegistration {
  return {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: "run.owner-verification" as ActiveWaveGateRegistration["runId"],
    wave: 1,
    authorityDigest: AUTHORITY_DIGEST,
    revision: 0,
    runsRoot: join(root, `.${layout}/reviews/wave-gate-runs`),
    terminalOutcome: null,
  };
}

/** The plan file the graph names: none, a missing one, or the fixture's plan. */
function namedPlanFile(root: string, options: OwnerVerificationRepoOptions): string | null {
  if (options.plan === "unnamed") return null;
  return join(root, options.plan === "missing" ? ".claude/plans/missing.md" : OWNER_FIXTURE.plan);
}

function stampedGraph(
  root: string,
  options: OwnerVerificationRepoOptions,
  manifest: FrozenVerificationManifest,
  task: Task,
): StampedGraph {
  return {
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: namedPlanFile(root, options),
    tasks: [task],
    wave_gates: {},
    verification_manifest: manifest,
    active_wave_gate: activeGate(root, options.layout ?? "claude"),
    owner_obligations: [obligationOf(options)],
  };
}

/** Write the graph read-only and open the active gate's Run Directory. */
function installGraph(root: string, graph: StampedGraph, layout: Layout): Readonly<{ manager: StateManager; handle: RunDirHandle }> {
  const statePath = join(root, stateFile(layout));
  write(root, stateFile(layout), JSON.stringify(graph, null, 2));
  chmodSync(statePath, 0o444);
  const active = graph.active_wave_gate!;
  mkdirSync(active.runsRoot!, { recursive: true });
  const run = createRunDirectory(active.runsRoot!, active.runId);
  if (!run.ok) throw new Error(run.error.message);
  return { manager: new StateManager(statePath), handle: run.value };
}

const WAVE_GATE_PROGRAM: RegisteredWaveGateProgram = Object.freeze({
  schemaVersion: 1,
  kind: "wave-gate",
  input: Object.freeze({ wave: 1 }),
  taskIds: Object.freeze(["T1"]),
  authorityDigest: AUTHORITY_DIGEST,
});

function readLaunches(log: string): readonly RunnerLaunch[] {
  return readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
    .map((line) => JSON.parse(line) as RunnerLaunch);
}

function readPublishedResults(handle: RunDirHandle): readonly Record<string, unknown>[] {
  const results = join(handle.runDirectory, "artifacts");
  return filesBeneath(results, "completion-suites", () => false)
    .filter((path) => path.endsWith(".json"))
    .map((path) => JSON.parse(readFileSync(join(results, path), "utf8")) as Record<string, unknown>);
}

function readWorkspaceBytes(root: string): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    [...filesBeneath(root, "", (path) => PROTECTED.includes(path))].sort()
      .map((path) => [path, sha256(readFileSync(join(root, path)))]),
  ));
}

function readWorkspaceDigest(root: string, manager: StateManager): string {
  const observed = observeCurrentWaveWorkspace(manager.load(), root);
  if (observed.kind !== "observed") throw new Error(`fixture workspace unavailable: ${observed.reason}`);
  return observed.workspaceDigest;
}

function readWorktrees(root: string): readonly string[] {
  return git(root, "worktree", "list", "--porcelain").split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** A fixture repository whose Wave changed the owner under the discriminating matrix test, unless `options` says otherwise. */
export const buildOwnerVerificationRepo = (options: Partial<OwnerVerificationRepoOptions> = {}): OwnerVerificationRepo =>
  ownerVerificationRepo({ waveChanges: "owner", matrixTest: "discriminating", ...options });

/** Build one fixture repository; `cleanupOwnerVerificationRepos` removes it. */
export function ownerVerificationRepo(options: OwnerVerificationRepoOptions): OwnerVerificationRepo {
  const root = canonicalTempDir("loom-owner-verification-");
  created.push(root);
  const log = freshLaunchLog();
  const change = waveChange(options);
  const ownerAfterWave = change.path === OWNER_FIXTURE.owner ? change.text : BASE_OWNER;
  const runner = options.runner ?? "faithful";
  const base = commitBase(root, log, options, ownerAfterWave, runner);
  applyWave(root, options, change);
  const manifest = manifestOf(runner);
  const { manager, handle } = installGraph(root, stampedGraph(root, options, manifest, waveTask(change, manifest, base)), options.layout ?? "claude");
  return Object.freeze({
    root,
    manager,
    handle,
    registration: WAVE_GATE_PROGRAM,
    ownerDigest: sha256(ownerAfterWave),
    runnerLaunches: () => readLaunches(log),
    publishedResults: () => readPublishedResults(handle),
    workspaceBytes: () => readWorkspaceBytes(root),
    workspaceDigest: () => readWorkspaceDigest(root, manager),
    worktrees: () => readWorktrees(root),
  });
}
