/**
 * `claudeLiveAttemptEvidence`, the production port `helper stop-check-plan`
 * resolves a Task's live attempt through, over real runtime files: sidecars,
 * session rosters and evidence ledgers in a temporary subagent directory.
 *
 * Its edge branches each answer differently, and none may read as "no
 * changed files" when the truth is "could not tell":
 * - one live, rostered sidecar: its own epoch, read back;
 * - two live sidecars naming one Task: unreadable, naming the count;
 * - a sidecar whose agent left its roster, or that names another Task or
 *   TaskGraph: no live attempt;
 * - a rostered agent with no parseable role: unreadable;
 * - a corrupt ledger: unreadable, with the reader's reason;
 * - an unreadable sidecar with no readable one naming the Task: uninspectable,
 *   and the plan prints a note saying its changed files may be incomplete.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImplementationAttemptAuthority } from "../../../src/core/implementation-completion";
import {
  claudeLiveAttemptEvidence,
  createStopCheckPlanHandler,
  type LiveAttemptEvidence,
} from "../../../src/handlers/helpers/stop-check-plan";
import { publishImplementationAttemptSidecar } from "../../../src/implementation-attempt-sidecar";
import {
  appendEvidence,
  epochOf,
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  markAgentActive,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type Evidence,
} from "../../../src/machine";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { stateFileJson, task, writeStateFile } from "../../fixtures/contract-status-fixtures";

const SESSION = "live-attempt-evidence-session";
const AGENT_TYPE = "code-implementer-agent";

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`fixture ${label} must parse`);
  return value;
}

const session = required(parseSessionId(SESSION), "session");
const agentType = required(parseAgentType(AGENT_TYPE), "agent type");

let root = "";
let statePath = "";
const initialSubagentDir = process.env.LOOM_SUBAGENT_DIR;
const initialStatePath = process.env.LOOM_STATE_PATH;

beforeEach(() => {
  root = canonicalTempDir("loom-live-attempt-evidence-");
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  mkdirSync(process.env.LOOM_SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  statePath = writeStateFile(root, stateFileJson([task("T1", 1, ["src/a.ts"]), task("T2", 1, ["src/b.ts"])]));
  process.env.LOOM_STATE_PATH = statePath;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (initialSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = initialSubagentDir;
  if (initialStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = initialStatePath;
});

/** Publish a sidecar for `agentId` reserving `taskId` on `graphPath`. */
function sidecar(agentId: string, taskId: string, graphPath = statePath): void {
  const authority = createImplementationAttemptAuthority({
    taskId,
    wave: 1,
    semanticAttempt: 1,
    reservationId: `live-${agentId}`,
    headSha: "a".repeat(40),
    reservedAt: "2026-10-17T00:00:00.000Z",
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  });
  if (!authority.ok) throw new Error(authority.error.errors.join("; "));
  publishImplementationAttemptSidecar({ sessionId: SESSION, agentId, taskGraphPath: graphPath, authority: authority.value });
}

/** Roster `agentId` under the implementer role and record `events` in its epoch. */
async function live(agentId: string, events: readonly Evidence[] = []): Promise<void> {
  const id = required(parseAgentId(agentId), "agent id");
  await markAgentActive(session, id, agentType);
  if (events.length > 0) appendEvidence(session, epochOf(id, agentType), events);
}

const write = (path: string): Evidence => ({ kind: "FileWrite", path, via: "tool" });
const evidence = (): LiveAttemptEvidence => claudeLiveAttemptEvidence("T1", statePath);
const sessionFile = (suffix: string): string => join(process.env.LOOM_SUBAGENT_DIR ?? "", `${SESSION}${suffix}`);

describe("claudeLiveAttemptEvidence: the plan view's live-attempt port", () => {
  it("reads one live, rostered attempt's own epoch back from the session ledger", async () => {
    sidecar("agent-1", "T1");
    await live("agent-1", [write("src/a.ts")]);
    await live("agent-2", [write("src/foreign.ts")]);
    expect(evidence()).toEqual({ kind: "live", ledger: { kind: "read", events: [write("src/a.ts")] } });
  });

  it("is unreadable, naming the count, when two live attempts name the Task", async () => {
    sidecar("agent-1", "T1");
    sidecar("agent-2", "T1");
    await live("agent-1");
    await live("agent-2");
    expect(evidence()).toEqual({
      kind: "live",
      ledger: { kind: "unreadable", reason: "2 live implementation attempts name T1" },
    });
  });

  it("reads an attempt whose agent left its roster, or that names another Task or TaskGraph, as no live attempt", async () => {
    sidecar("agent-ended", "T1");
    sidecar("agent-other-task", "T2");
    await live("agent-other-task");
    const otherGraph = writeStateFile(join(root, "elsewhere"), stateFileJson([task("T1", 1, ["src/a.ts"])]));
    sidecar("agent-other-graph", "T1", otherGraph);
    await live("agent-other-graph");
    expect(evidence()).toEqual({ kind: "no-live-attempt" });
  });

  it("is unreadable when the live attempt's agent is rostered without a parseable role", () => {
    sidecar("agent-1", "T1");
    writeFileSync(sessionFile(".active"), "agent-1\n");
    expect(evidence()).toEqual({
      kind: "live",
      ledger: { kind: "unreadable", reason: "the live attempt of T1 is rostered without a parseable role" },
    });
  });

  it("is unreadable, with the reader's reason, when the session ledger is corrupt", async () => {
    sidecar("agent-1", "T1");
    await live("agent-1");
    writeFileSync(sessionFile(".evidence.jsonl"), "not json\n");
    const observed = evidence();
    expect(observed).toMatchObject({ kind: "live", ledger: { kind: "unreadable" } });
    expect(observed.kind === "live" && observed.ledger.kind === "unreadable" ? observed.ledger.reason : "")
      .toMatch(/evidence ledger .* is corrupt/);
  });

  it("is uninspectable, never no live attempt, when a sidecar cannot be read and none names the Task", () => {
    const leaf = `${SESSION}.${Buffer.from("agent-broken", "utf8").toString("hex")}${IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX}`;
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR ?? "", leaf), "{ not a sidecar");
    const observed = evidence();
    expect(observed.kind).toBe("uninspectable");
    expect(observed.kind === "uninspectable" ? observed.reason : "")
      .toMatch(/^1 implementation attempt sidecar\(s\) could not be read \(.+\), so a live attempt of T1 may be missed$/);
  });

  it("prints the plan and then the note when the Task's attempt is uninspectable", async () => {
    const written: string[] = [];
    const result = await createStopCheckPlanHandler(
      (text) => { written.push(text); },
      undefined,
      () => ({ kind: "uninspectable", reason: "1 implementation attempt sidecar(s) could not be read (corrupt)" }),
    )("", ["--task", "T1"]);
    expect(result).toEqual({ kind: "passthrough" });
    const lines = written.join("").replace(/\n$/, "").split("\n");
    expect(lines.at(-1)).toBe(
      "note: 1 implementation attempt sidecar(s) could not be read (corrupt); the affected plan above may name too few changed files",
    );
  });
});
