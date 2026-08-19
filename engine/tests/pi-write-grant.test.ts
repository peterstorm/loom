import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumePiWriteGrant,
  injectPiWriteGrant,
  issuePiWriteGrant,
  PI_WRITE_GRANT_START_WINDOW_MS,
  revokePiWriteGrant,
  sweepExpiredPiWriteGrants,
  writeTargetViolatesScope,
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

describe("Pi child write grants (incl. scoped phase-agent grants)", () => {
  let priorStatePath: string | undefined;
  beforeEach(() => {
    // Point the guarded-state resolution at THIS test's project so the
    // scope-vs-guarded overlap check resolves real paths.
    priorStatePath = process.env.LOOM_STATE_PATH;
    process.env.LOOM_STATE_PATH = join(root, "project", ".claude", "state", "active_task_graph.json");
  });
  afterEach(() => {
    if (priorStatePath === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = priorStatePath;
  });

  it("issues, consumes, and returns a prompt-derived artifact scope", () => {
    const { cwd, graph } = fixture();
    const issued = issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".claude/specs/2026-08-12-foo"],
    });
    const consumed = consumePiWriteGrant(
      injectPiWriteGrant("Write the spec.\n", issued),
      cwd,
      "specify-agent",
    )!;
    expect(consumed.taskId).toBe("phase:specify");
    expect(consumed.scopeDirs).toHaveLength(1);
    expect(consumed.scopeDirs![0]).toBe(join(cwd, ".claude", "specs", "2026-08-12-foo") + "/");
  });

  it("enforces scope on write targets with trailing-slash prefix semantics", () => {
    const { cwd } = fixture();
    const scope = [join(cwd, ".claude", "specs", "2026-08-12-foo") + "/"];
    expect(writeTargetViolatesScope(join(cwd, ".claude", "specs", "2026-08-12-foo", "spec.md"), scope)).toBeNull();
    expect(writeTargetViolatesScope(join(cwd, ".claude", "specs", "2026-08-12-foo", "nested", "x.md"), scope)).toBeNull();
    // Sibling dirs must not match.
    expect(writeTargetViolatesScope(join(cwd, ".claude", "specs", "2026-08-12-foo-other", "x.md"), scope)).not.toBeNull();
    expect(writeTargetViolatesScope(join(cwd, ".claude", "specs2", "x.md"), scope)).not.toBeNull();
    expect(writeTargetViolatesScope(join(cwd, "README.md"), scope)).not.toBeNull();
    expect(writeTargetViolatesScope(join(cwd, ".claude", "state", "active_task_graph.json"), scope)).not.toBeNull();
  });

  it("canonicalizes through symlinks: a scoped symlink cannot escape the scope", () => {
    const { cwd } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    const scope = [join(cwd, ".claude", "specs", "2026-08-12-foo") + "/"];
    mkdirSync(join(cwd, ".claude", "specs", "2026-08-12-foo"), { recursive: true });
    // A symlink INSIDE the scope dir pointing outside: writing through it
    // must be refused even though the raw path is under the scope prefix.
    symlinkSync(outside, join(cwd, ".claude", "specs", "2026-08-12-foo", "escape"));
    expect(writeTargetViolatesScope(join(cwd, ".claude", "specs", "2026-08-12-foo", "escape", "x.md"), scope)).not.toBeNull();
    // A symlink OUTSIDE the scope pointing INSIDE: writes through it stay
    // inside the real artifact tree and are admitted.
    symlinkSync(join(cwd, ".claude", "specs", "2026-08-12-foo"), join(outside, "link-in"));
    expect(writeTargetViolatesScope(join(outside, "link-in", "spec.md"), scope)).toBeNull();
  });

  // `canonicalTarget` walks up on ENOENT/ENOTDIR only — "this component does not
  // exist yet". Every OTHER errno means the resolution could not be PERFORMED,
  // which is a different answer and must not be absorbed into it. The blanket
  // catch this replaced re-appended the tail and returned a "canonical" path
  // that did not describe what the filesystem would do on write, silently
  // widening the granted scope. A real symlink loop reproduces ELOOP without
  // mocking node:fs; the throw is what the Pi tool-call guard's fail-closed
  // wrapper converts into a blocked edit.
  it("propagates a non-absence errno (ELOOP) instead of widening the scope", () => {
    const { cwd } = fixture();
    const specs = join(cwd, ".claude", "specs", "2026-08-12-foo");
    mkdirSync(specs, { recursive: true });
    const scope = [specs + "/"];

    // Two symlinks pointing at each other: resolving either throws ELOOP.
    symlinkSync(join(specs, "b"), join(specs, "a"));
    symlinkSync(join(specs, "a"), join(specs, "b"));

    let thrown: NodeJS.ErrnoException | null = null;
    try {
      writeTargetViolatesScope(join(specs, "a", "spec.md"), scope);
    } catch (e) {
      thrown = e as NodeJS.ErrnoException;
    }
    // The point is that it did NOT quietly answer "inside the scope".
    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe("ELOOP");
  });

  it("refuses scope dirs that reach into loom-guarded state", () => {
    const { cwd, graph } = fixture();
    expect(() => issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".claude/state"],
    })).toThrow(/loom-guarded state/);
    expect(() => issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".claude/state/subdir"],
    })).toThrow(/loom-guarded state/);
    expect(() => issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [process.env.LOOM_SUBAGENT_DIR!],
    })).toThrow(/loom-guarded state/);
    // A scope that CONTAINS guarded state, or the cwd/ancestor itself, is
    // equivalent to no scope at all and is refused.
    expect(() => issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".claude"],
    })).toThrow(/loom-guarded state/);
    // The repo root / cwd is refused by whichever check fires first: it both
    // CONTAINS the guarded state dir and is the cwd/ancestor itself.
    expect(() => issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: ["."],
    })).toThrow(/loom-guarded state|cwd or an ancestor/);
    expect(() => issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".."],
    })).toThrow(/loom-guarded state|cwd or an ancestor|traversal segment/);
    // An embedded `..` that would resolve to a non-guarded sibling (escaping the
    // .claude confinement without touching guarded state or the cwd ancestors)
    // is refused by the traversal guard.
    expect(() => issuePiWriteGrant({
      agent: "specify-agent",
      taskId: "phase:specify",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".claude/specs/../../sibling"],
    })).toThrow(/traversal segment/);
  });

  it("phase grants do not require a Task ID in the child prompt", () => {
    const { cwd, graph } = fixture();
    const issued = issuePiWriteGrant({
      agent: "architecture-agent",
      taskId: "phase:architecture",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".claude/plans"],
    });
    expect(() => consumePiWriteGrant(
      injectPiWriteGrant("Write the plan.", issued),
      cwd,
      "architecture-agent",
    )).not.toThrow();
    // A smuggled implementation-style prompt cannot consume a phase grant:
    // the agent identity mismatch still burns it.
    const other = issuePiWriteGrant({
      agent: "architecture-agent",
      taskId: "phase:architecture",
      cwd,
      taskGraphPath: graph,
      scopeDirs: [".claude/plans"],
    });
    expect(() => consumePiWriteGrant(
      injectPiWriteGrant("Task ID: T7\nWrite the plan.", other),
      cwd,
      "code-implementer-agent",
    )).toThrow(/agent/);
  });

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

  it("audits a schema-invalid grant separately from an unparseable one", () => {
    // The `if (!grant)` branch is NOT the catch block: valid JSON that fails
    // `parseStoredGrant` never throws, so the sibling test above (which writes
    // "{not-json") exercises the catch and leaves this branch unvisited. The
    // two report the same prose but reach it by different routes, and only
    // this one proves a well-formed-but-wrong grant is deleted rather than
    // honoured.
    const { cwd, graph } = fixture();
    issuePiWriteGrant({
      agent: "code-implementer-agent", taskId: "T1", cwd, taskGraphPath: graph,
    });
    const grantDir = join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants");
    const grantPath = join(grantDir, readdirSync(grantDir)[0]!);
    const stored = JSON.parse(readFileSync(grantPath, "utf-8")) as Record<string, unknown>;
    delete stored.taskId;
    writeFileSync(grantPath, JSON.stringify(stored));

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      sweepExpiredPiWriteGrants();
      const written = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(written).toContain(`removing malformed write grant ${grantPath}`);
      expect(written).toContain("stored grant schema is invalid");
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

  /**
   * `parseStoredGrant`'s SCHEMA checks at CONSUME time.
   *
   * The tamper test above mutates `agent`, which leaves the record structurally
   * valid — so it trips the binding MAC, never the shape gate. The only test
   * that fed `consumePiWriteGrant` a structurally broken record was the sweep
   * test, and the sweep is a different function. That left the consume-time
   * fail-closed backstop — the one that stands between a schema-drifted or
   * hand-written record and a live write capability — with no coverage at all:
   * a regression that made `parseStoredGrant` accept a wrong-`version` record
   * would have shipped silently.
   *
   * Each case must ALSO burn the record: a rejected claim is still a claim, and
   * a malformed grant that survives its own rejection can be retried forever.
   */
  const storedGrantPath = (): string => {
    const grantDir = join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants");
    return join(grantDir, readdirSync(grantDir)[0]!);
  };

  it("refuses a stored grant whose version is not the current schema, and burns it", () => {
    const { cwd, graph } = fixture();
    const prompt = grantFor(cwd, graph);
    const path = storedGrantPath();
    const record = JSON.parse(readFileSync(path, "utf-8"));
    expect(record.version, "the fixture must start at the current schema").toBe(1);
    writeFileSync(path, JSON.stringify({ ...record, version: 0 }));

    expect(() => consumePiWriteGrant(prompt, cwd, "code-implementer-agent"))
      .toThrow(/write grant is malformed/);
    expect(readdirSync(join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants")))
      .toEqual([]);
  });

  it.each([
    ["a missing required field", (record: Record<string, unknown>) => {
      const { taskGraphPath: _dropped, ...rest } = record;
      return rest;
    }],
    ["a wrong-typed expiry", (record: Record<string, unknown>) => ({ ...record, expiresAt: "soon" })],
    ["a non-hex token digest", (record: Record<string, unknown>) => ({ ...record, tokenSha256: "not-a-digest" })],
    ["a scopeDirs entry that is not a string", (record: Record<string, unknown>) => ({ ...record, scopeDirs: [""] })],
    ["an array instead of a record", () => [] as unknown],
  ])("refuses a stored grant with %s, and burns it", (_label, corrupt) => {
    const { cwd, graph } = fixture();
    const prompt = grantFor(cwd, graph);
    const path = storedGrantPath();
    const record = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(corrupt(record)));

    expect(() => consumePiWriteGrant(prompt, cwd, "code-implementer-agent"))
      .toThrow(/write grant is malformed/);
    expect(readdirSync(join(process.env.LOOM_SUBAGENT_DIR!, "pi-write-grants")))
      .toEqual([]);
  });
});
