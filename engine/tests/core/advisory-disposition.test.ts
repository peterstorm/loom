/**
 * Advisory dispositions (ADR-0090, loom#213 Cause 4): the record, its State
 * File parser, the one advisory derivation, the anchor, the prior selector
 * and the pure operation that records them.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  advisoryDecisionTasks,
  advisoryDisposition,
  anchorDigest,
  issuedPriorFindings,
  parseAdvisoryDispositions,
  undispositionedAdvisories,
  waveAdvisories,
  type AdvisoryDisposition,
  type AdvisoryDispositionInput,
} from "../../src/core/advisory-disposition";
import { parseDispositionInput, recordAdvisoryDispositions } from "../../src/core/advisory-disposition-record";
import { REVIEWER_PROTOCOL_V2 } from "../../src/core/reviewer-contract";
import { waveAdvisoryApprovalRefusal } from "../../src/core/wave-gate-membership";
import type { RegisteredWaveGateProgram } from "../../src/core/wave-gate-program";
import { reviewedWorkspaceObservation, type ReviewedWorkspaceObservation } from "../../src/core/reviewed-workspace";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Finding, Task, TaskGraph } from "../../src/types";
import { findingFixture as finding } from "../fixtures/finding";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { value } from "../fixtures/parse-result";

const ANCHOR = "a".repeat(64);

const ADVISORY = finding("code-reviewer-1", "advisory");
const ELSEWHERE = finding("code-reviewer-2", "advisory", "README.md");
const CRITICAL = finding("code-reviewer-3", "critical");

const task = (id: string, findings: readonly Finding[] | undefined, extra: Partial<Task> = {}): Task => taskFixture({
  id, description: `${id} work`, agent: "code-implementer-agent", wave: 1, depends_on: [],
  status: "implemented", file_list: [`src/${id.toLowerCase()}.ts`], files_modified: [`src/${id.toLowerCase()}.ts`],
  ...(findings === undefined ? {} : {
    findings,
    critical_findings: findings.filter(({ severity }) => severity === "critical").map(({ claim }) => claim),
    advisory_findings: findings.filter(({ severity }) => severity === "advisory").map(({ claim }) => claim),
  }),
  ...extra,
});

const observe = (taskId: string, files: Readonly<Record<string, string | null>>): ReviewedWorkspaceObservation =>
  value(reviewedWorkspaceObservation(taskId, Object.keys(files), Object.entries(files).map(([path, text]) =>
    ({ path, bytes: text === null ? null : Buffer.from(text) }))));

const input = (overrides: Partial<AdvisoryDispositionInput> = {}): AdvisoryDispositionInput => ({
  wave: 1, taskId: "T1", findingId: "code-reviewer-1", decision: "deferred", reason: "out of scope",
  target: "Wave 3", anchor: ANCHOR, ...overrides,
});

const disposition = (overrides: Partial<AdvisoryDispositionInput> = {}): AdvisoryDisposition => value(advisoryDisposition(input(overrides)));

describe("advisoryDisposition: the one constructor", () => {
  it("builds a deferral with its target and anchor, and a fixed decision with neither", () => {
    expect(disposition()).toEqual({
      schemaVersion: 1, wave: 1, taskId: "T1", findingId: "code-reviewer-1", decision: "deferred",
      reason: "out of scope", target: "Wave 3", anchor: ANCHOR,
    });
    expect(disposition({ decision: "fixed", target: undefined, anchor: null })).toMatchObject({ decision: "fixed", target: null, anchor: null });
    expect(disposition({ decision: "dismissed", target: null })).toMatchObject({ decision: "dismissed", target: null, anchor: ANCHOR });
  });

  it.each<[string, Partial<AdvisoryDispositionInput>]>([
    ["a Wave below 1", { wave: 0 }],
    ["a fractional Wave", { wave: 1.5 }],
    ["a Task id that is not T<n>", { taskId: "task-1" }],
    ["a Finding id with a colon", { findingId: "T1:code-reviewer-1" }],
    ["a Finding id that is not a string", { findingId: 7 }],
    ["an unknown decision", { decision: "ignored" }],
    ["a blank reason", { reason: "  " }],
    ["a reason with outer whitespace", { reason: " why" }],
    ["a reason that is too long", { reason: "x".repeat(501) }],
    ["a target on a dismissal", { decision: "dismissed" }],
    ["a target on a fix", { decision: "fixed", anchor: null }],
    ["a blank target", { target: "" }],
    ["a deferral without an anchor", { anchor: null }],
    ["a malformed anchor", { anchor: "A".repeat(64) }],
    ["a fixed decision with an anchor", { decision: "fixed", target: null }],
  ])("refuses %s", (_label, overrides) => {
    expect(advisoryDisposition(input(overrides)).ok).toBe(false);
  });
});

describe("parseAdvisoryDispositions: the State File field", () => {
  it("is absent when absent, and round-trips every record through the constructor", () => {
    expect(parseAdvisoryDispositions(undefined)).toEqual({ ok: true, value: undefined });
    const records = [disposition(), disposition({ decision: "fixed", target: null, anchor: null })];
    expect(parseAdvisoryDispositions(JSON.parse(JSON.stringify(records)))).toEqual({ ok: true, value: records });
  });

  it.each<[string, unknown]>([
    ["a non-array", { 0: {} }],
    ["a non-object entry", ["x"]],
    ["an unknown field", [{ ...disposition(), note: "x" }]],
    ["a missing field", [{ ...disposition(), target: undefined }]],
    ["another schemaVersion", [{ ...disposition(), schemaVersion: 2 }]],
    ["an entry the constructor refuses", [{ ...disposition(), reason: "" }]],
  ])("refuses %s", (_label, raw) => {
    expect(parseAdvisoryDispositions(JSON.parse(JSON.stringify(raw))).ok).toBe(false);
  });
});

describe("advisory_dispositions on the TaskGraph", () => {
  const withDispositions = (raw: unknown): unknown => JSON.parse(JSON.stringify({
    ...graphFixture([task("T1", [ADVISORY])]), advisory_dispositions: raw,
  }));

  it("round-trips through the State File and loads a graph without it unchanged", () => {
    const records = [disposition(), disposition({ decision: "fixed", target: null, anchor: null })];
    const loaded = parseTaskGraph(withDispositions(records));
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (loaded.ok) expect(loaded.value.advisory_dispositions).toEqual(records);
    const without = parseTaskGraph(JSON.parse(JSON.stringify(graphFixture([task("T1", [ADVISORY])]))));
    expect(without.ok && without.value.advisory_dispositions).toBeUndefined();
  });

  it("refuses a record the constructor refuses", () => {
    const loaded = parseTaskGraph(withDispositions([{ ...disposition(), anchor: null }]));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain("advisory_dispositions[0]");
  });
});

describe("waveAdvisories: the one advisory derivation", () => {
  it("names a Task's advisory Findings, or its legacy advisory claims when it stores none, in Task order", () => {
    const legacy = task("T2", undefined, { advisory_findings: ["first", " ", "second"] });
    expect(waveAdvisories([task("T1", [CRITICAL, ADVISORY]), legacy]).map(({ identity, file, subject }) => [identity, file, subject.kind]))
      .toEqual([
        ["T1:code-reviewer-1", "src/t1.ts", "finding"],
        ["T2:legacy-advisory-1", null, "legacy-claim"],
        ["T2:legacy-advisory-2", null, "legacy-claim"],
      ]);
  });

  it("leaves out each advisory with a standing disposition", () => {
    const tasks = [task("T1", [ADVISORY, ELSEWHERE, CRITICAL])];
    expect(undispositionedAdvisories(tasks, undefined)).toEqual(["T1:code-reviewer-1", "T1:code-reviewer-2"]);
    expect(undispositionedAdvisories(tasks, [disposition({ decision: "fixed", target: null, anchor: null })]))
      .toEqual(["T1:code-reviewer-2"]);
  });
});

describe("anchorDigest: the bytes an advisory anchors to", () => {
  const base = observe("T1", { "src/t1.ts": "a", "src/t1.test.ts": "b" }).artifacts;
  const editedOwn = observe("T1", { "src/t1.ts": "A", "src/t1.test.ts": "b" }).artifacts;
  const editedOther = observe("T1", { "src/t1.ts": "a", "src/t1.test.ts": "B" }).artifacts;

  it("follows the advisory's own file when it is reviewed, and only that file", () => {
    expect(anchorDigest("src/t1.ts", base)).toMatch(/^[0-9a-f]{64}$/);
    expect(anchorDigest("src/t1.ts", editedOther)).toBe(anchorDigest("src/t1.ts", base));
    expect(anchorDigest("src/t1.ts", editedOwn)).not.toBe(anchorDigest("src/t1.ts", base));
  });

  it("follows the whole reviewed set for an advisory naming no reviewed file", () => {
    for (const file of [null, "README.md"]) {
      expect(anchorDigest(file, editedOther)).not.toBe(anchorDigest(file, base));
      expect(anchorDigest(file, editedOwn)).not.toBe(anchorDigest(file, base));
    }
    expect(anchorDigest(null, base)).toBe(anchorDigest("README.md", base));
  });

  it("tells an absent file from a present one", () => {
    const absent = observe("T1", { "src/t1.ts": null, "src/t1.test.ts": "b" }).artifacts;
    expect(anchorDigest("src/t1.ts", absent)).not.toBe(anchorDigest("src/t1.ts", base));
  });
});

describe("issuedPriorFindings: the one prior selector", () => {
  const t1 = task("T1", [ADVISORY, CRITICAL, ELSEWHERE]);
  const bytes = observe("T1", { "src/t1.ts": "a" }).artifacts;
  const changed = observe("T1", { "src/t1.ts": "b" }).artifacts;
  const anchored = (findingId: string, decision: "deferred" | "dismissed", artifacts = bytes, file: string | null = "src/t1.ts") =>
    disposition({ findingId, decision, target: null, anchor: anchorDigest(file, artifacts) });

  it("issues every active Finding when nothing is decided", () => {
    expect(issuedPriorFindings(t1, undefined, bytes)).toEqual([ADVISORY, CRITICAL, ELSEWHERE]);
  });

  it("leaves out a deferred or dismissed advisory while its anchored bytes hold, and reissues it when they change", () => {
    for (const decision of ["deferred", "dismissed"] as const) {
      const decided = [anchored("code-reviewer-1", decision)];
      expect(issuedPriorFindings(t1, decided, bytes)).toEqual([CRITICAL, ELSEWHERE]);
      expect(issuedPriorFindings(t1, decided, changed)).toEqual([ADVISORY, CRITICAL, ELSEWHERE]);
    }
  });

  it("never leaves out a fixed advisory or a critical, and the latest decision stands", () => {
    expect(issuedPriorFindings(t1, [disposition({ decision: "fixed", target: null, anchor: null })], bytes))
      .toEqual([ADVISORY, CRITICAL, ELSEWHERE]);
    expect(issuedPriorFindings(t1, [anchored("code-reviewer-3", "dismissed")], bytes)).toEqual([ADVISORY, CRITICAL, ELSEWHERE]);
    const reconsidered = [anchored("code-reviewer-1", "dismissed"), disposition({ decision: "fixed", target: null, anchor: null })];
    expect(issuedPriorFindings(t1, reconsidered, bytes)).toEqual([ADVISORY, CRITICAL, ELSEWHERE]);
  });

  it("reads a decision only for its own Task", () => {
    expect(issuedPriorFindings({ ...t1, id: "T2" }, [anchored("code-reviewer-1", "dismissed")], bytes))
      .toEqual([ADVISORY, CRITICAL, ELSEWHERE]);
  });

  it("is always the active Findings in order with every critical kept (property)", () => {
    const findingArb = fc.record({
      severity: fc.constantFrom<Finding["severity"]>("critical", "advisory"),
      file: fc.constantFrom<string | null>("src/t1.ts", "README.md", null),
    });
    fc.assert(fc.property(fc.array(findingArb, { maxLength: 8 }), fc.array(fc.boolean(), { maxLength: 8 }), fc.boolean(),
      (shapes, decided, edited) => {
        const findings = shapes.map(({ severity, file }, index) => finding(`code-reviewer-${index + 1}`, severity, file));
        const dispositions = findings.flatMap(({ id, file }, index) => decided[index] === true
          ? [disposition({ findingId: id, decision: "dismissed", target: null, anchor: anchorDigest(file, bytes) })] : []);
        const issued = issuedPriorFindings({ id: "T1", findings }, dispositions, edited ? changed : bytes);
        const ids = findings.map(({ id }) => id);
        expect(issued.map(({ id }) => ids.indexOf(id))).toEqual([...issued.map(({ id }) => ids.indexOf(id))].sort((a, b) => a - b));
        expect(issued.filter(({ severity }) => severity === "critical")).toEqual(findings.filter(({ severity }) => severity === "critical"));
        if (edited) expect(issued).toEqual(findings);
      }));
  });
});

describe("waveAdvisoryApprovalRefusal: approval needs a disposition on every issued advisory", () => {
  const registration: RegisteredWaveGateProgram = {
    schemaVersion: 2, reviewerProtocol: REVIEWER_PROTOCOL_V2, kind: "wave-gate", input: { wave: 1 },
    taskIds: ["T1", "T2"], authorityDigest: "a".repeat(64),
  };
  const graph = (dispositions?: readonly AdvisoryDisposition[]): TaskGraph => ({
    ...graphFixture([
      task("T1", [ADVISORY, CRITICAL]),
      task("T2", undefined, { advisory_findings: ["legacy claim"] }),
      task("T3", [ELSEWHERE], { wave: 2 }),
    ]),
    ...(dispositions === undefined ? {} : { advisory_dispositions: dispositions }),
  });
  const decided = (taskId: string, findingId: string) =>
    disposition({ taskId, findingId, decision: "fixed", target: null, anchor: null });

  it("names every advisory of the registered Tasks without a disposition, the legacy one included", () => {
    expect(waveAdvisoryApprovalRefusal(graph(), registration)).toBe(
      "approval refused: 2 advisories have no disposition (T1:code-reviewer-1, T2:legacy-advisory-1); " +
      "record each as fixed, deferred or dismissed with helper orchestration disposition, then approve");
    expect(waveAdvisoryApprovalRefusal(graph([decided("T1", "code-reviewer-1")]), registration))
      .toContain("1 advisory has no disposition (T2:legacy-advisory-1)");
  });

  it("admits approval once each one has a standing disposition, whatever it decided", () => {
    expect(waveAdvisoryApprovalRefusal(graph([decided("T1", "code-reviewer-1"), decided("T2", "legacy-advisory-1")]), registration))
      .toBeNull();
  });
});

describe("advisoryDecisionTasks: approval counts exactly the advisories the operation accepts", () => {
  const record = (graph: TaskGraph, identities: readonly string[], workspaces: readonly ReviewedWorkspaceObservation[]) =>
    recordAdvisoryDispositions(graph, value(parseDispositionInput(JSON.stringify({
      dispositions: identities.map((finding) => ({ finding, decision: "fixed", reason: "fixing it" })),
    }))), workspaces);

  it("is every Task of the Wave, in graph order", () => {
    const tasks = [task("T1", []), task("T2", [], { wave: 2 }), task("T3", [])];
    expect(advisoryDecisionTasks({ tasks }, 1).map(({ id }) => id)).toEqual(["T1", "T3"]);
    expect(advisoryDecisionTasks({ tasks }, 2).map(({ id }) => id)).toEqual(["T2"]);
  });

  it("refuses approval naming exactly the advisories the operation records, and admits it once they are recorded (property)", () => {
    const taskArb = fc.record({
      wave: fc.constantFrom(1, 2),
      shape: fc.constantFrom("findings", "legacy"),
      severities: fc.array(fc.constantFrom<Finding["severity"]>("critical", "advisory"), { maxLength: 3 }),
    });
    fc.assert(fc.property(fc.array(taskArb, { minLength: 1, maxLength: 4 }), (shapes) => {
      const tasks = shapes.map(({ wave, shape, severities }, index) => {
        const id = `T${index + 1}`;
        const findings = severities.map((severity, at) => finding(`code-reviewer-${at + 1}`, severity, `src/t${index + 1}.ts`));
        return shape === "findings"
          ? task(id, findings, { wave })
          : task(id, undefined, { wave, advisory_findings: findings.filter(({ severity }) => severity === "advisory").map(({ claim }) => claim) });
      });
      const graph = graphFixture(tasks);
      const registration: RegisteredWaveGateProgram = {
        schemaVersion: 2, reviewerProtocol: REVIEWER_PROTOCOL_V2, kind: "wave-gate", input: { wave: 1 },
        taskIds: tasks.filter(({ wave }) => wave === 1).map(({ id }) => id), authorityDigest: "a".repeat(64),
      };
      const workspaces = tasks.map(({ id }) => observe(id, { [`src/${id.toLowerCase()}.ts`]: "bytes" }));
      const every = waveAdvisories(tasks).map(({ identity }) => identity);
      const accepted = every.filter((identity) => record(graph, [identity], workspaces).ok);
      const refusal = waveAdvisoryApprovalRefusal(graph, registration);
      if (accepted.length === 0) {
        expect(refusal).toBeNull();
        return;
      }
      expect(refusal).toContain(`no disposition (${accepted.join(", ")})`);
      const recorded = value(record(graph, accepted, workspaces));
      expect(waveAdvisoryApprovalRefusal(recorded.graph, registration)).toBeNull();
    }));
  });
});

describe("parseDispositionInput: the operation's stdin", () => {
  it("reads each entry, defaulting an absent target to null", () => {
    const parsed = parseDispositionInput(JSON.stringify({ dispositions: [
      { finding: "T1:code-reviewer-1", decision: "deferred", reason: "later", target: "Wave 3" },
      { finding: "T2:legacy-advisory-1", decision: "dismissed", reason: "false positive" },
    ] }));
    expect(parsed).toEqual({ ok: true, value: [
      { taskId: "T1", findingId: "code-reviewer-1", decision: "deferred", reason: "later", target: "Wave 3" },
      { taskId: "T2", findingId: "legacy-advisory-1", decision: "dismissed", reason: "false positive", target: null },
    ] });
  });

  it.each<[string, string]>([
    ["text that is not JSON", "{"],
    ["another top-level shape", JSON.stringify({ dispositions: [], extra: 1 })],
    ["an empty list", JSON.stringify({ dispositions: [] })],
    ["an entry naming no Task", JSON.stringify({ dispositions: [{ finding: "code-reviewer-1", decision: "fixed", reason: "r" }] })],
    ["an unknown entry field", JSON.stringify({ dispositions: [{ finding: "T1:a-1", decision: "fixed", reason: "r", note: 1 }] })],
    ["one advisory named twice", JSON.stringify({ dispositions: [
      { finding: "T1:a-1", decision: "fixed", reason: "r" }, { finding: "T1:a-1", decision: "dismissed", reason: "r" }] })],
  ])("refuses %s, with the usage", (_label, stdin) => {
    const parsed = parseDispositionInput(stdin);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Usage: helper orchestration disposition");
  });
});

describe("recordAdvisoryDispositions: the pure operation", () => {
  const graph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
    ...graphFixture([
      task("T1", [ADVISORY, CRITICAL, ELSEWHERE]),
      task("T2", undefined, { advisory_findings: ["legacy claim"] }),
      task("T3", [finding("code-reviewer-1", "advisory", "src/t3.ts")], { wave: 2 }),
    ]),
    ...overrides,
  });
  const workspaces = [observe("T1", { "src/t1.ts": "a" }), observe("T2", { "src/t2.ts": "b" })];
  const entry = (finding: string, decision: string, extra: Record<string, unknown> = {}) =>
    value(parseDispositionInput(JSON.stringify({ dispositions: [{ finding, decision, reason: "decided", ...extra }] })));

  it("appends one record per advisory, anchored to the bytes observed now; a fix carries no anchor", () => {
    const outcome = value(recordAdvisoryDispositions(graph(), [
      ...entry("T1:code-reviewer-1", "deferred", { target: "Wave 2" }),
      ...entry("T1:code-reviewer-2", "fixed"),
      ...entry("T2:legacy-advisory-1", "dismissed"),
    ], workspaces));
    expect(outcome.unchanged).toEqual([]);
    expect(outcome.recorded.map(({ findingId, decision, anchor }) => [findingId, decision, anchor])).toEqual([
      ["code-reviewer-1", "deferred", anchorDigest("src/t1.ts", workspaces[0]!.artifacts)],
      ["code-reviewer-2", "fixed", null],
      ["legacy-advisory-1", "dismissed", anchorDigest(null, workspaces[1]!.artifacts)],
    ]);
    expect(outcome.graph.advisory_dispositions).toEqual(outcome.recorded);
  });

  it("is idempotent, and a changed decision appends a record that then stands", () => {
    const first = value(recordAdvisoryDispositions(graph(), entry("T1:code-reviewer-1", "dismissed"), workspaces));
    const repeat = value(recordAdvisoryDispositions(first.graph, entry("T1:code-reviewer-1", "dismissed"), workspaces));
    expect(repeat).toEqual({ graph: first.graph, recorded: [], unchanged: ["T1:code-reviewer-1"] });
    const changed = value(recordAdvisoryDispositions(first.graph, entry("T1:code-reviewer-1", "fixed"), workspaces));
    expect(changed.graph.advisory_dispositions?.map(({ decision }) => decision)).toEqual(["dismissed", "fixed"]);
    expect(undispositionedAdvisories(changed.graph.tasks.slice(0, 1), changed.graph.advisory_dispositions)).toEqual(["T1:code-reviewer-2"]);
  });

  it.each<[string, () => ReturnType<typeof recordAdvisoryDispositions>, string]>([
    ["outside the execute phase", () => recordAdvisoryDispositions(graph({ current_phase: "decompose" }), entry("T1:code-reviewer-1", "fixed"), workspaces), "not-executing"],
    ["a critical", () => recordAdvisoryDispositions(graph(), entry("T1:code-reviewer-3", "fixed"), workspaces), "unknown-advisory"],
    ["an unknown Finding", () => recordAdvisoryDispositions(graph(), entry("T1:code-reviewer-9", "fixed"), workspaces), "unknown-advisory"],
    ["an advisory of another Wave", () => recordAdvisoryDispositions(graph(), entry("T3:code-reviewer-1", "fixed"), workspaces), "unknown-advisory"],
    ["an unobserved workspace", () => recordAdvisoryDispositions(graph(), entry("T1:code-reviewer-1", "fixed"), []), "workspace-unobserved"],
    ["a workspace observed over another scope", () => recordAdvisoryDispositions(graph(), entry("T1:code-reviewer-1", "fixed"),
      [observe("T1", { "src/t1.ts": "a", "src/other.ts": "c" })]), "workspace-unobserved"],
    ["an invalid decision", () => recordAdvisoryDispositions(graph(), entry("T1:code-reviewer-1", "dismissed", { target: "Wave 2" }), workspaces), "invalid-disposition"],
  ])("refuses %s, recording nothing", (_label, run, kind) => {
    const outcome = run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe(kind);
  });
});
