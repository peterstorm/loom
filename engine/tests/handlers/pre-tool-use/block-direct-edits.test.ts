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
import { mkdirSync, rmSync, writeFileSync, symlinkSync, mkdtempSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldBlockDirectEdit,
  type ActiveRosterEntry,
  type ActiveRosterProbe,
} from "../../../src/core/block-direct-edits";
import blockDirectEdits, { activeRosterProbe } from "../../../src/handlers/pre-tool-use/block-direct-edits";
import { SUBAGENT_DIR, TASK_GRAPH_PATH, pathExistsFailClosed, gitRepositoryRoot } from "../../../src/config";
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

describe("shouldBlockDirectEdit — panel-artifact admission (grammar-constrained-decoding seam gap)", () => {
  /**
   * The panel templates promise write capability the guard did not admit: the
   * interviewer writes the run's interview digest and the designer writes one
   * candidate per lens under the run's panel-runs dir, while the guard admitted
   * only implementation-role agents — so a panel writer was blocked by the
   * guard at its first write ("a spawn with no scoped Pi write grant fails
   * confusingly at its first edit"). The admission is scoped to the spec
   * artifact root the panel run's artifacts live under; targets arrive
   * repo-relative from the caller's shell.
   */
  const decideWithTargets = (...entries: readonly ActiveRosterEntry[]) =>
    (targets: readonly string[]) =>
      shouldBlockDirectEdit("Write", s, orchestrating, roster(...entries), targets).kind;

  it("allows a panel artifact writer targeting the run's panel-runs digest path", () => {
    const decide = decideWithTargets(entry("a339f6fd51d78b179", "arch-interviewer-agent"));
    expect(decide([".claude/specs/2026-09-16-grammar-constrained-decoding/panel-runs/run-1/interview.md"])).toBe("allow");
  });

  it("allows every panel artifact writer role, not just the interviewer", () => {
    const decide = decideWithTargets(entry("opaque-designer", "arch-designer-agent"));
    expect(decide([".claude/specs/slug/panel-runs/run-1/candidates/candidate-lens.md"])).toBe("allow");
  });

  it("admits on any active entry, not only the first", () => {
    expect(shouldBlockDirectEdit("Write", s, orchestrating, roster(
      entry("opaque-judge", "arch-judge-agent"),
      entry("opaque-interviewer", "arch-interviewer-agent"),
    ), [".claude/specs/slug/panel-runs/run-1/interview.md"]).kind).toBe("allow");
  });

  it("blocks a panel writer targeting outside the spec artifact root", () => {
    const decide = decideWithTargets(entry("a339f6fd51d78b179", "arch-interviewer-agent"));
    for (const evil of [".claude/plans/plan.md", "engine/src/core/x.ts", "../outside.md", "unrelated.md"]) {
      expect(decide([evil]), evil).toBe("block");
    }
  });

  it("blocks a `..` segment that normalizes out of the spec artifact root", () => {
    const decide = decideWithTargets(entry("a339f6fd51d78b179", "arch-interviewer-agent"));
    expect(decide([".claude/specs/../.claude/state/active_task_graph.json"])).toBe("block");
  });

  it("blocks a panel writer with NO provable target — fail closed", () => {
    const decide = decideWithTargets(entry("a339f6fd51d78b179", "arch-interviewer-agent"));
    expect(decide([])).toBe("block");
  });

  it("blocks the judge even on an in-scope target — read-only role", () => {
    const decide = decideWithTargets(entry("opaque-judge", "arch-judge-agent"));
    expect(decide([".claude/specs/slug/panel-runs/run-1/candidates/candidate-lens.md"])).toBe("block");
  });

  it("keeps the impl admission untouched: targets are irrelevant to it", () => {
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, roster(entry("code-implementer-agent")), []).kind).toBe("allow");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating, roster(entry("code-implementer-agent")), ["/etc/passwd"]).kind).toBe("allow");
  });

  it("both admissions share ONE roster probe", () => {
    const probe = vi.fn<ActiveRosterProbe>(() => [entry("a339f6fd51d78b179", "arch-interviewer-agent")]);
    shouldBlockDirectEdit("Write", s, orchestrating, probe, [".claude/specs/slug/panel-runs/run-1/interview.md"]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a traversal session id still fails CLOSED before the panel admission", () => {
    const probe = vi.fn<ActiveRosterProbe>(() => [entry("a339f6fd51d78b179", "arch-interviewer-agent")]);
    const result = shouldBlockDirectEdit("Write", "../../etc", orchestrating, probe, [".claude/specs/x.md"]);
    expect(result.kind).toBe("block");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("block-direct-edits handler — panel-artifact targets (end-to-end wiring)", () => {
  /**
   * The wiring proof the array-fixture cases above deliberately do not carry:
   * the wrapper resolves the raw file_path against the harness cwd and makes
   * it repo-relative, so a real .claude/specs target under this repo admits a
   * real panel-writer roster while an outside-the-repo target stays blocked.
   * The guard is armed HERE, not by the checkout: `LOOM_STATE_PATH` is
   * re-pointed at a per-suite temp State File (the lazy resolver the handler
   * probes reads it at decision time), so the assertions hold on a fresh CI
   * checkout exactly as they do in a checkout hosting a live orchestration
   * run — a test that silently depended on the developer's state file passed
   * locally and allowed every edit on CI.
   */
  const statePath = join(tmpdir(), `block-direct-armed-${process.pid}.json`);
  const originalStatePath = process.env.LOOM_STATE_PATH;

  beforeEach(() => {
    writeFileSync(statePath, "{}");
    process.env.LOOM_STATE_PATH = statePath;
  });

  afterEach(() => {
    if (originalStatePath === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = originalStatePath;
    rmSync(statePath, { force: true });
  });

  it("a real .claude/specs target under the repo admits a real panel-writer roster", async () => {
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), "a339f6fd51d78b179\tarch-interviewer-agent\n");
    const repoRoot = gitRepositoryRoot();
    if (repoRoot === null) return; // proven non-repository: the resolution cannot be proven
    const target = join(repoRoot, ".claude", "specs", "panel-runs", `run-${process.pid}`, "interview.md");
    const result = await blockDirectEdits(JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: target },
      session_id: s,
    }), []);
    expect(result.kind).toBe("allow");
  });

  it("an outside-the-repo target stays blocked for a panel writer", async () => {
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), "a339f6fd51d78b179\tarch-interviewer-agent\n");
    if (gitRepositoryRoot() === null) return;
    const result = await blockDirectEdits(JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: join(tmpdir(), `outside-${process.pid}.md`) },
      session_id: s,
    }), []);
    expect(result.kind).toBe("block");
  });
});
