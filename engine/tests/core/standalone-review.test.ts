import { describe, expect, it } from "vitest";
import { buildStandaloneFindingBrief, parseFindingBriefJson, serializeFindingBrief } from "../../src/core/review-panel";
import {
  STANDALONE_REVIEW_SUBJECT,
  aggregateStandaloneReview,
  finalizeStandaloneReview,
  parseStandaloneAggregate,
  parseStandalonePanelOutcomes,
  serializeStandaloneAggregate,
} from "../../src/core/standalone-review";

const transcript = (critical: string[] = [], advisory: string[] = []) => [
  "### Machine Summary",
  `CRITICAL_COUNT: ${critical.length}`,
  `ADVISORY_COUNT: ${advisory.length}`,
  ...critical.map((claim) => `CRITICAL: ${claim}`),
  ...advisory.map((claim) => `ADVISORY: ${claim}`),
  "",
  "```findings",
  JSON.stringify([
    ...critical.map((claim) => ({ severity: "critical", file: "src/x.ts", line: 3, claim })),
    ...advisory.map((claim) => ({ severity: "advisory", file: "src/x.ts", line: 4, claim })),
  ]),
  "```",
].join("\n");

interface MutablePanelOutcome {
  finding_id: string;
  task_id: string;
  claim: string;
  survives: boolean;
  refuted_by: string[];
  reasoning: string[];
  upheld_by: string[];
  uncertain_from: string[];
}

interface MutablePanelOutcomes {
  lenses: string[];
  threshold: number;
  surviving: number;
  refuted: number;
  outcomes: MutablePanelOutcome[];
}

function required() {
  const result = aggregateStandaloneReview({
    runId: "run.abc",
    scope: ["src/x.ts"],
    transcripts: [
      { agent: "code-reviewer", output: transcript(["real blocker"], ["small improvement"]) },
      { agent: "type-design-analyzer", output: transcript(["duplicate wording"]) },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.value.kind !== "requires-refutation") throw new Error("expected criticals");
  return result.value;
}

describe("standalone review aggregate", () => {
  it("parses, attributes, and preserves findings from every reviewer", () => {
    const state = required();
    expect(state.criticals.map((finding) => finding.id)).toEqual(["code-reviewer-1", "type-design-analyzer-1"]);
    expect(state.aggregate.findings.map((finding) => finding.claim)).toEqual([
      "real blocker", "small improvement", "duplicate wording",
    ]);
  });

  it("fails closed when any reviewer omits its evidence marker", () => {
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: "looks fine" }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain("CRITICAL_COUNT marker not found");
  });

  it.each([
    ["absolute", "/tmp/outside.ts", "repository-relative"],
    ["drive-absolute", "C:/outside.ts", "repository-relative"],
    ["traversal", "src/../../outside.ts", "canonical"],
    ["dot alias", "./src/x.ts", "canonical"],
    ["repeated separator", "src//x.ts", "canonical"],
    ["backslash alias", "src\\x.ts", "POSIX"],
    ["newline", "src/bad\npath.ts", "single line without NUL"],
    ["NUL", "src/bad\0path.ts", "NUL"],
  ])("rejects malformed %s scope paths", (_label, scopePath, message) => {
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: [scopePath],
      transcripts: [{ agent: "code-reviewer", output: transcript() }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain(message);
  });

  it("rejects duplicate canonical scope paths", () => {
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts", "src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript() }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain("must be distinct");
  });

  it("rejects a transcript finding outside the frozen scope", () => {
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: ["src/inside.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript(["outside blocker"]) }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain(
      "code-reviewer findings[0].file is outside the frozen review scope: src/x.ts",
    );
  });

  it("preserves an honestly unlocated finding while enforcing scope on located findings", () => {
    const output = transcript(["unlocated blocker"]).replace(
      '"file":"src/x.ts"',
      '"file":null',
    );
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.aggregate.findings[0]?.file).toBeNull();
  });

  it("represents zero criticals as an explicit clean state", () => {
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript([], ["small improvement"]) }],
    });
    expect(result.ok && result.value.kind).toBe("clean");
  });

  it("round-trips the aggregate through its untrusted boundary", () => {
    const aggregate = required().aggregate;
    const parsed = parseStandaloneAggregate(JSON.parse(serializeStandaloneAggregate(aggregate)));
    expect(parsed).toEqual({ ok: true, value: aggregate });
  });

  it("rejects a stored aggregate tampered with an out-of-scope finding", () => {
    const raw = JSON.parse(serializeStandaloneAggregate(required().aggregate));
    raw.findings[0].file = "src/outside.ts";
    const parsed = parseStandaloneAggregate(raw);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain(
      "aggregate.findings[0].file is outside the frozen review scope: src/outside.ts",
    );
  });

  it("accepts and round-trips a stored aggregate with a null finding location", () => {
    const raw = JSON.parse(serializeStandaloneAggregate(required().aggregate));
    raw.findings[0].file = null;
    raw.findings[0].line = null;
    const parsed = parseStandaloneAggregate(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.findings[0]?.file).toBeNull();
  });
});

describe("standalone brief source invariant", () => {
  it("constructs only canonical standalone subjects and round-trips its output", () => {
    const brief = buildStandaloneFindingBrief(required().aggregate);
    expect(brief.taskIds).toEqual([STANDALONE_REVIEW_SUBJECT]);
    expect(brief.findings.every((finding) => finding.taskId === STANDALONE_REVIEW_SUBJECT)).toBe(true);
    expect(parseFindingBriefJson(JSON.parse(serializeFindingBrief(brief)))).toEqual({ ok: true, value: brief });
  });

  it("rejects a standalone source flag on a non-standalone subject", () => {
    const parsed = parseFindingBriefJson({
      wave: 9,
      source_kind: "standalone",
      severity: "critical",
      task_ids: ["T1"],
      findings: [{
        id: "T1:code-reviewer-1", task_id: "T1", agent: "code-reviewer",
        severity: "critical", file: null, line: null, claim: "blocker",
      }],
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("standalone brief.wave must be 1");
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("standalone brief.task_ids must be exactly");
  });
});

describe("standalone review adjudication", () => {
  it("partitions every critical into surviving or audibly refuted", () => {
    const state = required();
    const raw = {
      lenses: ["reproduction", "intent", "blast-radius"],
      threshold: 2,
      surviving: 1,
      refuted: 1,
      outcomes: state.criticals.map((finding, index) => ({
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: finding.claim,
        survives: index === 0,
        refuted_by: index === 0 ? [] : ["reproduction", "intent"],
        reasoning: index === 0 ? [] : ["cannot trigger", "deliberate"],
        upheld_by: index === 0 ? ["reproduction", "intent"] : ["blast-radius"],
        uncertain_from: index === 0 ? ["blast-radius"] : [],
      })),
    };
    const panel = parseStandalonePanelOutcomes(
      raw,
      state.criticals,
      buildStandaloneFindingBrief(state.aggregate).findings,
      ["reproduction", "intent", "blast-radius"],
    );
    expect(panel.ok).toBe(true);
    if (!panel.ok) return;
    expect(panel.value.outcomes[1]?.refutations).toEqual([
      { lens: "reproduction", reason: "cannot trigger" },
      { lens: "intent", reason: "deliberate" },
    ]);
    const result = finalizeStandaloneReview(state.aggregate, panel.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.survivingCriticals.map((finding) => finding.claim)).toEqual(["real blocker"]);
    expect(result.value.refutedCriticals[0]?.finding.claim).toBe("duplicate wording");
    expect(result.value.refutedCriticals[0]?.refutations).toEqual([
      { lens: "reproduction", reason: "cannot trigger" },
      { lens: "intent", reason: "deliberate" },
    ]);
    expect(result.value.advisories.map((finding) => finding.claim)).toEqual(["small improvement"]);
  });

  it("rejects missing, foreign, duplicate, or threshold-inconsistent outcomes", () => {
    const state = required();
    const one = state.criticals[0]!;
    const parsed = parseStandalonePanelOutcomes({
      lenses: ["reproduction", "intent", "blast-radius"], threshold: 2,
      outcomes: [{
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${one.id}`,
        claim: one.claim,
        survives: false,
        refuted_by: ["intent"], reasoning: ["not enough"], upheld_by: [], uncertain_from: [],
      }],
    }, state.criticals, buildStandaloneFindingBrief(state.aggregate).findings, ["reproduction", "intent", "blast-radius"]);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("must meet threshold");
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("missing critical finding");
  });

  it.each([
    ["canonical claim", (raw: MutablePanelOutcomes) => { raw.outcomes[0]!.claim = "forged claim"; }],
    ["vote partition", (raw: MutablePanelOutcomes) => { raw.outcomes[0]!.upheld_by.push("reproduction"); }],
    ["refutation reasoning", (raw: MutablePanelOutcomes) => { raw.outcomes[1]!.reasoning.pop(); }],
    ["derived counts", (raw: MutablePanelOutcomes) => { raw.surviving = 2; raw.refuted = 0; }],
  ])("rejects a %s mismatch in canonical panel outcomes", (_label, corrupt) => {
    const state = required();
    const panelFindings = buildStandaloneFindingBrief(state.aggregate).findings;
    const raw: MutablePanelOutcomes = {
      lenses: ["reproduction", "intent", "blast-radius"],
      threshold: 2,
      surviving: 1,
      refuted: 1,
      outcomes: state.criticals.map((finding, index) => ({
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: finding.claim,
        survives: index === 0,
        refuted_by: index === 0 ? [] : ["reproduction", "intent"],
        reasoning: index === 0 ? [] : ["cannot trigger", "deliberate"],
        upheld_by: index === 0 ? ["reproduction", "intent"] : ["blast-radius"],
        uncertain_from: index === 0 ? ["blast-radius"] : [],
      })),
    };
    corrupt(raw);

    const parsed = parseStandalonePanelOutcomes(
      raw,
      state.criticals,
      panelFindings,
      ["reproduction", "intent", "blast-radius"],
    );

    expect(parsed.ok).toBe(false);
  });

  it("accepts sanitized panel claims while retaining the original aggregate claim", () => {
    const aggregated = aggregateStandaloneReview({
      runId: "run.braces",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript(["the {config} value is unchecked"]) }],
    });
    expect(aggregated.ok).toBe(true);
    if (!aggregated.ok || aggregated.value.kind !== "requires-refutation") return;
    const panelFindings = buildStandaloneFindingBrief(aggregated.value.aggregate).findings;
    expect(panelFindings[0]?.claim).toBe("the config value is unchecked");
    const raw = {
      lenses: ["reproduction", "intent"], threshold: 2, surviving: 1, refuted: 0,
      outcomes: [{
        finding_id: panelFindings[0]!.id,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: panelFindings[0]!.claim,
        survives: true,
        refuted_by: [], reasoning: [], upheld_by: ["reproduction", "intent"], uncertain_from: [],
      }],
    };
    const parsed = parseStandalonePanelOutcomes(
      raw,
      aggregated.value.criticals,
      panelFindings,
      ["reproduction", "intent"],
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const finalized = finalizeStandaloneReview(aggregated.value.aggregate, parsed.value);
    expect(finalized.ok).toBe(true);
    if (finalized.ok) {
      expect(finalized.value.survivingCriticals[0]?.claim).toBe("the {config} value is unchecked");
    }
  });

  it("cannot finalize critical findings without a panel", () => {
    const result = finalizeStandaloneReview(required().aggregate, null);
    expect(result).toEqual({ ok: false, errors: ["standalone review has unadjudicated critical findings"] });
  });
});
