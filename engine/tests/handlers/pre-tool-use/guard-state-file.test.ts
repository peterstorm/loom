import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { WRITE_PATTERNS, STATE_FILE_PATTERNS, WHITELISTED_HELPERS, SUBAGENT_DIR, MACHINES_DIR } from "../../../src/config";
import { runGuardStateFile, stampCallStart } from "../../../src/handlers/pre-tool-use/guard-state-file";
import { parseSessionId, type SessionRegistry } from "../../../src/machine/evidence";
import { inMemorySessionRegistry } from "../../machine/fake-session-registry";
import type { HookResult } from "../../../src/types";

/**
 * Test the pure regex logic from guard-state-file directly.
 * The handler wraps FS checks around these regexes — we test the regexes themselves.
 */

/** Simulate the core guard decision (extracted from handler logic) */
function guardDecision(command: string): "allow" | "block" {
  if (!command) return "allow";
  if (WHITELISTED_HELPERS.some((h) => command.includes(h))) return "allow";
  if (!STATE_FILE_PATTERNS.test(command)) return "allow";
  if (WRITE_PATTERNS.test(command)) return "block";
  return "allow";
}

describe("guard-state-file — property tests", () => {
  it("any command with state file + WRITE_PATTERN → block", () => {
    const writeOps = [
      "> active_task_graph.json",
      ">> active_task_graph.json",
      "mv active_task_graph.json /tmp/",
      "cp active_task_graph.json /tmp/backup",
      "tee active_task_graph.json",
      "sed -i 's/a/b/' active_task_graph.json",
      "perl -i -pe 's/a/b/' active_task_graph.json",
      "dd if=/dev/zero of=active_task_graph.json",
      "sponge active_task_graph.json",
      "chmod 777 active_task_graph.json",
      'python3 -c "open(\'active_task_graph.json\',\'w\')"',
      'python -c "open(\'active_task_graph.json\',\'write\')"',
      'node -e "require(\'fs\').writeFileSync(\'active_task_graph.json\')"',
      'node -e "fs.writeFileSync(\'active_task_graph.json\')"',
    ];

    for (const cmd of writeOps) {
      expect(guardDecision(cmd)).toBe("block");
    }
  });

  it("read commands on state file → allow", () => {
    const readOps = [
      "jq '.tasks' active_task_graph.json",
      "cat active_task_graph.json",
      "head -20 active_task_graph.json",
      "less active_task_graph.json",
      "wc -l active_task_graph.json",
      "grep 'T1' active_task_graph.json",
      "jq '.current_wave' active_task_graph.json",
    ];

    for (const cmd of readOps) {
      expect(guardDecision(cmd)).toBe("allow");
    }
  });

  it("commands not referencing state files → always allow", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter(
          (s) => !s.includes("active_task_graph") && !s.includes("review-invocations") && !s.includes(SUBAGENT_DIR) && !s.includes(MACHINES_DIR),
        ),
        (cmd) => {
          expect(guardDecision(cmd)).toBe("allow");
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("guard-state-file — edge cases", () => {
  it("empty command → allow", () => {
    expect(guardDecision("")).toBe("allow");
  });

  it("whitelisted helpers bypass guard even with write patterns", () => {
    for (const helper of WHITELISTED_HELPERS) {
      expect(guardDecision(`bun cli.ts helper ${helper} > active_task_graph.json`)).toBe("allow");
    }
  });

  it("review-invocations file also guarded", () => {
    expect(guardDecision("> review-invocations.json")).toBe("block");
    expect(guardDecision("cat review-invocations.json")).toBe("allow");
  });

  it("echo append to state file → block", () => {
    expect(guardDecision('echo "hi" >> active_task_graph.json')).toBe("block");
  });

  it("node fs operations on state file → block", () => {
    expect(guardDecision('node -e "require(\'fs\').writeFileSync(\'active_task_graph.json\')"')).toBe("block");
  });

  it("python open(write) on state file → block", () => {
    expect(guardDecision("python3 -c \"open('active_task_graph.json','w').write('{}')\"")).toBe("block");
  });

  it("jq read operations → allow", () => {
    expect(guardDecision("jq '.tasks[] | select(.wave == 1)' active_task_graph.json")).toBe("allow");
    expect(guardDecision("jq -r '.current_phase' active_task_graph.json")).toBe("allow");
  });

  it("cp with state file in source position → block (still matches cp pattern)", () => {
    expect(guardDecision("cp active_task_graph.json /tmp/backup.json")).toBe("block");
  });

  it("subagent ledger/binding/active files AND the directory itself are guarded (derived from SUBAGENT_DIR)", () => {
    expect(guardDecision(`echo forged >> ${SUBAGENT_DIR}/s.evidence.jsonl`)).toBe("block");
    expect(guardDecision(`echo a-1 >> ${SUBAGENT_DIR}/s.active`)).toBe("block");
    expect(guardDecision(`echo bind > ${SUBAGENT_DIR}/s.machine`)).toBe("block");
    expect(guardDecision(`rm -rf ${SUBAGENT_DIR}`)).toBe("block");
    expect(guardDecision(`rm ${SUBAGENT_DIR}/s.machine`)).toBe("block");
    // reads stay allowed
    expect(guardDecision(`cat ${SUBAGENT_DIR}/s.evidence.jsonl`)).toBe("allow");
    expect(guardDecision(`ls ${SUBAGENT_DIR}`)).toBe("allow");
  });

  it("machine definition files are guarded (derived from MACHINES_DIR) — rm cannot silently disarm the gate", () => {
    expect(guardDecision(`rm ${MACHINES_DIR}/code-implementer-agent.machine.json`)).toBe("block");
    expect(guardDecision(`rm -rf ${MACHINES_DIR}`)).toBe("block");
    expect(guardDecision(`echo '{}' > ${MACHINES_DIR}/code-implementer-agent.machine.json`)).toBe("block");
    expect(guardDecision(`mv ${MACHINES_DIR}/code-implementer-agent.machine.json /tmp/`)).toBe("block");
    // reads stay allowed
    expect(guardDecision(`cat ${MACHINES_DIR}/code-implementer-agent.machine.json`)).toBe("allow");
    expect(guardDecision(`ls ${MACHINES_DIR}`)).toBe("allow");
  });
});

describe("guard-state-file handler — call-start stamping never changes the guard outcome", () => {
  const stdin = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "stamp-session",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_use_id: "toolu_stamp_01",
      ...extra,
    });

  /** A registry whose stamp op always throws — the failure mode the
   *  fail-open contract is about. */
  const throwingRegistry = (): SessionRegistry => ({
    ...inMemorySessionRegistry(),
    recordCallStart: async () => {
      throw new Error("disk full");
    },
  });

  it("stamps the call start for the session (readable by callStartFor)", async () => {
    const reg = inMemorySessionRegistry();
    const result = await runGuardStateFile(stdin(), reg);
    expect(result.kind).toBe("allow");
    const sessionId = parseSessionId("stamp-session")!;
    const stamp = reg.callStartFor(sessionId, "toolu_stamp_01");
    expect(stamp).not.toBeNull();
    expect(Math.abs(Date.now() - stamp!)).toBeLessThan(60_000);
  });

  it("an ALLOW stays an allow when the stamp write throws (loud stderr, no exception)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await runGuardStateFile(stdin(), throwingRegistry());
      expect(result.kind).toBe("allow");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("call-start stamp failed");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a BLOCK stays a block when the stamp write throws — stamping runs AFTER the decision", async () => {
    const blockingGuard = (): HookResult => ({ kind: "block", message: "state file write" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await runGuardStateFile(stdin(), throwingRegistry(), blockingGuard);
      expect(result.kind).toBe("block");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("call-start stamp failed");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a BLOCK also stays a block when stamping SUCCEEDS (stamp is side-band bookkeeping)", async () => {
    const blockingGuard = (): HookResult => ({ kind: "block", message: "state file write" });
    const reg = inMemorySessionRegistry();
    const result = await runGuardStateFile(stdin(), reg, blockingGuard);
    expect(result.kind).toBe("block");
    // The stamp still landed — a blocked call's PostToolUse never fires, but
    // the stamp is bounded and harmless.
    expect(reg.callStartFor(parseSessionId("stamp-session")!, "toolu_stamp_01")).not.toBeNull();
  });

  it("no tool_use_id / unparseable session id → no stamp, guard outcome unchanged", async () => {
    const reg = inMemorySessionRegistry();
    expect((await runGuardStateFile(stdin({ tool_use_id: undefined }), reg)).kind).toBe("allow");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const evil = await runGuardStateFile(stdin({ session_id: "../../escape" }), reg);
      expect(evil.kind).toBe("allow");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("invalid session id");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("stampCallStart itself never throws (fail-open with stderr)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        stampCallStart(
          { session_id: "s-1", tool_name: "Bash", tool_input: {}, tool_use_id: "toolu_x" },
          throwingRegistry(),
        ),
      ).resolves.toBeUndefined();
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("call-start stamp failed");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
