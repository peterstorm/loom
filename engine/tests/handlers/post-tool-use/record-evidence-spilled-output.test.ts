/**
 * loom#241 end to end through the real recorder: a `helper run-tests` call
 * whose output Claude Code spilled to a file still mints its engine-run
 * TestRun. The receipt is the last line of the whole output, past the
 * 30 000-character head the harness keeps in `tool_response.stdout`, so before
 * the recorder read the spilled file back, a long failing Maven run (the red
 * I6 needs) minted nothing and a test-first Task settled `red-missing`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runRecordEvidence, type ReadPersistedOutput } from "../../../src/handlers/post-tool-use/record-evidence";
import { formatEngineTestRunReceipt } from "../../../src/core/engine-test-run";
import { parseReportSummary } from "../../../src/core/structured-test-report";
import { epochOf, eventsForEpoch } from "../../../src/machine";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { IMPLEMENTER_TYPE, agentIdOf, sessionIdOf } from "../../fixtures/machine-identities";
import { inMemorySessionRegistry } from "../../machine/fake-session-registry";

const temp = canonicalTempDir("loom-record-evidence-spill-");
const repo = join(temp, "repo");
mkdirSync(repo, { recursive: true });

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

const ENGINE_CLI = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const TEST_FILE = "src/test/java/dk/acme/JobNameTest.java";
const COMMAND = `bun '${ENGINE_CLI}' helper run-tests --files '${TEST_FILE}'`;
const HEAD_CHARACTERS = 30_000;

const session = sessionIdOf("spill-claude-session");
const agent = agentIdOf("claude-impl-spill");

/** The whole output of a failing run: a long compiler log, then the receipt. */
function wholeOutput(): string {
  const report = parseReportSummary(1, 1, "runner-crash", {
    kind: "recorded", results: [{ file: TEST_FILE, executed: 1, failed: 1, skipped: 0, collectionError: true }],
  });
  if (report === null) throw new Error("fixture report must reconcile");
  const receipt = formatEngineTestRunReceipt({
    repositoryRoot: repo, manifestDigest: "a".repeat(64), files: [TEST_FILE], exit: 1, report,
  });
  return `--- runner stdout ---\n${"[ERROR] cannot find symbol: class JobName\n".repeat(1_000)}${receipt}\n`;
}

/** Deliver the spilled PostToolUse payload; returns the engine-run TestRuns the epoch holds. */
async function deliverSpilled(whole: string, spilledFile: string, read?: ReadPersistedOutput) {
  const registry = inMemorySessionRegistry();
  await registry.markActive(session, agent);
  await registry.bind(session, IMPLEMENTER_TYPE, agent);
  await registry.recordCallStart(session, "red", Date.now());
  const payload = {
    session_id: session, agent_id: agent, cwd: repo, tool_use_id: "red",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: COMMAND },
    tool_response: {
      stdout: whole.slice(0, HEAD_CHARACTERS), stderr: "", interrupted: false, isImage: false, noOutputExpected: false,
      persistedOutputPath: spilledFile, persistedOutputSize: new TextEncoder().encode(whole).length,
    },
  };
  // An undefined reader takes the handler's default: the real file read.
  await runRecordEvidence(JSON.stringify(payload), registry, read);
  return eventsForEpoch(registry.readEvidence(session), epochOf(agent, IMPLEMENTER_TYPE))
    .filter((event) => event.kind === "TestRun" && event.origin.kind === "engine-run");
}

describe("record-evidence restores Claude Code's spilled Bash output", () => {
  it("mints the engine-run TestRun whose receipt is only in the spilled file", async () => {
    const whole = wholeOutput();
    expect(whole.length).toBeGreaterThan(HEAD_CHARACTERS);
    const file = join(temp, "spilled.txt");
    writeFileSync(file, whole);

    const runs = await deliverSpilled(whole, file);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "TestRun", exit: 1, command: COMMAND, origin: { kind: "engine-run", repositoryRoot: repo } });
  });

  it("mints nothing, and says so, when the spilled file no longer holds the reported output", async () => {
    const whole = wholeOutput();
    const file = join(temp, "spilled-changed.txt");
    writeFileSync(file, `${whole}one more line\n`);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await deliverSpilled(whole, file)).toEqual([]);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("could not be read back whole");
    } finally {
      stderr.mockRestore();
    }
  });

  it("mints nothing when the spilled file is unreadable", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await deliverSpilled(wholeOutput(), join(temp, "missing.txt"))).toEqual([]);
      expect(await deliverSpilled(wholeOutput(), join(temp, "spilled.txt"), () => null)).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });
});
