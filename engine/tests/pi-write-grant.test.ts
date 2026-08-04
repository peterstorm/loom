import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumePiWriteGrant,
  injectPiWriteGrant,
  issuePiWriteGrant,
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
