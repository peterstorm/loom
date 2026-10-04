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

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
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
import { SUBAGENT_DIR, pathExistsFailClosed } from "../../../src/config";
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
    // Only architecture writes the plan tree.
    expect(decide([entry(CALLER, "specify-agent")], CALLER, PLAN).kind).toBe("block");
    expect(decide([entry(CALLER, "plan-alignment-agent")], CALLER, PLAN).kind).toBe("block");
  });

  it("architecture writes its plan, spec-tree files, and lint rules — and nothing else", () => {
    const architecture = [entry(CALLER, "architecture-agent")];
    expect(decide(architecture, CALLER, PLAN).kind).toBe("allow");
    expect(decide(architecture, CALLER, SPEC).kind).toBe("allow");
    expect(decide(architecture, CALLER, "/proj/.claude/linter/rules/inv-1-pure-core.json").kind).toBe("allow");
    expect(decide(architecture, CALLER, "/proj/.pi/linter/rules/inv-1-pure-core.json").kind).toBe("allow");
    const outside = decide(architecture, CALLER, "/proj/src/index.ts");
    expect(outside.kind).toBe("block");
    if (outside.kind === "block") {
      for (const root of [".claude/plans/", ".claude/specs/", ".claude/linter/rules/", ".pi/linter/rules/"]) {
        expect(outside.message).toContain(`/proj/${root}`);
      }
    }
    // Neighbours of the lint-rule dir stay outside.
    expect(decide(architecture, CALLER, "/proj/.claude/linter/config.json").kind).toBe("block");
    expect(decide(architecture, CALLER, "/proj/.claude/state/active_task_graph.json").kind).toBe("block");
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

  it("a MultiEdit from a writer carries its file_path and agent_id into an admitted request", () => {
    const d = project();
    const request = artifactWriteRequest(input({ cwd: d, agent_id: "a1", tool_name: "MultiEdit", tool_input: { file_path: ".claude/specs/foo/spec.md", edits: [] } }), d);
    expect(request).toEqual({ callerAgentId: "a1", targetPath: join(d, ".claude/specs/foo/spec.md"), projectRoot: d });
    expect(shouldBlockDirectEdit("MultiEdit", s, orchestrating, roster(entry("a1", "specify-agent")), request).kind).toBe("allow");
  });

  it("an unresolvable project root yields no request AND announces the cause on stderr", () => {
    const d = project();
    const dangling = join(d, "dangling-root");
    symlinkSync(join(d, "nowhere"), dangling);
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      expect(artifactWriteRequest(input({ cwd: d, agent_id: "a1", tool_input: { file_path: "x.md" } }), dangling)).toBeUndefined();
    } finally {
      stderr.mockRestore();
    }
    expect(written.join("")).toContain(`cannot canonicalize project root ${dangling}`);
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

  it("JSON that is not a hook payload (null, wrong shape) → block, never a crash", async () => {
    for (const stdin of ["null", "42", "[]", '{"tool_name":"Edit"}', '{"tool_input":{}}']) {
      const result = await blockDirectEdits(stdin, []);
      expect(result.kind, stdin).toBe("block");
      if (result.kind === "block") expect(result.message, stdin).toContain("malformed hook input");
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

describe("shouldBlockDirectEdit — the arming port is required (lazy-arming doctrine)", () => {
  it("the probe decides: a proven-absent graph allows, a proven-present graph blocks", () => {
    // The probe-to-decision mapping the lazy-arming doctrine pins: the SAME
    // session must ALLOW when the injected probe proves no task graph and
    // BLOCK when it proves one — the arming decision is the probe's, made at
    // call time, never the module's (the old round-40 concern — fail-closed
    // arming — now lives in the probe itself, `pathExistsFailClosed`).
    expect(shouldBlockDirectEdit("Edit", sNoActive, () => false).kind).toBe("allow");
    expect(shouldBlockDirectEdit("Edit", sNoActive, () => true).kind).toBe("block");
    // Type-level pin: omitting the required port is a COMPILE error — no
    // frozen default stands in for the arming decision. Typed, never executed.
    // @ts-expect-error the task-graph port is required — no frozen default stands in
    const omitted: Parameters<typeof shouldBlockDirectEdit> = ["Edit", sNoActive];
    void omitted;
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

  /**
   * The shared ELOOP fixture: both announcement cases below prove the SAME
   * probe through the SAME failure (a self-referencing symlink roster), so the
   * setup lives once here and each test keeps only the assertion that makes it
   * distinct.
   */
  const eloopAnnouncement = (): { result: ReturnType<typeof activeRosterProbe>; written: string[] } => {
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
      return { result: activeRosterProbe(session), written };
    } finally {
      stderr.mockRestore();
    }
  };

  it("an ELOOP roster returns null AND announces the cause on stderr", () => {
    const { result, written } = eloopAnnouncement();
    expect(result).toBeNull();
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

  it("the announcement names the ELOOP cause family", () => {
    // Same probe, same failure as the case above — this test keeps only its
    // distinguishing assertion: the cause WORD must be ELOOP (or the label a
    // Node upgrade substitutes for it), which pinning the exact current
    // message alone would not survive.
    const { result, written } = eloopAnnouncement();
    expect(result).toBeNull();
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

describe("shouldBlockDirectEdit — panel-artifact admission (grammar-constrained-decoding seam gap)", () => {
  /**
   * The panel templates promise write capability the guard once did not admit:
   * the interviewer writes the run's interview digest and the designer writes
   * one candidate per lens under the run's panel-runs dir ("a spawn with no
   * scoped Pi write grant fails confusingly at its first edit"). On Claude Code
   * that capability is the ONE caller-identity admission (`ArtifactWriteRequest`
   * + `artifactWriteRoots`): the CALLING panel writer may write under the spec
   * tree, and nothing else on the roster lends it that capability.
   */
  const PROJECT = "/proj";
  const INTERVIEWER = "a339f6fd51d78b179";
  const JUDGE = "b448e7fe62e89c280";
  const request = (callerAgentId: string | null, targetPath: string | null) =>
    ({ callerAgentId, targetPath, projectRoot: PROJECT });
  const panel = roster(entry(JUDGE, "arch-judge-agent"), entry(INTERVIEWER, "arch-interviewer-agent"));
  const decide = (callerAgentId: string | null, targetPath: string | null) =>
    shouldBlockDirectEdit("Write", s, orchestrating, panel, request(callerAgentId, targetPath)).kind;

  it("allows each panel writer role on its run's panel-runs artifact path", () => {
    expect(decide(INTERVIEWER, "/proj/.claude/specs/2026-09-16-grammar-constrained-decoding/panel-runs/run-1/interview.md")).toBe("allow");
    const designer = roster(entry("opaque-designer", "arch-designer-agent"));
    expect(shouldBlockDirectEdit("Write", s, orchestrating, designer,
      request("opaque-designer", "/proj/.claude/specs/slug/panel-runs/run-1/candidates/candidate-lens.md")).kind).toBe("allow");
  });

  it("finds the caller's entry anywhere on the roster, not only the first", () => {
    // The judge is listed first; the interviewer caller is still recognised.
    expect(decide(INTERVIEWER, "/proj/.claude/specs/slug/panel-runs/run-1/interview.md")).toBe("allow");
  });

  it("blocks a panel writer targeting outside the spec tree, including a normalizing `..` escape", () => {
    for (const evil of [
      "/proj/.claude/plans/plan.md",
      "/proj/engine/src/core/x.ts",
      "/outside.md",
      "/proj/.claude/specs/../state/active_task_graph.json",
    ]) {
      expect(decide(INTERVIEWER, evil), evil).toBe("block");
    }
  });

  it("blocks a panel writer with NO provable target — fail closed", () => {
    expect(decide(INTERVIEWER, null)).toBe("block");
  });

  it("blocks the judge on an in-scope target even beside an active panel writer — read-only role", () => {
    expect(decide(JUDGE, "/proj/.claude/specs/slug/panel-runs/run-1/candidates/candidate-lens.md")).toBe("block");
  });

  it("blocks the main agent (no caller) while a panel writer is active — the writer's role is not lent out", () => {
    expect(decide(null, "/proj/.claude/specs/slug/panel-runs/run-1/interview.md")).toBe("block");
  });

  it("keeps the impl admission untouched: the request is irrelevant to it", () => {
    const impl = roster(entry("code-implementer-agent"));
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, impl).kind).toBe("allow");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, impl, request(null, "/etc/passwd")).kind).toBe("allow");
  });

  it("both admissions share ONE roster probe", () => {
    const probe = vi.fn<ActiveRosterProbe>(() => [entry(INTERVIEWER, "arch-interviewer-agent")]);
    shouldBlockDirectEdit("Write", s, orchestrating, probe, request(INTERVIEWER, "/proj/.claude/specs/slug/panel-runs/run-1/interview.md"));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a traversal session id still fails CLOSED before the artifact admission", () => {
    const probe = vi.fn<ActiveRosterProbe>(() => [entry(INTERVIEWER, "arch-interviewer-agent")]);
    const result = shouldBlockDirectEdit("Write", "../../etc", orchestrating, probe, request(INTERVIEWER, "/proj/.claude/specs/x.md"));
    expect(result.kind).toBe("block");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("block-direct-edits handler — artifact-writer admission (end-to-end wiring)", () => {
  /**
   * The wiring proof the array-fixture cases above deliberately do not carry:
   * the handler reads the real roster, canonicalizes the raw file_path against
   * the hook's cwd and project dir, and hands core the CALLER's identity — so a
   * real .claude/specs target admits the calling panel writer, while an
   * outside-the-project target and a main-agent call stay blocked. The guard is
   * armed HERE, not by the checkout: `LOOM_STATE_PATH` is re-pointed at a
   * per-suite temp State File (the lazy resolver the handler probes reads it at
   * decision time), so the assertions hold on a fresh CI checkout exactly as
   * they do in a checkout hosting a live orchestration run — a test that
   * silently depended on the developer's state file passed locally and allowed
   * every edit on CI.
   */
  const statePath = join(tmpdir(), `block-direct-armed-${process.pid}.json`);
  const originalStatePath = process.env.LOOM_STATE_PATH;
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  const project = realpathSync(mkdtempSync(join(tmpdir(), "loom-handler-artifact-")));
  const CALLER = "a339f6fd51d78b179";

  beforeEach(() => {
    writeFileSync(statePath, "{}");
    process.env.LOOM_STATE_PATH = statePath;
    process.env.CLAUDE_PROJECT_DIR = project;
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), `${CALLER}\tarch-interviewer-agent\n`);
  });

  afterEach(() => {
    if (originalStatePath === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = originalStatePath;
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    rmSync(statePath, { force: true });
  });

  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
  });

  const run = (over: Record<string, unknown>) => blockDirectEdits(JSON.stringify({
    tool_name: "Write",
    session_id: s,
    cwd: project,
    ...over,
  }), []);

  it("a real .claude/specs target admits the calling panel writer", async () => {
    const target = join(project, ".claude", "specs", "panel-runs", `run-${process.pid}`, "interview.md");
    expect((await run({ agent_id: CALLER, tool_input: { file_path: target } })).kind).toBe("allow");
  });

  it("an outside-the-project target stays blocked for the panel writer", async () => {
    const result = await run({ agent_id: CALLER, tool_input: { file_path: join(tmpdir(), `outside-${process.pid}.md`) } });
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("arch-interviewer-agent may write only its artifacts");
  });

  it("the main agent (no agent_id) stays blocked on the same in-scope target", async () => {
    const target = join(project, ".claude", "specs", "panel-runs", `run-${process.pid}`, "interview.md");
    const result = await run({ tool_input: { file_path: target } });
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("BLOCKED: Direct edits not allowed");
  });
});
