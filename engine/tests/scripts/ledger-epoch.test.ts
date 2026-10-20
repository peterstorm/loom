/**
 * The Ledger Epoch View shell (`scripts/ledger-epoch.ts`), driven through its
 * real entry point: `bun scripts/ledger-epoch.ts` as a subprocess, with
 * `LOOM_SUBAGENT_DIR` pointed at a temp dir that holds hand-written
 * `<session>.evidence.jsonl` ledgers.
 *
 * The script is read-only (FR-006): every run here also proves the ledger's
 * bytes and mtime and the directory listing are unchanged, and a run with no
 * ledger creates nothing. Positions are checked against the engine's own fold
 * (`eventsForEpoch`) over the same records, so `#N` is the position I6 cites.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { epochOf, eventsForEpoch, parseAgentId, parseAgentType, parseEvidenceLine } from "../../src/machine/evidence";
import type { EvidenceRecord } from "../../src/machine/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const SCRIPT = resolve(__dirname, "../../../scripts/ledger-epoch.ts");
const USAGE =
  "usage: bun scripts/ledger-epoch.ts --session <session-id> [--agent <agent-id> --type <agent-type>]";

const SESSION = "sess-epoch-view";
const IMPLEMENTER = "agent-impl:code-implementer-agent";
const TESTER = "agent-test:ts-test-agent";
const EPOCH_ARGS = ["--session", SESSION, "--agent", "agent-impl", "--type", "code-implementer-agent"] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempSubagentDir = (): string => {
  const dir = canonicalTempDir("loom-ledger-epoch-");
  dirs.push(dir);
  return dir;
};

type Run = Readonly<{ status: number | null; stdout: string; stderr: string }>;

const runView = (subagentDir: string, args: readonly string[]): Run => {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, LOOM_SUBAGENT_DIR: subagentDir },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const line = (record: object): string => JSON.stringify(record);

const recordedReport = {
  total: 3,
  failed: 1,
  source: "vitest-json",
  files: {
    kind: "recorded",
    results: [
      { file: "tests/a.test.ts", executed: 3, failed: 1, skipped: 1, collectionError: false },
      { file: "tests/b.test.ts", executed: 0, failed: 0, skipped: 0, collectionError: true },
    ],
  },
};

const recordedTestRun = { kind: "TestRun", command: "bun test --reporter=junit", exit: 1, report: recordedReport };

/** A multi-epoch ledger with every evidence kind and one duplicate delivery. */
const LEDGER_LINES: readonly string[] = [
  line({ epoch: IMPLEMENTER, event: { kind: "FileRead", path: "/repo/plan.md" }, callId: "c1" }),
  line({ epoch: TESTER, event: { kind: "FileRead", path: "/repo/other.ts" }, callId: "t1" }),
  line({ epoch: IMPLEMENTER, event: recordedTestRun, callId: "c2" }),
  // A re-delivered PostToolUse for c2: byte-identical, dropped by the fold.
  line({ epoch: IMPLEMENTER, event: recordedTestRun, callId: "c2" }),
  line({ epoch: IMPLEMENTER, event: { kind: "FileWrite", path: "/repo/src/a.ts", via: "tool" }, callId: "c3" }),
  line({ epoch: IMPLEMENTER, event: { kind: "FileWrite", path: "/repo/out.log", via: "shell" }, callId: "c4" }),
  line({ epoch: IMPLEMENTER, event: { kind: "TestRun", command: "pytest" }, callId: "c5" }),
  line({ epoch: TESTER, event: { kind: "FileWrite", path: "/repo/t.ts", via: "tool" }, callId: "t2" }),
];

const writeLedger = (dir: string, lines: readonly string[]): string => {
  const path = join(dir, `${SESSION}.evidence.jsonl`);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
  return path;
};

type Snapshot = Readonly<{ listing: readonly string[]; bytes: string | null; mtimeMs: number | null }>;

const snapshot = (dir: string, ledger: string | null): Snapshot => ({
  listing: readdirSync(dir).sort(),
  bytes: ledger === null ? null : readFileSync(ledger, "utf8"),
  mtimeMs: ledger === null ? null : statSync(ledger).mtimeMs,
});

const parsedRecords = (lines: readonly string[]): readonly EvidenceRecord[] =>
  lines.map((l) => {
    const parsed = parseEvidenceLine(l);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });

const implementerEpoch = () => {
  const agentId = parseAgentId("agent-impl");
  const agentType = parseAgentType("code-implementer-agent");
  if (agentId === null || agentType === null) throw new Error("fixture ids must parse");
  return epochOf(agentId, agentType);
};

describe("scripts/ledger-epoch.ts — epoch view", () => {
  it("AS-001: lists exactly one epoch's facts in ledger order, duplicate dropped, positions as I6 cites them", () => {
    const dir = tempSubagentDir();
    const ledger = writeLedger(dir, LEDGER_LINES);
    const before = snapshot(dir, ledger);

    const run = runView(dir, EPOCH_ARGS);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const out = run.stdout.split("\n");
    expect(out[0]).toBe(`epoch ${IMPLEMENTER} — 5 fact(s)`);
    const headers = out.filter((l) => l.startsWith("#"));
    expect(headers).toEqual([
      "#0 FileRead /repo/plan.md",
      "#1 TestRun bun test --reporter=junit",
      "#2 FileWrite /repo/src/a.ts (via tool)",
      "#3 FileWrite /repo/out.log (via shell)",
      "#4 TestRun pytest",
    ]);
    // Each position is the fact's index in the engine's own fold, the array settlement hands I6.
    const folded = eventsForEpoch(parsedRecords(LEDGER_LINES), implementerEpoch());
    expect(headers).toHaveLength(folded.length);
    folded.forEach((event, index) => {
      expect(headers[index]!.startsWith(`#${index} ${event.kind} `)).toBe(true);
    });
    expect(run.stdout).not.toContain("/repo/other.ts");
    expect(run.stdout).not.toContain("/repo/t.ts");
    expect(snapshot(dir, ledger)).toEqual(before);
  });

  it("AS-002: renders every evidence kind: write path and source, read path, test command, exit and report summary", () => {
    const dir = tempSubagentDir();
    const ledger = writeLedger(dir, LEDGER_LINES);
    const before = snapshot(dir, ledger);

    const run = runView(dir, EPOCH_ARGS);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        `epoch ${IMPLEMENTER} — 5 fact(s)`,
        "#0 FileRead /repo/plan.md",
        "#1 TestRun bun test --reporter=junit",
        "    exit 1",
        "    report vitest-json: total 3, failed 1",
        "      tests/a.test.ts: executed 3, failed 1, skipped 1",
        "      tests/b.test.ts: executed 0, failed 0, skipped 0, collection error",
        "#2 FileWrite /repo/src/a.ts (via tool)",
        "#3 FileWrite /repo/out.log (via shell)",
        "#4 TestRun pytest",
        "    exit none recorded",
        "    no structured report",
      ].join("\n") + "\n",
    );
    expect(snapshot(dir, ledger)).toEqual(before);
  });
});

describe("scripts/ledger-epoch.ts — epoch index", () => {
  it("AS-003: without an agent, lists every epoch in first-appearance order with its deduplicated fact count", () => {
    const dir = tempSubagentDir();
    const ledger = writeLedger(dir, LEDGER_LINES);
    const before = snapshot(dir, ledger);

    const run = runView(dir, ["--session", SESSION]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      ["2 epoch(s)", `${IMPLEMENTER} — 5 fact(s)`, `${TESTER} — 2 fact(s)`].join("\n") + "\n",
    );
    expect(snapshot(dir, ledger)).toEqual(before);
  });

  it("AS-005: an existing ledger with no records states it holds no epochs, exit 0", () => {
    const dir = tempSubagentDir();
    const ledger = writeLedger(dir, []);
    const before = snapshot(dir, ledger);

    const run = runView(dir, ["--session", SESSION]);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("ledger holds no epochs\n");
    expect(snapshot(dir, ledger)).toEqual(before);
  });
});

describe("scripts/ledger-epoch.ts — refusals", () => {
  it("AS-004: refuses a session with no ledger naming the path under LOOM_SUBAGENT_DIR, exit 1, and creates nothing", () => {
    const dir = tempSubagentDir();

    const run = runView(dir, ["--session", SESSION]);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`ledger-epoch: no evidence ledger at ${join(dir, `${SESSION}.evidence.jsonl`)}\n`);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("AS-004: refuses a session with no ledger in epoch mode too, and never creates a missing subagent dir", () => {
    const dir = join(tempSubagentDir(), "absent");

    const run = runView(dir, EPOCH_ARGS);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`ledger-epoch: no evidence ledger at ${join(dir, `${SESSION}.evidence.jsonl`)}\n`);
    expect(readdirSync(join(dir, ".."))).toEqual([]);
  });

  it("AS-004: refuses a ledger with an unparseable line naming that line, exit 1, ledger untouched", () => {
    const dir = tempSubagentDir();
    const ledger = writeLedger(dir, [LEDGER_LINES[0]!, LEDGER_LINES[1]!, "{not json", LEDGER_LINES[2]!]);
    const before = snapshot(dir, ledger);

    for (const args of [["--session", SESSION], EPOCH_ARGS]) {
      const run = runView(dir, args);
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr.startsWith("ledger-epoch: ")).toBe(true);
      expect(run.stderr).toContain("line 3:");
      expect(run.stderr).toContain(ledger);
    }
    expect(snapshot(dir, ledger)).toEqual(before);
  });

  it("AS-005: an agent whose epoch holds no facts is stated, exit 0, not refused", () => {
    const dir = tempSubagentDir();
    const ledger = writeLedger(dir, LEDGER_LINES);
    const before = snapshot(dir, ledger);

    const run = runView(dir, ["--session", SESSION, "--agent", "nobody", "--type", "ts-test-agent"]);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("epoch nobody:ts-test-agent holds no facts\n");
    expect(snapshot(dir, ledger)).toEqual(before);
  });

  it.each([
    ["no arguments", []],
    ["--agent without --type", ["--session", SESSION, "--agent", "agent-impl"]],
    ["--type without --agent", ["--session", SESSION, "--type", "code-implementer-agent"]],
    ["an unknown flag", ["--session", SESSION, "--verbose"]],
    ["a traversing session id", ["--session", "../x"]],
    ["a flag-valued session", ["--session", "--agent", "a", "--type", "b"]],
    ["a malformed agent id", ["--session", SESSION, "--agent", "a:b", "--type", "t"]],
  ] as const)("AS-005: %s prints the usage and exits 2", (_label, args) => {
    const dir = tempSubagentDir();
    const ledger = writeLedger(dir, LEDGER_LINES);
    const before = snapshot(dir, ledger);

    const run = runView(dir, args);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    const [reason, usage, ...rest] = run.stderr.split("\n");
    expect(reason).not.toBe("");
    expect(usage).toBe(USAGE);
    expect(rest).toEqual([""]);
    expect(snapshot(dir, ledger)).toEqual(before);
  });
});
