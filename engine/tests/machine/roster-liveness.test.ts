/**
 * loom#198, Cause 5: a roster entry whose agent never started (a spawn the
 * harness refused after SubagentStart) no longer vetoes quiescence forever,
 * and the next SubagentStart removes it. Only a Claude Code id, on a roster
 * older than the grace period, with no transcript anywhere under the
 * configuration directory's projects, is never-started; everything unknown
 * stays active.
 */
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isClaudeCodeAgentId, isNeverStarted, NEVER_STARTED_GRACE_MS, type TranscriptPresence } from "../../src/core/roster-liveness";
import { markAgentActive, neverStartedRosterEntries, observeAnyActiveSubagent, rosterAgentId } from "../../src/machine/ledger";
import { parseSessionId } from "../../src/machine/evidence";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const PHANTOM = "a0123456789abcdef";
const REAL = "afedcba9876543210";
const SESSION = "11111111-2222-3333-4444-555555555555";

describe("isNeverStarted", () => {
  it.each<[string, number, TranscriptPresence, boolean]>([
    [PHANTOM, NEVER_STARTED_GRACE_MS, "absent", true],
    [PHANTOM, NEVER_STARTED_GRACE_MS - 1, "absent", false],
    [PHANTOM, NEVER_STARTED_GRACE_MS, "present", false],
    [PHANTOM, NEVER_STARTED_GRACE_MS, "unknown", false],
    ["pi-grant-7", NEVER_STARTED_GRACE_MS * 10, "absent", false],
  ])("%s at %ims with transcript %s: %s", (agentId, ageMs, transcript, expected) => {
    expect(isNeverStarted(agentId, ageMs, transcript)).toBe(expected);
  });

  it("knows Claude Code's opaque agent ids", () => {
    expect(isClaudeCodeAgentId(PHANTOM)).toBe(true);
    expect(isClaudeCodeAgentId("a0123")).toBe(false);
    expect(isClaudeCodeAgentId("A0123456789ABCDEF")).toBe(false);
  });
});

describe("the ledger ignores and removes never-started roster entries", () => {
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

  const roster = (ids: readonly string[], ageMs: number) => {
    const path = join(subagents, `${SESSION}.active`);
    writeFileSync(path, ids.map((id) => `${id}\tgeneral-purpose\n`).join(""));
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
    return path;
  };
  const transcriptFor = (agentId: string) => {
    const directory = join(config, "projects", "-work-somewhere-else", SESSION, "subagents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `agent-${agentId}.jsonl`), "{}\n");
  };
  const active = () => observeAnyActiveSubagent(statePath);
  const OLD = NEVER_STARTED_GRACE_MS * 2;

  it("does not count a roster of agents that never started", () => {
    roster([PHANTOM], OLD);
    expect(active()).toEqual({ kind: "observed", anyActiveForGraph: false });
  });

  it("counts an agent whose transcript exists, even under another project's directory", () => {
    roster([PHANTOM], OLD);
    transcriptFor(PHANTOM);
    expect(active()).toEqual({ kind: "observed", anyActiveForGraph: true });
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
    expect(neverStartedRosterEntries("bad session", Date.now())).toBeNull();
    roster([], OLD);
    expect(neverStartedRosterEntries(SESSION, Date.now(), () => "absent")).toBeNull();
  });

  it("asks the injected transcript observer, and calls every entry never-started only when it says absent", () => {
    roster([PHANTOM, REAL], OLD);
    const observed = neverStartedRosterEntries(SESSION, Date.now(), (_session, agentId) => (agentId === REAL ? "present" : "absent"));
    expect(observed).toEqual({ agentIds: [PHANTOM], all: false });
  });

  it("removes a never-started entry when the next agent starts, keeping a live one", async () => {
    const path = roster([PHANTOM, REAL], OLD);
    transcriptFor(REAL);
    const session = parseSessionId(SESSION);
    if (session === null) throw new Error("fixture session id");
    await markAgentActive(session, rosterAgentId("afffffffffffffff0"));
    expect(readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => line.split("\t")[0]))
      .toEqual([REAL, "afffffffffffffff0"]);
  });
});
