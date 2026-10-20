/**
 * Ledger Epoch View (pure core): the query decision, one epoch's facts
 * numbered exactly as I6 settlement cites positions, and the session's epoch
 * index. Every record is built through the engine's own ledger-line parser, so
 * only shapes the ledger reader admits are ever rendered.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LEDGER_EPOCH_USAGE,
  parseLedgerEpochQuery,
  renderEpoch,
  renderEpochIndex,
  renderLedgerEpochView,
  type LedgerEpochArguments,
} from "../../src/core/ledger-epoch-view";
import { judgeRedThenGreen } from "../../src/core/red-then-green";
import { epochOf, eventsForEpoch, parseEvidenceLine } from "../../src/machine/evidence";
import type { Epoch, EvidenceRecord } from "../../src/machine/types";
import { agentIdOf, agentTypeOf, sessionIdOf } from "../fixtures/machine-identities";

// --- Fixtures, through the production parsers ---

/** One ledger line, parsed by the engine's own reader; a fixture that does not parse fails its test. */
function record(raw: Record<string, unknown>): EvidenceRecord {
  const parsed = parseEvidenceLine(JSON.stringify(raw));
  if (!parsed.ok) throw new Error(`fixture ledger line must parse: ${parsed.error}`);
  return parsed.value;
}

const IMPL = epochOf(agentIdOf("impl-1"), agentTypeOf("code-implementer-agent"));
const OTHER = epochOf(agentIdOf("impl-2"), agentTypeOf("code-implementer-agent"));
const REVIEW = epochOf(agentIdOf("rev-1"), agentTypeOf("code-reviewer"));

const write = (epoch: Epoch, path: string, via: "tool" | "shell", callId?: string) =>
  record({ epoch, event: { kind: "FileWrite", path, via }, ...(callId === undefined ? {} : { callId }) });
const read = (epoch: Epoch, path: string, callId?: string) =>
  record({ epoch, event: { kind: "FileRead", path }, ...(callId === undefined ? {} : { callId }) });
const testRun = (epoch: Epoch, command: string, exit: number | null, report: unknown, callId?: string) =>
  record({
    epoch,
    event: { kind: "TestRun", command, ...(exit === null ? {} : { exit }), ...(report === null ? {} : { report }) },
    ...(callId === undefined ? {} : { callId }),
  });

type FileFixture = Readonly<{ file: string; executed: number; failed: number; skipped: number; collectionError: boolean }>;
const recordedReport = (source: "junit-xml" | "vitest-json", results: readonly FileFixture[]) => ({
  source,
  total: results.reduce((sum, r) => sum + r.executed, 0),
  failed: results.reduce((sum, r) => sum + r.failed, 0),
  files: { kind: "recorded", results },
});

const args = (over: Partial<LedgerEpochArguments>): LedgerEpochArguments => ({
  session: null,
  agent: null,
  type: null,
  unconsumed: [],
  ...over,
});

const refusalOf = (raw: LedgerEpochArguments): string => {
  const result = parseLedgerEpochQuery(raw);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result.error;
};

// --- parseLedgerEpochQuery ---

describe("parseLedgerEpochQuery", () => {
  it("parses --session alone as the epoch index query", () => {
    expect(parseLedgerEpochQuery(args({ session: "s-1" }))).toEqual({
      ok: true,
      value: { kind: "index", session: sessionIdOf("s-1") },
    });
  });

  it("parses --session --agent --type as one epoch, built with epochOf", () => {
    expect(parseLedgerEpochQuery(args({ session: "s-1", agent: "impl-1", type: "code-implementer-agent" }))).toEqual({
      ok: true,
      value: { kind: "epoch", session: sessionIdOf("s-1"), epoch: IMPL },
    });
  });

  it("refuses unconsumed tokens, naming them", () => {
    const error = refusalOf(args({ session: "s-1", unconsumed: ["--bogus", "stray"] }));
    expect(error).toContain("--bogus");
    expect(error).toContain("stray");
  });

  it("refuses a missing --session", () => {
    expect(refusalOf(args({}))).toContain("--session");
    expect(refusalOf(args({ agent: "impl-1", type: "code-implementer-agent" }))).toContain("--session");
  });

  it("refuses --agent without --type and --type without --agent", () => {
    const agentOnly = refusalOf(args({ session: "s-1", agent: "impl-1" }));
    const typeOnly = refusalOf(args({ session: "s-1", type: "code-implementer-agent" }));
    for (const error of [agentOnly, typeOnly]) {
      expect(error).toContain("--agent");
      expect(error).toContain("--type");
    }
  });

  it.each([
    ["--session", args({ session: "../etc" })],
    ["--session", args({ session: "a/b" })],
    ["--agent", args({ session: "s-1", agent: "a:b", type: "t" })],
    ["--agent", args({ session: "s-1", agent: "..", type: "t" })],
    ["--type", args({ session: "s-1", agent: "a", type: "../t" })],
    ["--type", args({ session: "s-1", agent: "a", type: "t y" })],
  ])("refuses an unsafe id, naming the flag %s", (flag, raw) => {
    expect(refusalOf(raw)).toContain(flag);
  });

  it("exposes the usage text the shell prints", () => {
    expect(LEDGER_EPOCH_USAGE).toBe(
      "usage: bun scripts/ledger-epoch.ts --session <session-id> [--agent <agent-id> --type <agent-type>]",
    );
  });
});

// --- renderEpoch ---

describe("renderEpoch", () => {
  it("AS-001: lists exactly one epoch's facts in ledger order with the duplicate delivery dropped", () => {
    const records = [
      read(IMPL, "/repo/src/a.ts", "c1"),
      write(OTHER, "/repo/src/other.ts", "tool", "c2"),
      write(IMPL, "/repo/src/a.ts", "tool", "c3"),
      write(IMPL, "/repo/src/a.ts", "tool", "c3"), // duplicate delivery of c3
      read(REVIEW, "/repo/src/a.ts", "c4"),
      testRun(IMPL, "npx vitest run", 0, null, "c5"),
    ];
    expect(renderEpoch(records, IMPL)).toEqual([
      "epoch impl-1:code-implementer-agent — 3 fact(s)",
      "#0 FileRead /repo/src/a.ts",
      "#1 FileWrite /repo/src/a.ts (via tool)",
      "#2 TestRun npx vitest run",
      "    exit 0",
      "    no structured report",
    ]);
  });

  it("keeps records without a callId, even when identical", () => {
    const records = [read(IMPL, "/x"), read(IMPL, "/x")];
    expect(renderEpoch(records, IMPL)).toEqual([
      "epoch impl-1:code-implementer-agent — 2 fact(s)",
      "#0 FileRead /x",
      "#1 FileRead /x",
    ]);
  });

  it("AS-002: a file write shows its path and whether it came from a tool or the shell", () => {
    const lines = renderEpoch([write(IMPL, "/a", "tool"), write(IMPL, "/b", "shell")], IMPL);
    expect(lines.slice(1)).toEqual(["#0 FileWrite /a (via tool)", "#1 FileWrite /b (via shell)"]);
  });

  it("AS-002: a file read shows its path", () => {
    expect(renderEpoch([read(IMPL, "/r")], IMPL).slice(1)).toEqual(["#0 FileRead /r"]);
  });

  it("AS-002: a test run with no exit code and no report says both", () => {
    expect(renderEpoch([testRun(IMPL, "bun test", null, null)], IMPL).slice(1)).toEqual([
      "#0 TestRun bun test",
      "    exit none recorded",
      "    no structured report",
    ]);
  });

  it("AS-002: a report without per-file results says they were not recorded", () => {
    const lines = renderEpoch([testRun(IMPL, "bun test", 1, { source: "junit-xml", total: 4, failed: 1 })], IMPL);
    expect(lines.slice(1)).toEqual([
      "#0 TestRun bun test",
      "    exit 1",
      "    report junit-xml: total 4, failed 1",
      "      per-file results not recorded",
    ]);
  });

  it("AS-002: recorded per-file results list executed, failed, skipped and collection errors in report order", () => {
    const report = recordedReport("junit-xml", [
      { file: "tests/b.test.ts", executed: 3, failed: 1, skipped: 1, collectionError: false },
      { file: "tests/a.test.ts", executed: 1, failed: 1, skipped: 0, collectionError: true },
    ]);
    expect(renderEpoch([testRun(IMPL, "npx vitest run", 1, report)], IMPL).slice(1)).toEqual([
      "#0 TestRun npx vitest run",
      "    exit 1",
      "    report junit-xml: total 4, failed 2",
      "      tests/b.test.ts: executed 3, failed 1, skipped 1",
      "      tests/a.test.ts: executed 1, failed 1, skipped 0, collection error",
    ]);
  });

  it("AS-002: a recorded report with an empty results list says it holds no per-file results", () => {
    const report = recordedReport("vitest-json", []);
    expect(renderEpoch([testRun(IMPL, "npx vitest run", 0, report)], IMPL).slice(1)).toEqual([
      "#0 TestRun npx vitest run",
      "    exit 0",
      "    report vitest-json: total 0, failed 0",
      "      no per-file results",
    ]);
  });

  it("AS-005: an epoch with no facts is stated, not refused", () => {
    expect(renderEpoch([read(OTHER, "/x")], IMPL)).toEqual(["epoch impl-1:code-implementer-agent holds no facts"]);
    expect(renderEpoch([], IMPL)).toEqual(["epoch impl-1:code-implementer-agent holds no facts"]);
  });

  it("never prints a callId", () => {
    const lines = renderEpoch([read(IMPL, "/x", "toolu_secret_call")], IMPL);
    expect(lines.join("\n")).not.toContain("toolu_secret_call");
  });
});

// --- Settlement agreement (AS-001, SC-002) ---

describe("positions agree with I6 settlement", () => {
  it("AS-001: the #red, write and #green positions are the ones judgeRedThenGreen cites", () => {
    const repo = "/repo";
    const testFile = "tests/feature.test.ts";
    const red = recordedReport("junit-xml", [{ file: testFile, executed: 1, failed: 1, skipped: 0, collectionError: false }]);
    const green = recordedReport("junit-xml", [{ file: testFile, executed: 1, failed: 0, skipped: 0, collectionError: false }]);
    const records = [
      read(IMPL, `${repo}/src/feature.ts`, "r1"),
      write(OTHER, `${repo}/src/noise.ts`, "tool", "n1"),
      write(IMPL, `${repo}/${testFile}`, "tool", "w0"),
      testRun(IMPL, "npx vitest run red", 1, red, "t1"),
      testRun(IMPL, "npx vitest run red", 1, red, "t1"), // duplicate delivery
      testRun(OTHER, "npx vitest run noise", 0, green, "n2"),
      write(IMPL, `${repo}/src/feature.ts`, "tool", "w1"),
      testRun(IMPL, "npx vitest run green", 0, green, "t2"),
    ];
    const events = eventsForEpoch(records, IMPL);
    const verdict = judgeRedThenGreen(
      events,
      { testFiles: [testFile], implementationFiles: ["src/feature.ts"], createdImplementationFiles: [] },
      repo,
      false,
    );
    if (verdict.kind !== "shown") throw new Error(`fixture epoch must prove I6: ${JSON.stringify(verdict)}`);

    const lines = renderEpoch(records, IMPL);
    expect(lines).toContain(`#${verdict.red.index} TestRun ${verdict.red.command}`);
    expect(lines).toContain(`#${verdict.green.index} TestRun ${verdict.green.command}`);

    const writePosition = lines
      .map((line) => /^#(\d+) FileWrite (.*) \(via (tool|shell)\)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .filter((m) => m[2].endsWith(verdict.implementationWrite))
      .map((m) => Number(m[1]))
      .find((position) => position > verdict.red.index);
    expect(writePosition).toBeDefined();
    expect(writePosition!).toBeGreaterThan(verdict.red.index);
    expect(writePosition!).toBeLessThan(verdict.green.index);
    expect([verdict.red.index, writePosition, verdict.green.index]).toEqual([2, 3, 4]);
  });
});

// --- renderEpochIndex ---

describe("renderEpochIndex", () => {
  it("AS-003: lists every epoch in first-appearance order with its fact count after duplicates are dropped", () => {
    const records = [
      read(REVIEW, "/a", "c1"),
      write(IMPL, "/b", "tool", "c2"),
      write(IMPL, "/b", "tool", "c2"), // duplicate delivery
      read(REVIEW, "/a", "c3"),
      read(OTHER, "/c"),
      read(OTHER, "/c"), // no callId: never deduplicated
    ];
    expect(renderEpochIndex(records)).toEqual([
      "3 epoch(s)",
      "rev-1:code-reviewer — 2 fact(s)",
      "impl-1:code-implementer-agent — 1 fact(s)",
      "impl-2:code-implementer-agent — 2 fact(s)",
    ]);
  });

  it("states a ledger that holds no records", () => {
    expect(renderEpochIndex([])).toEqual(["ledger holds no epochs"]);
  });
});

// --- renderLedgerEpochView ---

describe("renderLedgerEpochView", () => {
  const records = [read(IMPL, "/a"), read(OTHER, "/b")];
  const session = sessionIdOf("s-1");

  it("renders one epoch for an epoch query", () => {
    expect(renderLedgerEpochView(records, { kind: "epoch", session, epoch: IMPL })).toEqual(renderEpoch(records, IMPL));
  });

  it("renders the epoch index for an index query", () => {
    expect(renderLedgerEpochView(records, { kind: "index", session })).toEqual(renderEpochIndex(records));
  });
});

// --- Properties over admitted records (FR-005) ---

const EPOCH_POOL = [IMPL, OTHER, REVIEW] as const;

const fileResultArb = fc
  .record({
    executed: fc.nat(6),
    failedShare: fc.nat(6),
    skippedShare: fc.nat(6),
    collectionError: fc.boolean(),
  })
  .map(({ executed, failedShare, skippedShare, collectionError }) => {
    const failed = Math.min(failedShare, executed);
    const skipped = Math.min(skippedShare, executed - failed);
    return { executed, failed, skipped, collectionError };
  });

const reportArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.record({ source: fc.constantFrom("junit-xml", "vitest-json"), total: fc.nat(10), failedShare: fc.nat(10) })
    .map(({ source, total, failedShare }) => ({ source, total, failed: Math.min(total, failedShare) })),
  fc.record({
    source: fc.constantFrom("junit-xml" as const, "vitest-json" as const),
    files: fc.uniqueArray(
      fc.tuple(fc.string({ minLength: 1 }).filter((file) => file.trim() !== ""), fileResultArb),
      { selector: ([file]) => file, maxLength: 4 },
    ),
  }).map(({ source, files }) =>
    // A collection error only where its format can report one, so the parser admits the report.
    recordedReport(source, files.map(([file, r]) => ({
      file,
      ...r,
      collectionError: r.collectionError && (source === "junit-xml" ? r.failed > 0 : r.executed === 0),
    })))),
  fc.anything(), // malformed reports: the parser reads them as no report
);

const rawRecordArb = fc.record({
  epoch: fc.constantFrom(...EPOCH_POOL),
  callId: fc.option(fc.constantFrom("c1", "c2", "c3"), { nil: undefined }),
  event: fc.oneof(
    fc.record({ kind: fc.constant("FileRead"), path: fc.string({ minLength: 1 }) }),
    fc.record({ kind: fc.constant("FileWrite"), path: fc.string({ minLength: 1 }), via: fc.constantFrom("tool", "shell", "other") }),
    fc.record({ kind: fc.constant("TestRun"), command: fc.string(), exit: fc.option(fc.integer(), { nil: undefined }), report: reportArb }),
  ),
});

/** Records round-tripped through the engine's ledger-line parser: only admitted shapes survive. */
const admittedRecordsArb: fc.Arbitrary<readonly EvidenceRecord[]> = fc.array(rawRecordArb, { maxLength: 30 }).map((raws) =>
  raws
    .map((raw) => parseEvidenceLine(JSON.stringify(raw)))
    .flatMap((parsed) => (parsed.ok ? [parsed.value] : [])),
);

const FACT_LINE = /^#(\d+) /;

describe("properties over admitted records", () => {
  it("rendering is total: it never throws, for either query kind", () => {
    fc.assert(
      fc.property(admittedRecordsArb, fc.constantFrom(...EPOCH_POOL), (records, epoch) => {
        const session = sessionIdOf("s-1");
        renderLedgerEpochView(records, { kind: "epoch", session, epoch });
        renderLedgerEpochView(records, { kind: "index", session });
      }),
    );
  });

  it("the epoch view has one fact line per folded event, and line k begins '#k '", () => {
    fc.assert(
      fc.property(admittedRecordsArb, fc.constantFrom(...EPOCH_POOL), (records, epoch) => {
        const factLines = renderEpoch(records, epoch).filter((line) => FACT_LINE.test(line));
        expect(factLines).toHaveLength(eventsForEpoch(records, epoch).length);
        factLines.forEach((line, k) => expect(line.startsWith(`#${k} `)).toBe(true));
      }),
    );
  });

  it("the index lists epochs in first-appearance order with counts that sum to the folded total", () => {
    fc.assert(
      fc.property(admittedRecordsArb, (records) => {
        const lines = renderEpochIndex(records);
        const firstAppearance = [...new Set(records.map((r) => r.epoch))];
        if (firstAppearance.length === 0) {
          expect(lines).toEqual(["ledger holds no epochs"]);
          return;
        }
        expect(lines[0]).toBe(`${firstAppearance.length} epoch(s)`);
        const rows = lines.slice(1).map((line) => /^(.*) — (\d+) fact\(s\)$/.exec(line));
        expect(rows.map((m) => m?.[1])).toEqual(firstAppearance);
        const total = rows.reduce((sum, m) => sum + Number(m?.[2]), 0);
        expect(total).toBe(firstAppearance.reduce((sum, e) => sum + eventsForEpoch(records, e).length, 0));
      }),
    );
  });
});
