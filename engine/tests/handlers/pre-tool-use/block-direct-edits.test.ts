/**
 * shouldBlockDirectEdit — the session id from hook input is PARSED before the
 * roster port is handed one (Fix: raw interpolation bypassed the SessionId
 * brand). An unparseable id fails CLOSED (block): allowing would open direct
 * edits on malformed input.
 *
 * The roster arrives through the injected `ActiveRosterProbe`, so the
 * authorization rule is exercised with plain arrays. Reading the `.active` file
 * is the ADAPTER's job and is tested once, against real files, at the bottom —
 * rather than every authorization case paying for filesystem setup to reach a
 * decision that never touches the filesystem.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, mkdtempSync, chmodSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldBlockDirectEdit,
  type ActiveRosterEntry,
  type ActiveRosterProbe,
} from "../../../src/core/block-direct-edits";
import blockDirectEdits, {
  activeRosterProbe,
  artifactWriteRequest,
  canonicalWritePath,
} from "../../../src/handlers/pre-tool-use/block-direct-edits";
import { SUBAGENT_DIR, TASK_GRAPH_PATH, pathExistsFailClosed } from "../../../src/config";
import { parseSessionId } from "../../../src/machine/evidence";

const orchestrating = () => true;

/** chmod 0o000 denies nothing to root; skip the EACCES case there instead of
 *  asserting a permission the OS is not enforcing. */
function readableAsRoot(path: string): boolean {
  try { readFileSync(path); return true; } catch { return false; }
}
const s = `block-direct-${process.pid}-${Date.now()}`;
// A session that never gets an .active file — used by the default-probe test
// so a leftover active-file fixture from earlier cases cannot mask the gate.
const sNoActive = `${s}-no-active`;

/** A roster row, with the brands the port's element type carries. */
const entry = (agentId: string, agentType: string | null = null): ActiveRosterEntry =>
  ({ agentId, agentType } as ActiveRosterEntry);

/** A probe answering with a fixed roster, for every session. */
const roster = (...entries: readonly ActiveRosterEntry[]): ActiveRosterProbe => () => entries;

/** A probe that cannot prove anyone is active. */
const noRoster: ActiveRosterProbe = () => null;

afterAll(() => {
  rmSync(join(SUBAGENT_DIR, `${s}.active`), { force: true });
  rmSync(join(SUBAGENT_DIR, `${sNoActive}.active`), { force: true });
});

describe("shouldBlockDirectEdit — session-id parse boundary", () => {
  it("non-file tools always pass", () => {
    expect(shouldBlockDirectEdit("Bash", s, orchestrating, noRoster).kind).toBe("allow");
  });

  it("no active subagent → block every supported file mutation tool", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "edit", "write", "multi_edit"]) {
      expect(shouldBlockDirectEdit(tool, s, orchestrating, noRoster).kind, tool).toBe("block");
    }
  });

  it("an EMPTY roster is not an active subagent", () => {
    // A roster that exists but names nobody proves nothing.
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, roster()).kind).toBe("block");
  });

  it("active subagent → allow", () => {
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, roster(entry("code-implementer-agent"))).kind).toBe("allow");
  });

  it("active write-grant agent → allow", () => {
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, roster(entry("pi-grant-abcdef0123456789"))).kind).toBe("allow");
  });

  it("active review agent → block (read-only role)", () => {
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, roster(entry("code-reviewer"))).kind).toBe("block");
  });

  // On Claude Code `agent_id` is an opaque handle, so identity alone can never
  // match IMPL_AGENTS (which holds agent-type NAMES) and every implementation
  // subagent was blocked by the guard meant to let it through. The roster's
  // type column is what answers "may this agent write?".
  describe("authorization by recorded role", () => {
    const decide = (...entries: readonly ActiveRosterEntry[]) =>
      shouldBlockDirectEdit("Edit", s, orchestrating, roster(...entries)).kind;

    it("allows an opaque Claude agent id carrying an implementation role", () => {
      expect(decide(entry("a339f6fd51d78b179", "code-implementer-agent"))).toBe("allow");
    });

    it("allows every implementation role, not just the machine-gated one", () => {
      // Only code-implementer-agent ships a .machine definition, so a
      // binding-based lookup would still strand these.
      for (const role of ["adr-writer-agent", "ts-test-agent", "frontend-agent"]) {
        expect(decide(entry(`opaque${role.length}`, role)), role).toBe("allow");
      }
    });

    it("still blocks an opaque id carrying a read-only role", () => {
      expect(decide(entry("b448e7fe62e89c280", "code-reviewer"))).toBe("block");
    });

    it("blocks an opaque id with no recorded role", () => {
      // Unknown role must not be guessed into authorization.
      expect(decide(entry("c559f80f73f90d391"))).toBe("block");
    });

    it("authorizes on any active entry, not only the first", () => {
      expect(decide(
        entry("d66a091084a01e4a2", "code-reviewer"),
        entry("e77b1a2195b12f5b3", "code-implementer-agent"),
      )).toBe("allow");
    });

    // Pi writes single-column lines (it passes no type) and authorizes via the
    // `pi-grant-` capability prefix. Both must keep working untouched.
    it("keeps Pi write-grant and legacy single-column rosters working", () => {
      expect(decide(entry("pi-grant-abcdef0123456789"))).toBe("allow");
      expect(decide(entry("code-implementer-agent"))).toBe("allow");
    });

    // The write-grant capability is the NAMESPACE, not a suffix shape: the
    // grant record is burned at mint time, so nothing downstream can re-verify
    // a digest, and `parseGrantedAgentId` deliberately admits any binding-safe
    // id inside it. What makes that safe is exclusivity at the other end —
    // `parseReportedAgentId` refuses the namespace for harness-reported ids, so
    // a self-reported id can never reach this roster wearing it. These pin both
    // halves, so a future "tighten the suffix" change cannot quietly stand in
    // for the exclusivity that is actually load-bearing.
    it("admits any binding-SAFE id inside the write-grant namespace", () => {
      for (const id of ["pi-grant-abcdef0123456789", "pi-grant-xyz", "pi-grant-"]) {
        expect(decide(entry(id)), id).toBe("allow");
      }
    });

    it("blocks a near-miss OUTSIDE the namespace, and unsafe ids inside it", () => {
      // Outside the namespace: prefix resemblance is not membership.
      expect(decide(entry("pi-granted-abcdef0123456789"))).toBe("block");
      expect(decide(entry("pi-grant"))).toBe("block");
      // Inside it, but rejected by the binding/path rules parseAgentId applies.
      for (const unsafe of ["pi-grant-a/b", "pi-grant-a b", "pi-grant-..", "pi-grant-a:b"]) {
        expect(decide(entry(unsafe)), unsafe).toBe("block");
      }
    });
  });

  it("a traversal session id fails CLOSED — block, and the roster port is never called", () => {
    for (const evil of ["../../etc", "a/b", "..", "a b", ""]) {
      const probe = vi.fn<ActiveRosterProbe>(() => [entry("code-implementer-agent")]);
      const result = shouldBlockDirectEdit("Write", evil, orchestrating, probe);
      expect(result.kind).toBe("block");
      if (result.kind === "block") expect(result.message).toContain("invalid session id");
      // Even an authorizing roster must not rescue an unparseable id, and the
      // port must never receive one — an adapter may put it in a path.
      expect(probe).not.toHaveBeenCalled();
    }
  });

  it("no task graph → allow regardless of session id", () => {
    expect(shouldBlockDirectEdit("Edit", "../../etc", () => false, noRoster).kind).toBe("allow");
  });

  it("hands the port the BRANDED session id, not the raw string", () => {
    const probe = vi.fn<ActiveRosterProbe>(() => null);
    shouldBlockDirectEdit("Edit", s, orchestrating, probe);
    expect(probe).toHaveBeenCalledWith(parseSessionId(s));
  });

  // No filesystem default: a default that read the shell would put back the
  // very import the port exists to remove from the functional core.
  it("defaults to 'cannot prove anyone is active' when no port is supplied", () => {
    expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("block");
  });
});

// Phase agents (specify, architecture, …) and panel writers must be able to
// write the artifacts their templates promise — but only the CALLING agent's
// role counts, and only inside that role's roots.
describe("shouldBlockDirectEdit — artifact writers (Claude Code caller admission)", () => {
  const PROJECT = "/proj";
  const SPEC = "/proj/.claude/specs/2026-10-02-foo/spec.md";
  const PLAN = "/proj/.claude/plans/2026-10-02-foo.md";
  const CALLER = "a339f6fd51d78b179";

  const decide = (
    entries: readonly ActiveRosterEntry[],
    callerAgentId: string | null,
    targetPath: string | null,
    projectRoot = PROJECT,
  ) => shouldBlockDirectEdit("Write", s, orchestrating, roster(...entries), { callerAgentId, targetPath, projectRoot });

  it("phase writer inside its root → allow", () => {
    expect(decide([entry(CALLER, "specify-agent")], CALLER, SPEC).kind).toBe("allow");
    expect(decide([entry(CALLER, "architecture-agent")], CALLER, PLAN).kind).toBe("allow");
    expect(decide([entry(CALLER, "loom:plan-alignment-agent")], CALLER, SPEC).kind).toBe("allow");
  });

  it("phase writer outside its root → block naming the allowed roots", () => {
    const result = decide([entry(CALLER, "specify-agent")], CALLER, "/proj/src/index.ts");
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("specify-agent may write only its artifacts");
      expect(result.message).toContain("/proj/src/index.ts");
      expect(result.message).toContain("/proj/.claude/specs/");
    }
    // The other phase's root is outside too.
    expect(decide([entry(CALLER, "specify-agent")], CALLER, PLAN).kind).toBe("block");
    expect(decide([entry(CALLER, "architecture-agent")], CALLER, SPEC).kind).toBe("block");
  });

  it("the root itself, a sibling prefix, and `..` escapes are outside", () => {
    const specify = [entry(CALLER, "specify-agent")];
    expect(decide(specify, CALLER, "/proj/.claude/specs").kind).toBe("block");
    expect(decide(specify, CALLER, "/proj/.claude/specs-evil/x.md").kind).toBe("block");
    expect(decide(specify, CALLER, "/proj/.claude/specs/../hooks/x.sh").kind).toBe("block");
    expect(decide(specify, CALLER, "/proj/.claude/specs/a/../../../etc/passwd").kind).toBe("block");
    // A file whose NAME starts with `..` is still inside.
    expect(decide(specify, CALLER, "/proj/.claude/specs/..notes.md").kind).toBe("allow");
  });

  it("non-absolute or unresolvable inputs are never admitted", () => {
    const specify = [entry(CALLER, "specify-agent")];
    expect(decide(specify, CALLER, ".claude/specs/x/spec.md").kind).toBe("block");
    expect(decide(specify, CALLER, null).kind).toBe("block");
    expect(decide(specify, CALLER, "/proj/.claude/specs/x/spec.md", "proj").kind).toBe("block");
  });

  it("main agent (null caller) is blocked even while a phase agent is active", () => {
    const result = decide([entry(CALLER, "specify-agent")], null, SPEC);
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("Direct edits not allowed");
  });

  it("a caller id that is not on the roster is blocked", () => {
    expect(decide([entry(CALLER, "specify-agent")], "f00000000000000000", SPEC).kind).toBe("block");
  });

  it("a caller with no recorded role is blocked", () => {
    expect(decide([entry(CALLER)], CALLER, SPEC).kind).toBe("block");
  });

  it("read-only roles are blocked inside the roots, even beside an active phase writer", () => {
    for (const role of ["code-reviewer", "arch-judge-agent", "review-verifier-agent", "decompose-agent"]) {
      const result = decide([entry("writer0000000000", "specify-agent"), entry(CALLER, role)], CALLER, SPEC);
      expect(result.kind, role).toBe("block");
      if (result.kind === "block") expect(result.message, role).toContain("Direct edits not allowed");
    }
  });

  it("panel writer inside specs → allow; inside plans → block", () => {
    for (const role of ["arch-interviewer-agent", "arch-designer-agent"]) {
      expect(decide([entry(CALLER, role)], CALLER, "/proj/.claude/specs/x/panel-runs/run.y/interview.md").kind, role).toBe("allow");
      expect(decide([entry(CALLER, role)], CALLER, PLAN).kind, role).toBe("block");
    }
  });

  it("does not loosen the implementation admission or the no-task-graph pass", () => {
    expect(decide([entry(CALLER, "code-implementer-agent")], null, "/anywhere/x.ts").kind).toBe("allow");
    expect(shouldBlockDirectEdit("Write", s, () => false, noRoster, { callerAgentId: null, targetPath: null, projectRoot: PROJECT }).kind).toBe("allow");
  });
});

describe("artifactWriteRequest — the handler's canonicalization shell", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const project = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "loom-artifact-write-")));
    dirs.push(d);
    mkdirSync(join(d, ".claude", "specs", "foo"), { recursive: true });
    return d;
  };
  const input = (over: Record<string, unknown>) => ({
    tool_name: "Write", tool_input: {}, session_id: s, ...over,
  }) as Parameters<typeof artifactWriteRequest>[0];

  it("resolves a relative file_path against cwd and canonicalizes not-yet-existing files", () => {
    const d = project();
    const request = artifactWriteRequest(input({ cwd: d, agent_id: "a1", tool_input: { file_path: ".claude/specs/foo/new/spec.md" } }), d);
    expect(request).toEqual({ callerAgentId: "a1", targetPath: join(d, ".claude/specs/foo/new/spec.md"), projectRoot: d });
  });

  it("main-agent calls carry a null caller; non-file tools a null target", () => {
    const d = project();
    expect(artifactWriteRequest(input({ cwd: d, tool_input: { file_path: "x.md" } }), d)?.callerAgentId).toBeNull();
    expect(artifactWriteRequest(input({ cwd: d, tool_name: "Bash", tool_input: { command: "ls" } }), d)?.targetPath).toBeNull();
  });

  it("a symlinked dir inside the specs root resolves to where it really points — and is blocked", () => {
    const d = project();
    const outside = join(d, "src");
    mkdirSync(outside);
    symlinkSync(outside, join(d, ".claude", "specs", "foo", "escape"));
    const request = artifactWriteRequest(input({ cwd: d, agent_id: "a1", tool_input: { file_path: join(d, ".claude/specs/foo/escape/evil.ts") } }), d);
    expect(request?.targetPath).toBe(join(outside, "evil.ts"));
    const result = shouldBlockDirectEdit("Write", s, orchestrating, roster(entry("a1", "specify-agent")), request);
    expect(result.kind).toBe("block");
    // The honest path through the same project is admitted.
    const honest = artifactWriteRequest(input({ cwd: d, agent_id: "a1", tool_input: { file_path: join(d, ".claude/specs/foo/spec.md") } }), d);
    expect(shouldBlockDirectEdit("Write", s, orchestrating, roster(entry("a1", "specify-agent")), honest).kind).toBe("allow");
  });

  it("a dangling symlink target is unresolvable (a write would follow it out)", () => {
    const d = project();
    const link = join(d, ".claude", "specs", "foo", "dangling.md");
    symlinkSync(join(d, "nowhere", "x.md"), link);
    expect(canonicalWritePath(link)).toBeNull();
    expect(artifactWriteRequest(input({ cwd: d, agent_id: "a1", tool_input: { file_path: link } }), d)?.targetPath).toBeNull();
  });

  it("a symlinked project dir canonicalizes to its real path", () => {
    const d = project();
    const alias = join(d, "..", `${d.split("/").pop()}-alias`);
    symlinkSync(d, alias);
    dirs.push(alias);
    const request = artifactWriteRequest(input({ cwd: alias, agent_id: "a1", tool_input: { file_path: ".claude/specs/foo/spec.md" } }), alias);
    expect(request).toMatchObject({ projectRoot: d, targetPath: join(d, ".claude/specs/foo/spec.md") });
  });
});

describe("activeRosterProbe — the adapter that reads the .active file", () => {
  const write = (contents: string) => {
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), contents);
  };
  const read = () => activeRosterProbe(parseSessionId(s)!);

  it("answers null when no flag file exists", () => {
    rmSync(join(SUBAGENT_DIR, `${s}.active`), { force: true });
    expect(read()).toBeNull();
  });

  it("answers null for an EMPTY flag file — a zero-byte roster proves nothing", () => {
    write("");
    expect(read()).toBeNull();
  });

  it("reads a two-column roster into id/type pairs", () => {
    write("a339f6fd51d78b179\tcode-implementer-agent\n");
    expect(read()).toEqual([{ agentId: "a339f6fd51d78b179", agentType: "code-implementer-agent" }]);
  });

  it("reads a legacy single-column roster with a null type", () => {
    write("code-implementer-agent\n");
    expect(read()).toEqual([{ agentId: "code-implementer-agent", agentType: null }]);
  });

  it("feeds the gate end-to-end: a real roster file authorizes a real edit", () => {
    // The wiring proof the array-fixture cases above deliberately do not carry.
    write("a339f6fd51d78b179\tcode-implementer-agent\n");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, activeRosterProbe).kind).toBe("allow");

    write("b448e7fe62e89c280\tcode-reviewer\n");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, activeRosterProbe).kind).toBe("block");
  });
});

describe("block-direct-edits handler — malformed stdin fails CLOSED (round-11)", () => {
  it("non-JSON stdin → block, never a rethrow or a silent allow", async () => {
    // A parse crash exits 1 which is NON-blocking for PreToolUse — it would
    // wave the edit past the direct-edit guard. Fail CLOSED instead.
    const result = await blockDirectEdits("{not json", []);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("malformed hook input");
    }
  });
});

describe("pathExistsFailClosed — fail-closed existence probe (round-40 C1/C2)", () => {
  const absent = join(tmpdir(), `loom-absent-${process.pid}-${Date.now()}`);

  it("ENOENT is the only absent answer", () => {
    expect(pathExistsFailClosed(absent)).toBe(false);
  });

  it("an existing path is present", () => {
    expect(pathExistsFailClosed(process.cwd())).toBe(true);
  });

  it("a non-ENOENT access error (ELOOP symlink loop) assumes present — fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-failclosed-"));
    try {
      const loop = join(dir, "loop");
      symlinkSync(loop, loop); // self-referencing symlink → ELOOP on access
      expect(pathExistsFailClosed(loop)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shouldBlockDirectEdit — default task-graph probe fails CLOSED (round-40 C1)", () => {
  it("the default probe is the fail-closed probe (unreadable paths stay armed)", () => {
    // Wiring regression guard: the default must be pathExistsFailClosed, whose
    // non-ENOENT branch keeps the gate armed (exercised above via ELOOP).
    const viaDefault = shouldBlockDirectEdit("Edit", sNoActive);
    const viaFailClosed = shouldBlockDirectEdit("Edit", sNoActive, () => pathExistsFailClosed(TASK_GRAPH_PATH));
    expect(viaDefault.kind).toBe(viaFailClosed.kind);
  });
});

describe("activeRosterProbe — the adapter's catch branch (round-41 A2)", () => {
  /**
   * The probe's own comment promises the failure is ANNOUNCED rather than
   * swallowed: "silence here would make a permissions or race problem
   * indistinguishable from 'no subagent active'". The ELOOP case for the
   * sibling `pathExistsFailClosed` was pinned; this branch was not, so the
   * promise rested on reading the code.
   *
   * Reached through a REAL failure — a roster file that exists and is
   * non-empty but cannot be read — rather than by stubbing `readActiveAgentRoles`,
   * so the test proves the adapter converts what the filesystem actually throws.
   */
  const dirs: string[] = [];
  const originalSubagentDir = process.env.LOOM_SUBAGENT_DIR;

  afterAll(() => {
    if (originalSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
    else process.env.LOOM_SUBAGENT_DIR = originalSubagentDir;
    for (const dir of dirs) {
      try { chmodSync(dir, 0o700); } catch { /* best effort before removal */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an ELOOP roster returns null AND announces the cause on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-roster-eloop-"));
    dirs.push(dir);
    process.env.LOOM_SUBAGENT_DIR = dir;
    const session = parseSessionId(`roster-eloop-${process.pid}`)!;
    const active = join(dir, `${session}.active`);
    symlinkSync(active, active);

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(activeRosterProbe(session)).toBeNull();
    } finally {
      stderr.mockRestore();
    }
    expect(written.join("")).toContain("block-direct-edits: cannot check");
    expect(written.join("")).toContain("ELOOP");
  });

  it("an unreadable roster file returns null AND announces the cause on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-roster-eacces-"));
    dirs.push(dir);
    process.env.LOOM_SUBAGENT_DIR = dir;
    const session = parseSessionId(`roster-eacces-${process.pid}`)!;
    const active = join(dir, `${session}.active`);
    writeFileSync(active, "agent-1\tcode-reviewer\n");
    chmodSync(active, 0o000);
    if (readableAsRoot(active)) return; // running as root: the mode is not enforced

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(activeRosterProbe(session)).toBeNull();
    } finally {
      stderr.mockRestore();
    }
    expect(written.join("")).toContain("block-direct-edits: cannot check");
    expect(written.join("")).toContain("falling through to block");
  });

  it("an unstatable roster path returns null AND announces the cause on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-roster-eloop-"));
    dirs.push(dir);
    process.env.LOOM_SUBAGENT_DIR = dir;
    const session = parseSessionId(`roster-eloop-${process.pid}`)!;
    const active = join(dir, `${session}.active`);
    symlinkSync(active, active);

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(activeRosterProbe(session)).toBeNull();
    } finally {
      stderr.mockRestore();
    }
    expect(written.join("")).toContain("block-direct-edits: cannot check");
    expect(written.join("")).toMatch(/ELOOP|symbolic link/i);
  });

  it("null from the probe makes the gate fail CLOSED", () => {
    const session = parseSessionId(`roster-null-${process.pid}`)!;
    expect(shouldBlockDirectEdit("Edit", session, orchestrating, () => null).kind).toBe("block");
  });

  it("an absent roster file answers null without entering the catch (no diagnostic)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-roster-absent-"));
    dirs.push(dir);
    process.env.LOOM_SUBAGENT_DIR = dir;
    const session = parseSessionId(`roster-absent-${process.pid}`)!;

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(activeRosterProbe(session)).toBeNull();
    } finally {
      stderr.mockRestore();
    }
    expect(written.join("")).toBe("");
  });
});
