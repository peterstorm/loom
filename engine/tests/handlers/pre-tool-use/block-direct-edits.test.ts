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

import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import fc from "fast-check";
import { execFileSync } from "node:child_process";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, mkdtempSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editPlacement,
  guardedByRoot,
  shouldBlockDirectEdit,
  UNRESOLVED,
  type ActiveRosterEntry,
  type ActiveRosterProbe,
  type EditPlacement,
  type EditTargets,
  type OrchestratedRepository,
} from "../../../src/core/block-direct-edits";
import blockDirectEdits, {
  activeRosterProbe,
  artifactWriteRequest,
  canonicalEditTargets,
  canonicalWritePath,
  orchestratedRepositoryOf,
} from "../../../src/handlers/pre-tool-use/block-direct-edits";
import { SUBAGENT_DIR, pathExistsFailClosed } from "../../../src/config";
import { parseSessionId } from "../../../src/machine/evidence";
import { sessionIdOf } from "../../fixtures/machine-identities";

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
  ) => shouldBlockDirectEdit("Write", s, orchestrating, roster(...entries), { artifactWrite: { callerAgentId, targetPath, projectRoot } });

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
    expect(shouldBlockDirectEdit("Write", s, () => false, noRoster, { artifactWrite: { callerAgentId: null, targetPath: null, projectRoot: PROJECT } }).kind).toBe("allow");
  });
});

describe("artifactWriteRequest — the handler's canonicalization shell", () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const project = () => {
    const d = canonicalTempDir("loom-artifact-write-");
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
    const result = shouldBlockDirectEdit("Write", s, orchestrating, roster(entry("a1", "specify-agent")), { artifactWrite: request });
    expect(result.kind).toBe("block");
    // The honest path through the same project is admitted.
    const honest = artifactWriteRequest(input({ cwd: d, agent_id: "a1", tool_input: { file_path: join(d, ".claude/specs/foo/spec.md") } }), d);
    expect(shouldBlockDirectEdit("Write", s, orchestrating, roster(entry("a1", "specify-agent")), { artifactWrite: honest }).kind).toBe("allow");
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
    expect(shouldBlockDirectEdit("MultiEdit", s, orchestrating, roster(entry("a1", "specify-agent")), { artifactWrite: request }).kind).toBe("allow");
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
  const read = () => activeRosterProbe(sessionIdOf(s));

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
    const session = sessionIdOf(`roster-eloop-${process.pid}`);
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
    const session = sessionIdOf(`roster-eacces-${process.pid}`);
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
    const session = sessionIdOf(`roster-null-${process.pid}`);
    expect(shouldBlockDirectEdit("Edit", session, orchestrating, () => null).kind).toBe("block");
  });

  it("an absent roster file answers null without entering the catch (no diagnostic)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-roster-absent-"));
    dirs.push(dir);
    process.env.LOOM_SUBAGENT_DIR = dir;
    const session = sessionIdOf(`roster-absent-${process.pid}`);

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
    shouldBlockDirectEdit("Write", s, orchestrating, panel, { artifactWrite: request(callerAgentId, targetPath) }).kind;

  it("allows each panel writer role on its run's panel-runs artifact path", () => {
    expect(decide(INTERVIEWER, "/proj/.claude/specs/2026-09-16-grammar-constrained-decoding/panel-runs/run-1/interview.md")).toBe("allow");
    const designer = roster(entry("opaque-designer", "arch-designer-agent"));
    expect(shouldBlockDirectEdit("Write", s, orchestrating, designer, { artifactWrite: request("opaque-designer", "/proj/.claude/specs/slug/panel-runs/run-1/candidates/candidate-lens.md") }).kind).toBe("allow");
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
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, impl, { artifactWrite: request(null, "/etc/passwd") }).kind).toBe("allow");
  });

  it("both admissions share ONE roster probe", () => {
    const probe = vi.fn<ActiveRosterProbe>(() => [entry(INTERVIEWER, "arch-interviewer-agent")]);
    shouldBlockDirectEdit("Write", s, orchestrating, probe, { artifactWrite: request(INTERVIEWER, "/proj/.claude/specs/slug/panel-runs/run-1/interview.md") });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a traversal session id still fails CLOSED before the artifact admission", () => {
    const probe = vi.fn<ActiveRosterProbe>(() => [entry(INTERVIEWER, "arch-interviewer-agent")]);
    const result = shouldBlockDirectEdit("Write", "../../etc", orchestrating, probe, { artifactWrite: request(INTERVIEWER, "/proj/.claude/specs/x.md") });
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
   * in-repository target outside its roots and a main-agent call stay blocked.
   * The guard is armed HERE, not by the checkout: `LOOM_STATE_PATH` is
   * re-pointed at a per-suite State File in the project's canonical
   * `.claude/state/` layout (the lazy resolver the handler probes reads it at
   * decision time, and the orchestrated repository is derived from it), so the
   * assertions hold on a fresh CI checkout exactly as they do in a checkout
   * hosting a live orchestration run — a test that silently depended on the
   * developer's state file passed locally and allowed every edit on CI.
   */
  const originalStatePath = process.env.LOOM_STATE_PATH;
  const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  const project = canonicalTempDir("loom-handler-artifact-");
  const statePath = join(project, ".claude", "state", "active_task_graph.json");
  const CALLER = "a339f6fd51d78b179";

  beforeEach(() => {
    mkdirSync(join(project, ".claude", "state"), { recursive: true });
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

  it("an in-repository target outside its roots stays blocked for the panel writer", async () => {
    const result = await run({ agent_id: CALLER, tool_input: { file_path: join(project, "src", "index.ts") } });
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("arch-interviewer-agent may write only its artifacts");
  });

  it("a target outside the orchestrated repository is not the guard's concern, even for the panel writer", async () => {
    const outside = canonicalTempDir("loom-handler-outside-");
    try {
      expect((await run({ agent_id: CALLER, tool_input: { file_path: join(outside, "notes.md") } })).kind).toBe("allow");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("the main agent (no agent_id) stays blocked on the same in-scope target", async () => {
    const target = join(project, ".claude", "specs", "panel-runs", `run-${process.pid}`, "interview.md");
    const result = await run({ tool_input: { file_path: target } });
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("BLOCKED: Direct edits not allowed");
  });
});

// ─── Guard scope: the orchestrated repository and Loom's protected dirs ─────

/** A protected Loom directory far from every repository root the cases use. */
const PROTECTED = "/loom-protected";
const resolvedRepository = (...roots: readonly [string, ...string[]]): OrchestratedRepository =>
  ({ kind: "resolved", roots, protectedRoots: [PROTECTED] });
const resolvedTargets = (...paths: readonly [string, ...string[]]): EditTargets => ({ kind: "resolved", paths });

describe("guardedByRoot / editPlacement — the pure placement rule", () => {
  it.each([
    ["/repo", "/repo", true, "the root itself"],
    ["/repo", "/repo/src/x.ts", true, "a file below the root"],
    ["/repo", "/repo/.claude/worktrees/agent-1/x.ts", true, "a nested worktree directory stays inside"],
    ["/repo", "/repo/..notes.md", true, "a name starting with `..` is inside"],
    ["/repo", "/repo-foo/x.ts", false, "a sibling sharing the prefix is outside"],
    ["/repo", "/repo2", false, "a sibling sharing the prefix (no separator) is outside"],
    ["/repo", "/other/x.ts", false, "an unrelated tree is outside"],
    ["/repo", "/", false, "an ancestor is outside"],
    ["/repo", "/repo/../other/x.ts", false, "a `..` escape is judged after normalisation"],
    ["/repo", "repo/x.ts", true, "a relative target cannot be placed — fails closed"],
    ["repo", "/elsewhere/x.ts", true, "a relative root cannot be placed — fails closed"],
  ])("guardedByRoot(%s, %s) = %s — %s", (root, target, guarded) => {
    expect(guardedByRoot(root, target)).toBe(guarded);
  });

  it("anything unresolved places the call inside", () => {
    expect(editPlacement(UNRESOLVED, resolvedTargets("/elsewhere/x.ts")).kind).toBe("inside");
    expect(editPlacement(resolvedRepository("/repo"), UNRESOLVED).kind).toBe("inside");
    expect(editPlacement(UNRESOLVED, UNRESOLVED).kind).toBe("inside");
  });

  it("one guarded target places the whole call inside; every root counts", () => {
    expect(editPlacement(resolvedRepository("/repo"), resolvedTargets("/tmp/a", "/repo/b")).kind).toBe("inside");
    expect(editPlacement(resolvedRepository("/repo", "/second"), resolvedTargets("/second/x")).kind).toBe("inside");
    expect(editPlacement(resolvedRepository("/repo", "/second"), resolvedTargets("/tmp/a", "/repo-x/b")).kind).toBe("outside");
  });

  const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
  const absoluteDir = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => `/${parts.join("/")}`);

  it("property: a path below the root (or the root itself) is always inside", () => {
    fc.assert(fc.property(absoluteDir, fc.array(segment, { maxLength: 4 }), (root, below) => {
      const target = below.length === 0 ? root : `${root}/${below.join("/")}`;
      expect(editPlacement(resolvedRepository(root), resolvedTargets(target)).kind).toBe("inside");
    }));
  });

  it("property: a sibling sharing the root as a string prefix is always outside (segment boundary)", () => {
    fc.assert(fc.property(absoluteDir, segment, fc.array(segment, { maxLength: 3 }), (root, suffix, below) => {
      const sibling = [`${root}${suffix}`, ...below].join("/");
      expect(editPlacement(resolvedRepository(root), resolvedTargets(sibling)).kind).toBe("outside");
    }));
  });

  it("property: adding a target never moves a call from inside to outside", () => {
    fc.assert(fc.property(absoluteDir, absoluteDir, absoluteDir, (root, first, second) => {
      const one = editPlacement(resolvedRepository(root), resolvedTargets(first));
      const both = editPlacement(resolvedRepository(root), resolvedTargets(first, second));
      if (one.kind === "inside") expect(both.kind).toBe("inside");
    }));
  });
});

describe("shouldBlockDirectEdit — placement gates every admission", () => {
  const inside = (): EditPlacement => ({ kind: "inside" });
  const outside = (): EditPlacement => ({ kind: "outside" });

  it("the main agent may write outside the orchestrated repository; inside it stays blocked", () => {
    expect(shouldBlockDirectEdit("Edit", sNoActive, orchestrating, noRoster, { placeEdit: outside }).kind).toBe("allow");
    const blocked = shouldBlockDirectEdit("Edit", sNoActive, orchestrating, noRoster, { placeEdit: inside });
    expect(blocked.kind).toBe("block");
    if (blocked.kind === "block") expect(blocked.message).toContain("Direct edits not allowed");
  });

  it("an omitted placement judges the write inside", () => {
    expect(shouldBlockDirectEdit("Edit", sNoActive, orchestrating, noRoster).kind).toBe("block");
  });

  it("placement is never consulted when disarmed, for a non-file tool, or on an invalid session id", () => {
    const probe = vi.fn(outside);
    expect(shouldBlockDirectEdit("Edit", sNoActive, () => false, noRoster, { placeEdit: probe }).kind).toBe("allow");
    expect(shouldBlockDirectEdit("Bash", sNoActive, orchestrating, noRoster, { placeEdit: probe }).kind).toBe("allow");
    expect(shouldBlockDirectEdit("Edit", "../../etc", orchestrating, noRoster, { placeEdit: probe }).kind).toBe("block");
    expect(probe).not.toHaveBeenCalled();
  });

  it("inside the repository every admission is unchanged", () => {
    const request = { callerAgentId: "a1", targetPath: "/proj/src/x.ts", projectRoot: "/proj" };
    const writer = shouldBlockDirectEdit("Write", sNoActive, orchestrating, roster(entry("a1", "specify-agent")), { artifactWrite: request, placeEdit: inside });
    expect(writer.kind).toBe("block");
    if (writer.kind === "block") expect(writer.message).toContain("specify-agent may write only its artifacts");
    expect(shouldBlockDirectEdit("Edit", sNoActive, orchestrating, roster(entry("code-implementer-agent")), { placeEdit: inside }).kind).toBe("allow");
  });
});

describe("protected Loom directories stay guarded wherever they lie (code-reviewer-1)", () => {
  // Default layout: the subagent dir and the machine-definitions dir both sit
  // OUTSIDE the orchestrated repository, and only Bash is covered by
  // guard-state-file — so placement alone must keep them guarded.
  const subagents = "/tmp/claude-subagents";
  const machines = "/opt/loom/machines";
  const repository: OrchestratedRepository = { kind: "resolved", roots: ["/repo"], protectedRoots: [subagents, machines] };
  const protectedTargets = [
    [`${subagents}/${sNoActive}.evidence.jsonl`, "the evidence ledger"],
    [`${subagents}/${sNoActive}.active`, "the active roster"],
    [`${subagents}/${sNoActive}.task_graph`, "the TaskGraph pointer"],
    [`${machines}/code-implementer-agent.json`, "a machine definition"],
  ] as const;
  const parentWrite = (target: string) => shouldBlockDirectEdit(
    "Write", sNoActive, orchestrating, noRoster, { placeEdit: () => editPlacement(repository, resolvedTargets(target)) },
  );

  it.each(protectedTargets)("%s (%s) is placed inside and blocked for the parent", (target) => {
    expect(editPlacement(repository, resolvedTargets(target)).kind).toBe("inside");
    const result = parentWrite(target);
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("Direct edits not allowed");
  });

  it("one protected target guards a batch that is otherwise outside", () => {
    expect(editPlacement(repository, resolvedTargets("/scratch/a.md", `${machines}/x.json`)).kind).toBe("inside");
  });

  it("a scratch path outside both the repository and every protected directory is still allowed", () => {
    expect(editPlacement(repository, resolvedTargets("/scratch/notes.md")).kind).toBe("outside");
    expect(parentWrite("/scratch/notes.md").kind).toBe("allow");
    // Segment boundary: a sibling sharing a protected root's prefix is outside.
    expect(parentWrite(`${subagents}-other/notes.md`).kind).toBe("allow");
  });

  const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
  const absoluteDir = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => `/${parts.join("/")}`);

  it("property: a path at or below any protected root is inside, whatever the repository roots", () => {
    fc.assert(fc.property(absoluteDir, absoluteDir, fc.array(segment, { maxLength: 4 }), (repoRoot, protectedRoot, below) => {
      const target = below.length === 0 ? protectedRoot : `${protectedRoot}/${below.join("/")}`;
      const placed = editPlacement({ kind: "resolved", roots: [repoRoot], protectedRoots: [protectedRoot] }, resolvedTargets(target));
      expect(placed.kind).toBe("inside");
    }));
  });
});

describe("block-direct-edits handler — guard scope (end-to-end, canonical layout without Git)", () => {
  const originalStatePath = process.env.LOOM_STATE_PATH;
  const project = canonicalTempDir("loom-scope-repo-");
  const sibling = `${project}-other`;
  const elsewhere = canonicalTempDir("loom-scope-elsewhere-");

  beforeEach(() => {
    mkdirSync(join(project, ".claude", "state"), { recursive: true });
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(project, ".claude", "state", "active_task_graph.json"), "{}");
    process.env.LOOM_STATE_PATH = join(project, ".claude", "state", "active_task_graph.json");
  });

  afterEach(() => {
    if (originalStatePath === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = originalStatePath;
  });

  afterAll(() => {
    for (const dir of [project, sibling, elsewhere]) rmSync(dir, { recursive: true, force: true });
  });

  const parentWrite = (filePath: string | undefined, cwd = project) => blockDirectEdits(JSON.stringify({
    tool_name: "Write",
    session_id: sNoActive,
    cwd,
    tool_input: filePath === undefined ? {} : { file_path: filePath },
  }), []);

  it("a file inside the repository is blocked for the parent", async () => {
    const result = await parentWrite(join(project, "src", "x.ts"));
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("Direct edits not allowed");
    expect((await parentWrite("src/relative.ts")).kind).toBe("block");
  });

  it("a sibling directory sharing the root's prefix is outside", async () => {
    expect((await parentWrite(join(sibling, "x.ts"))).kind).toBe("allow");
  });

  it("a scratchpad path (not-yet-existing, nested) is outside", async () => {
    expect((await parentWrite(join(elsewhere, "scratchpad", "deep", "notes.md"))).kind).toBe("allow");
    expect((await parentWrite("relative-notes.md", elsewhere)).kind).toBe("allow");
  });

  it("a symlink inside the repository pointing out is judged by its realpath — outside", async () => {
    const link = join(project, "out-link");
    rmSync(link, { force: true });
    symlinkSync(elsewhere, link);
    expect((await parentWrite(join(link, "x.ts"))).kind).toBe("allow");
  });

  it("a path through a symlinked directory into the repository is judged by its realpath — inside", async () => {
    const link = join(elsewhere, "in-link");
    rmSync(link, { force: true });
    symlinkSync(project, link);
    expect((await parentWrite(join(link, "src", "x.ts"))).kind).toBe("block");
  });

  it("an uncanonicalisable target (dangling symlink) stays guarded even outside the repository", async () => {
    const dangling = join(elsewhere, "dangling");
    rmSync(dangling, { force: true });
    symlinkSync(join(elsewhere, "missing-target"), dangling);
    expect((await parentWrite(dangling)).kind).toBe("block");
  });

  it("a write naming no target stays guarded", async () => {
    expect((await parentWrite(undefined)).kind).toBe("block");
  });

  it("a LOOM_STATE_PATH override at no documented layout and outside Git guards every target, announced", async () => {
    const odd = join(elsewhere, "state", "graph.json");
    mkdirSync(join(elsewhere, "state"), { recursive: true });
    writeFileSync(odd, "{}");
    process.env.LOOM_STATE_PATH = odd;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect((await parentWrite(join(sibling, "x.ts"))).kind).toBe("block");
      expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("guarding every target");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("orchestratedRepositoryOf / canonicalEditTargets — Git working trees", () => {
  const base = canonicalTempDir("loom-scope-git-");
  const repo = join(base, "repo");
  const worktree = join(base, "repo-fix");
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: base,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "pipe",
  });

  beforeAll(() => {
    git("init", "-q", repo);
    git("-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
    git("-C", repo, "worktree", "add", "-q", worktree);
    git("-C", repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "nested"));
    mkdirSync(join(repo, ".claude", "state"), { recursive: true });
    writeFileSync(join(repo, ".claude", "state", "active_task_graph.json"), "{}");
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // Not yet created: canonicalised through its nearest existing ancestor.
  const subagents = join(base, "subagents");
  const graph = () => join(repo, ".claude", "state", "active_task_graph.json");

  it("derives the root from the Git working tree holding the graph, and carries the canonical protected dirs", () => {
    expect(orchestratedRepositoryOf([graph()], [subagents]))
      .toEqual({ kind: "resolved", roots: [repo], protectedRoots: [subagents] });
  });

  it("canonicalises a symlinked protected directory to its real location, deduplicated", () => {
    const real = join(base, "real-subagents");
    const link = join(base, "linked-subagents");
    mkdirSync(real, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(real, link);
    expect(orchestratedRepositoryOf([graph()], [link, real]))
      .toEqual({ kind: "resolved", roots: [repo], protectedRoots: [real] });
  });

  it("an uncanonicalisable protected directory guards every target, announced", () => {
    const dangling = join(base, "dangling-subagents");
    rmSync(dangling, { force: true });
    symlinkSync(join(base, "missing"), dangling);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(orchestratedRepositoryOf([graph()], [dangling])).toBe(UNRESOLVED);
      expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("cannot canonicalize protected directory");
    } finally {
      stderr.mockRestore();
    }
  });

  it("another worktree of the same repository is outside; the orchestrated checkout and nested worktrees are inside", () => {
    const repository = orchestratedRepositoryOf([graph()], [subagents]);
    const place = (path: string, cwd = base) => editPlacement(repository, canonicalEditTargets([path], cwd)).kind;
    expect(place(join(worktree, "engine", "src", "x.ts"))).toBe("outside");
    expect(place("engine/src/x.ts", worktree)).toBe("outside");
    expect(place(join(repo, "engine", "src", "x.ts"))).toBe("inside");
    expect(place(join(repo, ".claude", "worktrees", "nested", "x.ts"))).toBe("inside");
    expect(place(join(subagents, "s.evidence.jsonl"))).toBe("inside");
  });

  it("no armed graph resolves nothing, silently — every target stays guarded", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(orchestratedRepositoryOf([], [subagents])).toBe(UNRESOLVED);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(canonicalEditTargets([], base)).toBe(UNRESOLVED);
  });
});

describe("block-direct-edits handler — protected directories outside the repository (end-to-end)", () => {
  // LOOM_SUBAGENT_DIR and LOOM_MACHINES_DIR re-pointed at temp dirs OUTSIDE
  // the orchestrated repository — the default layout's shape, hermetically.
  const originalEnv = {
    LOOM_STATE_PATH: process.env.LOOM_STATE_PATH,
    LOOM_SUBAGENT_DIR: process.env.LOOM_SUBAGENT_DIR,
    LOOM_MACHINES_DIR: process.env.LOOM_MACHINES_DIR,
  };
  const project = canonicalTempDir("loom-protected-repo-");
  const subagents = canonicalTempDir("loom-protected-subagents-");
  const machines = canonicalTempDir("loom-protected-machines-");
  const scratch = canonicalTempDir("loom-protected-scratch-");

  beforeEach(() => {
    mkdirSync(join(project, ".claude", "state"), { recursive: true });
    writeFileSync(join(project, ".claude", "state", "active_task_graph.json"), "{}");
    process.env.LOOM_STATE_PATH = join(project, ".claude", "state", "active_task_graph.json");
    process.env.LOOM_SUBAGENT_DIR = subagents;
    process.env.LOOM_MACHINES_DIR = machines;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  afterAll(() => {
    for (const dir of [project, subagents, machines, scratch]) rmSync(dir, { recursive: true, force: true });
  });

  const parentWrite = (filePath: string) => blockDirectEdits(JSON.stringify({
    tool_name: "Write",
    session_id: sNoActive,
    cwd: project,
    tool_input: { file_path: filePath },
  }), []);

  it.each([
    [`${sNoActive}.evidence.jsonl`, "the evidence ledger"],
    [`${sNoActive}.active`, "the active roster"],
    [`${sNoActive}.machine`, "a machine binding"],
    [`${sNoActive}.task_graph`, "the TaskGraph pointer"],
  ])("a parent Write to <subagentDir>/%s (%s) is blocked", async (name) => {
    const result = await parentWrite(join(subagents, name));
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("Direct edits not allowed");
  });

  it("a parent Write into the machine-definitions dir is blocked", async () => {
    expect((await parentWrite(join(machines, "code-implementer-agent.json"))).kind).toBe("block");
  });

  it("a protected directory reached through a symlink is judged by its realpath — blocked", async () => {
    const link = join(scratch, "subagents-link");
    rmSync(link, { force: true });
    symlinkSync(subagents, link);
    expect((await parentWrite(join(link, `${sNoActive}.evidence.jsonl`))).kind).toBe("block");
  });

  it("a scratch path outside the repository and every protected directory is still allowed", async () => {
    expect((await parentWrite(join(scratch, "notes", "plan.md"))).kind).toBe("allow");
  });
});
