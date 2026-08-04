import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { join } from "node:path";
import type { Task } from "../../src/types";
import type { Finding } from "../../src/core/findings";
import { applyFindingOutcomes, claimsOfSeverity } from "../../src/core/findings";
import type { VerdictEnvelope } from "../../src/core/panel-kernel";
import {
  briefCompletenessErrors,
  briefFindingFilename,
  buildFindingBrief,
  defaultRefutationThreshold,
  parseFindingBriefJson,
  parseRefutationVerdict,
  parseReviewManifest,
  renderFindingBriefMarkdown,
  reviewSignals,
  selectReviewLenses,
  serializeFindingBrief,
  serializeOutcomes,
  serializeRefutationVerdict,
  serializeReviewManifest,
  tallyRefutations,
  waveFindingId,
  REVIEW_LENSES,
  REVIEW_LENSES_DEFAULT,
  REVIEW_LENSES_MIN,
  type BriefFinding,
  type FindingOutcome,
  type RefutationVerdict,
  type ReviewLens,
  type WaveFindingId,
} from "../../src/core/review-panel";
import { REVIEW_LAYOUT } from "../../src/core/panel-kernel";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "code-reviewer-1",
  agent: "code-reviewer",
  severity: "critical",
  file: "src/x.ts",
  line: 4,
  claim: "unchecked cast",
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: "T1",
  description: "d",
  agent: "code-implementer-agent",
  wave: 1,
  status: "implemented",
  depends_on: [],
  ...over,
});

/** Wave-scoped ids are branded; production code mints them through
 *  `waveFindingId` or proves the `${taskId}:` prefix while parsing. Fixtures
 *  assert the shape by hand, which is what a test fixture is for. */
const waveId = (raw: string): WaveFindingId => raw as WaveFindingId;

const brief = (over: Partial<BriefFinding> = {}): BriefFinding => ({
  id: waveId("T1:code-reviewer-1"),
  taskId: "T1",
  agent: "code-reviewer",
  severity: "critical",
  file: "src/x.ts",
  line: 4,
  claim: "unchecked cast",
  ...over,
});

/** A validated envelope, built the way the CLI builds one. */
function envelope(
  lens: ReviewLens,
  votes: readonly (readonly [WaveFindingId, "refuted" | "upheld" | "uncertain"])[],
): VerdictEnvelope<RefutationVerdict> {
  const parsed = parseRefutationVerdict(
    JSON.stringify({
      criterion: lens,
      verdicts: votes.map(([findingId, verdict]) => ({
        finding_id: findingId,
        verdict,
        reasoning: `${lens} says ${verdict}`,
      })),
    }),
    lens,
    votes.map(([findingId]) => findingId),
  );
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.value;
}

describe("selectReviewLenses", () => {
  it("always includes the two baselines", () => {
    const lenses = selectReviewLenses({ touchesSensitiveBoundary: false, touchesTests: false }, 2);
    expect(lenses.ok && lenses.value).toEqual(["reproduction", "intent"]);
  });

  it("pulls in security when the finding set touches a sensitive boundary", () => {
    const lenses = selectReviewLenses({ touchesSensitiveBoundary: true, touchesTests: false }, 3);
    expect(lenses.ok && lenses.value).toEqual(["reproduction", "intent", "security"]);
  });

  it("pulls in test-coverage when findings land on test files", () => {
    const lenses = selectReviewLenses({ touchesSensitiveBoundary: false, touchesTests: true }, 3);
    expect(lenses.ok && lenses.value).toEqual(["reproduction", "intent", "test-coverage"]);
  });

  it("prioritizes security over test-coverage when both signals fire", () => {
    const lenses = selectReviewLenses({ touchesSensitiveBoundary: true, touchesTests: true }, 4);
    expect(lenses.ok && lenses.value).toEqual(["reproduction", "intent", "security", "test-coverage"]);
  });

  it("fills the unsignalled third slot with blast-radius — cause, intent, consequence", () => {
    const lenses = selectReviewLenses({ touchesSensitiveBoundary: false, touchesTests: false }, REVIEW_LENSES_DEFAULT);
    expect(lenses.ok && lenses.value).toEqual(["reproduction", "intent", "blast-radius"]);
  });

  it("fills remaining slots from the table order", () => {
    const lenses = selectReviewLenses({ touchesSensitiveBoundary: false, touchesTests: false }, 5);
    expect(lenses.ok && lenses.value).toEqual([...REVIEW_LENSES]);
  });

  it("rejects a lens count outside the viable range", () => {
    for (const n of [0, 1, REVIEW_LENSES.length + 1, 2.5, Number.NaN]) {
      expect(selectReviewLenses({ touchesSensitiveBoundary: false, touchesTests: false }, n).ok).toBe(false);
    }
  });

  it("the default sits inside the viable range", () => {
    expect(REVIEW_LENSES_DEFAULT).toBeGreaterThanOrEqual(REVIEW_LENSES_MIN);
    expect(REVIEW_LENSES_DEFAULT).toBeLessThanOrEqual(REVIEW_LENSES.length);
  });
});

describe("reviewSignals", () => {
  it("detects sensitive boundaries from the path or the claim", () => {
    expect(reviewSignals([brief({ file: "src/auth/token.ts" })]).touchesSensitiveBoundary).toBe(true);
    expect(reviewSignals([brief({ file: null, claim: "the JWT is never verified" })]).touchesSensitiveBoundary).toBe(true);
    expect(reviewSignals([brief({ file: "src/render.ts", claim: "off-by-one" })]).touchesSensitiveBoundary).toBe(false);
  });

  it("detects test files across the conventions loom supports", () => {
    for (const file of ["tests/x.test.ts", "src/__tests__/y.ts", "src/a.spec.tsx", "src/FooTest.java", "pkg/x_test.go"]) {
      expect(reviewSignals([brief({ file })]).touchesTests, file).toBe(true);
    }
    expect(reviewSignals([brief({ file: "src/testimonials.ts" })]).touchesTests).toBe(false);
  });

  it("reads the CLAIM for a test signal too, not only the path", () => {
    // The asymmetry this pins: touchesSensitiveBoundary consulted file AND
    // claim while touchesTests consulted only file. `file` is null for every
    // finding the line scraper produced — which is every finding on a review
    // whose block was absent, rejected, or superseded, all first-class states —
    // so touchesTests was unconditionally false on exactly those reviews and
    // the test-coverage lens could never be signal-selected to judge them.
    expect(reviewSignals([brief({ file: null, claim: "no coverage for tests/auth.test.ts" })]).touchesTests)
      .toBe(true);
    expect(reviewSignals([brief({ file: null, claim: "the spec/ suite never exercises this" })]).touchesTests)
      .toBe(true);
    expect(reviewSignals([brief({ file: null, claim: "an ordinary claim about a reducer" })]).touchesTests)
      .toBe(false);
  });

  it("pulls the test-coverage lens into a panel judging scraper-sourced findings", () => {
    // The consequence, end to end: the signal has to reach lens selection, not
    // merely flip a boolean.
    const signals = reviewSignals([brief({ file: null, claim: "src/x.test.ts asserts nothing" })]);
    const lenses = selectReviewLenses(signals, 3);
    expect(lenses.ok && lenses.value).toContain("test-coverage");
  });
});

describe("buildFindingBrief", () => {
  it("collects only critical findings, scoped by task", () => {
    const result = buildFindingBrief(1, [
      task({ id: "T1", findings: [finding(), finding({ id: "code-reviewer-2", severity: "advisory", claim: "nit" })] }),
      task({ id: "T2", findings: [finding({ id: "code-reviewer-1", claim: "another" })] }),
      task({ id: "T3", wave: 2, findings: [finding({ claim: "next wave" })] }),
    ]);
    expect(result.taskIds).toEqual(["T1", "T2"]);
    expect(result.findings.map((f) => f.id)).toEqual(["T1:code-reviewer-1", "T2:code-reviewer-1"]);
  });

  it("re-scopes ids by task so two tasks' code-reviewer-1 stay distinct", () => {
    // Without wave scoping the envelope's coverage check would silently
    // collapse two different findings into one item.
    const result = buildFindingBrief(1, [
      task({ id: "T1", findings: [finding()] }),
      task({ id: "T2", findings: [finding()] }),
    ]);
    expect(new Set(result.findings.map((f) => f.id)).size).toBe(2);
    expect(result.findings[0]!.id).toBe(waveFindingId("T1", finding()));
  });

  it("sanitizes braces out of claims — the brief is substituted into prompts", () => {
    const result = buildFindingBrief(1, [
      task({ findings: [finding({ claim: "the {config} value is unchecked" })] }),
    ]);
    expect(result.findings[0]!.claim).toBe("the config value is unchecked");
  });

  it("keeps a finding whose claim sanitizes to nothing rather than losing a critical", () => {
    const result = buildFindingBrief(1, [task({ findings: [finding({ claim: "{}" })] })]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.claim).toContain("unusable after sanitization");
  });

  it("produces an empty brief for a wave with no criticals", () => {
    const result = buildFindingBrief(1, [task({ findings: [finding({ severity: "advisory" })] })]);
    expect(result.findings).toEqual([]);
    expect(renderFindingBriefMarkdown(result)).toContain("nothing to adjudicate");
  });
});

describe("briefCompletenessErrors — buildFindingBrief's postcondition", () => {
  // A short brief makes every later stage succeed vacuously and report
  // "0 survived, 0 refuted", which is indistinguishable from a panel that
  // adjudicated the wave and upheld nothing. Now a pure function beside the
  // builder whose postcondition it is, rather than an unexported helper in the
  // shell reachable only by spawning the CLI.
  const withView = (id: string, findings: readonly Finding[], view: readonly string[]) =>
    task({ id, findings, critical_findings: [...view] });

  const briefFor = (tasks: readonly Task[]) =>
    briefCompletenessErrors(buildFindingBrief(1, tasks), tasks);

  it("passes when every counted critical carries identity", () => {
    expect(briefFor([withView("T1", [finding()], ["unchecked cast"])])).toEqual([]);
  });

  it("names the wave when it holds no criticals at all", () => {
    const errors = briefFor([withView("T1", [], [])]);
    expect(errors[0]).toContain("has no critical findings");
    expect(errors[0]).toContain("nothing to adjudicate");
  });

  it("refuses a wave whose --wave flag matches no task", () => {
    expect(briefCompletenessErrors(buildFindingBrief(9, []), [])[0])
      .toContain("check --wave against .current_wave");
  });

  it("catches a task whose view outruns its findings, and names it", () => {
    const errors = briefFor([withView("T1", [], ["orphaned critical"])]);
    expect(errors[0]).toContain("T1 has 1 critical_findings but only 0 carry structured identity");
    expect(errors[0]).toContain("repair-task-graph");
  });

  it("counts the view that matches the brief's severity, not always the critical one", () => {
    // buildFindingBrief takes the severity as a parameter and the diagnostic
    // interpolates brief.severity, but the arithmetic read critical_findings
    // unconditionally — so the proof was wrong in BOTH directions for any other
    // severity. Here: one advisory, fully identified, beside two criticals. The
    // advisory brief is complete, and the check used to reject it by comparing
    // its one entry against the two criticals it does not cover.
    const advisory = finding({ id: "code-reviewer-9", severity: "advisory", claim: "a nit" });
    const t1 = task({
      id: "T1",
      findings: [finding(), finding({ id: "code-reviewer-2", claim: "second" }), advisory],
      critical_findings: ["unchecked cast", "second"],
      advisory_findings: ["a nit"],
    });
    expect(briefCompletenessErrors(buildFindingBrief(1, [t1], "advisory"), [t1])).toEqual([]);
  });

  it("catches a SHORT advisory brief, and says advisory", () => {
    // The other direction: a task with no criticals and an orphaned advisory
    // used to pass, because 0 criticals never outran anything.
    const t1 = task({ id: "T1", findings: [], critical_findings: [], advisory_findings: ["orphaned nit"] });
    const errors = briefCompletenessErrors(buildFindingBrief(1, [t1], "advisory"), [t1]);
    expect(errors[0]).toContain("T1 has 1 advisory_findings but only 0 carry structured identity");
  });

  it("does NOT let one task's surplus mask another task's orphans", () => {
    // The wave-wide sum this replaces: T1's two identified findings offset T2's
    // orphan, the totals matched, the check passed — and T2's critical entered
    // no brief, could never be refuted, and blocked the wave permanently, with
    // the only prescribed escape being a --fix that used to delete it.
    const errors = briefFor([
      withView("T1", [finding(), finding({ id: "code-reviewer-2", claim: "second" })], ["unchecked cast", "second"]),
      withView("T2", [], ["invisible to the panel"]),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T2 has 1 critical_findings but only 0");
    expect(errors[0], "the task that IS complete is not blamed").not.toContain("T1 has");
  });

  it("names every short task, not just the first", () => {
    const errors = briefFor([
      withView("T1", [], ["one orphan"]),
      withView("T2", [], ["another orphan"]),
    ]);
    expect(errors[0]).toContain("T1 has 1");
    expect(errors[0]).toContain("T2 has 1");
  });
});

describe("parseFindingBriefJson — re-parse, never trust the writer", () => {
  const validBrief = () => JSON.parse(serializeFindingBrief(buildFindingBrief(1, [task({ findings: [finding()] })])));

  it("round-trips a brief this module wrote", () => {
    const parsed = parseFindingBriefJson(validBrief());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.findings[0]!.id).toBe("T1:code-reviewer-1");
  });

  it.each([
    ["non-object", "not a brief"],
    ["bad wave", { ...validBrief(), wave: 0 }],
    ["bad severity", { ...validBrief(), severity: "high" }],
    ["non-array findings", { ...validBrief(), findings: {} }],
    ["empty task_ids entry", { ...validBrief(), task_ids: [""] }],
  ])("rejects %s", (_label, raw) => {
    expect(parseFindingBriefJson(raw).ok).toBe(false);
  });

  it("rejects a finding whose task is not in task_ids", () => {
    const raw = validBrief();
    raw.findings[0].task_id = "T9";
    expect(parseFindingBriefJson(raw).ok).toBe(false);
  });

  it("rejects an id that is not scoped by its task", () => {
    const raw = validBrief();
    raw.findings[0].id = "code-reviewer-1";
    expect(parseFindingBriefJson(raw).ok).toBe(false);
  });

  it.each(["T1:code:reviewer-1", "T1:code reviewer-1"])(
    "rejects an id outside the WaveFindingId grammar: %s",
    (id) => {
      const raw = validBrief();
      raw.findings[0].id = id;
      expect(parseFindingBriefJson(raw).ok).toBe(false);
    },
  );

  it("rejects duplicate finding ids", () => {
    const raw = validBrief();
    raw.findings.push({ ...raw.findings[0] });
    expect(parseFindingBriefJson(raw).ok).toBe(false);
  });

  it("rejects ids that collide once mapped to filenames", () => {
    const raw = validBrief();
    raw.findings.push({ ...raw.findings[0], id: "T1:code/reviewer/1" });
    expect(briefFindingFilename(waveId("T1:code-reviewer-1"))).toBe(briefFindingFilename(waveId("T1:code/reviewer/1")));
    expect(parseFindingBriefJson(raw).ok).toBe(false);
  });
});

describe("parseReviewManifest", () => {
  const RUN_DIR = join("panel-runs", "run.abc");
  const LENSES: readonly ReviewLens[] = ["reproduction", "intent"];
  const FINDINGS = [brief(), brief({ id: waveId("T1:silent-failure-hunter-1"), agent: "silent-failure-hunter" })];
  const IDS = FINDINGS.map((f) => f.id);

  interface RawManifest {
    run_id: string;
    brief_file: string;
    brief_json: string;
    lenses: string[];
    findings: { id: string; filename: string; path: string }[];
  }
  const valid = (): RawManifest =>
    JSON.parse(serializeReviewManifest("run.abc", RUN_DIR, REVIEW_LAYOUT, LENSES, FINDINGS));

  it("accepts the manifest this module serializes", () => {
    const parsed = parseReviewManifest(valid(), RUN_DIR, REVIEW_LAYOUT, LENSES, IDS);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.findings.map((f) => f.id)).toEqual(IDS);
  });

  it.each<[string, (m: RawManifest) => void]>([
    ["a wrong run id", (m) => { m.run_id = "run.other"; }],
    ["a brief path outside the run dir", (m) => { m.brief_json = "/etc/passwd"; }],
    ["a wrong lens count", (m) => { m.lenses = ["reproduction"]; }],
    ["an unknown lens", (m) => { m.lenses = ["reproduction", "vibes"]; }],
    ["reordered lenses", (m) => { m.lenses = ["intent", "reproduction"]; }],
    ["a foreign finding", (m) => { m.findings[0]!.id = "T9:x-1"; }],
    ["a finding path outside the item dir", (m) => { m.findings[0]!.path = "/tmp/evil.json"; }],
    ["a filename that does not match its id", (m) => { m.findings[0]!.filename = "other.json"; }],
    ["a dropped finding", (m) => { m.findings.pop(); }],
  ])("rejects %s", (_label, mutate) => {
    const raw = valid();
    mutate(raw);
    expect(parseReviewManifest(raw, RUN_DIR, REVIEW_LAYOUT, LENSES, IDS).ok).toBe(false);
  });
});

describe("parseRefutationVerdict — the kernel envelope, a different payload", () => {
  const IDS = [waveId("T1:code-reviewer-1"), waveId("T1:silent-failure-hunter-1")];
  const raw = (over: Record<string, unknown> = {}) => JSON.stringify({
    criterion: "reproduction",
    verdicts: [
      { finding_id: IDS[0], verdict: "refuted", reasoning: "the guard three lines up excludes the null" },
      { finding_id: IDS[1], verdict: "upheld", reasoning: "the catch really does swallow it" },
    ],
    ...over,
  });

  it("accepts a well-formed verdict and sanitizes reasoning", () => {
    const parsed = parseRefutationVerdict(
      JSON.stringify({
        criterion: "reproduction",
        verdicts: IDS.map((id) => ({ finding_id: id, verdict: "uncertain", reasoning: "the {guard} is unclear" })),
      }),
      "reproduction",
      IDS,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.entries[0]!.reasoning).toBe("the guard is unclear");
    expect(serializeRefutationVerdict(parsed.value)).not.toContain("{guard}");
  });

  it.each([
    ["malformed JSON", "not json"],
    ["a non-object", "[]"],
    ["a lens mismatch", raw({ criterion: "intent" })],
    ["a missing finding", JSON.stringify({ criterion: "reproduction", verdicts: JSON.parse(raw()).verdicts.slice(0, 1) })],
    ["a duplicate finding", JSON.stringify({ criterion: "reproduction", verdicts: [JSON.parse(raw()).verdicts[0], JSON.parse(raw()).verdicts[0]] })],
    ["a foreign finding", raw({ verdicts: [{ ...JSON.parse(raw()).verdicts[0], finding_id: "T9:x-1" }, JSON.parse(raw()).verdicts[1]] })],
    ["an unknown verdict word", raw({ verdicts: [{ ...JSON.parse(raw()).verdicts[0], verdict: "maybe" }, JSON.parse(raw()).verdicts[1]] })],
    ["empty reasoning", raw({ verdicts: [{ ...JSON.parse(raw()).verdicts[0], reasoning: "  " }, JSON.parse(raw()).verdicts[1]] })],
    ["brace-only reasoning", raw({ verdicts: [{ ...JSON.parse(raw()).verdicts[0], reasoning: "{}" }, JSON.parse(raw()).verdicts[1]] })],
    ["a non-array verdicts field", raw({ verdicts: {} })],
  ])("rejects %s", (_label, input) => {
    expect(parseRefutationVerdict(input, "reproduction", IDS).ok).toBe(false);
  });

  it("imposes NO ordering rule — findings have no meaningful order", () => {
    const reversed = JSON.stringify({
      criterion: "reproduction",
      verdicts: [...JSON.parse(raw()).verdicts].reverse(),
    });
    expect(parseRefutationVerdict(reversed, "reproduction", IDS).ok).toBe(true);
  });
});

describe("defaultRefutationThreshold", () => {
  it("is a strict majority of the panel", () => {
    expect(defaultRefutationThreshold(2)).toBe(2);
    expect(defaultRefutationThreshold(3)).toBe(2);
    expect(defaultRefutationThreshold(4)).toBe(3);
    expect(defaultRefutationThreshold(5)).toBe(3);
  });
});

describe("tallyRefutations", () => {
  const F1 = brief();
  const F2 = brief({ id: waveId("T1:silent-failure-hunter-1"), agent: "silent-failure-hunter", claim: "swallowed error" });
  const FINDINGS = [F1, F2];
  const LENSES: readonly ReviewLens[] = ["reproduction", "intent", "security"];

  const tally = (
    votes: Record<string, readonly ["refuted" | "upheld" | "uncertain", "refuted" | "upheld" | "uncertain"]>,
    threshold = 2,
  ) =>
    tallyRefutations(
      LENSES.map((lens) => envelope(lens, [[F1.id, votes[lens]![0]], [F2.id, votes[lens]![1]]])),
      LENSES,
      FINDINGS,
      threshold,
    );

  it("kills a finding on unanimous refutation", () => {
    const result = tally({
      reproduction: ["refuted", "upheld"],
      intent: ["refuted", "upheld"],
      security: ["refuted", "upheld"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.survives).toBe(false);
    expect(result.value[0]!.refutations.map((r) => r.lens)).toEqual(LENSES);
    expect(result.value[0]!.refutations).toHaveLength(3);
    expect(result.value[1]!.survives).toBe(true);
  });

  it("keeps a finding on unanimous upholding", () => {
    const result = tally({
      reproduction: ["upheld", "upheld"],
      intent: ["upheld", "upheld"],
      security: ["upheld", "upheld"],
    });
    expect(result.ok && result.value.every((outcome) => outcome.survives)).toBe(true);
  });

  it("kills at exactly the threshold", () => {
    const result = tally({
      reproduction: ["refuted", "upheld"],
      intent: ["refuted", "upheld"],
      security: ["upheld", "upheld"],
    });
    expect(result.ok && result.value[0]!.survives).toBe(false);
  });

  it("keeps at one below the threshold", () => {
    const result = tally({
      reproduction: ["refuted", "upheld"],
      intent: ["upheld", "upheld"],
      security: ["upheld", "upheld"],
    });
    expect(result.ok && result.value[0]!.survives).toBe(true);
  });

  it("keeps a finding an all-uncertain panel could not judge", () => {
    const result = tally({
      reproduction: ["uncertain", "uncertain"],
      intent: ["uncertain", "uncertain"],
      security: ["uncertain", "uncertain"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.every((outcome) => outcome.survives)).toBe(true);
    expect(result.value[0]!.uncertainFrom).toEqual(LENSES);
  });

  it("uncertain counts toward neither side — a tie favors keeping the finding", () => {
    // 1 refuted, 1 upheld, 1 uncertain, threshold 2: no majority refuted.
    const result = tally({
      reproduction: ["refuted", "upheld"],
      intent: ["upheld", "upheld"],
      security: ["uncertain", "upheld"],
    });
    expect(result.ok && result.value[0]!.survives).toBe(true);
    expect(result.ok && result.value[0]!.refutations.map((r) => r.lens)).toEqual(["reproduction"]);
  });

  it("orders the refutations by lens order, each paired with its own reason", () => {
    const result = tally({
      reproduction: ["upheld", "upheld"],
      intent: ["refuted", "upheld"],
      security: ["refuted", "upheld"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.refutations.map((r) => r.lens)).toEqual(["intent", "security"]);
    expect(result.value[0]!.refutations.map((r) => r.reason)).toEqual(["intent says refuted", "security says refuted"]);
  });

  it("rejects a duplicated or missing verifier", () => {
    const one = envelope("reproduction", [[F1.id, "refuted"], [F2.id, "upheld"]]);
    expect(tallyRefutations([one, one, one], LENSES, FINDINGS, 2).ok).toBe(false);
    expect(tallyRefutations([one], LENSES, FINDINGS, 2).ok).toBe(false);
  });

  it("rejects a verdict that does not cover every finding exactly once", () => {
    const partial = envelope("reproduction", [[F1.id, "refuted"]]);
    const rest = (["intent", "security"] as ReviewLens[]).map((lens) => envelope(lens, [[F1.id, "upheld"], [F2.id, "upheld"]]));
    expect(tallyRefutations([partial, ...rest], LENSES, FINDINGS, 2).ok).toBe(false);
  });

  it("rejects a threshold outside 1..lensCount", () => {
    for (const threshold of [0, 4, 2.5]) {
      expect(tally({ reproduction: ["upheld", "upheld"], intent: ["upheld", "upheld"], security: ["upheld", "upheld"] }, threshold).ok).toBe(false);
    }
  });

  it("serializes a tally the gate can read", () => {
    const result = tally({
      reproduction: ["refuted", "upheld"],
      intent: ["refuted", "upheld"],
      security: ["refuted", "upheld"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.parse(serializeOutcomes(result.value, LENSES, 2));
    expect(json).toMatchObject({ lenses: LENSES, threshold: 2, surviving: 1, refuted: 1 });
    expect(json.outcomes[0].refuted_by).toEqual(LENSES);
  });
});

describe("applyFindingOutcomes", () => {
  const critical = finding({ id: "code-reviewer-1", claim: "unchecked cast" });
  const survivor = finding({ id: "silent-failure-hunter-1", agent: "silent-failure-hunter", claim: "swallowed error" });
  const advisory = finding({ id: "code-reviewer-2", severity: "advisory", claim: "nit" });

  const blocked = task({
    review_status: "blocked",
    findings: [critical, advisory, survivor],
    critical_findings: ["unchecked cast", "swallowed error"],
    advisory_findings: ["nit"],
  });

  // Returns the union arm that matches `survives`, because FindingOutcome is a
  // union: a refuted outcome carries a NON-EMPTY refutations tuple by type, so
  // a helper producing `survives: boolean` beside a possibly-empty array no
  // longer type-checks — which is the whole point of the change.
  const outcome = (f: Finding, survives: boolean): FindingOutcome => {
    const votes = {
      finding: brief({ id: waveFindingId("T1", f), claim: f.claim, agent: f.agent, severity: f.severity }),
      uncertainFrom: [] as ReviewLens[],
    };
    return survives
      ? { ...votes, survives: true, refutations: [], upheldBy: ["reproduction", "intent"] as ReviewLens[] }
      : {
          ...votes,
          survives: false,
          refutations: [{ lens: "reproduction", reason: "cannot trigger" }, { lens: "intent", reason: "deliberate" }],
          upheldBy: [] as ReviewLens[],
        };
  };

  it("is a no-op when nothing was refuted", () => {
    const result = applyFindingOutcomes(blocked, [outcome(critical, true), outcome(survivor, true)]);
    expect(result).toBe(blocked);
  });

  it("moves a refuted finding into refuted_findings, keeping views in lockstep", () => {
    const result = applyFindingOutcomes(blocked, [outcome(critical, false), outcome(survivor, true)]);
    expect(result.findings?.map((f) => f.id)).toEqual(["code-reviewer-2", "silent-failure-hunter-1"]);
    expect(result.critical_findings).toEqual(["swallowed error"]);
    expect(result.advisory_findings).toEqual(["nit"]);
    expect(result.refuted_findings).toEqual([
      { finding: critical, refutations: [{ lens: "reproduction", reason: "cannot trigger" }, { lens: "intent", reason: "deliberate" }] },
    ]);
    expect(result.critical_findings).toEqual(claimsOfSeverity(result.findings ?? [], "critical"));
    expect(result.advisory_findings).toEqual(claimsOfSeverity(result.findings ?? [], "advisory"));
  });

  it("demotes blocked to passed only when every critical was refuted", () => {
    const half = applyFindingOutcomes(blocked, [outcome(critical, false), outcome(survivor, true)]);
    expect(half.review_status).toBe("blocked");
    const all = applyFindingOutcomes(blocked, [outcome(critical, false), outcome(survivor, false)]);
    expect(all.review_status).toBe("passed");
    expect(all.critical_findings).toEqual([]);
  });

  it("never promotes evidence_capture_failed", () => {
    const broken = { ...blocked, review_status: "evidence_capture_failed" as const };
    const result = applyFindingOutcomes(broken, [outcome(critical, false), outcome(survivor, false)]);
    expect(result.review_status).toBe("evidence_capture_failed");
  });

  it("removes only ONE occurrence when two reviewers reported the same wording", () => {
    // A set-difference here would delete a finding nobody refuted.
    const twin = finding({ id: "comment-analyzer-1", agent: "comment-analyzer", claim: "unchecked cast" });
    const duplicated = task({
      review_status: "blocked",
      findings: [critical, twin],
      critical_findings: ["unchecked cast", "unchecked cast"],
    });
    const result = applyFindingOutcomes(duplicated, [outcome(critical, false)]);
    expect(result.critical_findings).toEqual(["unchecked cast"]);
    expect(result.findings?.map((f) => f.id)).toEqual(["comment-analyzer-1"]);
  });

  it("ignores outcomes belonging to another task", () => {
    const other = { ...outcome(critical, false), finding: brief({ id: waveId("T2:code-reviewer-1"), taskId: "T2" }) };
    expect(applyFindingOutcomes(blocked, [other])).toBe(blocked);
  });
});

describe("the brief's severity policy is enforced by its own re-parser", () => {
  const validCriticalBrief = () => JSON.parse(serializeFindingBrief({
    wave: 1,
    severity: "critical",
    taskIds: ["T1"],
    findings: [brief()],
  }));

  it("rejects an entry whose severity disagrees with the brief's", () => {
    // VERIFIED_SEVERITY is policy: advisories skip the panel because refuting
    // one saves nothing and the agent quota it burns is real. The brief filters
    // on it; without this check the re-parse that exists to stop the disk and
    // the panel diverging would wave through the one divergence that matters,
    // and a refuted advisory would be stripped from advisory_findings.
    const raw = validCriticalBrief();
    raw.findings[0].severity = "advisory";
    const parsed = parseFindingBriefJson(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain("must equal brief.severity");
  });

  it("accepts an advisory entry in a brief that declares advisory", () => {
    const raw = validCriticalBrief();
    raw.severity = "advisory";
    raw.findings[0].severity = "advisory";
    expect(parseFindingBriefJson(raw).ok).toBe(true);
  });
});

describe("tallyRefutations invariants", () => {
  const F1 = brief();
  const F2 = brief({ id: waveId("T1:silent-failure-hunter-1"), agent: "silent-failure-hunter", claim: "swallowed" });
  const PANEL: readonly ReviewLens[] = ["reproduction", "intent", "security"];
  const VOTE = fc.constantFrom<"refuted" | "upheld" | "uncertain">("refuted", "upheld", "uncertain");

  const run = (matrix: readonly (readonly ["refuted" | "upheld" | "uncertain", "refuted" | "upheld" | "uncertain"])[], threshold: number) =>
    tallyRefutations(
      PANEL.map((lens, index) => envelope(lens, [[F1.id, matrix[index]![0]], [F2.id, matrix[index]![1]]])),
      PANEL,
      [F1, F2],
      threshold,
    );

  const matrixArb = fc.array(fc.tuple(VOTE, VOTE), { minLength: 3, maxLength: 3 });

  it("partitions every lens into exactly one bucket per finding", () => {
    fc.assert(
      fc.property(matrixArb, fc.integer({ min: 1, max: 3 }), (matrix, threshold) => {
        const result = run(matrix, threshold);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        for (const outcome of result.value) {
          expect(
            outcome.refutations.length + outcome.upheldBy.length + outcome.uncertainFrom.length,
          ).toBe(PANEL.length);
          // Every refutation carries its own reason — the pair shape makes the
          // old parallel-array misalignment unrepresentable, and this proves
          // the tally never produces a lens with no reason attached.
          expect(outcome.refutations.every((r) => r.reason.length > 0)).toBe(true);
        }
      }),
    );
  });

  it("survives exactly when refutations fall short of the threshold", () => {
    fc.assert(
      fc.property(matrixArb, fc.integer({ min: 1, max: 3 }), (matrix, threshold) => {
        const result = run(matrix, threshold);
        expect(result.ok && result.value.every((o) => o.survives === o.refutations.length < threshold)).toBe(true);
      }),
    );
  });

  it("is monotone: flipping a vote to refuted can never resurrect a dead finding", () => {
    fc.assert(
      fc.property(matrixArb, fc.integer({ min: 0, max: 2 }), (matrix, flipAt) => {
        const before = run(matrix, 2);
        const harsher = matrix.map((row, index) =>
          index === flipAt ? (["refuted", row[1]] as const) : row,
        );
        const after = run(harsher, 2);
        expect(before.ok && after.ok).toBe(true);
        if (!before.ok || !after.ok) return;
        // A finding dead before must stay dead; nothing about a HARSHER panel
        // can bring it back.
        expect(before.value[0]!.survives || !after.value[0]!.survives).toBe(true);
      }),
    );
  });
});

describe("sanitized claims survive the brief → tally → apply round trip", () => {
  it("removes a brace-bearing critical by the claim actually stored on the task", () => {
    // buildFindingBrief sanitizes claims for prompt substitution while
    // applyFindingOutcomes removes by the STORED claim. Both halves are tested
    // in isolation; this is the composition, where a mismatch would either drop
    // the wrong entry or silently keep the refuted one.
    const stored = finding({ claim: "the {config} value is unchecked" });
    const blocked = task({
      review_status: "blocked",
      findings: [stored],
      critical_findings: ["the {config} value is unchecked"],
    });
    const built = buildFindingBrief(1, [blocked]);
    expect(built.findings[0]!.claim).toBe("the config value is unchecked");

    const result = applyFindingOutcomes(blocked, [{
      finding: built.findings[0]!,
      refutations: [{ lens: "intent", reason: "deliberate" }],
      survives: false,
    }]);
    expect(result.findings).toEqual([]);
    expect(result.critical_findings).toEqual([]);
    expect(result.review_status).toBe("passed");
    expect(result.refuted_findings?.[0]!.finding.claim).toBe("the {config} value is unchecked");
  });

  it("removes a critical whose claim sanitized to nothing at all", () => {
    const stored = finding({ claim: "{}" });
    const blocked = task({ review_status: "blocked", findings: [stored], critical_findings: ["{}"] });
    const built = buildFindingBrief(1, [blocked]);
    expect(built.findings[0]!.claim).toContain("unusable after sanitization");

    const result = applyFindingOutcomes(blocked, [{
      finding: built.findings[0]!,
      refutations: [{ lens: "intent", reason: "deliberate" }],
      survives: false,
    }]);
    expect(result.critical_findings).toEqual([]);
    expect(result.refuted_findings).toHaveLength(1);
  });
});
