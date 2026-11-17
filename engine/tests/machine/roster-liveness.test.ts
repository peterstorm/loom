/**
 * loom#198, Cause 5: a roster entry with no running agent behind it no longer
 * vetoes quiescence forever, and the next SubagentStart removes it. Two kinds
 * are dead: an agent that never started (a spawn the harness refused after
 * SubagentStart: no transcript anywhere under the configuration directory's
 * projects, on a roster older than the grace period), and an agent an API
 * error aborted (a usage limit: its transcript ends in Claude Code's API error
 * record and has been quiet for the grace period). Only Claude Code ids are
 * judged; everything unknown stays active.
 */
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEAD_ENTRY_GRACE_MS,
  deadEntryReason,
  isClaudeCodeAgentId,
  lastTranscriptRecord,
  type TranscriptObservation,
} from "../../src/core/roster-liveness";
import { deadRosterEntries, markAgentActive, observeAnyActiveSubagent, rosterAgentId } from "../../src/machine/ledger";
import { parseSessionId } from "../../src/machine/evidence";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const PHANTOM = "a0123456789abcdef";
const REAL = "afedcba9876543210";
const SESSION = "11111111-2222-3333-4444-555555555555";
const GRACE = DEAD_ENTRY_GRACE_MS;

const API_ERROR_RECORD = JSON.stringify({ type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: "weekly limit" }] } });
const ASSISTANT_RECORD = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });

const ABSENT: TranscriptObservation = { kind: "absent" };
const UNKNOWN: TranscriptObservation = { kind: "unknown" };
const present = (lastRecord: "api-error" | "other", idleMs: number): TranscriptObservation => ({ kind: "present", lastRecord, idleMs });

describe("deadEntryReason", () => {
  it.each<[string, string, number, TranscriptObservation, ReturnType<typeof deadEntryReason>]>([
    ["no transcript on an old roster", PHANTOM, GRACE, ABSENT, "never-started"],
    ["no transcript on a young roster", PHANTOM, GRACE - 1, ABSENT, null],
    ["a quiet transcript ending in an API error", PHANTOM, 0, present("api-error", GRACE), "aborted"],
    ["a transcript that ended in an API error moments ago", PHANTOM, GRACE * 10, present("api-error", GRACE - 1), null],
    ["a quiet transcript ending in an ordinary record", PHANTOM, GRACE * 10, present("other", GRACE * 10), null],
    ["an unknown transcript", PHANTOM, GRACE * 10, UNKNOWN, null],
    ["a non-Claude Code id with no transcript", "pi-grant-7", GRACE * 10, ABSENT, null],
    ["a non-Claude Code id ending in an API error", "pi-grant-7", GRACE * 10, present("api-error", GRACE * 10), null],
  ])("%s", (_case, agentId, rosterAgeMs, transcript, expected) => {
    expect(deadEntryReason(agentId, rosterAgeMs, transcript)).toBe(expected);
  });

  it("knows Claude Code's opaque agent ids", () => {
    expect(isClaudeCodeAgentId(PHANTOM)).toBe(true);
    expect(isClaudeCodeAgentId("a0123")).toBe(false);
    expect(isClaudeCodeAgentId("A0123456789ABCDEF")).toBe(false);
  });
});

describe("lastTranscriptRecord", () => {
  it.each<[string, string, "api-error" | "other"]>([
    ["an API error last", `${ASSISTANT_RECORD}\n${API_ERROR_RECORD}\n`, "api-error"],
    ["an API error last, before blank lines", `${API_ERROR_RECORD}\n\n  \n`, "api-error"],
    ["an API error followed by more work", `${API_ERROR_RECORD}\n${ASSISTANT_RECORD}\n`, "other"],
    ["an ordinary record last", `${ASSISTANT_RECORD}\n`, "other"],
    ["isApiErrorMessage that is not exactly true", `${JSON.stringify({ isApiErrorMessage: "true" })}\n`, "other"],
    ["an unparseable last line", `${API_ERROR_RECORD}\n{"type":`, "other"],
    ["a last line that is not an object", "true\n", "other"],
    ["nothing", "", "other"],
  ])("%s: %s", (_case, wholeLines, expected) => {
    expect(lastTranscriptRecord(wholeLines)).toBe(expected);
  });
});

describe("the ledger ignores and removes dead roster entries", () => {
  const saved = { subagents: process.env.LOOM_SUBAGENT_DIR, config: process.env.CLAUDE_CONFIG_DIR };
  let root: string;
  let subagents: string;
  let config: string;
  let statePath: string;

  beforeEach(() => {
    root = canonicalTempDir("loom-roster-liveness-");
    subagents = join(root, "subagents");
    config = join(root, "claude-config");
    statePath = join(root, "project", ".claude", "state", "active_task_graph.json");
    mkdirSync(subagents, { recursive: true });
    mkdirSync(join(config, "projects", "-work-somewhere-else"), { recursive: true });
    process.env.LOOM_SUBAGENT_DIR = subagents;
    process.env.CLAUDE_CONFIG_DIR = config;
    writeFileSync(join(subagents, `${SESSION}.task_graph`), statePath);
  });
  afterEach(() => {
    if (saved.subagents === undefined) delete process.env.LOOM_SUBAGENT_DIR;
    else process.env.LOOM_SUBAGENT_DIR = saved.subagents;
    if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.config;
    rmSync(root, { recursive: true, force: true });
  });

  const backdate = (path: string, ageMs: number) => {
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
  };
  const roster = (ids: readonly string[], ageMs: number) => {
    const path = join(subagents, `${SESSION}.active`);
    writeFileSync(path, ids.map((id) => `${id}\tgeneral-purpose\n`).join(""));
    backdate(path, ageMs);
    return path;
  };
  const transcriptFor = (agentId: string, text = `${ASSISTANT_RECORD}\n`, idleMs = 0) => {
    const directory = join(config, "projects", "-work-somewhere-else", SESSION, "subagents");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `agent-${agentId}.jsonl`);
    writeFileSync(path, text);
    backdate(path, idleMs);
  };
  const active = () => observeAnyActiveSubagent(statePath);
  const OLD = GRACE * 2;

  it("does not count a roster of agents that never started", () => {
    roster([PHANTOM], OLD);
    expect(active()).toEqual({ kind: "observed", anyActiveForGraph: false });
  });

  it("counts an agent whose transcript exists, even under another project's directory", () => {
    roster([PHANTOM], OLD);
    transcriptFor(PHANTOM);
    expect(active()).toEqual({ kind: "observed", anyActiveForGraph: true });
  });

  it("does not count agents an API error aborted, once their transcripts are quiet", () => {
    roster([PHANTOM, REAL], OLD);
    transcriptFor(PHANTOM, `${ASSISTANT_RECORD}\n${API_ERROR_RECORD}\n`, OLD);
    transcriptFor(REAL, `${API_ERROR_RECORD}\n`, OLD);
    expect(active()).toEqual({ kind: "observed", anyActiveForGraph: false });
    expect(deadRosterEntries(SESSION, Date.now())).toEqual({
      entries: [{ agentId: PHANTOM, reason: "aborted" }, { agentId: REAL, reason: "aborted" }],
      all: true,
    });
  });

  it("counts an agent whose API error is recent, or that wrote again after it", () => {
    roster([PHANTOM], OLD);
    transcriptFor(PHANTOM, `${API_ERROR_RECORD}\n`, 1_000);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
    transcriptFor(PHANTOM, `${API_ERROR_RECORD}\n${ASSISTANT_RECORD}\n`, OLD);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
  });

  it("finds the API error at the end of a transcript longer than the tail it reads", () => {
    roster([PHANTOM], OLD);
    const filler = `${JSON.stringify({ type: "user", text: "x".repeat(10_000) })}\n`.repeat(20);
    transcriptFor(PHANTOM, `${filler}${API_ERROR_RECORD}\n`, OLD);
    expect(active()).toEqual({ kind: "observed", anyActiveForGraph: false });
    transcriptFor(PHANTOM, `${filler}${API_ERROR_RECORD}\n${filler}`, OLD);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
  });

  it("counts a roster too young to judge, a non-Claude Code id, and a mixed roster", () => {
    roster([PHANTOM], 1_000);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
    roster(["pi-grant-7"], OLD);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
    roster([PHANTOM, REAL], OLD);
    transcriptFor(REAL);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
  });

  it("counts the agent when the configuration has no projects directory to prove absence", () => {
    rmSync(join(config, "projects"), { recursive: true, force: true });
    roster([PHANTOM], OLD);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
  });

  it("counts the agent when its transcript cannot be probed (a read fails other than by absence)", () => {
    writeFileSync(join(config, "projects", "a-file-not-a-directory"), "");
    roster([PHANTOM], OLD);
    expect(active()).toMatchObject({ anyActiveForGraph: true });
  });

  it("judges nothing for a roster whose session id does not parse, or that is empty", () => {
    expect(deadRosterEntries("bad session", Date.now())).toBeNull();
    roster([], OLD);
    expect(deadRosterEntries(SESSION, Date.now(), () => ABSENT)).toBeNull();
  });

  it("asks the injected transcript observer, and names each dead entry's reason", () => {
    roster([PHANTOM, REAL, "afffffffffffffff0"], OLD);
    const observed = deadRosterEntries(SESSION, Date.now(), (_session, agentId) =>
      agentId === PHANTOM ? ABSENT : agentId === REAL ? present("api-error", OLD) : present("other", OLD));
    expect(observed).toEqual({
      entries: [{ agentId: PHANTOM, reason: "never-started" }, { agentId: REAL, reason: "aborted" }],
      all: false,
    });
  });

  it("removes dead entries when the next agent starts, keeping a live one", async () => {
    const path = roster([PHANTOM, REAL, "aeeeeeeeeeeeeeee0"], OLD);
    transcriptFor(REAL);
    transcriptFor("aeeeeeeeeeeeeeee0", `${API_ERROR_RECORD}\n`, OLD);
    const session = parseSessionId(SESSION);
    if (session === null) throw new Error("fixture session id");
    await markAgentActive(session, rosterAgentId("afffffffffffffff0"));
    expect(readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => line.split("\t")[0]))
      .toEqual([REAL, "afffffffffffffff0"]);
  });
});
