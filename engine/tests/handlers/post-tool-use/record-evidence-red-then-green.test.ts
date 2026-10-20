/**
 * I6 on Claude Code, end to end through the real recorder: a red run, the
 * first implementation write and a green run, each delivered as the hook
 * payload Claude Code 2.1.286 sends, must leave an epoch the I6 judge shows.
 *
 * This is the G4 slice 2 pilot's T1 epoch in miniature. Before the recorder
 * read PostToolUseFailure, the red run (a failed Bash call) never reached the
 * ledger, and no recorded run carried an exit code, so a Task that worked
 * test-first was refused `red-missing`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runRecordEvidence } from "../../../src/handlers/post-tool-use/record-evidence";
import { judgeRedThenGreen } from "../../../src/core/red-then-green";
import { epochOf, eventsForEpoch } from "../../../src/machine";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { IMPLEMENTER_TYPE, agentIdOf, sessionIdOf } from "../../fixtures/machine-identities";
import { inMemorySessionRegistry } from "../../machine/fake-session-registry";

const temp = canonicalTempDir("loom-record-evidence-i6-");
const repo = join(temp, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "tests"), { recursive: true });

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

const report = (name: string) => join(temp, name);

/** A Vitest JSON report for one test file with one testcase. */
function vitestJson(failed: boolean): string {
  return JSON.stringify({
    numTotalTestSuites: 1,
    numPassedTestSuites: failed ? 0 : 1,
    numFailedTestSuites: failed ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: failed ? 0 : 1,
    numFailedTests: failed ? 1 : 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: Date.now(),
    success: !failed,
    testResults: [{
      name: join(repo, "tests/feature.test.ts"),
      status: failed ? "failed" : "passed",
      message: "",
      startTime: Date.now(),
      endTime: Date.now(),
      assertionResults: [{
        ancestorTitles: ["feature"],
        fullName: "feature works",
        title: "works",
        status: failed ? "failed" : "passed",
        duration: 1,
        failureMessages: failed ? ["AssertionError"] : [],
      }],
    }],
  });
}

const session = sessionIdOf("i6-claude-session");
const agent = agentIdOf("claude-impl-i6");
/** A Task that edits `src/feature.ts`, which existed at its first artifact baseline (FR-007). */
const classification = { testFiles: ["tests/feature.test.ts"], implementationFiles: ["src/feature.ts"], createdImplementationFiles: [] };
/** The same Task, creating `src/feature.ts` (FR-007a). */
const creating = { ...classification, createdImplementationFiles: ["src/feature.ts"] };

async function deliver(registry: ReturnType<typeof inMemorySessionRegistry>, callId: string, payload: Record<string, unknown>, effect?: () => void): Promise<void> {
  await registry.recordCallStart(session, callId, Date.now());
  effect?.();
  await runRecordEvidence(JSON.stringify({ session_id: session, agent_id: agent, cwd: repo, tool_use_id: callId, ...payload }), registry);
}

describe("I6 through Claude Code's recorder", () => {
  it("a red failure, the first implementation write and a green success are shown", async () => {
    const registry = inMemorySessionRegistry();
    await registry.markActive(session, agent);
    await registry.bind(session, IMPLEMENTER_TYPE, agent);

    const redReport = report("red.json");
    const redCommand = `npx vitest run tests/feature.test.ts --reporter=default --reporter=json --outputFile=${redReport}`;
    await deliver(registry, "red", {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: redCommand },
      error: "Exit code 1\n Tests  1 failed (1)\n",
      is_interrupt: false,
    }, () => writeFileSync(redReport, vitestJson(true)));

    await deliver(registry, "write", {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src/feature.ts"), content: "export const feature = 1;\n" },
      tool_response: { type: "create", filePath: join(repo, "src/feature.ts") },
    });

    const greenReport = report("green.json");
    const greenCommand = `npx vitest run tests/feature.test.ts --reporter=default --reporter=json --outputFile=${greenReport}`;
    await deliver(registry, "green", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: greenCommand },
      tool_response: { stdout: " Tests  1 passed (1)\n", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    }, () => writeFileSync(greenReport, vitestJson(false)));

    const events = eventsForEpoch(registry.readEvidence(session), epochOf(agent, IMPLEMENTER_TYPE));
    expect(events.filter((event) => event.kind === "TestRun").map((event) => event.kind === "TestRun" && event.exit)).toEqual([1, 0]);
    expect(judgeRedThenGreen(events, classification, repo, false)).toEqual({
      kind: "shown",
      red: { index: 0, command: redCommand },
      implementationWrite: "src/feature.ts",
      green: { index: 2, command: greenCommand },
    });
  });

  it("AS-042: a test file that cannot import the module the Task creates is red only for a Task that creates it", async () => {
    const registry = inMemorySessionRegistry();
    await registry.markActive(session, agent);
    await registry.bind(session, IMPLEMENTER_TYPE, agent);

    // What Vitest writes when the test file statically imports a module that does not exist yet.
    const redReport = report("collection-red.json");
    const redCommand = `npx vitest run tests/feature.test.ts --reporter=default --reporter=json --outputFile=${redReport}`;
    await deliver(registry, "collection-red", {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: redCommand },
      error: "Exit code 1\n FAIL  tests/feature.test.ts [ tests/feature.test.ts ]\nError: Failed to load url ../src/feature\n",
      is_interrupt: false,
    }, () => writeFileSync(redReport, vitestCollectionErrorJson()));

    await deliver(registry, "create", {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src/feature.ts"), content: "export const feature = 1;\n" },
      tool_response: { type: "create", filePath: join(repo, "src/feature.ts") },
    });

    const greenReport = report("collection-green.json");
    const greenCommand = `npx vitest run tests/feature.test.ts --reporter=default --reporter=json --outputFile=${greenReport}`;
    await deliver(registry, "collection-green", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: greenCommand },
      tool_response: { stdout: " Tests  1 passed (1)\n", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    }, () => writeFileSync(greenReport, vitestJson(false)));

    const events = eventsForEpoch(registry.readEvidence(session), epochOf(agent, IMPLEMENTER_TYPE));
    const red = events[0];
    expect(red?.kind === "TestRun" && red.report?.files).toEqual({
      kind: "recorded",
      results: [{ file: join(repo, "tests/feature.test.ts"), executed: 0, failed: 0, skipped: 0, collectionError: true }],
    });
    expect(judgeRedThenGreen(events, creating, repo, false)).toEqual({
      kind: "shown",
      red: { index: 0, command: redCommand },
      implementationWrite: "src/feature.ts",
      green: { index: 2, command: greenCommand },
    });
    expect(judgeRedThenGreen(events, classification, repo, false))
      .toEqual({ kind: "unproven", gap: { kind: "red-missing", untrustedOnly: false } });
  });
});

/** A Vitest JSON report whose one test file failed to collect: a failed entry with no assertions. */
function vitestCollectionErrorJson(): string {
  return JSON.stringify({
    numTotalTestSuites: 1,
    numPassedTestSuites: 0,
    numFailedTestSuites: 1,
    numPendingTestSuites: 0,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: Date.now(),
    success: false,
    testResults: [{
      name: join(repo, "tests/feature.test.ts"),
      status: "failed",
      message: "Failed to load url ../src/feature (resolved id: ../src/feature) in tests/feature.test.ts. Does the file exist?",
      startTime: Date.now(),
      endTime: Date.now(),
      assertionResults: [],
    }],
  });
}
