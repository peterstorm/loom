import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumePiWriteGrant,
  grantWriteScope,
  injectPiWriteGrant,
  issuePiWriteGrant,
  PI_WRITE_GRANT_START_WINDOW_MS,
  revokePiWriteGrant,
  sweepExpiredPiWriteGrants,
} from "../../pi/write-grant";
import { artifactWriteRoots } from "../src/core/artifact-write-scope";
import { shouldBlockDirectEdit, UNRESOLVED, type ActiveRosterEntry } from "../src/core/block-direct-edits";
import { canonicalEditTargets } from "../src/handlers/pre-tool-use/block-direct-edits";
import type { HookResult } from "../src/types";

/**
 * The direct-edit decision for one scoped-grant holder's write, inside the
 * guarded area (the repository is left unresolved, so placement is `inside`):
 * the targets and scope go through the same shell canonicalisation the Pi
 * extension uses, and core confines them.
 */
function confined(scopeDirs: readonly string[] | undefined, cwd: string, ...targets: string[]): HookResult["kind"] {
  const grantHolder = [{ agentId: "pi-grant-abcdef0123456789", agentType: null } as ActiveRosterEntry];
  return shouldBlockDirectEdit("write", "scoped-session", () => true, () => grantHolder, {
    locateEdit: () => ({ repository: UNRESOLVED, targets: canonicalEditTargets(targets, cwd) }),
    grantScope: () => grantWriteScope(scopeDirs, realpathSync(cwd), cwd),
  }).kind;
}

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

  it("issues the architecture role's full roots — lint-rule dirs included, outside guarded state", () => {
    const { cwd, graph } = fixture();
    const scopeDirs = artifactWriteRoots("architecture-agent")!;
    const issued = issuePiWriteGrant({ agent: "architecture-agent", taskId: "phase:architecture", cwd, taskGraphPath: graph, scopeDirs });
    const consumed = consumePiWriteGrant(injectPiWriteGrant("Write the plan.\n", issued), cwd, "architecture-agent")!;
    expect(consumed.scopeDirs).toEqual(scopeDirs.map((dir) => join(cwd, dir) + "/"));
    expect(confined(consumed.scopeDirs, cwd, join(cwd, ".claude", "linter", "rules", "inv-1-pure.json"))).toBe("allow");
    expect(confined(consumed.scopeDirs, cwd, join(cwd, "src", "index.ts"))).toBe("block");
  });

  it("confines write targets on path-segment boundaries", () => {
    const { cwd } = fixture();
    const scope = [join(cwd, ".claude", "specs", "2026-08-12-foo") + "/"];
    expect(confined(scope, cwd, join(cwd, ".claude", "specs", "2026-08-12-foo", "spec.md"))).toBe("allow");
    expect(confined(scope, cwd, join(cwd, ".claude", "specs", "2026-08-12-foo", "nested", "x.md"))).toBe("allow");
    expect(confined(scope, cwd, ".claude/specs/2026-08-12-foo/relative.md")).toBe("allow");
    // Sibling dirs must not match.
    expect(confined(scope, cwd, join(cwd, ".claude", "specs", "2026-08-12-foo-other", "x.md"))).toBe("block");
    expect(confined(scope, cwd, join(cwd, ".claude", "specs2", "x.md"))).toBe("block");
    expect(confined(scope, cwd, join(cwd, "README.md"))).toBe("block");
    expect(confined(scope, cwd, join(cwd, ".claude", "state", "active_task_graph.json"))).toBe("block");
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
    expect(confined(scope, cwd, join(cwd, ".claude", "specs", "2026-08-12-foo", "escape", "x.md"))).toBe("block");
    // A symlink OUTSIDE the scope pointing INSIDE: writes through it stay
    // inside the real artifact tree and are admitted.
    symlinkSync(join(cwd, ".claude", "specs", "2026-08-12-foo"), join(outside, "link-in"));
    expect(confined(scope, cwd, join(outside, "link-in", "spec.md"))).toBe("allow");
  });

  // A target that cannot be canonicalised — a symlink loop (ELOOP), or a
  // dangling symlink a write would follow out of the scope — must never read
  // as "inside the scope". It leaves the targets unresolved, and core refuses
  // a scoped write it cannot place.
  it("refuses an uncanonicalisable target (ELOOP, dangling symlink) instead of widening the scope", () => {
    const { cwd } = fixture();
    const specs = join(cwd, ".claude", "specs", "2026-08-12-foo");
    mkdirSync(specs, { recursive: true });
    const scope = [specs + "/"];

    // Two symlinks pointing at each other: resolving either throws ELOOP.
    symlinkSync(join(specs, "b"), join(specs, "a"));
    symlinkSync(join(specs, "a"), join(specs, "b"));
    expect(confined(scope, cwd, join(specs, "a", "spec.md"))).toBe("block");

    symlinkSync(join(root, "elsewhere", "x.md"), join(specs, "dangling.md"));
    expect(confined(scope, cwd, join(specs, "dangling.md"))).toBe("block");
  });

  it("grantWriteScope: unscoped grants confine nothing; scope dirs canonicalise by their real location", () => {
    const { cwd } = fixture();
    expect(grantWriteScope(undefined, cwd, cwd)).toBeUndefined();
    expect(grantWriteScope([], cwd, cwd)).toBeUndefined();
    const real = join(cwd, ".claude", "specs", "real");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(cwd, ".claude", "specs", "alias"));
    expect(grantWriteScope([join(cwd, ".claude", "specs", "alias") + "/"], realpathSync(cwd), cwd))
      .toEqual({ kind: "resolved", dirs: [realpathSync(real)] });
  });

  it("grantWriteScope: a tool cwd that is not the grant's authorizing cwd refuses every guarded write", () => {
    const { cwd } = fixture();
    const other = join(root, "other-cwd");
    mkdirSync(other);
    const scope = grantWriteScope([join(cwd, ".claude", "specs", "x") + "/"], realpathSync(cwd), other);
    expect(scope).toMatchObject({ kind: "unresolved" });
    if (scope?.kind === "unresolved") expect(scope.reason).toContain("is not the grant's authorizing cwd");
  });

  it("grantWriteScope: a scoped grant that recorded no authorizing cwd fails closed", () => {
    const { cwd } = fixture();
    expect(grantWriteScope([join(cwd, ".claude", "specs", "x") + "/"], undefined, cwd))
      .toEqual({ kind: "unresolved", reason: "the grant recorded no authorizing cwd" });
    // An unscoped grant has nothing to confine, recorded cwd or not.
    expect(grantWriteScope(undefined, undefined, cwd)).toBeUndefined();
  });

  it("grantWriteScope: an uncanonicalisable scope dir is unresolved", () => {
    const { cwd } = fixture();
    const loop = join(cwd, ".claude", "loop");
    symlinkSync(loop, loop);
    expect(grantWriteScope([join(loop, "specs") + "/"], realpathSync(cwd), cwd))
      .toEqual({ kind: "unresolved", reason: `cannot canonicalize scope dir ${join(loop, "specs")}/` });
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
