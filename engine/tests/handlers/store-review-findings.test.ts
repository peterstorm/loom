import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseFindings, updateTaskFindings, OVERRIDE_AGENT } from "../../src/handlers/helpers/store-review-findings";
import { claimsOfSeverity } from "../../src/core/findings";
import { parseTaskGraph } from "../../src/state-manager";
import type { Task } from "../../src/types";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");

const baseTask: Task = {
  id: "T1",
  description: "Test task",
  agent: "test",
  wave: 1,
  status: "implemented",
  legacy_missing_proof: true,
  depends_on: [],
};

describe("parseFindings (pure)", () => {
  it("parses critical and advisory lines", () => {
    const stdin = "CRITICAL: SQL injection\nADVISORY: Consider refactor";
    const result = parseFindings(stdin);

    expect(result.critical).toEqual(["SQL injection"]);
    expect(result.advisory).toEqual(["Consider refactor"]);
  });

  it("handles multiple findings of each type", () => {
    const stdin = "CRITICAL: Issue 1\nCRITICAL: Issue 2\nADVISORY: Advice 1\nADVISORY: Advice 2";
    const result = parseFindings(stdin);

    expect(result.critical).toEqual(["Issue 1", "Issue 2"]);
    expect(result.advisory).toEqual(["Advice 1", "Advice 2"]);
  });

  it("returns empty arrays when no findings", () => {
    const result = parseFindings("");
    expect(result.critical).toEqual([]);
    expect(result.advisory).toEqual([]);
  });

  it("ignores non-matching lines", () => {
    const stdin = "Some text\nCRITICAL: Issue 1\nMore text\nADVISORY: Advice 1\nExtra";
    const result = parseFindings(stdin);

    expect(result.critical).toEqual(["Issue 1"]);
    expect(result.advisory).toEqual(["Advice 1"]);
  });
});

describe("updateTaskFindings (pure)", () => {
  it("stores critical and advisory when both provided", () => {
    const updated = updateTaskFindings(baseTask, ["SQL injection"], ["Consider refactor"]);

    expect(updated.critical_findings).toEqual(["SQL injection"]);
    expect(updated.advisory_findings).toEqual(["Consider refactor"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("preserves existing advisories when none provided", () => {
    const taskWithAdvisories: Task = {
      ...baseTask,
      advisory_findings: ["Existing advisory 1", "Existing advisory 2"],
      critical_findings: ["Old critical"],
    };

    const updated = updateTaskFindings(taskWithAdvisories, ["New critical"], []);

    expect(updated.critical_findings).toEqual(["New critical"]);
    expect(updated.advisory_findings).toEqual(["Existing advisory 1", "Existing advisory 2"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("clears criticals and sets status to passed when no criticals", () => {
    const taskWithFindings: Task = {
      ...baseTask,
      critical_findings: ["Old critical"],
      advisory_findings: ["Old advisory"],
      review_status: "blocked",
    };

    const updated = updateTaskFindings(taskWithFindings, [], []);

    expect(updated.critical_findings).toEqual([]);
    expect(updated.advisory_findings).toEqual(["Old advisory"]);
    expect(updated.review_status).toBe("passed");
  });

  it("dismisses omitted advisories when preservation is explicitly disabled", () => {
    const taskWithAdvisories: Task = {
      ...baseTask,
      advisory_findings: ["Old advisory"],
    };

    const updated = updateTaskFindings(taskWithAdvisories, [], [], false);

    expect(updated.advisory_findings).toEqual([]);
    expect(updated.refuted_findings).toHaveLength(1);
    expect(updated.refuted_findings?.[0]?.finding.claim).toBe("Old advisory");
  });

  it("overwrites advisories when new ones provided", () => {
    const taskWithAdvisories: Task = {
      ...baseTask,
      advisory_findings: ["Old advisory"],
    };

    const updated = updateTaskFindings(taskWithAdvisories, [], ["New advisory 1", "New advisory 2"]);

    expect(updated.advisory_findings).toEqual(["New advisory 1", "New advisory 2"]);
    expect(updated.review_status).toBe("passed");
  });

  it("sets blocked status when criticals present", () => {
    const updated = updateTaskFindings(baseTask, ["Critical issue"], ["Advisory"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("sets passed status when no criticals", () => {
    const updated = updateTaskFindings(baseTask, [], ["Advisory"]);
    expect(updated.review_status).toBe("passed");
  });
});

describe("the manual override keeps findings and its derived views in lockstep", () => {
  const reviewed: Task = {
    ...baseTask,
    review_status: "blocked",
    findings: [
      { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "false positive" },
      { id: "code-reviewer-2", agent: "code-reviewer", severity: "advisory", file: null, line: null, claim: "kept nit" },
    ],
    critical_findings: ["false positive"],
    advisory_findings: ["kept nit"],
  };

  it("rewrites the authoritative array, not only the view", () => {
    // The sanctioned false-positive downgrade used to replace
    // critical_findings and leave `findings` untouched. The dismissed critical
    // then went right back in front of the refutation panel, while an ADDED
    // critical existed only in the view and the panel could never adjudicate it.
    const updated = updateTaskFindings(reviewed, [], []);
    expect(updated.critical_findings).toEqual([]);
    expect((updated.findings ?? []).some((f) => f.severity === "critical")).toBe(false);
    expect(updated.review_status).toBe("passed");
  });

  it("gives an added critical structured identity so the panel can see it", () => {
    const updated = updateTaskFindings(reviewed, ["a real one"], []);
    expect(updated.critical_findings).toEqual(["a real one"]);
    expect((updated.findings ?? []).filter((f) => f.severity === "critical").map((f) => f.claim))
      .toEqual(["a real one"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("preserves the advisories it was not asked about, identity intact", () => {
    const updated = updateTaskFindings(reviewed, ["a real one"], []);
    expect(updated.advisory_findings).toEqual(["kept nit"]);
    expect((updated.findings ?? []).find((f) => f.severity === "advisory")?.id).toBe("code-reviewer-2");
  });

  it("migrates a pre-identity task's advisories rather than dropping them", () => {
    const legacy: Task = { ...baseTask, advisory_findings: ["from before identity"] };
    const updated = updateTaskFindings(legacy, ["new critical"], []);
    expect(updated.advisory_findings).toEqual(["from before identity"]);
    expect(new Set((updated.findings ?? []).map((f) => f.id)).size).toBe(2);
  });

  it("never remints an id a refutation record still holds", () => {
    const withRefutation: Task = {
      ...reviewed,
      refuted_findings: [{
        finding: { id: "manual-override-1", agent: OVERRIDE_AGENT, severity: "critical", file: null, line: null, claim: "killed" },
        refutations: [{ lens: "intent", reason: "deliberate" }],
      }],
    };
    const updated = updateTaskFindings(withRefutation, ["a real one"], ["an advisory"]);
    const active = (updated.findings ?? []).map((f) => f.id);
    expect(active).not.toContain("manual-override-1");
    expect(new Set([...active, "manual-override-1"]).size).toBe(active.length + 1);
  });

  it("holds the derived-view invariant for any override", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
        (critical, advisory) => {
          const updated = updateTaskFindings(reviewed, [...critical], [...advisory]);
          expect(updated.critical_findings).toEqual(claimsOfSeverity(updated.findings ?? [], "critical"));
          expect(updated.advisory_findings).toEqual(claimsOfSeverity(updated.findings ?? [], "advisory"));
          expect(new Set((updated.findings ?? []).map((f) => f.id)).size)
            .toBe((updated.findings ?? []).length);
        },
      ),
    );
  });
});

describe("store-review-findings CLI — an override must land or say why not", () => {
  let tmp: string;
  let statePath: string;

  const graph = () => ({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    wave_gates: { "1": { impl_complete: true, tests_passed: true, reviews_complete: false, blocked: false } },
    tasks: [{
      id: "T1",
      description: "d",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      review_status: "passed",
      findings: [],
      critical_findings: [],
      advisory_findings: [],
      refuted_findings: [],
    }],
  });

  const run = (args: readonly string[], input: string) =>
    spawnSync("bun", [CLI, "helper", "store-review-findings", ...args], {
      cwd: tmp,
      input,
      encoding: "utf-8",
      env: { ...process.env, LOOM_STATE_PATH: ".claude/state/active_task_graph.json" },
    });

  const state = () => JSON.parse(readFileSync(statePath, "utf-8"));

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loom-store-findings-"));
    statePath = join(tmp, ".claude", "state", "active_task_graph.json");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(graph(), null, 2));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("stores an operator-added critical and blocks the wave in one transaction", () => {
    const result = run(["--task", "T1"], "CRITICAL: operator-added blocker\n");
    expect(result.status, result.stderr).toBe(0);
    expect(state().tasks[0].critical_findings).toEqual(["operator-added blocker"]);
    expect(state().tasks[0].review_status).toBe("blocked");
    expect(state().wave_gates["1"].blocked).toBe(true);
  });

  it("REFUSES an unknown --task instead of reporting a success it did not perform", () => {
    // `tasks.map` over a non-matching id is a total no-op, so this used to print
    // "Stored findings for T2: 1 critical" and exit 0 with nothing written. The
    // downgrade direction self-corrects — the gate keeps blocking and the
    // operator retries — but the ADD direction is terminal: a critical the
    // operator deliberately injected never reaches complete-wave-gate, and
    // nothing anywhere says so.
    const result = run(["--task", "T2"], "CRITICAL: operator-added blocker\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No task 'T2'");
    expect(result.stderr, "the diagnostic names the ids that DO exist").toContain("known ids: T1");
    expect(state().tasks[0].critical_findings).toEqual([]);
  });

  it("leaves the gate alone when the override clears the criticals", () => {
    run(["--task", "T1"], "CRITICAL: first\n");
    expect(state().wave_gates["1"].blocked).toBe(true);
    const result = run(["--task", "T1"], "ADVISORY: downgraded on review\n");
    expect(result.status, result.stderr).toBe(0);
    expect(state().tasks[0].critical_findings).toEqual([]);
    expect(state().tasks[0].review_status).toBe("passed");
  });

  it("REFUSES empty input instead of reading it as \"dismiss everything\"", () => {
    // `updateTaskFindings` writes the state it is given, so parsing nothing out
    // of stdin moved EVERY finding into refuted_findings under manual-override,
    // emptied critical_findings and set review_status "passed" — an unblocked
    // gate — while logging "0 critical, 0 advisory", which is exactly what a
    // legitimate all-clear override logs. An operator pipeline whose upstream
    // command produced nothing (a failed grep, a truncated file, a typo'd path)
    // therefore unblocked the wave silently.
    run(["--task", "T1"], "CRITICAL: a real blocker\n");
    expect(state().tasks[0].review_status).toBe("blocked");

    const result = run(["--task", "T1"], "");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No findings parsed from stdin");
    expect(result.stderr, "the diagnostic names the way to say it on purpose").toContain("--dismiss-all");
    expect(state().tasks[0].review_status, "nothing was written").toBe("blocked");
    expect(state().tasks[0].critical_findings).toEqual(["a real blocker"]);
  });

  it("refuses unparseable input for the same reason — it parsed to nothing", () => {
    run(["--task", "T1"], "CRITICAL: a real blocker\n");
    const result = run(["--task", "T1"], "this is prose, not a findings marker\n");
    expect(result.status).toBe(1);
    expect(state().tasks[0].critical_findings).toEqual(["a real blocker"]);
  });

  it("--dismiss-all performs the dismissal, and SAYS it passed the review", () => {
    // Dismissing every finding is a real operation; it just has to be asked for.
    // The log line is distinct because this one opens a gate.
    run(["--task", "T1"], "CRITICAL: a real blocker\nADVISORY: a real advisory\n");
    const result = run(["--task", "T1", "--dismiss-all"], "");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("DISMISSED every finding");
    expect(state().tasks[0].review_status).toBe("passed");
    expect(state().tasks[0].critical_findings).toEqual([]);
    expect(state().tasks[0].advisory_findings).toEqual([]);
    // Recorded, never deleted — the audit trail outlives both findings.
    expect(state().tasks[0].refuted_findings).toHaveLength(2);
    expect(parseTaskGraph(state()).ok).toBe(true);
  });

  it("writes a graph the load boundary accepts", () => {
    // The override is a lockstep writer; findingsLockstepError now proves it.
    run(["--task", "T1"], "CRITICAL: a blocker\nADVISORY: a nit\n");
    expect(parseTaskGraph(state()).ok).toBe(true);
  });
});
