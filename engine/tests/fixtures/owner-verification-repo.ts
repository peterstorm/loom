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
import { isRecord } from "../../src/core/plain-record";
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

/**
 * The paths of one fixture family. A Java family's siblings live in their own
 * package so the matrix test must import them, and its matrix test sits in the
 * owner's package so the same-package reach rule is exercised too.
 */
export type FamilyPaths = Readonly<{
  owner: string;
  siblings: readonly [string, string];
  matrixTests: Readonly<Record<MatrixTestKind, string>>;
  unrelated: string;
  runner: string;
  report: string;
  plan: string;
  invariant: string;
  title: string;
  statement: string;
}>;

/** The paths of the Java family (issue #254): a module-prefixed Maven layout. */
export const JAVA_OWNER_FIXTURE: FamilyPaths = Object.freeze({
  owner: "billing/src/main/java/dk/example/decision/GatedDecision.java",
  siblings: Object.freeze([
    "billing/src/main/java/dk/example/admission/AdmitMember.java",
    "billing/src/main/java/dk/example/admission/AdmitGuest.java",
  ] as const),
  matrixTests: Object.freeze({
    discriminating: "billing/src/test/java/dk/example/decision/GatedDecisionTest.java",
    vacuous: "billing/src/test/java/dk/example/decision/VacuousTest.java",
    "sibling-omitting": "billing/src/test/java/dk/example/decision/OmittingTest.java",
  } satisfies Record<MatrixTestKind, string>),
  unrelated: "billing/src/main/java/dk/example/Other.java",
  runner: "scripts/matrix-runner.mjs",
  report: ".loom/completion-reports/owner-matrix.junit.xml",
  plan: ".claude/plans/owner-fixture.md",
  invariant: "INV-1",
  title: "A decision is gated only by the owner",
  statement: "Every entry point gates through GatedDecision.blocks().",
});

export type OwnerVerificationRepoOptions = Readonly<{
  /** The family's language: the TypeScript fixture (default) or the Java one. */
  language?: "typescript" | "java";
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
   * freezes an executable that does not exist; `hang` never exits, and
   * `hang-mutants` never exits while the owner differs from the Wave's (a
   * faithful baseline, every mutant hanging). Both hanging modes freeze the
   * runner with the short `HANGING_RUNNER_TIMEOUT_MS`, so the frozen time
   * limit ends each hanging run. `mocha` decides as `faithful` but writes
   * Mocha's xunit shape: each testcase's `file` absolute beneath the
   * directory the runner ran in.
   */
  runner?: "faithful" | "red" | "no-report" | "unstartable" | "hang" | "hang-mutants" | "mocha";
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
  for (let dir = created.pop(); dir !== undefined; dir = created.pop()) rmSync(dir, { recursive: true, force: true });
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

/** One fixture family: its paths and the bytes of every file it writes; a barrel's path and text come together or not at all. */
type Family = FamilyPaths & Readonly<{
  baseOwner: string;
  waveOwner: string;
  siblingTexts: readonly [string, string];
  siblingChange: string;
  barrel: Readonly<{ path: string; text: string }> | null;
  unrelatedBase: string;
  unrelatedWave: string;
  extraFiles: readonly (readonly [string, string])[];
  matrixTest: (kind: MatrixTestKind) => string;
}>;

const TS_FAMILY: Family = Object.freeze({
  ...OWNER_FIXTURE,
  baseOwner: BASE_OWNER,
  waveOwner: WAVE_OWNER,
  siblingTexts: Object.freeze([SIBLING_A, SIBLING_B] as const),
  siblingChange: 'export const memberAge = 18;\n',
  barrel: Object.freeze({ path: OWNER_FIXTURE.barrel, text: BARREL }),
  unrelatedBase: "export const other = 1;\n",
  unrelatedWave: "export const other = 2;\n",
  extraFiles: Object.freeze([Object.freeze(["tsconfig.json", TSCONFIG] as const)]),
  matrixTest: matrixTestText,
});

const JAVA_BASE_OWNER = [
  "package dk.example.decision;",
  "",
  "public final class GatedDecision {",
  "  public static boolean blocks(int score, String reason) {",
  "    return false;",
  "  }",
  "}",
  "",
].join("\n");

/** The Java owner the Wave writes: lines 5-7 (the guard and its `return true;`) are its changed lines against the base. */
const JAVA_WAVE_OWNER = [
  "package dk.example.decision;",
  "",
  "public final class GatedDecision {",
  "  public static boolean blocks(int score, String reason) {",
  "    if (score < 20 && !reason.isEmpty()) {",
  "      return true;",
  "    }",
  "    return false;",
  "  }",
  "}",
  "",
].join("\n");

const JAVA_SIBLING_MEMBER = [
  "package dk.example.admission;",
  "",
  "import dk.example.decision.GatedDecision;",
  "",
  "public final class AdmitMember {",
  "  public static boolean admits(int score) {",
  '    return GatedDecision.blocks(score, "");',
  "  }",
  "}",
  "",
].join("\n");

const JAVA_SIBLING_GUEST = [
  "package dk.example.admission;",
  "",
  "import dk.example.decision.GatedDecision;",
  "",
  "public final class AdmitGuest {",
  "  public static boolean admits(int score) {",
  '    return GatedDecision.blocks(score, "");',
  "  }",
  "}",
  "",
].join("\n");

/** A Java matrix test in the owner's package: same-package reach, plus explicit imports of both siblings. */
function javaMatrixTest(kind: MatrixTestKind): string {
  const marker = kind === "vacuous" ? "vacuous" : "discriminating";
  const imports = [
    "import dk.example.admission.AdmitMember;",
    ...(kind === "sibling-omitting" ? [] : ["import dk.example.admission.AdmitGuest;"]),
  ];
  const body = kind === "vacuous"
    ? ["    assert true;"]
    : [
        "    assert AdmitMember.admits(18);",
        "    assert !GatedDecision.blocks(17, \"\");",
        ...(kind === "sibling-omitting" ? [] : ["    assert !AdmitGuest.admits(17);"]),
      ];
  return [
    "package dk.example.decision;",
    "",
    ...imports,
    `// fixture-runner: ${marker}`,
    "",
    "final class GatedDecisionTest {",
    "  void decidesAdmissionThroughEveryEntryPoint() {",
    ...body,
    "  }",
    "}",
    "",
  ].join("\n");
}

const JAVA_FAMILY: Family = Object.freeze({
  ...JAVA_OWNER_FIXTURE,
  baseOwner: JAVA_BASE_OWNER,
  waveOwner: JAVA_WAVE_OWNER,
  siblingTexts: Object.freeze([JAVA_SIBLING_MEMBER, JAVA_SIBLING_GUEST] as const),
  siblingChange: "// member age 18\n",
  barrel: null,
  unrelatedBase: "package dk.example;\n\nfinal class Other {}\n",
  unrelatedWave: "package dk.example;\n\nfinal class Other { static final int V = 2; }\n",
  extraFiles: Object.freeze([]),
  matrixTest: javaMatrixTest,
});

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

/** The runner stand-in's `mocha` branch: Mocha's xunit shape, each testcase's `file` absolute beneath the run's cwd. */
const MOCHA_REPORT_SNIPPET = `if (MODE === "mocha") {
  writeFileSync(REPORT, [
    '<testsuite name="Mocha Tests" tests="' + cases.length + '" failures="0" errors="' + failures + '">',
    ...cases.map(({ file, fails }) =>
      '<testcase classname="matrix" name="decides admission through every entry point" file="' + escape(process.cwd() + "/" + file) + '">' +
      (fails ? "<failure>AssertionError: expected true to be false</failure>" : "") + "</testcase>"),
    "</testsuite>",
  ].join("\\\\n"));
  process.exit(failures > 0 ? 1 : 0);
}`;

/**
 * The runner stand-in. `faithful`: a matrix test marked discriminating fails
 * whenever the owner's bytes differ from `original` (the Wave's), one marked
 * vacuous always passes. `red`: every testcase fails. `no-report`: exit 0
 * with no report. `hang`: never exits. `hang-mutants`: never exits while the
 * owner's bytes differ from `original`, otherwise faithful. `mocha`: faithful,
 * in Mocha's xunit shape with absolute files. Every launch is logged first.
 */
function runnerScript(family: FamilyPaths, log: string, original: string, mode: Exclude<RunnerMode, "unstartable">): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

const LOG = ${JSON.stringify(log)};
const OWNER = ${JSON.stringify(family.owner)};
const ORIGINAL = ${JSON.stringify(original)};
const MODE = ${JSON.stringify(mode)};
const REPORT = ${JSON.stringify(family.report)};

const files = process.argv.slice(2);
const owner = existsSync(OWNER) ? createHash("sha256").update(readFileSync(OWNER)).digest("hex") : null;
appendFileSync(LOG, JSON.stringify({ cwd: process.cwd(), files, owner }) + "\\n");
if (MODE === "no-report") process.exit(0);
if (MODE === "hang" || (MODE === "hang-mutants" && owner !== ORIGINAL)) {
  setInterval(() => {}, 60_000);
} else {

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cases = files.map((file) => {
  const marker = /fixture-runner: ([a-z-]+)/.exec(readFileSync(file, "utf8"))?.[1] ?? "vacuous";
  return { file, fails: MODE === "red" || (marker === "discriminating" && owner !== ORIGINAL) };
});
const failures = cases.filter((testcase) => testcase.fails).length;
mkdirSync(dirname(REPORT), { recursive: true });
${MOCHA_REPORT_SNIPPET}
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
}
`;
}

function invariantBlock(heading: string, fields: readonly string[]): readonly string[] {
  return [`### ${heading}`, "", ...fields, ""];
}

function planText(family: FamilyPaths, options: OwnerVerificationRepoOptions): string {
  const exemption = options.plan === "malformed"
    ? ["**Mutation exemption:**"]
    : options.exemption === undefined ? [] : [`**Mutation exemption:** ${options.exemption}`];
  const owned = invariantBlock(`${family.invariant}: ${family.title}`, [
    "**Tier:** advisory",
    `**Owner module:** \`${family.owner}\``,
    "**Sibling entry points:**",
    `- \`${family.siblings[0]}\` — admits members`,
    `- \`${family.siblings[1]}\` — admits guests`,
    `**Matrix test:** \`${family.matrixTests[options.matrixTest]}\``,
    `**Statement:** ${family.statement}`,
    ...exemption,
  ]);
  const drifted = options.plan === "drift"
    ? invariantBlock("INV-2: Other values come only from other.ts", [
        "**Tier:** advisory",
        `**Owner module:** \`${family.unrelated}\``,
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

function obligationOf(family: FamilyPaths, options: OwnerVerificationRepoOptions): OwnerObligation {
  return ownerObligation({
    invariant: family.invariant,
    title: family.title,
    statement: family.statement,
    owner: family.owner,
    siblings: [
      { path: family.siblings[0], note: "admits members" },
      { path: family.siblings[1], note: "admits guests" },
    ],
    matrixTest: family.matrixTests[options.matrixTest],
    mutation: mutationPolicyOf(options),
  });
}

/** The file the Wave's Task lists and the bytes the Wave leaves in it. */
function waveChange(family: Family, options: OwnerVerificationRepoOptions): Readonly<{ path: string; text: string }> {
  switch (options.waveChanges) {
    case "owner":
      return { path: family.owner, text: family.waveOwner };
    case "sibling":
      return { path: family.siblings[0], text: `${family.siblingTexts[0]}${family.siblingChange}` };
    case "matrix-test":
      return { path: family.matrixTests[options.matrixTest], text: `${family.matrixTest(options.matrixTest)}// reviewed\n` };
    case "unrelated":
      return { path: family.unrelated, text: family.unrelatedWave };
  }
}

/** The frozen runner time limit of the hanging runner modes: long enough for a faithful baseline, short enough to end each hanging run quickly. */
export const HANGING_RUNNER_TIMEOUT_MS = 3_000;

function manifestOf(family: FamilyPaths, runner: RunnerMode): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    affectedRunner: {
      // `.loom/bin/` is ignored and never created: an allowlisted basename that cannot start.
      executable: runner === "unstartable" ? ".loom/bin/node" : "node",
      args: [family.runner, "{files}"],
      cwd: ".",
      timeoutMs: runner === "hang" || runner === "hang-mutants" ? HANGING_RUNNER_TIMEOUT_MS : 30_000,
      report: { kind: "required-file", path: family.report },
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
  family: Family,
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
  for (const [path, text] of family.extraFiles) write(root, path, text);
  write(root, family.owner, family.baseOwner);
  write(root, family.siblings[0], family.siblingTexts[0]);
  write(root, family.siblings[1], family.siblingTexts[1]);
  if (family.barrel !== null) write(root, family.barrel.path, family.barrel.text);
  write(root, family.unrelated, family.unrelatedBase);
  for (const kind of Object.keys(family.matrixTests) as MatrixTestKind[]) {
    write(root, family.matrixTests[kind], family.matrixTest(kind));
  }
  write(root, family.runner, runnerScript(family, log, sha256(ownerAfterWave), runner === "unstartable" ? "faithful" : runner));
  write(root, family.plan, planText(family, { ...options, plan: "agreeing" }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture base");
  return git(root, "rev-parse", "HEAD");
}

/** The Wave's work and any plan or worktree defect, uncommitted as at a real gate. */
function applyWave(family: FamilyPaths, root: string, options: OwnerVerificationRepoOptions, change: WaveChange): void {
  write(root, change.path, change.text);
  if (options.plan === "malformed" || options.plan === "drift") write(root, family.plan, planText(family, options));
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
function namedPlanFile(family: FamilyPaths, root: string, options: OwnerVerificationRepoOptions): string | null {
  if (options.plan === "unnamed") return null;
  return join(root, options.plan === "missing" ? ".claude/plans/missing.md" : family.plan);
}

function stampedGraph(
  family: Family,
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
    plan_file: namedPlanFile(family, root, options),
    tasks: [task],
    wave_gates: {},
    verification_manifest: manifest,
    active_wave_gate: activeGate(root, options.layout ?? "claude"),
    owner_obligations: [obligationOf(family, options)],
  };
}

/** Write the graph read-only and open the active gate's Run Directory. */
function installGraph(root: string, graph: StampedGraph, layout: Layout): Readonly<{ manager: StateManager; handle: RunDirHandle }> {
  const statePath = join(root, stateFile(layout));
  write(root, stateFile(layout), JSON.stringify(graph, null, 2));
  chmodSync(statePath, 0o444);
  const active = graph.active_wave_gate;
  if (active === undefined) throw new Error("fixture graph has no active Wave Gate");
  const { runsRoot } = active;
  if (runsRoot === undefined) throw new Error("fixture Wave Gate records no runs root");
  mkdirSync(runsRoot, { recursive: true });
  const run = createRunDirectory(runsRoot, active.runId);
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

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** One line of the launch log, as the runner stand-in wrote it. */
function parseRunnerLaunch(line: string): RunnerLaunch {
  const raw: unknown = JSON.parse(line);
  if (!isRecord(raw)) throw new Error(`the runner logged a launch that is not an object: ${line}`);
  const { cwd, files, owner } = raw;
  if (typeof cwd !== "string" || !isStringList(files) || (owner !== null && typeof owner !== "string")) {
    throw new Error(`the runner logged a malformed launch: ${line}`);
  }
  return { cwd, files, owner };
}

function readLaunches(log: string): readonly RunnerLaunch[] {
  return readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map(parseRunnerLaunch);
}

function readPublishedResults(handle: RunDirHandle): readonly Record<string, unknown>[] {
  const results = join(handle.runDirectory, "artifacts");
  return filesBeneath(results, "completion-suites", () => false)
    .filter((path) => path.endsWith(".json"))
    .map((path) => {
      const result: unknown = JSON.parse(readFileSync(join(results, path), "utf8"));
      if (!isRecord(result)) throw new Error(`the published completion result ${path} is not a JSON object`);
      return result;
    });
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
  ownerVerificationRepo({ language: "typescript", waveChanges: "owner", matrixTest: "discriminating", ...options });

/** The Java family's fixture repository (issue #254), built like the TypeScript one. */
export const buildJavaOwnerVerificationRepo = (options: Partial<OwnerVerificationRepoOptions> = {}): OwnerVerificationRepo =>
  ownerVerificationRepo({ language: "java", waveChanges: "owner", matrixTest: "discriminating", ...options });

/** Build one fixture repository; `cleanupOwnerVerificationRepos` removes it. */
export function ownerVerificationRepo(options: OwnerVerificationRepoOptions): OwnerVerificationRepo {
  const family = options.language === "java" ? JAVA_FAMILY : TS_FAMILY;
  const root = canonicalTempDir("loom-owner-verification-");
  created.push(root);
  const log = freshLaunchLog();
  const change = waveChange(family, options);
  const ownerAfterWave = change.path === family.owner ? change.text : family.baseOwner;
  const runner = options.runner ?? "faithful";
  const base = commitBase(family, root, log, options, ownerAfterWave, runner);
  applyWave(family, root, options, change);
  const manifest = manifestOf(family, runner);
  const { manager, handle } = installGraph(root, stampedGraph(family, root, options, manifest, waveTask(change, manifest, base)), options.layout ?? "claude");
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
