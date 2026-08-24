import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Task } from "../../src/types";
import {
  applyFindingOutcomes,
  deduplicateFindingIds,
  findingsLockstepError,
  findingsUnionError,
  mergeFindings,
  recoverViewOnlyClaims,
  refutationsUnionError,
  type AdjudicatedFinding,
} from "../../src/core/findings";
import { makeParsedFindings } from "../../src/core/review-output";

import {
  attributeFindings,
  claimsOfSeverity,
  draftsFromClaims,
  FINDING_SEVERITIES,
  makeDraftFinding,
  nextOrdinal,
  parseFindingId,
  parseFindingSeverity,
  parseFindingsBlockResult,
  parseStoredFindings,
  parseStoredRefutations,
  salvageFindingsFromMalformedRefutations,
  salvageFindingsFromMalformedResolutions,
  type DraftFinding,
  type Finding,
  type RefutedFinding,
} from "../../src/core/findings";

/** One reviewer emission of N criticals, shaped the way the parser produces it. */
const makeParsed = (critical: readonly string[]) =>
  makeParsedFindings({ critical, criticalCount: critical.length });

const draft = (over: Partial<DraftFinding> = {}): DraftFinding => ({
  severity: "critical",
  file: null,
  line: null,
  claim: "a claim",
  ...over,
});

describe("parseFindingSeverity", () => {
  it("accepts exactly the closed severity set", () => {
    for (const severity of FINDING_SEVERITIES) {
      expect(parseFindingSeverity(severity)).toBe(severity);
    }
  });

  it("rejects anything else", () => {
    for (const raw of ["CRITICAL", "high", "", null, 1, undefined, {}]) {
      expect(parseFindingSeverity(raw)).toBeNull();
    }
  });
});

describe("parseFindingId", () => {
  it("accepts task-local ids and rejects panel-ambiguous spellings", () => {
    expect(parseFindingId("code-reviewer-1")).toBe("code-reviewer-1");
    for (const raw of ["bad:id", "bad id", "bad\tid", "", "  code-reviewer-1  "]) {
      expect(parseFindingId(raw)).toBeNull();
    }
  });
});

describe("makeDraftFinding (smart constructor)", () => {
  it("drops empty and whitespace-only claims", () => {
    expect(makeDraftFinding({ severity: "critical", claim: "" })).toBeNull();
    expect(makeDraftFinding({ severity: "critical", claim: "   \n  " })).toBeNull();
  });

  it("drops no-finding sentinels — the same filter the string views always applied", () => {
    for (const claim of ["none", "(none)", "N/A", "nil", "none — prior critical fixed"]) {
      expect(makeDraftFinding({ severity: "advisory", claim })).toBeNull();
    }
  });

  it("keeps a real finding that merely starts with 'none'", () => {
    const finding = makeDraftFinding({
      severity: "critical",
      claim: "none of the callers check the result",
    });
    expect(finding?.claim).toBe("none of the callers check the result");
  });

  it("collapses whitespace so a claim never carries a line terminator", () => {
    const finding = makeDraftFinding({
      severity: "critical",
      claim: "the reducer\nswallows  the error",
    });
    expect(finding?.claim).toBe("the reducer swallows the error");
  });

  it("keeps a plausible file/line and nulls anything else", () => {
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: "src/a.ts", line: 42 }))
      .toMatchObject({ file: "src/a.ts", line: 42 });
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: "  ", line: 0 }))
      .toMatchObject({ file: null, line: null });
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: "a\nb", line: -3 }))
      .toMatchObject({ file: null, line: null });
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: 7, line: 1.5 }))
      .toMatchObject({ file: null, line: null });
  });

  it("accepts a numeric-string line (agents emit JSON loosely)", () => {
    expect(makeDraftFinding({ severity: "critical", claim: "x", line: "42" })?.line).toBe(42);
  });
});

describe("draftsFromClaims / claimsOfSeverity", () => {
  it("round-trips the legacy severity-grouped view", () => {
    const drafts = draftsFromClaims(["c1", "c2"], ["a1"]);
    expect(claimsOfSeverity(drafts, "critical")).toEqual(["c1", "c2"]);
    expect(claimsOfSeverity(drafts, "advisory")).toEqual(["a1"]);
  });

  it("applies the sentinel filter on the way in", () => {
    const drafts = draftsFromClaims(["real", "none", ""], ["(n/a)"]);
    expect(claimsOfSeverity(drafts, "critical")).toEqual(["real"]);
    expect(claimsOfSeverity(drafts, "advisory")).toEqual([]);
  });
});

describe("attributeFindings — derived, never agent-chosen identity", () => {
  it("derives ids from agent and emission order", () => {
    const findings = attributeFindings([draft(), draft({ claim: "second" })], "code-reviewer");
    expect(findings.map((f) => f.id)).toEqual(["code-reviewer-1", "code-reviewer-2"]);
    expect(findings.every((f) => f.agent === "code-reviewer")).toBe(true);
  });

  it("is deterministic — same input, same ids", () => {
    const drafts = [draft(), draft({ claim: "b" }), draft({ claim: "c" })];
    expect(attributeFindings(drafts, "pr-test-analyzer").map((f) => f.id))
      .toEqual(attributeFindings(drafts, "pr-test-analyzer").map((f) => f.id));
  });

  it("collapses id-unsafe characters in the agent name", () => {
    expect(attributeFindings([draft()], "loom:code reviewer!")[0]!.id).toBe("loom-code-reviewer-1");
  });

  it("continues past an existing ordinal so a re-review cannot mint a duplicate", () => {
    const first = attributeFindings([draft(), draft({ claim: "b" })], "code-reviewer");
    const second = attributeFindings(
      [draft({ claim: "c" })],
      "code-reviewer",
      nextOrdinal(first, [], "code-reviewer"),
    );
    expect(second[0]!.id).toBe("code-reviewer-3");
    expect(new Set([...first, ...second].map((f) => f.id)).size).toBe(3);
  });

  it("counts ordinals per agent, not per task", () => {
    const existing: readonly Finding[] = [
      ...attributeFindings([draft()], "code-reviewer"),
      ...attributeFindings([draft(), draft({ claim: "b" })], "comment-analyzer"),
    ];
    expect(nextOrdinal(existing, [], "code-reviewer")).toBe(2);
    expect(nextOrdinal(existing, [], "comment-analyzer")).toBe(3);
    expect(nextOrdinal(existing, [], "type-design-analyzer")).toBe(1);
  });
});

describe("parseFindingsBlock — the optional structured Machine Summary block", () => {
  const block = (body: string) => "prose before\n```findings\n" + body + "\n```\nprose after";

  it("returns absent when there is no block, so the caller falls back to the scraper", () => {
    expect(parseFindingsBlockResult("### Machine Summary\nCRITICAL_COUNT: 0\n")).toEqual({ kind: "absent" });
  });

  it("parses severity, file, line and claim", () => {
    expect(parseFindingsBlockResult(block(
      JSON.stringify([{ severity: "critical", file: "src/x.ts", line: 42, claim: "unchecked cast" }]),
    ))).toEqual({
      kind: "parsed",
      drafts: [{ severity: "critical", file: "src/x.ts", line: 42, claim: "unchecked cast" }],
    });
  });

  it("treats an empty array as 'I found nothing', not as a malformed block", () => {
    expect(parseFindingsBlockResult(block("[]"))).toEqual({ kind: "parsed", drafts: [] });
  });

  it("rejects invalid JSON so the line scraper can report the degradation", () => {
    expect(parseFindingsBlockResult(block("[{severity: critical}]"))).toMatchObject({ kind: "rejected" });
  });

  it("preserves the exact structured-block rejection as typed diagnostic data", () => {
    expect(parseFindingsBlockResult(block("[{severity: critical}]"))).toMatchObject({
      kind: "rejected",
      reason: expect.stringContaining("invalid JSON"),
    });
    expect(parseFindingsBlockResult(block(JSON.stringify([{ severity: "high", claim: "x" }])))).toEqual({
      kind: "rejected",
      reason: "entry 0.severity is not critical or advisory",
    });
    expect(parseFindingsBlockResult("no block")).toEqual({ kind: "absent" });
  });

  it("rejects an entry with an unknown severity or a non-string claim", () => {
    expect(parseFindingsBlockResult(block(JSON.stringify([{ severity: "high", claim: "x" }]))))
      .toMatchObject({ kind: "rejected" });
    expect(parseFindingsBlockResult(block(JSON.stringify([{ severity: "critical", claim: 3 }]))))
      .toMatchObject({ kind: "rejected" });
  });

  it("rejects a payload that is not an array of objects", () => {
    expect(parseFindingsBlockResult(block('{"severity":"critical","claim":"x"}')))
      .toMatchObject({ kind: "rejected" });
    expect(parseFindingsBlockResult(block('["x"]'))).toMatchObject({ kind: "rejected" });
  });

  it("skips sentinel entries without discarding the block", () => {
    expect(parseFindingsBlockResult(block(JSON.stringify([
      { severity: "critical", claim: "none" },
      { severity: "advisory", claim: "prefer a named constant" },
    ])))).toEqual({
      kind: "parsed",
      drafts: [{ severity: "advisory", file: null, line: null, claim: "prefer a named constant" }],
    });
  });

  it("uses the LAST block — agents echo the template before their real output", () => {
    const echoed = block(JSON.stringify([{ severity: "critical", claim: "TEMPLATE EXAMPLE" }]))
      + "\n" + block(JSON.stringify([{ severity: "advisory", claim: "the real one" }]));
    const parsed = parseFindingsBlockResult(echoed);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(parsed.drafts.map((finding) => finding.claim)).toEqual(["the real one"]);
  });

  it("tolerates indentation on the fence", () => {
    const indented = "  ```findings\n  " + JSON.stringify([{ severity: "critical", claim: "x" }]) + "\n  ```\n";
    const parsed = parseFindingsBlockResult(indented);
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") expect(parsed.drafts.map((finding) => finding.claim)).toEqual(["x"]);
  });
});

describe("parseStoredFindings — untrusted state file", () => {
  const stored: Finding = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: "src/x.ts",
    line: 4,
    claim: "unchecked cast",
  };

  it("returns [] for a missing or non-array field", () => {
    expect(parseStoredFindings(undefined)).toEqual([]);
    expect(parseStoredFindings({})).toEqual([]);
    expect(parseStoredFindings("[]")).toEqual([]);
  });

  it("round-trips a well-formed record", () => {
    expect(parseStoredFindings([stored])).toEqual([stored]);
  });

  it("drops entries missing or carrying panel-incompatible identity rather than failing the whole task", () => {
    const parsed = parseStoredFindings([
      { ...stored, id: "" },
      { ...stored, id: "bad:id" },
      { ...stored, id: "bad id" },
      { ...stored, id: " code-reviewer-1" },
      { ...stored, id: "code-reviewer-1 " },
      { ...stored, agent: undefined },
      { ...stored, severity: "high" },
      { ...stored, claim: "" },
      stored,
    ]);
    expect(parsed).toEqual([stored]);
  });
});

describe("malformed remediation-record salvage", () => {
  const finding: Finding = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: null,
    line: null,
    claim: "unchecked cast",
  };

  it.each([
    ["resolution", salvageFindingsFromMalformedResolutions, { finding, resolution: { kind: "wrong" } }],
    ["refutation", salvageFindingsFromMalformedRefutations, { finding, refutations: [] }],
  ] as const)("recovers the nested finding from a malformed %s envelope", (_label, salvage, malformed) => {
    expect(salvage([malformed, null, { finding: { ...finding, id: "" } }])).toEqual([finding]);
    expect(salvage(undefined)).toEqual([]);
  });
});

describe("parseStoredRefutations", () => {
  const finding: Finding = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: null,
    line: null,
    claim: "unchecked cast",
  };

  it("keeps a well-formed refutation record", () => {
    const raw = [{
      finding,
      refutations: [
        { lens: "reproduction", reason: "cannot trigger" },
        { lens: "intent", reason: "deliberate" },
      ],
    }];
    expect(parseStoredRefutations(raw)).toEqual(raw);
  });

  it("drops a record with no refuters — a refutation nobody made is not one", () => {
    expect(parseStoredRefutations([{ finding, refutations: [] }])).toEqual([]);
    expect(parseStoredRefutations([{ finding }])).toEqual([]);
  });

  it("drops a record whose pair is missing a lens or a reason", () => {
    // The pair shape is what makes lens/reason misalignment unrepresentable;
    // a half-filled pair is the only way it can still arrive from disk.
    expect(parseStoredRefutations([{ finding, refutations: [{ lens: "reproduction" }] }])).toEqual([]);
    expect(parseStoredRefutations([{ finding, refutations: [{ reason: "cannot trigger" }] }])).toEqual([]);
    expect(parseStoredRefutations([{ finding, refutations: [{ lens: " ", reason: "x" }] }])).toEqual([]);
  });

  it("drops a record whose finding lost its identity", () => {
    expect(parseStoredRefutations([{ finding: { ...finding, id: "" }, refutations: [{ lens: "x", reason: "y" }] }]))
      .toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Identity across a refutation — the invariant the panel introduced
// ---------------------------------------------------------------------------

const taskFixture = (over: Partial<Task> = {}): Task => ({
  id: "T1",
  description: "d",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  depends_on: [],
  ...over,
});

/** The panel decision `applyFindingOutcomes` consumes, for one stored finding. */
const kill = (finding: Finding): AdjudicatedFinding => ({
  finding: { id: `T1:${finding.id}`, taskId: "T1" },
  refutations: [{ lens: "reproduction", reason: "cannot trigger" }],
  survives: false,
});

describe("nextOrdinal across a refutation", () => {
  it("does not remint an ordinal a refutation record still holds", () => {
    // The bug this pins: nextOrdinal used to count `task.findings`, which
    // applyFindingOutcomes REMOVES from. Refute one, re-review, and the new
    // finding took the refuted one's id — after which the id filter deleted
    // two findings where one was adjudicated, and the audit trail named the
    // wrong claim.
    let task = mergeFindings(
      taskFixture({ review_status: "pending" }),
      makeParsed(["c one", "c two"]),
      "code-reviewer",
    );
    expect(task.findings?.map((f) => f.id)).toEqual(["code-reviewer-1", "code-reviewer-2"]);

    task = applyFindingOutcomes(task, [kill(task.findings![1]!)]);
    expect(task.findings?.map((f) => f.id)).toEqual(["code-reviewer-1"]);
    expect(task.refuted_findings?.map((r) => r.finding.id)).toEqual(["code-reviewer-2"]);

    task = mergeFindings(task, makeParsed(["c three"]), "code-reviewer");
    expect(task.findings?.map((f) => f.id)).toEqual(["code-reviewer-1", "code-reviewer-3"]);

    const everyId = [
      ...(task.findings ?? []).map((f) => f.id),
      ...(task.refuted_findings ?? []).map((r) => r.finding.id),
    ];
    expect(new Set(everyId).size, "every id this task ever minted stays distinct").toBe(everyId.length);
  });

  it("survives repeated refute-then-re-review cycles", () => {
    let task: Task = taskFixture({ review_status: "pending" });
    const seen = new Set<string>();
    for (let round = 0; round < 6; round++) {
      task = mergeFindings(task, makeParsed([`round ${round}`]), "code-reviewer");
      const minted = task.findings![task.findings!.length - 1]!;
      expect(seen.has(minted.id), `id ${minted.id} was reused in round ${round}`).toBe(false);
      seen.add(minted.id);
      task = applyFindingOutcomes(task, [kill(minted)]);
    }
    expect(task.refuted_findings).toHaveLength(6);
  });
});

describe("applyFindingOutcomes keeps the derived views in lockstep", () => {
  it("holds for any subset of a mixed finding set", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ critical: fc.boolean(), claim: fc.string({ minLength: 1, maxLength: 6 }) }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        (specs, killFlags) => {
          const parsed = makeParsedFindings({
            drafts: specs
              .map((spec) =>
                makeDraftFinding({ severity: spec.critical ? "critical" : "advisory", claim: spec.claim }),
              )
              .filter((d): d is DraftFinding => d !== null),
            criticalCount: specs.filter((s) => s.critical).length,
          });
          const start = mergeFindings(taskFixture({ review_status: "pending" }), parsed, "code-reviewer");
          const outcomes = (start.findings ?? []).map((finding, index): AdjudicatedFinding => ({
            finding: { id: `T1:${finding.id}`, taskId: "T1" },
            refutations: [{ lens: "intent", reason: "deliberate" }],
            survives: !killFlags[index],
          }));
          const after = applyFindingOutcomes(start, outcomes);

          // The headline invariant: the two string[] views are exactly the
          // claims of the authoritative array, at every severity, always.
          expect(after.critical_findings).toEqual(claimsOfSeverity(after.findings ?? [], "critical"));
          expect(after.advisory_findings).toEqual(claimsOfSeverity(after.findings ?? [], "advisory"));
          // Nothing is lost: every finding is either still active or recorded
          // as refuted. A dropped critical is the failure mode this forbids.
          expect((after.findings ?? []).length + (after.refuted_findings ?? []).length).toBe(
            (start.findings ?? []).length,
          );
        },
      ),
    );
  });

  it("promotes blocked to passed exactly when no critical remains", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), (killFlags) => {
        const parsed = makeParsedFindings({
          critical: killFlags.map((_, index) => `critical ${index}`),
          criticalCount: killFlags.length,
        });
        const blocked = mergeFindings(taskFixture({ review_status: "pending" }), parsed, "code-reviewer");
        expect(blocked.review_status).toBe("blocked");
        const after = applyFindingOutcomes(
          blocked,
          (blocked.findings ?? []).map((finding, index): AdjudicatedFinding => ({
            finding: { id: `T1:${finding.id}`, taskId: "T1" },
            refutations: [{ lens: "intent", reason: "deliberate" }],
            survives: !killFlags[index],
          })),
        );
        expect(after.review_status).toBe(killFlags.every(Boolean) ? "passed" : "blocked");
      }),
    );
  });
});

describe("the load boundary proves what the Task type asserts", () => {
  const wellFormed = { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", claim: "x" };

  it("accepts an absent field and a well-formed array", () => {
    expect(findingsUnionError(undefined, "findings")).toBeNull();
    expect(findingsUnionError([wellFormed], "findings")).toBeNull();
    expect(refutationsUnionError(undefined, "refuted_findings")).toBeNull();
    expect(
      refutationsUnionError([{ finding: wellFormed, refutations: [{ lens: "intent", reason: "y" }] }], "r"),
    ).toBeNull();
  });

  it.each([
    ["a non-array", {}],
    ["a non-object entry", ["nope"]],
    ["an entry with no id", [{ ...wellFormed, id: "" }]],
    ["an entry with no agent", [{ ...wellFormed, agent: undefined }]],
    ["an unknown severity", [{ ...wellFormed, severity: "blocker" }]],
    ["a non-string claim", [{ ...wellFormed, claim: 7 }]],
  ])("rejects %s, naming the repair", (_label, raw) => {
    const error = findingsUnionError(raw, "tasks[0].findings");
    expect(error).not.toBeNull();
    expect(error).toContain("tasks[0].findings");
  });

  it("points at the repair command rather than leaving the operator stuck", () => {
    expect(findingsUnionError([{}], "findings")).toContain("repair-task-graph");
  });

  it("rejects exactly what the repair path drops — the two must agree", () => {
    // Otherwise a graph could be simultaneously unloadable and unrepairable.
    for (const raw of [[{}], [{ ...wellFormed, claim: "none" }], [{ ...wellFormed, id: "  " }]]) {
      expect(findingsUnionError(raw, "findings")).not.toBeNull();
      expect(parseStoredFindings(raw)).toEqual([]);
    }
  });
});

describe("the load boundary proves the LOCKSTEP, not only the shapes", () => {
  const wellFormed = { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", claim: "x" };

  it("rejects two findings sharing an id", () => {
    // The failure `nextOrdinal` forecloses when MINTING, and nothing caught on
    // read: `applyFindingOutcomes` filters by an id set, so a duplicate makes
    // one adjudication delete two findings and record the panel's reasoning
    // against the wrong claim.
    const error = findingsUnionError([wellFormed, { ...wellFormed, claim: "y" }], "tasks[0].findings");
    expect(error).toContain("repeats finding id 'code-reviewer-1'");
    expect(error).toContain("repair-task-graph");
  });

  it("accepts distinct ids carrying the same claim", () => {
    expect(
      findingsUnionError(
        [wellFormed, { ...wellFormed, id: "silent-failure-hunter-1", agent: "silent-failure-hunter" }],
        "f",
      ),
    ).toBeNull();
  });

  it.each([
    ["a critical present only in findings", [wellFormed], [], []],
    ["a claim present only in the view", [], ["orphan"], []],
    ["an advisory view that outruns findings", [wellFormed], ["x"], ["nit"]],
  ])("rejects %s", (_label, findings, critical, advisory) => {
    const error = findingsLockstepError(findings, critical, advisory, "tasks[0]");
    expect(error).toContain("is not the derived view of findings");
    expect(error).toContain("repair-task-graph");
  });

  it("compares as a MULTISET — two reviewers may word a claim identically", () => {
    expect(
      findingsLockstepError(
        [wellFormed, { ...wellFormed, id: "silent-failure-hunter-1", agent: "silent-failure-hunter" }],
        ["x", "x"],
        [],
        "t",
      ),
    ).toBeNull();
    // ...but one finding cannot back two identical view entries.
    expect(findingsLockstepError([wellFormed], ["x", "x"], [], "t")).not.toBeNull();
  });

  it("says nothing about a pre-identity task — its views are all it has", () => {
    expect(findingsLockstepError(undefined, ["from before identity"], [], "t")).toBeNull();
  });

  it("holds for every graph the sanctioned writers produce", () => {
    // The property that ties the check to the writers: if any of them could
    // produce a graph this rejects, the load boundary would brick the workflow.
    fc.assert(
      fc.property(
        fc.array(fc.record({ critical: fc.boolean(), claim: fc.string({ minLength: 1, maxLength: 6 }) }), {
          maxLength: 6,
        }),
        (specs) => {
          const parsed = makeParsedFindings({
            drafts: specs
              .map((s) => makeDraftFinding({ severity: s.critical ? "critical" : "advisory", claim: s.claim }))
              .filter((d): d is DraftFinding => d !== null),
            criticalCount: specs.filter((s) => s.critical).length,
          });
          const merged = mergeFindings(taskFixture({ review_status: "pending" }), parsed, "code-reviewer");
          expect(
            findingsLockstepError(
              merged.findings,
              merged.critical_findings,
              merged.advisory_findings,
              "t",
            ),
          ).toBeNull();
        },
      ),
    );
  });
});

describe("mergeFindings", () => {
  it("blocks when the markers carry a critical the reviewer's count denied", () => {
    // `CRITICAL_COUNT: 0` beside a real CRITICAL: line used to record `passed`,
    // and a task pinned at `passed` is one applyFindingOutcomes' promotion
    // guard can never adjudicate.
    const understated = makeParsedFindings({ critical: ["a real blocker"], criticalCount: 0 });
    const merged = mergeFindings(taskFixture({ review_status: "pending" }), understated, "code-reviewer");
    expect(merged.review_status).toBe("blocked");
    expect(merged.critical_findings).toEqual(["a real blocker"]);
  });

  it("gives a pre-identity task's view claims identity instead of orphaning them", () => {
    // Appending beside them without migrating left `findings` holding strictly
    // less than the views claimed — the drift the load boundary now rejects.
    const legacy = taskFixture({
      review_status: "blocked",
      findings: undefined,
      critical_findings: ["from before identity"],
      advisory_findings: ["an old nit"],
    });
    const merged = mergeFindings(legacy, makeParsed(["a new one"]), "code-reviewer");
    expect(merged.critical_findings).toEqual(["from before identity", "a new one"]);
    expect(merged.advisory_findings).toEqual(["an old nit"]);
    expect(merged.findings?.map((f) => f.agent)).toEqual([
      "recovered-view",
      "recovered-view",
      "code-reviewer",
    ]);
    expect(findingsLockstepError(merged.findings, merged.critical_findings, merged.advisory_findings, "t"))
      .toBeNull();
  });
});

describe("applyFindingOutcomes refuses to adjudicate what it cannot find", () => {
  const blocked = () =>
    mergeFindings(taskFixture({ review_status: "pending" }), makeParsed(["a blocker"]), "code-reviewer");

  it("throws on an outcome naming a finding the task no longer holds", () => {
    // Silently skipping it wrote no audit record while serializeOutcomes and
    // the operator line both still reported the finding as refuted — and
    // dropping the wave's last critical that way promotes blocked → passed.
    // Reachable when a store-review-findings override lands between brief and
    // tally, which invalidates every brief id for that task.
    expect(() =>
      applyFindingOutcomes(blocked(), [{
        finding: { id: "T1:code-reviewer-99", taskId: "T1" },
        refutations: [{ lens: "intent", reason: "deliberate" }],
        survives: false,
      }]),
    ).toThrow(/no finding 'code-reviewer-99'/);
  });

  it("cannot be handed a refuted finding with no refutations", () => {
    // parseStoredRefutation refuses an empty refutations list, so writing one
    // would make the graph unloadable by the module that wrote it. This used to
    // be a runtime throw at the consumer; AdjudicatedFinding is now a union
    // whose `survives: false` arm requires a non-empty tuple, so the state is
    // unrepresentable and the check is a COMPILE-time one. `ts-expect-error`
    // fails the typecheck if the constraint is ever loosened back.
    // @ts-expect-error refutations must be non-empty when survives is false
    const illegal: AdjudicatedFinding = {
      finding: { id: "T1:code-reviewer-1", taskId: "T1" },
      refutations: [],
      survives: false,
    };
    void illegal;

    // And the surviving arm — where an empty list IS legal — still adjudicates
    // nothing, so the union did not merely move the failure somewhere quieter.
    const task = blocked();
    expect(applyFindingOutcomes(task, [{
      finding: { id: "T1:code-reviewer-1", taskId: "T1" },
      refutations: [],
      survives: true,
    }])).toBe(task);
  });

  it("still ignores an outcome belonging to another task", () => {
    const task = blocked();
    expect(applyFindingOutcomes(task, [{
      finding: { id: "T2:code-reviewer-1", taskId: "T2" },
      refutations: [{ lens: "intent", reason: "deliberate" }],
      survives: false,
    }])).toBe(task);
  });
});

describe("deduplicateFindingIds — the repair for what the boundary rejects", () => {
  const finding = (id: string, claim: string): Finding => ({
    id, agent: "code-reviewer", severity: "critical", file: null, line: null, claim,
  });

  it("re-mints the collision rather than dropping the second claim", () => {
    const deduped = deduplicateFindingIds(
      [finding("code-reviewer-1", "first"), finding("code-reviewer-1", "second")],
      [],
    );
    expect(deduped.map((f) => f.claim)).toEqual(["first", "second"]);
    expect(new Set(deduped.map((f) => f.id)).size).toBe(2);
  });

  it("never remints onto an ordinal a refutation record still holds", () => {
    const refuted: RefutedFinding[] = [{
      finding: finding("code-reviewer-2", "already refuted"),
      refutations: [{ lens: "intent", reason: "deliberate" }],
    }];
    const deduped = deduplicateFindingIds(
      [finding("code-reviewer-1", "first"), finding("code-reviewer-1", "second")],
      refuted,
    );
    expect(deduped.map((f) => f.id)).not.toContain("code-reviewer-2");
  });

  it("is a no-op on an already-distinct set", () => {
    const distinct = [finding("code-reviewer-1", "a"), finding("code-reviewer-2", "b")];
    expect(deduplicateFindingIds(distinct, [])).toEqual(distinct);
  });
});

describe("recoverViewOnlyClaims", () => {
  it("mints identity for exactly the claims no finding accounts for", () => {
    const held: Finding = {
      id: "code-reviewer-1", agent: "code-reviewer", severity: "critical",
      file: null, line: null, claim: "already identified",
    };
    const recovered = recoverViewOnlyClaims([held], [], { critical: ["already identified", "orphan"], advisory: ["a nit"] });
    expect(recovered.map((f) => f.claim)).toEqual(["orphan", "a nit"]);
    expect(recovered.every((f) => f.agent === "recovered-view")).toBe(true);
  });

  it("recovers nothing when the views are already in step", () => {
    expect(recoverViewOnlyClaims([], [], { critical: [], advisory: [] })).toEqual([]);
  });
});
