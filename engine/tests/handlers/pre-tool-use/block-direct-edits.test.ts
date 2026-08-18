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
import { mkdirSync, rmSync, writeFileSync, symlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldBlockDirectEdit,
  type ActiveRosterEntry,
  type ActiveRosterProbe,
} from "../../../src/core/block-direct-edits";
import blockDirectEdits, { activeRosterProbe } from "../../../src/handlers/pre-tool-use/block-direct-edits";
import { SUBAGENT_DIR, TASK_GRAPH_PATH, pathExistsFailClosed } from "../../../src/config";
import { parseSessionId } from "../../../src/machine/evidence";

const orchestrating = () => true;
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
