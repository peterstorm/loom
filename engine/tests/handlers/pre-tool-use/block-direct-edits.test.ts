/**
 * shouldBlockDirectEdit — the session id from hook input is PARSED before
 * naming the `.active` file under SUBAGENT_DIR (Fix: raw interpolation
 * bypassed the SessionId brand). An unparseable id fails CLOSED (block):
 * allowing would open direct edits on malformed input.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldBlockDirectEdit } from "../../../src/core/block-direct-edits";
import blockDirectEdits from "../../../src/handlers/pre-tool-use/block-direct-edits";
import { SUBAGENT_DIR, TASK_GRAPH_PATH, pathExistsFailClosed } from "../../../src/config";

const orchestrating = () => true;
const s = `block-direct-${process.pid}-${Date.now()}`;
// A session that never gets an .active file — used by the default-probe test
// so a leftover active-file fixture from earlier cases cannot mask the gate.
const sNoActive = `${s}-no-active`;

afterAll(() => {
  rmSync(join(SUBAGENT_DIR, `${s}.active`), { force: true });
  rmSync(join(SUBAGENT_DIR, `${sNoActive}.active`), { force: true });
});

describe("shouldBlockDirectEdit — session-id parse boundary", () => {
  it("non-file tools always pass", () => {
    expect(shouldBlockDirectEdit("Bash", s, orchestrating).kind).toBe("allow");
  });

  it("no active subagent → block every supported file mutation tool", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "edit", "write", "multi_edit"]) {
      expect(shouldBlockDirectEdit(tool, s, orchestrating).kind).toBe("block");
    }
  });

  it("active subagent → allow", () => {
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), "code-implementer-agent\n");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("allow");
  });

  it("active write-grant agent → allow", () => {
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), "pi-grant-abcdef0123456789\n");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("allow");
  });

  it("active review agent → block (read-only role)", () => {
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), "code-reviewer\n");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("block");
  });

  // On Claude Code `agent_id` is an opaque handle, so identity alone can never
  // match IMPL_AGENTS (which holds agent-type NAMES) and every implementation
  // subagent was blocked by the guard meant to let it through. The roster's
  // type column is what answers "may this agent write?".
  describe("authorization by recorded role", () => {
    const rosterLine = (line: string) => {
      mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(join(SUBAGENT_DIR, `${s}.active`), line);
    };

    it("allows an opaque Claude agent id carrying an implementation role", () => {
      rosterLine("a339f6fd51d78b179\tcode-implementer-agent\n");
      expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("allow");
    });

    it("allows every implementation role, not just the machine-gated one", () => {
      // Only code-implementer-agent ships a .machine definition, so a
      // binding-based lookup would still strand these.
      for (const role of ["adr-writer-agent", "ts-test-agent", "frontend-agent"]) {
        rosterLine(`opaque${role.length}\t${role}\n`);
        expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind, role).toBe("allow");
      }
    });

    it("still blocks an opaque id carrying a read-only role", () => {
      rosterLine("b448e7fe62e89c280\tcode-reviewer\n");
      expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("block");
    });

    it("blocks an opaque id with no recorded role", () => {
      // Unknown role must not be guessed into authorization.
      rosterLine("c559f80f73f90d391\n");
      expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("block");
    });

    it("authorizes on any active entry, not only the first", () => {
      rosterLine("d66a091084a01e4a2\tcode-reviewer\ne77b1a2195b12f5b3\tcode-implementer-agent\n");
      expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("allow");
    });

    // Pi writes single-column lines (it passes no type) and authorizes via the
    // `pi-grant-` capability prefix. Both must keep working untouched.
    it("keeps Pi write-grant and legacy single-column rosters working", () => {
      rosterLine("pi-grant-abcdef0123456789\n");
      expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("allow");

      rosterLine("code-implementer-agent\n");
      expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("allow");
    });
  });

  it("a traversal session id fails CLOSED — block, no path outside SUBAGENT_DIR consulted", () => {
    for (const evil of ["../../etc", "a/b", "..", "a b", ""]) {
      const result = shouldBlockDirectEdit("Write", evil, orchestrating);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("invalid session id");
      }
    }
  });

  it("no task graph → allow regardless of session id", () => {
    expect(shouldBlockDirectEdit("Edit", "../../etc", () => false).kind).toBe("allow");
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
