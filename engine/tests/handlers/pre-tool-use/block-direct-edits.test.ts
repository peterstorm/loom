/**
 * shouldBlockDirectEdit — the session id from hook input is PARSED before
 * naming the `.active` file under SUBAGENT_DIR (Fix: raw interpolation
 * bypassed the SessionId brand). An unparseable id fails CLOSED (block):
 * allowing would open direct edits on malformed input.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shouldBlockDirectEdit } from "../../../src/core/block-direct-edits";
import { SUBAGENT_DIR } from "../../../src/config";

const orchestrating = () => true;
const s = `block-direct-${process.pid}-${Date.now()}`;

afterAll(() => {
  rmSync(join(SUBAGENT_DIR, `${s}.active`), { force: true });
});

describe("shouldBlockDirectEdit — session-id parse boundary", () => {
  it("non-file tools always pass", () => {
    expect(shouldBlockDirectEdit("Bash", s, orchestrating).kind).toBe("allow");
  });

  it("no active subagent → block (orchestration in progress)", () => {
    const result = shouldBlockDirectEdit("Edit", s, orchestrating);
    expect(result.kind).toBe("block");
  });

  it("active subagent → allow", () => {
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SUBAGENT_DIR, `${s}.active`), "a-1\n");
    expect(shouldBlockDirectEdit("Edit", s, orchestrating).kind).toBe("allow");
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
