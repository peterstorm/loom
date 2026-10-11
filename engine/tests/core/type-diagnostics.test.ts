import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  NO_ADVISORY,
  REPEAT_THRESHOLDS,
  REPEAT_WINDOW_MS,
  isTypeScriptSource,
  judgeTypeCheck,
  outcomeOfTscExit,
  parseTscOutput,
  parseTypeCheckMemory,
  remedyFor,
  type TypeCheckJudgement,
  type TypeCheckMemory,
  type TypeCheckOutcome,
  type TypeDiagnostic,
} from "../../src/core/type-diagnostics";

const PROJECT = "/repo/app";
const TOUCHED = "/repo/app/src/order.ts";
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

const diagnostic = (overrides: Partial<TypeDiagnostic> = {}): TypeDiagnostic => ({
  file: TOUCHED,
  line: 12,
  column: 5,
  code: 2322,
  message: "Type 'string' is not assignable to type 'number'.",
  ...overrides,
});

const completed = (diagnostics: readonly TypeDiagnostic[]): TypeCheckOutcome => ({ kind: "completed", diagnostics, global: [] });

/** The memory a judgement leaves behind, given the memory it was judged against. */
const memoryAfter = (judged: TypeCheckJudgement, before: TypeCheckMemory | null): TypeCheckMemory | null =>
  judged.memoryUpdate.kind === "replace" ? judged.memoryUpdate.memory : before;

/** Run the judge over a sequence of outcomes, threading memory like the shell does, `stepMs` apart. */
function judgeSequence(outcomes: readonly TypeCheckOutcome[], initial: TypeCheckMemory | null = null, stepMs = MINUTE) {
  let memory = initial;
  return outcomes.map((outcome, i) => {
    const judged = judgeTypeCheck({ touchedFile: TOUCHED, projectDir: PROJECT, outcome, memory, now: T0 + i * stepMs });
    memory = memoryAfter(judged, memory);
    return { ...judged, memory };
  });
}

describe("isTypeScriptSource", () => {
  it.each(["a.ts", "a.tsx", "a.mts", "a.cts", "/x/y/z.ts"])("accepts %s", (path) => {
    expect(isTypeScriptSource(path)).toBe(true);
  });

  it.each(["a.d.ts", "a.d.mts", "a.js", "a.json", "a.md", "ts", "a.ts.bak"])("rejects %s", (path) => {
    expect(isTypeScriptSource(path)).toBe(false);
  });
});

describe("parseTscOutput", () => {
  it("parses located diagnostics relative to the project directory", () => {
    const output = [
      "src/order.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/lib/price.ts(3,10): error TS2307: Cannot find module './tax' or its corresponding type declarations.",
    ].join("\n");
    expect(parseTscOutput(output, PROJECT)).toEqual({
      located: [
        diagnostic(),
        diagnostic({ file: "/repo/app/src/lib/price.ts", line: 3, column: 10, code: 2307, message: "Cannot find module './tax' or its corresponding type declarations." }),
      ],
      global: [],
    });
  });

  it("folds indented continuation lines into the preceding message", () => {
    const output = [
      "src/order.ts(4,7): error TS2741: Property 'id' is missing in type '{}' but required in type 'Order'.",
      "  src/types.ts(2,3): 'id' is declared here.",
    ].join("\n");
    expect(parseTscOutput(output, PROJECT).located).toEqual([
      diagnostic({ line: 4, column: 7, code: 2741, message: "Property 'id' is missing in type '{}' but required in type 'Order'.\n  src/types.ts(2,3): 'id' is declared here." }),
    ]);
  });

  it("keeps project-level errors apart from located ones", () => {
    const output = "error TS5023: Unknown compiler option 'bogus'.\r\nsrc/order.ts(1,1): error TS1005: ';' expected.\r\n";
    const parsed = parseTscOutput(output, PROJECT);
    expect(parsed.global).toEqual([{ code: 5023, message: "Unknown compiler option 'bogus'." }]);
    expect(parsed.located).toEqual([diagnostic({ line: 1, column: 1, code: 1005, message: "';' expected." })]);
  });

  it("resolves absolute paths as-is and ignores noise lines", () => {
    const output = "Version 5.9.3\n/elsewhere/x.ts(2,2): error TS2304: Cannot find name 'y'.\n\n";
    expect(parseTscOutput(output, PROJECT).located).toEqual([
      diagnostic({ file: "/elsewhere/x.ts", line: 2, column: 2, code: 2304, message: "Cannot find name 'y'." }),
    ]);
  });

  it("never throws and returns only well-formed diagnostics for arbitrary output", () => {
    fc.assert(fc.property(fc.string({ maxLength: 400 }), (output) => {
      const parsed = parseTscOutput(output, PROJECT);
      for (const d of parsed.located) {
        expect(d.file.startsWith("/")).toBe(true);
        expect(Number.isInteger(d.line) && d.line > 0).toBe(true);
        expect(Number.isInteger(d.column) && d.column > 0).toBe(true);
        expect(Number.isInteger(d.code)).toBe(true);
      }
    }));
  });
});

describe("outcomeOfTscExit", () => {
  const located = "src/order.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";

  it("a clean exit is a completed, clean program", () => {
    expect(outcomeOfTscExit({ code: 0, signal: null }, "", PROJECT)).toEqual(completed([]));
  });

  it.each<[number]>([[1], [2]])("exit %s with diagnostics is a completed run", (code) => {
    expect(outcomeOfTscExit({ code, signal: null }, located, PROJECT)).toEqual(completed([diagnostic()]));
  });

  it("a project-level error alone still counts as diagnostics", () => {
    expect(outcomeOfTscExit({ code: 1, signal: null }, "error TS5023: Unknown compiler option 'bogus'.\n", PROJECT))
      .toEqual({ kind: "completed", diagnostics: [], global: [{ code: 5023, message: "Unknown compiler option 'bogus'." }] });
  });

  it.each<[number, string, RegExp]>([
    [1, "TypeError: Cannot read properties of undefined\n    at main (tsc.js:1:1)\n", /^tsc exited with 1 without diagnostics: TypeError: Cannot read properties of undefined$/],
    [2, "", /^tsc exited with 2 without diagnostics$/],
  ])("a nonzero exit %s with nothing parseable is a failure, never a clean program", (code, output, reason) => {
    const outcome = outcomeOfTscExit({ code, signal: null }, output, PROJECT);
    expect(outcome).toEqual({ kind: "failed", reason: expect.stringMatching(reason) });
  });

  it.each<[number | null, string | null, string]>([
    [7, null, "tsc exited with 7: boom"],
    [null, "SIGKILL", "tsc exited with SIGKILL: boom"],
  ])("any other exit (%s, %s) is a failure carrying the first output line", (code, signal, reason) => {
    expect(outcomeOfTscExit({ code, signal }, "\nboom\nmore\n", PROJECT)).toEqual({ kind: "failed", reason });
  });
});

describe("remedyFor", () => {
  it.each([2307, 2304, 2305, 2724, 2339, 2322, 2345, 2532, 18048, 2531, 18047, 7006, 2366, 7030, 2741, 6133, 2554])(
    "TS%s carries a remedy",
    (code) => {
      expect(remedyFor(code)).toMatch(/\S/);
    },
  );

  it.each<[number, number]>([[2305, 2724], [2532, 18048], [2531, 18047], [2366, 7030]])(
    "TS%s and TS%s share one remedy",
    (a, b) => {
      expect(remedyFor(a)).toBe(remedyFor(b));
    },
  );

  it("offers no remedy for codes it does not know", () => {
    expect(remedyFor(9999)).toBeUndefined();
  });

  it("never tells the model to cast its way out", () => {
    expect(remedyFor(2322)).toMatch(/not .*`as`|never .*`as`|without .*`as`/i);
  });
});

describe("judgeTypeCheck — the touched file", () => {
  it("says nothing when the project typechecks", () => {
    const [judged] = judgeSequence([completed([])]);
    expect(judged!.advisory).toEqual(NO_ADVISORY);
  });

  it("names the touched file's diagnostics with their remedies, as advisory", () => {
    const [judged] = judgeSequence([completed([diagnostic()])]);
    const text = judged!.advisory.forModel!;
    expect(text).toContain("advisory");
    expect(text).toContain("src/order.ts");
    expect(text).toContain("12:5 TS2322 Type 'string' is not assignable to type 'number'.");
    expect(text).toContain(remedyFor(2322)!);
  });

  it("caps the listed diagnostics and counts the rest", () => {
    const many = Array.from({ length: 12 }, (_, i) => diagnostic({ line: i + 1 }));
    const text = judgeSequence([completed(many)])[0]!.advisory.forModel!;
    expect(text.match(/TS2322/g)!.length).toBe(8);
    expect(text).toContain("4 more in this file");
  });
});

describe("judgeTypeCheck — other files", () => {
  const caller = diagnostic({ file: "/repo/app/src/checkout.ts", line: 4, column: 1, code: 2554, message: "Expected 2 arguments, but got 1." });
  const legacy = diagnostic({ file: "/repo/app/src/legacy.ts", code: 2339, message: "Property 'x' does not exist on type 'Y'." });

  it("does not report errors elsewhere on the first run: there is no baseline to blame this edit", () => {
    const [judged] = judgeSequence([completed([legacy])]);
    expect(judged!.advisory.forModel).toBeNull();
  });

  it("reports only errors in other files that this edit introduced", () => {
    const [, second] = judgeSequence([completed([legacy]), completed([legacy, caller])]);
    const text = second!.advisory.forModel!;
    expect(text).toContain("src/checkout.ts");
    expect(text).toContain("TS2554");
    expect(text).not.toContain("legacy.ts");
  });

  it("does not re-report a caller error once it is part of the baseline", () => {
    const [, , third] = judgeSequence([completed([]), completed([caller]), completed([caller])]);
    expect(third!.advisory.forModel).toBeNull();
  });

  it("treats a moved line as the same diagnostic", () => {
    const [, second] = judgeSequence([completed([legacy]), completed([{ ...legacy, line: 40 }])]);
    expect(second!.advisory.forModel).toBeNull();
  });

  it("counts a second identical diagnostic on another line as introduced", () => {
    const [, second] = judgeSequence([completed([caller]), completed([caller, { ...caller, line: 9 }])]);
    const text = second!.advisory.forModel!;
    expect(text).toContain("introduced 1 error(s)");
    expect(text).toMatch(/\d+:1 TS2554/);
  });

  it("does not blame this edit on a baseline older than the window", () => {
    const [, second] = judgeSequence([completed([]), completed([caller])], null, REPEAT_WINDOW_MS + 1);
    expect(second!.advisory.forModel).toBeNull();
  });
});

describe("judgeTypeCheck — repeat reminder", () => {
  it("escalates at each threshold while the same diagnostics survive consecutive edits", () => {
    const runs = judgeSequence(Array.from({ length: 9 }, () => completed([diagnostic()])));
    const reminders = runs.map((r) => r.advisory.forModel!.match(/survived (\d+) consecutive edits/)?.[1] ?? null);
    expect(reminders).toEqual([null, null, "3", "4", "5", "6", "7", "8", "9"]);
    expect(runs[4]!.advisory.forModel).toContain("change approach");
    expect(runs[7]!.advisory.forModel).toContain("Stop editing this file");
    expect(REPEAT_THRESHOLDS).toEqual([3, 5, 8]);
  });

  it("resets when the diagnostics change, and when the file typechecks", () => {
    const other = diagnostic({ code: 2304, message: "Cannot find name 'q'." });
    const runs = judgeSequence([
      completed([diagnostic()]), completed([diagnostic()]), completed([other]),
      completed([other]), completed([]), completed([other]),
    ]);
    expect(runs.map((r) => /survived/.test(r.advisory.forModel ?? ""))).toEqual([false, false, false, false, false, false]);
  });

  it("restarts the count after a gap longer than the window: another session's edits are not this one's", () => {
    const runs = judgeSequence(Array.from({ length: 3 }, () => completed([diagnostic()])), null, REPEAT_WINDOW_MS + 1);
    expect(runs.map((r) => r.memory!.repeats[TOUCHED]!.consecutive)).toEqual([1, 1, 1]);
  });

  it("treats a duplicated diagnostic as a change, not a repeat", () => {
    const runs = judgeSequence([completed([diagnostic()]), completed([diagnostic(), diagnostic({ line: 30 })])]);
    expect(runs[1]!.memory!.repeats[TOUCHED]!.consecutive).toBe(1);
  });

  it("forgets other files' repeat records once they fall out of the window", () => {
    const stale: TypeCheckMemory = {
      recordedAt: T0,
      diagnosticKeys: [],
      repeats: { "/repo/app/src/old.ts": { fingerprint: "f", consecutive: 4, at: T0 - REPEAT_WINDOW_MS - 1 } },
    };
    const [judged] = judgeSequence([completed([])], stale);
    expect(judged!.memory!.repeats).toEqual({});
  });

  it("counts consecutive identical diagnostic sets regardless of order or line movement", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ line: fc.integer({ min: 1, max: 500 }), code: fc.constantFrom(2322, 2304, 2339) }), { minLength: 1, maxLength: 5 }),
      fc.integer({ min: 1, max: 10 }),
      (shapes, runs) => {
        const base = shapes.map((s) => diagnostic({ line: s.line, code: s.code, message: `m${s.code}` }));
        const outcomes = Array.from({ length: runs }, (_, i) =>
          completed((i % 2 === 0 ? base : [...base].reverse()).map((d) => ({ ...d, line: d.line + i }))));
        const last = judgeSequence(outcomes).at(-1)!;
        expect(last.memory!.repeats[TOUCHED]!.consecutive).toBe(runs);
      },
    ));
  });
});

describe("judgeTypeCheck — runs that did not complete", () => {
  const memory: TypeCheckMemory = { recordedAt: T0, diagnosticKeys: ["k"], repeats: { [TOUCHED]: { fingerprint: "f", consecutive: 2, at: T0 } } };

  it.each<[TypeCheckOutcome, RegExp | null]>([
    [{ kind: "unavailable", reason: "no tsconfig.json above the file" }, null],
    [{ kind: "busy" }, null],
    [{ kind: "timed-out", afterMs: 30_000 }, /did not finish within 30s/],
    [{ kind: "failed", reason: "spawn ENOENT" }, /spawn ENOENT/],
  ])("%o tells the model nothing and keeps memory", (outcome, operator) => {
    const judged = judgeTypeCheck({ touchedFile: TOUCHED, projectDir: PROJECT, outcome, memory, now: T0 });
    expect(judged.advisory.forModel).toBeNull();
    expect(judged.memoryUpdate).toEqual({ kind: "keep" });
    if (operator === null) expect(judged.advisory.forOperator).toBeNull();
    else expect(judged.advisory.forOperator).toMatch(operator);
  });

  it("a completed run always replaces memory", () => {
    const judged = judgeTypeCheck({ touchedFile: TOUCHED, projectDir: PROJECT, outcome: completed([]), memory, now: T0 + MINUTE });
    expect(judged.memoryUpdate).toEqual({ kind: "replace", memory: { recordedAt: T0 + MINUTE, diagnosticKeys: [], repeats: {} } });
  });

  it("surfaces project-level configuration errors to the operator, not the model", () => {
    const judged = judgeTypeCheck({
      touchedFile: TOUCHED,
      projectDir: PROJECT,
      outcome: { kind: "completed", diagnostics: [], global: [{ code: 5023, message: "Unknown compiler option 'bogus'." }] },
      memory: null,
      now: T0,
    });
    expect(judged.advisory.forModel).toBeNull();
    expect(judged.advisory.forOperator).toContain("TS5023");
  });
});

describe("parseTypeCheckMemory", () => {
  it("round-trips the memory the judge produces", () => {
    const [, second] = judgeSequence([completed([diagnostic()]), completed([diagnostic()])]);
    expect(parseTypeCheckMemory(JSON.parse(JSON.stringify(second!.memory)))).toEqual(second!.memory);
  });

  it.each<[unknown]>([
    [null], [1], ["x"], [[]], [{}],
    [{ recordedAt: T0, diagnosticKeys: [1], repeats: {} }],
    [{ recordedAt: T0, diagnosticKeys: [], repeats: { a: { fingerprint: "f", consecutive: 0, at: T0 } } }],
    [{ recordedAt: T0, diagnosticKeys: [], repeats: { a: { fingerprint: "f", consecutive: 1 } } }],
    [{ diagnosticKeys: [], repeats: {} }],
    [{ recordedAt: "yesterday", diagnosticKeys: [], repeats: {} }],
  ])(
    "rejects malformed memory %j",
    (raw) => {
      expect(parseTypeCheckMemory(raw)).toBeNull();
    },
  );
});
