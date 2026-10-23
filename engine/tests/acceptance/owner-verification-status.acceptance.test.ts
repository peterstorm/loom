/**
 * CT-2 acceptance: the brief's owner duties and the owner-verification status.
 *
 * Brief (FR-027, AS-028): `renderTaskImplementationBrief`, the shell behind
 * `helper orchestration brief`, renders a Task's brief from a protected graph
 * on disk that carries the population stamp `owner_obligations` (plan AD-2)
 * and names a real plan. The duty paragraph is asserted inside the brief's
 * `## Invariant Ownership` section.
 *
 * Status (FR-028, AS-029, AS-030): `renderStatus`, the renderer behind
 * `helper orchestration status [--json]`, reads a stamped graph with a live
 * Wave Gate registration and the latest persisted completion result. The
 * result fixture is built the way the gate builds one: the suite is authorized
 * by the production `authorizeWaveCompletionSuite` with the owner check
 * authority that obligations.ts (INV-3's owner) derives from the graph (plan
 * AD-1, AD-4), every authorized check gets an observed outcome, the result
 * carries `ownerVerification` (plan AD-1, CT-1's observation), and it then
 * passes through the production result parser exactly as the shell's persisted
 * result read does. A result the parser refuses is observed as unavailable,
 * as the shell would observe it.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeWaveCompletionSuite,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { parseWaveCompletionSuiteResult } from "../../src/core/completion-suite";
import { capturedSpecCheck } from "../../src/core/spec-check";
import type { ArtifactDigest, NonEmpty } from "../../src/core/orchestration-contract";
import type {
  CoverageVerdict,
  InvariantVerdict,
  OwnerObligation,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
  VerifiedMutationFields,
} from "../../src/core/owner-verification/types";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import type { StatusDeps } from "../../src/core/loom-status";
import { renderStatus } from "../../src/handlers/helpers/orchestration";
import { renderTaskImplementationBrief } from "../../src/orchestration/implementation-brief";
import { parseTaskGraph } from "../../src/state-manager";
import type { ActiveWaveGateRegistration, TaskGraph, WaveCompletionResultObservation } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { labelledValue, value } from "../fixtures/parse-result";
import { AFFECTED_RUNNER } from "../fixtures/stop-check-runners";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared plan fixture: one verified owned Invariant and one exempt one.
// ---------------------------------------------------------------------------

const PLAN_FILE = ".claude/plans/2026-10-21-fees.md";

const FEES = Object.freeze({
  invariant: "INV-1",
  title: "Fees are computed only by the fee calculator",
  statement: "Every fee is computed by computeFee; no entry point rounds or discounts a fee inline.",
  owner: "src/core/fees.ts",
  siblings: Object.freeze([
    Object.freeze({ path: "src/api/quote.ts", note: "quote endpoint" }),
    Object.freeze({ path: "src/jobs/invoice.ts", note: "nightly invoicing" }),
  ]),
  matrixTest: "tests/fees.matrix.test.ts",
  mutation: Object.freeze({ kind: "verify" }),
});

const CLOCK = Object.freeze({
  invariant: "INV-2",
  title: "Time is read only through the clock port",
  statement: "No module reads Date.now outside the clock port.",
  owner: "src/core/clock.ts",
  siblings: Object.freeze([Object.freeze({ path: "src/jobs/schedule.ts", note: null })]),
  matrixTest: "tests/clock.matrix.test.ts",
  mutation: Object.freeze({ kind: "exempt", reason: "timing-only code; every mutant only changes a sleep" }),
});

/** The population stamp, typed by CT-1 so the fixture is the shape the wire admits. */
const OBLIGATIONS: readonly OwnerObligation[] = Object.freeze([FEES, CLOCK]);

const PLAN_TEXT = [
  "# Plan: fees", "",
  "## Invariants", "",
  `### ${FEES.invariant}: ${FEES.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** \`${FEES.owner}\``,
  "**Sibling entry points:**",
  ...FEES.siblings.map(({ path, note }) => `- \`${path}\` — ${note}`),
  `**Matrix test:** \`${FEES.matrixTest}\``,
  `**Statement:** ${FEES.statement}`, "",
  `### ${CLOCK.invariant}: ${CLOCK.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** \`${CLOCK.owner}\``,
  "**Sibling entry points:**",
  ...CLOCK.siblings.map(({ path }) => `- \`${path}\``),
  `**Matrix test:** \`${CLOCK.matrixTest}\``,
  `**Mutation exemption:** ${CLOCK.mutation.reason}`,
  `**Statement:** ${CLOCK.statement}`, "",
].join("\n");

/** True when some blank-line-separated paragraph of `text` matches every pattern. */
const someParagraph = (text: string, ...patterns: readonly RegExp[]): boolean =>
  text.split(/\n\s*\n/).some((paragraph) => patterns.every((pattern) => pattern.test(paragraph)));

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literal = (text: string): RegExp => new RegExp(escaped(text));

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

/** A protected graph on disk whose one Wave 1 Task declares `fileList`. */
function briefGraph(fileList: readonly string[]): string {
  const root = canonicalTempDir("loom-owner-duties-");
  cleanup.push(root);
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), PLAN_TEXT);
  const path = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(path, JSON.stringify({
    current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: PLAN_FILE, wave_gates: {},
    owner_obligations: OBLIGATIONS,
    tasks: [{
      id: "T1", description: "Change the fee family", agent: "code-implementer-agent", wave: 1, depends_on: [],
      file_list: fileList, status: "pending",
    }],
  }));
  return path;
}

/** The rendered brief's `## Invariant Ownership` section. */
function ownershipSection(fileList: readonly string[]): string {
  const rendered = renderTaskImplementationBrief(briefGraph(fileList), LOOM_PACKAGE_ROOT, { taskId: "T1", operatorNotes: [] });
  if (!rendered.ok) throw new Error(`brief refused: ${rendered.error}`);
  const prompt = rendered.value.prompt;
  const start = prompt.indexOf("## Invariant Ownership");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = prompt.indexOf("\n## ", start + 1);
  return prompt.slice(start, end < 0 ? undefined : end);
}

describe("owner duties in the implementation brief (CT-2)", () => {
  it("AS-028: FR-027: the owner Task's brief states the matrix test must import the owner and every sibling, and that the owner's changed lines will be mutation-verified", () => {
    const section = ownershipSection([FEES.owner]);

    // Coverage duty: the matrix test must import the owner and every named sibling.
    expect(someParagraph(
      section,
      /must import/i,
      literal(FEES.matrixTest),
      literal(FEES.owner),
      ...FEES.siblings.map(({ path }) => literal(path)),
    )).toBe(true);
    // Mutation duty: the owner's lines changed in the Wave are mutation-verified.
    expect(someParagraph(section, /mutation[- ]verif/i, /changed/i, literal(FEES.owner))).toBe(true);
  });

  it("AS-028: FR-027: the matrix-test author's brief for an exempt Invariant states the import duty and names the declared mutation exemption and its reason", () => {
    const section = ownershipSection([CLOCK.matrixTest]);

    expect(someParagraph(
      section,
      /must import/i,
      literal(CLOCK.matrixTest),
      literal(CLOCK.owner),
      ...CLOCK.siblings.map(({ path }) => literal(path)),
    )).toBe(true);
    expect(someParagraph(section, /exempt/i, literal(CLOCK.mutation.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const digest = (fill: string): ArtifactDigest => fill.repeat(64) as ArtifactDigest;
const WORKSPACE = digest("b");

const registration: ActiveWaveGateRegistration = {
  schemaVersion: 1,
  kind: "active-wave-gate",
  runId: "run.owner-verification-status" as ActiveWaveGateRegistration["runId"],
  wave: 1,
  authorityDigest: digest("a") as ActiveWaveGateRegistration["authorityDigest"],
  revision: 0,
  terminalOutcome: null,
};

/** An operator manifest freezing the affectedRunner owner verification runs through (plan AD-8). */
const MANIFEST: FrozenVerificationManifest = value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
  schemaVersion: 2,
  kind: "loom-verification-manifest",
  checks: [],
  affectedRunner: AFFECTED_RUNNER,
}))));

const STATUS_TASK_FILES: readonly string[] = [FEES.owner, CLOCK.owner];

/** A satisfied Proof, so the completion suite is the Wave's only open prerequisite. */
const proof = evaluateTaskProof(
  { newTestsRequired: false, declaredArtifacts: STATUS_TASK_FILES },
  { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: STATUS_TASK_FILES, newTestsWritten: false },
);
if (proof.state !== "satisfied") throw new Error("proof fixture must be satisfied");

/** The protected graph as stored: one implemented, reviewed Wave 1 Task changing both owners. */
const STATUS_GRAPH = Object.freeze({
  current_phase: "execute",
  current_wave: 1,
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: PLAN_FILE,
  wave_gates: {},
  spec_check: capturedSpecCheck({ wave: 1, runAt: "now", criticalFindings: [] }),
  active_wave_gate: registration,
  verification_manifest: MANIFEST,
  owner_obligations: OBLIGATIONS,
  tasks: [{
    id: "T1",
    description: "Change the fee and clock owners",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    new_tests_required: false,
    proof,
    depends_on: [],
    file_list: STATUS_TASK_FILES,
    files_modified: STATUS_TASK_FILES,
    test_result: { verdict: "trusted-pass" },
    test_evidence: "vitest pass",
    review_status: "passed",
    critical_findings: [],
    advisory_findings: [],
  }],
});

const parsedStatusGraph = (): TaskGraph => {
  const parsed = parseTaskGraph(JSON.parse(JSON.stringify(STATUS_GRAPH)));
  if (!parsed.ok) throw new Error(`status fixture graph rejected: ${String(parsed.error)}`);
  return parsed.value;
};

/** The owner check authority the plan gives obligations.ts (AD-4): null iff the graph carries no stamp. */
type OwnerCheckAuthority = Readonly<{ obligationsDigest: ArtifactDigest; owed: readonly string[] }>;
type OwnerCheckAuthorityFn = (graph: TaskGraph, wave: number) => OwnerCheckAuthority | null;

/** `authorizeWaveCompletionSuite` with the owner parameter the plan adds (AD-1); its callers obtain it from `ownerCheckAuthority`. */
type AuthorizeWithOwner = (
  manifest: FrozenVerificationManifest,
  active: ActiveWaveGateRegistration,
  workspaceDigest: ArtifactDigest,
  owner: OwnerCheckAuthority | null,
) => ReturnType<typeof authorizeWaveCompletionSuite>;
const authorizeWithOwner = authorizeWaveCompletionSuite as unknown as AuthorizeWithOwner;

const OBLIGATIONS_MODULE = resolve(__dirname, "../../src/core/owner-verification/obligations.ts");

/**
 * The owner check authority of the stamped graph, from INV-3's owner. Until
 * that module exists the suite is authorized without the owner check, so the
 * status read still runs and the testcase fails on what status reports. Once
 * it exists it must load and export the function: anything else fails here.
 */
async function ownerCheckAuthorityOf(graph: TaskGraph): Promise<OwnerCheckAuthority | null> {
  if (!existsSync(OBLIGATIONS_MODULE)) return null;
  const loaded: unknown = await import(/* @vite-ignore */ OBLIGATIONS_MODULE);
  const candidate = typeof loaded === "object" && loaded !== null && "ownerCheckAuthority" in loaded
    ? loaded.ownerCheckAuthority
    : undefined;
  if (typeof candidate !== "function") throw new Error(`${OBLIGATIONS_MODULE} exports no ownerCheckAuthority`);
  return (candidate as OwnerCheckAuthorityFn)(graph, registration.wave);
}

const OWNER_CHECK_ID = "loom:owner-verification";

/** The tallies of a verified mutation run over a changed owner; `verifiedMutationOf` derives `generated`. */
type VerifiedMutation = Omit<VerifiedMutationFields, "ownerChangedInWave">;

/** INV-1's verdict: a verified mutation run over its changed owner lines. */
const feesVerdict = (coverage: CoverageVerdict, mutation: VerifiedMutation): InvariantVerdict => ({
  invariant: FEES.invariant,
  title: FEES.title,
  owner: FEES.owner,
  matrixTest: FEES.matrixTest,
  coverage,
  mutation: labelledValue("INV-1 verified mutation", verifiedMutationOf({ ...mutation, ownerChangedInWave: true })),
});

/** INV-2's verdict: covered, with its declared exemption recorded. */
const clockVerdict = (): InvariantVerdict => ({
  invariant: CLOCK.invariant,
  title: CLOCK.title,
  owner: CLOCK.owner,
  matrixTest: CLOCK.matrixTest,
  coverage: { kind: "covered" },
  mutation: { kind: "exempt", reason: CLOCK.mutation.reason },
});

/** INV-1's sibling the sibling-omitting matrix test never imports. */
const MISSING_SIBLING = FEES.siblings[1].path;
const missingSibling: CoverageVerdict = { kind: "missing", paths: [MISSING_SIBLING] satisfies NonEmpty<string> };

/**
 * The latest persisted completion result of the active Wave Gate run, as the
 * status shell observes it: every authorized check observed (the owner check
 * exits 1 exactly when owner verification blocks, as the reserved lint check
 * does), the owner-verification observation attached, then parsed.
 */
async function persistedResult(
  graph: TaskGraph,
  verdicts: readonly InvariantVerdict[],
  blocked: boolean,
): Promise<WaveCompletionResultObservation> {
  const owner = await ownerCheckAuthorityOf(graph);
  const ownerVerification: OwnerVerificationObservation = {
    kind: "verified",
    obligationsDigest: owner?.obligationsDigest ?? digest("e"),
    boundMs: 1_500_000,
    verdicts,
  };
  const authority = value(authorizeWithOwner(MANIFEST, registration, WORKSPACE, owner));
  const raw = {
    kind: "wave-completion-suite-result",
    runId: authority.runId,
    wave: authority.wave,
    revision: authority.revision,
    authorityDigest: authority.authorityDigest,
    manifestDigest: authority.manifestDigest,
    suiteDigest: authority.suiteDigest,
    workspaceDigest: authority.workspaceDigest,
    checks: authority.checks.map((check) => ({
      checkId: check.checkId,
      scope: "wave",
      outcome: {
        kind: "observed",
        exitCode: blocked && check.checkId === OWNER_CHECK_ID ? 1 : 0,
        timedOut: false,
        signal: null,
        report: { kind: "not-required" },
      },
    })),
    ownerVerification,
  };
  const parsed = parseWaveCompletionSuiteResult(raw);
  return parsed.ok
    ? { kind: "observed", result: parsed.value }
    : { kind: "unavailable", reason: `completion result is malformed: ${parsed.error.errors.join("; ")}` };
}

/** `helper orchestration status`, human and `--json`, from one graph and one persisted result. */
function status(currentWaveCompletionResult: WaveCompletionResultObservation): Readonly<{ human: string; json: unknown }> {
  const deps: StatusDeps = {
    loadPlanModels: () => ({ kind: "loaded", models: parsePlanModels(PLAN_TEXT) }),
    filePresence: () => ({ ok: true, exists: true }),
    currentWaveWorkspace: { kind: "observed", workspaceDigest: WORKSPACE },
    currentWaveCompletionResult,
  };
  const graph = JSON.parse(JSON.stringify(STATUS_GRAPH)) as unknown;
  return {
    human: renderStatus(graph, deps, false),
    json: JSON.parse(renderStatus(graph, deps, true)) as unknown,
  };
}

/** Every object in `node` (depth-first) whose `invariant` is `id`. */
function entriesFor(node: unknown, id: string): readonly Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((item) => entriesFor(item, id));
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  const own = record.invariant === id ? [record] : [];
  return [...own, ...Object.values(record).flatMap((child) => entriesFor(child, id))];
}

/** The JSON status entry reported for Invariant `id`. */
function jsonEntry(json: unknown, id: string): Record<string, unknown> {
  const [entry] = entriesFor(json, id);
  expect(entry, `status --json reports no per-Invariant entry for ${id}`).toBeDefined();
  return entry!;
}

/** The first number reported under `key` anywhere inside `node`. */
function numberAt(node: unknown, key: string): number | undefined {
  if (Array.isArray(node)) return node.map((item) => numberAt(item, key)).find((found) => found !== undefined);
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  if (typeof record[key] === "number") return record[key] as number;
  return Object.values(record).map((child) => numberAt(child, key)).find((found) => found !== undefined);
}

/** The survivor count of an entry: a `survived` count, or the length of its `survivors`. */
function survivedIn(entry: Record<string, unknown>): number | undefined {
  const counted = numberAt(entry, "survived");
  if (counted !== undefined) return counted;
  const find = (node: unknown): unknown[] | undefined => {
    if (typeof node !== "object" || node === null) return undefined;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.survivors)) return record.survivors;
    return Object.values(record).map(find).find((found) => found !== undefined);
  };
  return find(entry)?.length;
}

/** The human text from Invariant `id`'s first mention up to the next other Invariant's. */
function humanBlock(human: string, id: string, others: readonly string[]): string {
  const start = human.indexOf(id);
  expect(start, `human status never mentions ${id}`).toBeGreaterThanOrEqual(0);
  const ends = others.map((other) => human.indexOf(other, start + id.length)).filter((index) => index >= 0);
  return human.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

/** `label` reported with `count`: "generated 8", "generated: 8", `"generated":8` or "8 generated". */
const reportsCount = (text: string, label: string, count: number): boolean =>
  new RegExp(`(${label}\\W{0,3}${count}\\b)|(\\b${count}\\W{0,3}${label})`, "i").test(text);

const COUNT_LABELS = Object.freeze({
  generated: "generated",
  killed: "killed",
  timedOut: "timed[ _-]?out",
  invalid: "invalid",
  survived: "survived",
  unmutated: "unmutated",
});

/** The status's next action and its reasons, as one text. */
const nextActionText = (json: unknown): string =>
  JSON.stringify(typeof json === "object" && json !== null ? (json as Record<string, unknown>).next : null);

describe("owner verification in helper orchestration status (CT-2)", () => {
  it("AS-029: FR-028: status --json reports per Invariant the coverage pass and the mutants generated, killed, timed out, invalid, survived and unmutated, or the exemption", async () => {
    const graph = parsedStatusGraph();
    const mutation = { killed: 5, timedOut: 2, invalid: 1, survivors: [], unmutated: 3 };
    const { json } = status(await persistedResult(graph, [feesVerdict({ kind: "covered" }, mutation), clockVerdict()], false));

    const fees = jsonEntry(json, FEES.invariant);
    expect(JSON.stringify(fees)).toMatch(/"(pass|covered)"/);
    expect(numberAt(fees, "generated")).toBe(8);
    expect(numberAt(fees, "killed")).toBe(5);
    expect(numberAt(fees, "timedOut")).toBe(2);
    expect(numberAt(fees, "invalid")).toBe(1);
    expect(survivedIn(fees)).toBe(0);
    expect(numberAt(fees, "unmutated")).toBe(3);

    const clock = jsonEntry(json, CLOCK.invariant);
    expect(JSON.stringify(clock)).toMatch(/"(pass|covered)"/);
    expect(JSON.stringify(clock)).toMatch(/exempt/i);
    expect(JSON.stringify(clock)).toContain(CLOCK.mutation.reason);
    expect(numberAt(clock, "generated")).toBeUndefined();
  });

  it("AS-029: FR-028: human status reports the same per-Invariant coverage, mutant counts and exemption as --json, from one projection", async () => {
    const graph = parsedStatusGraph();
    const mutation = { killed: 5, timedOut: 2, invalid: 1, survivors: [], unmutated: 3 };
    const { human, json } = status(await persistedResult(graph, [feesVerdict({ kind: "covered" }, mutation), clockVerdict()], false));

    const fees = humanBlock(human, FEES.invariant, [CLOCK.invariant]);
    expect(fees).toMatch(/pass|covered/i);
    const expected = { generated: 8, killed: 5, timedOut: 2, invalid: 1, survived: 0, unmutated: 3 } as const;
    for (const [key, count] of Object.entries(expected)) {
      expect(reportsCount(fees, COUNT_LABELS[key as keyof typeof COUNT_LABELS], count), `human ${FEES.invariant} ${key} ${count}`).toBe(true);
    }
    const clock = humanBlock(human, CLOCK.invariant, [FEES.invariant]);
    expect(clock).toMatch(/exempt/i);
    expect(clock).toContain(CLOCK.mutation.reason);
    // One projection: the JSON entry carries the very counts the human text shows.
    const feesJson = jsonEntry(json, FEES.invariant);
    expect(numberAt(feesJson, "generated")).toBe(expected.generated);
    expect(numberAt(feesJson, "unmutated")).toBe(expected.unmutated);
  });

  it("AS-029: FR-028: status reports a missing sibling as the Invariant's coverage result", async () => {
    const graph = parsedStatusGraph();
    const mutation = { killed: 4, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 };
    const { human, json } = status(await persistedResult(
      graph,
      [feesVerdict(missingSibling, mutation), clockVerdict()],
      true,
    ));

    expect(JSON.stringify(jsonEntry(json, FEES.invariant))).toContain(MISSING_SIBLING);
    expect(humanBlock(human, FEES.invariant, [CLOCK.invariant])).toContain(MISSING_SIBLING);
  });

  it("AS-030: FR-028: a gate blocked by a missing sibling names the Invariant and the remedy in the next action: strengthen the matrix test to import it", async () => {
    const graph = parsedStatusGraph();
    const mutation = { killed: 4, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 };
    const { human, json } = status(await persistedResult(
      graph,
      [feesVerdict(missingSibling, mutation), clockVerdict()],
      true,
    ));

    const next = nextActionText(json);
    expect(next).toContain(FEES.invariant);
    expect(next).toMatch(/strengthen/i);
    expect(next).toContain(FEES.matrixTest);
    expect(next).toMatch(/import/i);
    expect(next).toContain(MISSING_SIBLING);
    // Human output carries the same next action.
    const humanNext = human.slice(human.indexOf("- nextAction"));
    expect(humanNext).toContain(FEES.invariant);
    expect(humanNext).toContain(MISSING_SIBLING);
  });

  it("AS-030: FR-028: a gate blocked by a surviving mutant names the Invariant and the remedy: kill the survivor in the matrix test, or declare a mutation exemption with a reason", async () => {
    const graph = parsedStatusGraph();
    const survivor: SurvivorDiagnostic = {
      mutantId: "f".repeat(64),
      operator: "comparison-flip",
      line: 12,
      column: 14,
      original: ">",
      replacement: "<=",
    };
    const mutation = { killed: 5, timedOut: 0, invalid: 0, survivors: [survivor], unmutated: 0 };
    const { human, json } = status(await persistedResult(
      graph,
      [feesVerdict({ kind: "covered" }, mutation), clockVerdict()],
      true,
    ));

    expect(survivedIn(jsonEntry(json, FEES.invariant))).toBe(1);
    const next = nextActionText(json);
    expect(next).toContain(FEES.invariant);
    expect(next).toMatch(/strengthen/i);
    expect(next).toContain(FEES.matrixTest);
    expect(next).toContain(`${FEES.owner}:${survivor.line}`);
    expect(next).toContain(survivor.operator);
    expect(next).toMatch(/mutation exemption/i);
    expect(next).toMatch(/reason/i);
    const humanNext = human.slice(human.indexOf("- nextAction"));
    expect(humanNext).toContain(FEES.invariant);
    expect(humanNext).toContain(`${FEES.owner}:${survivor.line}`);
  });
});
