/**
 * Improvement proof — before/after demonstrations that Phase A changed
 * real outcomes, not just architecture. Each test states the OLD behavior
 * (transcript-regex only, no gating) and asserts the NEW behavior.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractTestEvidence,
  resolveTestEvidence,
} from "../../src/handlers/subagent-stop/update-task-status";
import { parseBashTestOutput } from "../../src/parsers/parse-bash-test-output";
import { extractEvidence, extractBashOutcome } from "../../src/machine/extract-evidence";
import { foldEvidence, isToolAllowed, isTerminal, blockExplanation } from "../../src/machine/advance";
import { parseMachineJson } from "../../src/machine/parse-machine";
import { machineToMermaid } from "../../src/machine/mermaid";
import type { Evidence } from "../../src/machine/types";

const machinePath = join(__dirname, "../../../machines/code-implementer-agent.machine.json");
const parsed = parseMachineJson(readFileSync(machinePath, "utf-8"));
if (!parsed.ok) throw new Error(parsed.error);
const machine = parsed.value;

// Transcript JSONL for a Bash call whose output the agent controls
function bashTranscript(command: string, output: string): string {
  return [
    JSON.stringify({
      message: { content: [{ type: "tool_use", name: "Bash", id: "t1", input: { command } }] },
    }),
    JSON.stringify({
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: output }] },
    }),
  ].join("\n");
}

describe("R2 — real exit status beats happy output text", () => {
  // An agent runs `mvn test`; the build prints BUILD SUCCESS-shaped text
  // but the process actually exited 1 (e.g. failure in a later module).
  const lyingOutput = "BUILD SUCCESS\nTests run: 12, Failures: 0, Errors: 0";
  const transcript = bashTranscript("mvn test", lyingOutput);
  const bashOutput = parseBashTestOutput(transcript);

  it("OLD: transcript regex is fooled by the output text", () => {
    expect(extractTestEvidence(bashOutput).passed).toBe(true); // the documented weakness
  });

  it("NEW: a trusted ledger failure (exit 1) overrides the text", () => {
    const ledger = extractEvidence(
      "Bash",
      { command: "mvn test" },
      { exit: 1, stdout: lyingOutput },
      () => null,
    );
    const resolved = resolveTestEvidence(ledger, bashOutput);
    expect(resolved.passed).toBe(false);
    expect(resolved.evidence).toContain("ledger: exit 1");
  });
});

describe("R2 — reporter-confirmed pass carries explicit provenance", () => {
  it("NEW: exit 0 + parsed report → trusted pass, evidence names the ground truth", () => {
    const ledger = extractEvidence(
      "Bash",
      { command: "npx vitest run --reporter=json --outputFile=out.json" },
      { exit: 0, stdout: "" },
      () => ({ total: 9, failed: 0, source: "vitest-json" }),
    );
    const resolved = resolveTestEvidence(ledger, "");
    expect(resolved.passed).toBe(true);
    expect(resolved.evidence).toContain("ledger: exit 0");
    expect(resolved.evidence).toContain("9 tests / 0 failed");
  });

  it("NEW: exit 0 but the report shows failures → not passed (report cross-check)", () => {
    const ledger = extractEvidence(
      "Bash",
      { command: "npx vitest run --reporter=json" },
      { exit: 0, stdout: "" },
      () => ({ total: 9, failed: 2, source: "vitest-json" }),
    );
    expect(resolveTestEvidence(ledger, "irrelevant").passed).toBe(false);
  });

  it("NEW: exit 0 with a report saying 0 tests ran → not passed (nothing was verified)", () => {
    const ledger = extractEvidence(
      "Bash",
      { command: "npx vitest run --reporter=json" },
      { exit: 0, stdout: "" },
      () => ({ total: 0, failed: 0, source: "vitest-json" }),
    );
    expect(resolveTestEvidence(ledger, "").passed).toBe(false);
  });
});

describe("R2 — the echo spoof is no longer silent", () => {
  // The crafted-command spoof from the critique: the command matches test
  // patterns, exits 0, and its output matches the pass regex.
  const spoofCmd = 'echo "npm test: 5 passing"';
  const spoofOut = "npm test: 5 passing";
  const transcript = bashTranscript(spoofCmd, spoofOut);
  const bashOutput = parseBashTestOutput(transcript);

  it("OLD: spoof passes with evidence indistinguishable from a real run", () => {
    const old = extractTestEvidence(bashOutput);
    expect(old.passed).toBe(true);
    expect(old.evidence).toBe("node: 5 passing"); // looks legit — invisible spoof
  });

  it("NEW: spoof is flagged low-trust in the evidence trail (no report artifact)", () => {
    const ledger = extractEvidence("Bash", { command: spoofCmd }, { exit: 0, stdout: spoofOut }, () => null);
    const resolved = resolveTestEvidence(ledger, bashOutput);
    // Honest tiering, not silent pass: reporterless projects fall back,
    // but the evidence names the weakness for the wave gate / humans.
    expect(resolved.evidence).toContain("low-trust");
    expect(resolved.evidence).toContain("no report artifact");
  });

  it("NEW: the spoof never satisfies the machine — terminal stays unreachable", () => {
    const ledger = extractEvidence("Bash", { command: spoofCmd }, { exit: 0, stdout: spoofOut }, () => null);
    const events: Evidence[] = [{ kind: "FileRead", path: "/a.ts" }, { kind: "FileWrite", path: "/a.ts" }, ...ledger];
    const state = foldEvidence(machine, events);
    expect(isTerminal(machine, state)).toBe(false); // untrusted "pass" advances nothing
  });
});

describe("R1 — write-before-read is now structurally impossible", () => {
  it("OLD: nothing gated tool order (prose-only 'You MUST read first')", () => {
    // No assertion possible — there was no mechanism. This test documents it.
    expect(true).toBe(true);
  });

  it("NEW: Write/Edit/MultiEdit are denied in read-context, with a precise message", () => {
    const state = foldEvidence(machine, []);
    for (const tool of ["Write", "Edit", "MultiEdit"]) {
      expect(isToolAllowed(machine, state, tool)).toBe(false);
    }
    const msg = blockExplanation(machine, state, "Write");
    expect(msg).toContain("read-context");
    expect(msg).toContain("FileRead");
  });

  it("NEW: one real FileRead unlocks writes — no friction beyond the rule", () => {
    const state = foldEvidence(machine, [{ kind: "FileRead", path: "/plan.md" }]);
    expect(isToolAllowed(machine, state, "Write")).toBe(true);
  });

  it("NEW: read-only and unenforced tools are never blocked (no false positives)", () => {
    const state = foldEvidence(machine, []);
    for (const tool of ["Read", "Grep", "Glob", "Bash", "Task", "WebFetch"]) {
      expect(isToolAllowed(machine, state, tool)).toBe(true);
    }
  });
});

describe("transcript text is never evidence (standing invariant)", () => {
  it("narrative text claiming success produces zero evidence events", () => {
    // extractEvidence only sees tool calls; narrative has no entry point.
    // And the Bash path requires a test command — plain prose can't reach it.
    expect(extractEvidence("Bash", { command: "ls -la" }, { exit: 0, stdout: "BUILD SUCCESS 99 passing" }, () => null)).toEqual([]);
  });

  it("unknown tool_response shapes yield exit: null → never trusted as success", () => {
    expect(extractBashOutcome({ weird: true })).toEqual({ exit: null, stdout: "" });
    expect(extractBashOutcome("raw string output")).toEqual({ exit: null, stdout: "raw string output" });
    const ledger = extractEvidence("Bash", { command: "npm test" }, { exit: null, stdout: "5 passing" }, () => null);
    expect(ledger[0]).toMatchObject({ kind: "TestRun", passed: false, trusted: false });
  });
});

describe("docs stay true — README diagram is generated, not hand-drawn", () => {
  it("machines/README.md contains the exact machineToMermaid output", () => {
    const readme = readFileSync(join(__dirname, "../../../machines/README.md"), "utf-8");
    expect(readme).toContain(machineToMermaid(machine));
  });
});
