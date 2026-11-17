/**
 * Engine-run test evidence (loom#198, Cause 1): the receipt `helper run-tests`
 * prints, the TestRun the recorder mints from it, the TaskGraph's frozen
 * `test_evidence` mode, and the one admission rule the I6 judge and the test
 * verdict read.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ENGINE_TEST_RUN_RECEIPT_PREFIX,
  engineRunReport,
  formatEngineTestRunReceipt,
  parseEngineTestRunReceipt,
  type EngineTestRunReceipt,
} from "../../src/core/engine-test-run";
import {
  adoptEngineRunTestEvidence,
  engineRunTestEvidence,
  parseTestEvidenceField,
  POPULATION_ADOPTION,
  testEvidenceModeNotice,
  testEvidencePolicyOf,
} from "../../src/core/test-evidence-authority";
import { admitsTestRun, AGENT_COMMAND_EVIDENCE, type TestEvidencePolicy } from "../../src/core/test-evidence-policy";
import { judgeRedThenGreen } from "../../src/core/red-then-green";
import { resolveTestEvidence } from "../../src/core/implementation-evidence";
import { extractEvidence } from "../../src/machine/extract-evidence";
import type { Evidence } from "../../src/machine/types";
import type { TestFileClassification } from "../../src/core/red-then-green-types";
import { claudeCall } from "../fixtures/claude-tool-call";
import { mutationManifest, junitReport } from "../fixtures/task-mutation";
import { failing, IMPL, passing, report, TEST_A } from "../fixtures/red-then-green-status-fixtures";
import { graphFixture } from "../fixtures/task-lifecycle";
import { AGENT_COMMAND_ORIGIN } from "../../src/machine/types";
import { parseEvidenceLine } from "../../src/machine/evidence";
import { mutationRunFiles } from "../../src/core/task-mutation-check";

const ROOT = "/repo";
const MANIFEST = mutationManifest();
const DIGEST = MANIFEST.manifestDigest;
const ENGINE_CLI = "/loom/engine/src/cli.ts";
const isEngineCli = (word: string): boolean => word === ENGINE_CLI;
const POPULATED = engineRunTestEvidence(MANIFEST, POPULATION_ADOPTION);
if (!POPULATED.ok) throw new Error(`fixture manifest cannot run engine tests: ${POPULATED.error}`);
const ENGINE_POLICY: TestEvidencePolicy = testEvidencePolicyOf(POPULATED.value, ROOT);

const receipt = (overrides: Partial<EngineTestRunReceipt> = {}): EngineTestRunReceipt => ({
  repositoryRoot: ROOT,
  manifestDigest: DIGEST,
  files: [TEST_A],
  exit: 1,
  report: report([failing(TEST_A)]),
  ...overrides,
});

const RUN_TESTS = `bun ${ENGINE_CLI} helper run-tests --files ${TEST_A}`;

/** The events one Claude Code Bash call mints, with the engine CLI recognized. */
const mint = (command: string, stdout: string, exit = 0): readonly Evidence[] =>
  extractEvidence(claudeCall("Bash", { command }, { exit_code: exit, stdout }), () => null, isEngineCli);

const engineRuns = (events: readonly Evidence[]) =>
  events.filter((event) => event.kind === "TestRun" && event.origin.kind === "engine-run");

describe("the engine test-run receipt", () => {
  it("round-trips through its one format and parse", () => {
    const line = formatEngineTestRunReceipt(receipt());
    const parsed = parseEngineTestRunReceipt(`run-tests: exit 1\n${line}\n`);
    expect(parsed).toEqual({ ok: true, value: receipt() });
  });

  it("is read only from the last non-empty line: a receipt a test printed earlier is not one", () => {
    const forged = formatEngineTestRunReceipt(receipt({ exit: 0, report: report([passing(TEST_A)]) }));
    expect(parseEngineTestRunReceipt(`${forged}\nsome later runner output\n`).ok).toBe(false);
  });

  it("refuses a receipt with an extra key, a relative root, a bad digest, a repeated file or a non-integer exit", () => {
    const wire = (patch: Record<string, unknown>): string => {
      const body = JSON.parse(formatEngineTestRunReceipt(receipt()).slice(ENGINE_TEST_RUN_RECEIPT_PREFIX.length)) as Record<string, unknown>;
      return `${ENGINE_TEST_RUN_RECEIPT_PREFIX}${JSON.stringify({ ...body, ...patch })}`;
    };
    for (const patch of [
      { extra: true },
      { repositoryRoot: "repo" },
      { manifestDigest: "abc" },
      { files: [TEST_A, TEST_A] },
      { files: [] },
      { exit: 0.5 },
      { kind: "other" },
      { schemaVersion: 2 },
    ]) {
      expect(parseEngineTestRunReceipt(wire(patch)).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("refuses a report the summary constructor would not mint", () => {
    const body = JSON.parse(formatEngineTestRunReceipt(receipt()).slice(ENGINE_TEST_RUN_RECEIPT_PREFIX.length)) as Record<string, unknown>;
    const forged = { ...body, report: { ...(body.report as Record<string, unknown>), failed: 99 } };
    expect(parseEngineTestRunReceipt(`${ENGINE_TEST_RUN_RECEIPT_PREFIX}${JSON.stringify(forged)}`).ok).toBe(false);
  });
});

describe("engineRunReport: what a finished engine run yields", () => {
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

  it("is the runner's JUnit report, whatever the exit", () => {
    const junit = text(junitReport([{ file: TEST_A, name: "t", outcome: "failed" }]));
    expect(engineRunReport([TEST_A], 1, junit)).toMatchObject({ source: "junit-xml", total: 1, failed: 1 });
  });

  it("is a runner-crash summary when the runner exited non-zero without a readable report", () => {
    const crash = engineRunReport([TEST_A], 1, null);
    expect(crash).toMatchObject({ source: "runner-crash", total: 1, failed: 1 });
    expect(crash?.files).toEqual({ kind: "recorded", results: [expect.objectContaining({ file: TEST_A, collectionError: true })] });
    expect(engineRunReport([TEST_A], 1, "not a report")).toMatchObject({ source: "runner-crash" });
  });

  it("is nothing when the runner exited 0 without one: an exit alone proves nothing", () => {
    expect(engineRunReport([TEST_A], 0, null)).toBeNull();
  });
});

describe("minting: only a sole bare engine invocation with a receipt is an engine run", () => {
  const stdout = `run-tests: exit 1\n${formatEngineTestRunReceipt(receipt())}\n`;

  it("mints an engine-run TestRun bound to the receipt's root and manifest", () => {
    const [run] = engineRuns(mint(RUN_TESTS, stdout));
    expect(run).toMatchObject({ kind: "TestRun", origin: { kind: "engine-run", repositoryRoot: ROOT, manifestDigest: DIGEST }, exit: 1 });
  });

  it.each([
    ["an environment prefix", `CI=1 ${RUN_TESTS}`],
    ["a chain", `cd /repo && ${RUN_TESTS}`],
    ["a second command", `${RUN_TESTS}; true`],
    ["a pipe", `${RUN_TESTS} | tail -1`],
    ["a redirect", `${RUN_TESTS} > /tmp/out.txt`],
    ["a command substitution", `bun $(echo ${ENGINE_CLI}) helper run-tests --files ${TEST_A}`],
    ["a look-alike CLI", `bun /elsewhere/cli.ts helper run-tests --files ${TEST_A}`],
    ["another helper", `bun ${ENGINE_CLI} helper mutation-check --task T1`],
    ["a printed receipt", `printf '%s\\n' receipt`],
  ])("mints none through %s", (_label, command) => {
    expect(engineRuns(mint(command, stdout))).toEqual([]);
  });

  it("mints none when the receipt is not the last line", () => {
    expect(engineRuns(mint(RUN_TESTS, `${stdout}trailing\n`))).toEqual([]);
  });

  it("an agent's own test command is still recorded, as an agent-command run", () => {
    const events = mint("npx vitest run", "", 0);
    expect(events.filter((event) => event.kind === "TestRun")).toEqual([expect.objectContaining({ origin: { kind: "agent-command" } })]);
  });
});

describe("the test_evidence field", () => {
  it("parses population and operator adoptions bound to the frozen manifest", () => {
    expect(parseTestEvidenceField({ kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "population" }, MANIFEST))
      .toEqual({ ok: true, value: { kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "population" } });
    expect(parseTestEvidenceField({ kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "operator", reason: "mocha" }, MANIFEST))
      .toEqual({ ok: true, value: { kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "operator", reason: "mocha" } });
    expect(parseTestEvidenceField(undefined, MANIFEST)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ["another manifest's digest", { kind: "engine-run", manifestDigest: "f".repeat(64), adoptedBy: "population" }, MANIFEST],
    ["a manifest without an affectedRunner", { kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "population" }, mutationManifest({ affectedRunner: undefined })],
    ["no manifest", { kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "population" }, undefined],
    ["a reason on a population adoption", { kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "population", reason: "x" }, MANIFEST],
    ["an operator adoption without a reason", { kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "operator" }, MANIFEST],
    ["an unknown adopter", { kind: "engine-run", manifestDigest: DIGEST, adoptedBy: "agent" }, MANIFEST],
    ["another kind", { kind: "agent-command", manifestDigest: DIGEST, adoptedBy: "population" }, MANIFEST],
  ])("refuses %s", (_label, raw, manifest) => {
    expect(parseTestEvidenceField(raw, manifest).ok).toBe(false);
  });
});

describe("adoptEngineRunTestEvidence: the operator's adoption", () => {
  const graph = { ...graphFixture([]), verification_manifest: MANIFEST };

  it("installs the mode with the operator's reason, and is idempotent", () => {
    const adopted = adoptEngineRunTestEvidence(graph, "the project runs mocha");
    expect(adopted).toMatchObject({ ok: true, value: { kind: "adopted", testEvidence: { adoptedBy: "operator", reason: "the project runs mocha", manifestDigest: DIGEST } } });
    if (!adopted.ok || adopted.value.kind !== "adopted") throw new Error("expected adoption");
    expect(adoptEngineRunTestEvidence(adopted.value.graph, "again")).toMatchObject({ ok: true, value: { kind: "already-adopted" } });
  });

  it.each([
    ["outside execute", { ...graph, current_phase: "decompose" as const }, "why"],
    ["while an attempt is reserved", { ...graph, executing_tasks: ["T1"] }, "why"],
    ["without an affectedRunner", { ...graph, verification_manifest: mutationManifest({ affectedRunner: undefined }) }, "why"],
    ["with a blank reason", graph, "  "],
    ["with a multi-line reason", graph, "a\nb"],
  ])("refuses %s", (_label, candidate, reason) => {
    expect(adoptEngineRunTestEvidence(candidate, reason).ok).toBe(false);
  });
});

describe("admission: the one rule", () => {
  const agentRun: Extract<Evidence, { kind: "TestRun" }> = { kind: "TestRun", origin: { kind: "agent-command" }, command: "npx vitest", exit: 0, report: null };
  const engineRun = (repositoryRoot: string, manifestDigest: string): Extract<Evidence, { kind: "TestRun" }> =>
    ({ kind: "TestRun", origin: { kind: "engine-run", repositoryRoot, manifestDigest }, command: RUN_TESTS, exit: 0, report: null });

  it("a graph without the mode admits every run", () => {
    expect(admitsTestRun(AGENT_COMMAND_EVIDENCE, agentRun)).toBe(true);
    expect(admitsTestRun(AGENT_COMMAND_EVIDENCE, engineRun("/elsewhere", "0".repeat(64)))).toBe(true);
  });

  it("an engine-run graph admits only its own repository's runs under its own manifest", () => {
    fc.assert(fc.property(fc.constantFrom(ROOT, "/elsewhere"), fc.constantFrom(DIGEST, "0".repeat(64)), (root, digest) => {
      expect(admitsTestRun(ENGINE_POLICY, engineRun(root, digest))).toBe(root === ROOT && digest === DIGEST);
    }));
    expect(admitsTestRun(ENGINE_POLICY, agentRun)).toBe(false);
  });
});

describe("the I6 judge and the test verdict under an engine-run graph", () => {
  const CLASSIFIED: TestFileClassification = { testFiles: [TEST_A], implementationFiles: [IMPL], createdImplementationFiles: [] };
  const run = (origin: Extract<Evidence, { kind: "TestRun" }>["origin"], exit: number, red: boolean): Evidence =>
    ({ kind: "TestRun", origin, command: "run", exit, report: report([red ? failing(TEST_A) : passing(TEST_A)]) });
  const ENGINE = { kind: "engine-run" as const, repositoryRoot: ROOT, manifestDigest: DIGEST };
  const AGENT = AGENT_COMMAND_ORIGIN;
  const epoch = (origin: typeof ENGINE | typeof AGENT): readonly Evidence[] => [
    run(origin, 1, true),
    { kind: "FileWrite", path: IMPL, via: "tool" },
    run(origin, 0, false),
  ];

  it("shows red-then-green from engine runs", () => {
    expect(judgeRedThenGreen(epoch(ENGINE), CLASSIFIED, ROOT, false, ENGINE_POLICY)).toMatchObject({ kind: "shown" });
  });

  it("counts an agent's own runs as untrusted, never as the red", () => {
    expect(judgeRedThenGreen(epoch(AGENT), CLASSIFIED, ROOT, false, ENGINE_POLICY))
      .toEqual({ kind: "unproven", gap: { kind: "red-missing", untrustedOnly: true } });
    expect(judgeRedThenGreen(epoch(AGENT), CLASSIFIED, ROOT, false, AGENT_COMMAND_EVIDENCE)).toMatchObject({ kind: "shown" });
  });

  it("the test verdict admits only engine runs, and names why an agent's pass is not one", () => {
    expect(resolveTestEvidence([run(ENGINE, 0, false)], ENGINE_POLICY, "", false).result).toEqual({ verdict: "trusted-pass" });
    const agent = resolveTestEvidence([run(AGENT, 0, false)], ENGINE_POLICY, "", false);
    expect(agent.result).toMatchObject({ verdict: "untrusted" });
    expect(agent.result.verdict === "untrusted" ? agent.result.label : "").toContain("not admitted");
  });

  it("an agent's later exit-0 run does not make an engine run's trusted failure stale", () => {
    expect(resolveTestEvidence([run(ENGINE, 1, true), run(AGENT, 0, false)], ENGINE_POLICY, "", false).result)
      .toEqual({ verdict: "trusted-fail" });
  });
});

describe("the ledger's TestRun origin, read back (loom#198)", () => {
  const line = (event: Record<string, unknown>): string =>
    JSON.stringify({ epoch: "agent-1:code-implementer-agent", event: { kind: "TestRun", command: "run", exit: 1, report: null, ...event } });
  const originOf = (event: Record<string, unknown>) => {
    const parsed = parseEvidenceLine(line(event));
    if (!parsed.ok || parsed.value.event.kind !== "TestRun") throw new Error("expected a TestRun line");
    return parsed.value.event.origin;
  };
  const BINDING = { repositoryRoot: ROOT, manifestDigest: DIGEST };

  it("round-trips an engine-run origin", () => {
    expect(originOf({ origin: { kind: "engine-run", ...BINDING } })).toEqual({ kind: "engine-run", ...BINDING });
  });

  it("reads a line without an origin as an agent command, as every line before engine runs", () => {
    expect(originOf({})).toEqual(AGENT_COMMAND_ORIGIN);
  });

  it.each([
    ["an extra key", { kind: "engine-run", ...BINDING, extra: 1 }],
    ["a relative root", { kind: "engine-run", repositoryRoot: "repo", manifestDigest: DIGEST }],
    ["a digest that is no sha256", { kind: "engine-run", repositoryRoot: ROOT, manifestDigest: "abc" }],
    ["a missing digest", { kind: "engine-run", repositoryRoot: ROOT }],
    ["another kind", { kind: "other", ...BINDING }],
    ["an array", [BINDING]],
  ])("fails closed to an agent command on %s", (_label, origin) => {
    expect(originOf({ origin })).toEqual(AGENT_COMMAND_ORIGIN);
  });

  it("keeps a runner-crash report only on the engine run that minted it", () => {
    const crash = engineRunReport([TEST_A], 1, null);
    const read = (origin: unknown) => {
      const parsed = parseEvidenceLine(line({ origin, report: crash }));
      return parsed.ok && parsed.value.event.kind === "TestRun" ? parsed.value.event.report : "unparsed";
    };
    expect(read({ kind: "engine-run", ...BINDING })).toMatchObject({ source: "runner-crash" });
    expect(read(undefined)).toBeNull();
  });
});

describe("the receipt refuses a runner-crash report on a clean exit", () => {
  it("is refused whole", () => {
    const crash = engineRunReport([TEST_A], 1, null);
    expect(parseEngineTestRunReceipt(formatEngineTestRunReceipt(receipt({ exit: 0, report: crash }))).ok).toBe(false);
    expect(parseEngineTestRunReceipt(formatEngineTestRunReceipt(receipt({ exit: 2, report: crash }))).ok).toBe(true);
  });
});

describe("mutationRunFiles: what one mutation run hands the runner", () => {
  it("is the mutated file, then the Task's tests without it", () => {
    expect(mutationRunFiles("src/a.ts", ["src/a.test.ts", "src/b.test.ts"])).toEqual(["src/a.ts", "src/a.test.ts", "src/b.test.ts"]);
    expect(mutationRunFiles("src/a.ts", [])).toEqual(["src/a.ts"]);
    expect(mutationRunFiles("src/a.test.ts", ["src/a.test.ts"])).toEqual(["src/a.test.ts"]);
  });
});

describe("testEvidenceModeNotice: population says which mode it froze", () => {
  it("names engine runs, or why an agent's own commands are admitted", () => {
    expect(testEvidenceModeNotice(POPULATED.value, MANIFEST)).toContain("only engine runs");
    expect(testEvidenceModeNotice(undefined, mutationManifest({ affectedRunner: undefined }))).toContain("declares no affectedRunner");
    expect(testEvidenceModeNotice(undefined, MANIFEST)).toContain("has not adopted engine-run evidence");
  });
});
