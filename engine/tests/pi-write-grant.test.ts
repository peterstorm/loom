import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumePiWriteGrant,
  injectPiWriteGrant,
  issuePiWriteGrant,
  PI_WRITE_GRANT_START_WINDOW_MS,
  revokePiWriteGrant,
  sweepExpiredPiWriteGrants,
} from "../../pi/write-grant";

let root: string;
let priorSubagentDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-pi-write-grant-"));
  priorSubagentDir = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
});

afterEach(() => {
  if (priorSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = priorSubagentDir;
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const cwd = join(root, "project");
  const graph = join(cwd, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(cwd, ".claude", "state"), { recursive: true });
  writeFileSync(graph, "{}\n");
  return { cwd, graph };
}

describe("Pi child write grants", () => {
  it("hands one bound capability to one child without storing the raw token", () => {
    const { cwd, graph } = fixture();
    const issued = issuePiWriteGrant({
      agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph,
    });
    const prompt = injectPiWriteGrant("Task ID: T1\nImplement it.", issued);
    const recordName = readdirSync(join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants"))[0]!;
    expect(readFileSync(join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants", recordName), "utf-8"))
      .not.toContain(issued.token);

    expect(consumePiWriteGrant(prompt, cwd, "code-implementer-agent")).toMatchObject({
      agent: "code-implementer-agent", taskId: "T1", taskGraphPath: graph,
    });
    expect(() => consumePiWriteGrant(prompt, cwd, "code-implementer-agent")).toThrow();
  });

  it("keeps queued children valid for the fixed parent-session start window", () => {
    const { cwd, graph } = fixture();
    const issued = issuePiWriteGrant({
      agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph, now: 100,
    });
    const prompt = injectPiWriteGrant("Task ID: T1", issued);

    expect(consumePiWriteGrant(
      prompt,
      cwd,
      "code-implementer-agent",
      100 + PI_WRITE_GRANT_START_WINDOW_MS,
    )).toMatchObject({ taskId: "T1" });
  });

  it("burns mismatched, expired, and explicitly revoked grants fail-closed", () => {
    const { cwd, graph } = fixture();
    const other = join(root, "other");
    mkdirSync(other);

    const mismatched = issuePiWriteGrant({ agent: "frontend-agent", taskId: "T2", cwd, taskGraphPath: graph });
    const mismatchedPrompt = injectPiWriteGrant("Task ID: T2", mismatched);
    expect(() => consumePiWriteGrant(mismatchedPrompt, other, "frontend-agent")).toThrow(/cwd/);
    expect(() => consumePiWriteGrant(mismatchedPrompt, cwd, "frontend-agent")).toThrow();

    const wrongAgent = issuePiWriteGrant({ agent: "frontend-agent", taskId: "T2", cwd, taskGraphPath: graph });
    expect(() => consumePiWriteGrant(
      injectPiWriteGrant("Task ID: T2", wrongAgent), cwd, "security-agent",
    )).toThrow(/agent/);

    const wrongTask = issuePiWriteGrant({ agent: "frontend-agent", taskId: "T2", cwd, taskGraphPath: graph });
    expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T9", wrongTask), cwd, "frontend-agent"))
      .toThrow(/Task ID/);

    const tampered = issuePiWriteGrant({ agent: "frontend-agent", taskId: "T2", cwd, taskGraphPath: graph });
    const grantDir = join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants");
    const tamperedPath = join(grantDir, readdirSync(grantDir)[0]!);
    const tamperedRecord = JSON.parse(readFileSync(tamperedPath, "utf-8"));
    tamperedRecord.agent = "security-agent";
    writeFileSync(tamperedPath, JSON.stringify(tamperedRecord));
    expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T2", tampered), cwd, "frontend-agent"))
      .toThrow(/integrity/);

    const expired = issuePiWriteGrant({
      agent: "frontend-agent", taskId: "T2", cwd, taskGraphPath: graph, now: 100, ttlMs: 10,
    });
    expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T2", expired), cwd, "frontend-agent", 111))
      .toThrow(/expired/);

    const revoked = issuePiWriteGrant({ agent: "frontend-agent", taskId: "T2", cwd, taskGraphPath: graph });
    revokePiWriteGrant(revoked.token);
    expect(() => consumePiWriteGrant(injectPiWriteGrant("Task ID: T2", revoked), cwd, "frontend-agent")).toThrow();
  });

  it("audits malformed abandoned capabilities before deleting them", () => {
    const { cwd, graph } = fixture();
    issuePiWriteGrant({
      agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph,
    });
    const grantDir = join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants");
    const grantPath = join(grantDir, readdirSync(grantDir)[0]!);
    writeFileSync(grantPath, "{not-json");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      sweepExpiredPiWriteGrants();
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain(`removing malformed write grant ${grantPath}`);
      expect(readdirSync(grantDir)).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("rejects marker smuggling and sweeps abandoned capabilities", () => {
    const { cwd, graph } = fixture();
    const issued = issuePiWriteGrant({
      agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph, now: 100, ttlMs: 10,
    });
    expect(() => injectPiWriteGrant(`already ${issued.marker}`, issued)).toThrow(/already contains/);
    expect(() => consumePiWriteGrant(`${issued.marker}\n${issued.marker}`, cwd, "code-implementer-agent", 100))
      .toThrow(/multiple/);

    sweepExpiredPiWriteGrants(111);
    expect(() => consumePiWriteGrant(issued.marker, cwd, "code-implementer-agent", 111)).toThrow();
  });
});

describe("Pi write grants fail closed when their bound task graph disappears", () => {
  /**
   * The grant binds a specific task graph path, and the child is about to write
   * to it. Between issuance and consumption that file can be deleted, renamed,
   * or replaced by a directory — so the existence check is the last thing
   * standing between a stale capability and a write against a graph that is no
   * longer the one the parent authorised. Nothing exercised it, because every
   * other test left the fixture graph in place for the whole run.
   */
  const grantFor = (cwd: string, graph: string) => {
    const issued = issuePiWriteGrant({
      agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph,
    });
    return injectPiWriteGrant("Task ID: T1\nImplement it.", issued);
  };

  it("refuses a grant whose task graph was deleted after issuance", () => {
    const { cwd, graph } = fixture();
    const prompt = grantFor(cwd, graph);
    rmSync(graph, { force: true });

    expect(() => consumePiWriteGrant(prompt, cwd, "code-implementer-agent"))
      .toThrow(/task graph no longer exists/);
  });

  it("refuses a grant whose task graph directory was removed wholesale", () => {
    const { cwd, graph } = fixture();
    const prompt = grantFor(cwd, graph);
    rmSync(join(cwd, ".claude", "state"), { recursive: true, force: true });

    expect(() => consumePiWriteGrant(prompt, cwd, "code-implementer-agent"))
      .toThrow(/task graph no longer exists/);
  });

  it("still burns the one-time capability when the existence check refuses it", () => {
    const { cwd, graph } = fixture();
    const prompt = grantFor(cwd, graph);
    rmSync(graph, { force: true });
    expect(() => consumePiWriteGrant(prompt, cwd, "code-implementer-agent")).toThrow();

    // Restoring the file must NOT resurrect the grant: the record was claimed
    // and deleted on the first attempt, so a retry has nothing to consume.
    writeFileSync(graph, "{}\n");
    expect(() => consumePiWriteGrant(prompt, cwd, "code-implementer-agent")).toThrow();
  });

  it("accepts the same grant while its bound task graph is still present", () => {
    const { cwd, graph } = fixture();
    expect(consumePiWriteGrant(grantFor(cwd, graph), cwd, "code-implementer-agent"))
      .toMatchObject({ agent: "code-implementer-agent", taskId: "T1", taskGraphPath: graph });
  });
});
