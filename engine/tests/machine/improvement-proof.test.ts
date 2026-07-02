/**
 * Improvement proof — before/after demonstrations that Phase A (as remediated
 * post-review) changed real outcomes. Each test states the OLD behavior
 * (transcript-regex only, substring command matching, no gating) and asserts
 * the NEW behavior, including the honest limits.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractTestEvidence,
  resolveTestEvidence,
} from "../../src/handlers/subagent-stop/update-task-status";
import { parseBashTestOutput } from "../../src/parsers/parse-bash-test-output";
import { classifyTestCommand, extractEvidence, extractBashOutcome } from "../../src/machine/extract-evidence";
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
  const lyingOutput = "BUILD SUCCESS\nTests run: 12, Failures: 0, Errors: 0";
  const transcript = bashTranscript("mvn test", lyingOutput);
  const bashOutput = parseBashTestOutput(transcript);

  it("OLD: transcript regex is fooled by the output text", () => {
    expect(extractTestEvidence(bashOutput).passed).toBe(true); // the documented weakness
  });

  it("NEW: a ledger failure fact (exit 1) overrides the text and is marked untrusted=false? no — trusted failure", () => {
    const ledger = extractEvidence("Bash", { command: "mvn test" }, { exit: 1, stdout: lyingOutput }, () => null);
    const resolved = resolveTestEvidence(ledger, bashOutput, true);
    expect(resolved.passed).toBe(false);
    expect(resolved.trusted).toBe(true); // a real nonzero exit is trustworthy failure
    expect(resolved.evidence).toContain("ledger: exit 1");
  });
});

describe("R2 — reporter-confirmed pass carries explicit provenance and a trust bit", () => {
  it("NEW: exit 0 + parsed report → trusted pass, tests_trusted derivable", () => {
    const ledger = extractEvidence(
      "Bash",
      { command: "npx vitest run --reporter=json --outputFile=out.json" },
      { exit: 0, stdout: "" },
      () => ({ total: 9, failed: 0, source: "vitest-json" }),
    );
    const resolved = resolveTestEvidence(ledger, "", true);
    expect(resolved).toMatchObject({ passed: true, trusted: true });
    expect(resolved.evidence).toContain("9 tests / 0 failed");
  });

  it("NEW: report cross-check — failures or zero-tests never pass", () => {
    const failing = extractEvidence("Bash", { command: "npm test" }, { exit: 0, stdout: "" }, () => ({ total: 9, failed: 2, source: "vitest-json" }));
    expect(resolveTestEvidence(failing, "irrelevant", true).passed).toBe(false);

    const empty = extractEvidence("Bash", { command: "npm test" }, { exit: 0, stdout: "" }, () => ({ total: 0, failed: 0, source: "vitest-json" }));
    expect(resolveTestEvidence(empty, "", true).passed).toBe(false);
  });

  it("NEW: last trusted run wins — pass-then-fail fails, fail-then-pass passes", () => {
    const pass: Evidence = { kind: "TestRun", command: "npm test", exit: 0, report: { total: 5, failed: 0, source: "vitest-json" } };
    const fail: Evidence = { kind: "TestRun", command: "npm test", exit: 1, report: null };
    expect(resolveTestEvidence([pass, fail], "", true).passed).toBe(false);
    expect(resolveTestEvidence([fail, pass], "", true).passed).toBe(true);
  });

  it("NEW: an untrusted exit-0 run never displaces a trusted verdict", () => {
    const pass: Evidence = { kind: "TestRun", command: "npm test", exit: 0, report: { total: 5, failed: 0, source: "vitest-json" } };
    const noise: Evidence = { kind: "TestRun", command: "npm test", exit: 0, report: null };
    const resolved = resolveTestEvidence([pass, noise], "", true);
    expect(resolved).toMatchObject({ passed: true, trusted: true });
  });
});

describe("R2 — the spoofs the review found are dead", () => {
  it("comment spoof mints no TestRun at all", () => {
    // The review's end-to-end trusted-pass forgery:
    const cmd = `echo '{"numTotalTests":5,"numFailedTests":0}' # npm test --json`;
    expect(classifyTestCommand(cmd)).toBeNull();
    expect(extractEvidence("Bash", { command: cmd }, { exit: 0, stdout: '{"numTotalTests":5,"numFailedTests":0}' }, () => {
      throw new Error("report discovery must not even run for unclassified commands");
    })).toEqual([]);
  });

  it("prose false-failures are dead: grep exiting 1 is not a trusted failure", () => {
    const cmd = 'git grep "cargo test" src/';
    expect(extractEvidence("Bash", { command: cmd }, { exit: 1, stdout: "" }, () => null)).toEqual([]);
  });

  it("plain echo spoof: still labeled low-trust in the fallback, never trusted, machine never satisfied", () => {
    const spoofCmd = 'echo "npm test: 5 passing"';
    const transcript = bashTranscript(spoofCmd, "npm test: 5 passing");
    const bashOutput = parseBashTestOutput(transcript);

    // OLD: silent pass with clean-looking evidence
    const old = extractTestEvidence(bashOutput);
    expect(old.passed).toBe(true);
    expect(old.evidence).toBe("node: 5 passing");

    // NEW: no ledger TestRun (echo never classifies); the transcript fallback
    // still passes — honest tiering, not prevention — but it is labeled and
    // the trust bit is false, so wave gates can tell.
    const ledger = extractEvidence("Bash", { command: spoofCmd }, { exit: 0, stdout: "npm test: 5 passing" }, () => null);
    expect(ledger).toEqual([]);
    const resolved = resolveTestEvidence(ledger, bashOutput, true);
    expect(resolved.passed).toBe(true); // documented residual: reporterless fallback
    expect(resolved.trusted).toBe(false);
    expect(resolved.evidence).toContain("degraded (machine bound, no ledger evidence");
  });

  it("recorder failure is visible: machine bound + empty ledger → degraded label", () => {
    const resolved = resolveTestEvidence([], "12 passing", true);
    expect(resolved.trusted).toBe(false);
    expect(resolved.evidence).toContain("degraded");
  });

  it("unbound runs keep the plain fallback label", () => {
    const resolved = resolveTestEvidence([], "12 passing", false);
    expect(resolved.evidence).toContain("transcript-regex (fallback)");
  });
});

describe("R1 — write-before-read is structurally impossible for the bound agent", () => {
  it("NEW: Write/Edit/MultiEdit denied in read-context, with a precise message", () => {
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

  it("machine terminal stays unreachable without a fact-confirmed pass", () => {
    const events: Evidence[] = [
      { kind: "FileRead", path: "/a.ts" },
      { kind: "FileWrite", path: "/a.ts" },
      { kind: "TestRun", command: "npm test", exit: 0, report: null }, // no artifact
    ];
    expect(isTerminal(machine, foldEvidence(machine, events))).toBe(false);
  });
});

describe("transcript text is never evidence (standing invariant)", () => {
  it("narrative text claiming success produces zero evidence events", () => {
    expect(
      extractEvidence("Bash", { command: "ls -la" }, { exit: 0, stdout: "BUILD SUCCESS 99 passing" }, () => null),
    ).toEqual([]);
  });

  it("unknown tool_response shapes yield exit: null → judged untrusted, never success", () => {
    expect(extractBashOutcome({ weird: true })).toEqual({ exit: null, stdout: "" });
    const ledger = extractEvidence("Bash", { command: "npm test" }, { exit: null, stdout: "5 passing" }, () => null);
    const resolved = resolveTestEvidence(ledger, "", true);
    expect(resolved.trusted).toBe(false);
  });
});

describe("docs stay true — README diagram is generated, not hand-drawn", () => {
  it("machines/README.md contains the exact machineToMermaid output", () => {
    const readme = readFileSync(join(__dirname, "../../../machines/README.md"), "utf-8");
    expect(readme).toContain(machineToMermaid(machine));
  });
});
