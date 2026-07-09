import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { WHITELISTED_HELPERS, SUBAGENT_DIR, MACHINES_DIR } from "../../../src/config";
import { guardStateFileDecision } from "../../../src/core/guard-state-file";
import { runGuardStateFile, stampCallStart } from "../../../src/handlers/pre-tool-use/guard-state-file";
import { parseSessionId, type SessionRegistry } from "../../../src/machine/evidence";
import { inMemorySessionRegistry } from "../../machine/fake-session-registry";
import type { HookResult } from "../../../src/types";

/**
 * Test the REAL pure guard decision (guardStateFileDecision) — the handler
 * only wraps the task-graph-exists FS check around it.
 */
function guardDecision(command: string): "allow" | "block" {
  return guardStateFileDecision(command).kind === "block" ? "block" : "allow";
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
      expect(
        guardDecision(`bun \${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts helper ${helper} --wave 2`),
      ).toBe("allow");
    }
  });

  it("a helper name in an echo argument does NOT bypass the guard (substring spoof)", () => {
    expect(guardDecision('echo cleanup-state; echo forged >> active_task_graph.json')).toBe("block");
    expect(guardDecision('echo "complete-wave-gate" >> active_task_graph.json')).toBe("block");
    expect(guardDecision(`echo set-phase && echo forged >> ${SUBAGENT_DIR}/s.evidence.jsonl`)).toBe(
      "block",
    );
  });

  it("a helper name in a comment does NOT bypass the guard", () => {
    expect(guardDecision('echo x >> active_task_graph.json # cleanup-state')).toBe("block");
    expect(guardDecision('# set-phase\necho x >> active_task_graph.json')).toBe("block");
  });

  it("a helper name in a file path does NOT bypass the guard", () => {
    expect(guardDecision("cat /tmp/cleanup-state.txt > active_task_graph.json")).toBe("block");
    expect(guardDecision(`cp /tmp/mark-tests-passed ${SUBAGENT_DIR}/s.machine`)).toBe("block");
  });

  it("a REAL helper invocation on the same line as a forged ledger append still blocks (protected dirs checked first)", () => {
    expect(
      guardDecision(
        `bun cli.ts helper set-phase execute; echo forged >> ${SUBAGENT_DIR}/s.evidence.jsonl`,
      ),
    ).toBe("block");
    expect(
      guardDecision(`bun cli.ts helper cleanup-state && rm -rf ${MACHINES_DIR}`),
    ).toBe("block");
  });

  it("a REAL helper invocation cannot vouch for a task-graph write in ANOTHER segment (segment-scoped allow)", () => {
    // The round-11 fix covered SUBAGENT_DIR/MACHINES_DIR; these pin the
    // task-graph / review-invocations variant of the same smuggle.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase execute && chmod 644 .claude/state/active_task_graph.json && cp /tmp/forged.json .claude/state/active_task_graph.json",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper cleanup-state && sed -i 's/trusted-fail/trusted-pass/' .claude/state/active_task_graph.json",
      ),
    ).toBe("block");
    expect(
      guardDecision('bun cli.ts helper set-phase execute; echo forged > active_task_graph.json'),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper mark-tests-passed T1; jq '.verdict=\"PASSED\"' review-invocations.json | sponge review-invocations.json",
      ),
    ).toBe("block");
    // Non-write helper companions stay allowed — the scoping only bites on
    // write-bearing non-helper segments.
    expect(
      guardDecision("bun cli.ts helper set-phase execute && cat active_task_graph.json"),
    ).toBe("allow");
    expect(
      guardDecision("bun cli.ts helper complete-wave-gate --wave 2 && echo done"),
    ).toBe("allow");
  });

  it("a REAL helper invocation cannot vouch for a command-substitution write (round-13 bypass)", () => {
    // `$(…)` / backticks embed an independently-executed command; the segment
    // is a legitimate helper invocation, so segment-scoping alone missed the
    // smuggled write. Both forms, both state files, must block.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase \"$(sed -i s/trusted-fail/trusted-pass/ .claude/state/active_task_graph.json)\"",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper set-phase `sed -i s/a/b/ active_task_graph.json`",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper cleanup-state \"$(sponge review-invocations.json < /tmp/forged.json)\"",
      ),
    ).toBe("block");
    // A READ substitution (no write pattern) stays allowed — the guard only
    // bites when a write co-occurs with the substitution.
    expect(
      guardDecision("bun cli.ts helper set-phase \"$(jq .current_wave active_task_graph.json)\""),
    ).toBe("allow");
  });

  it("a REAL helper invocation cannot vouch for a variable-indirected write (round-13 bypass)", () => {
    // The state-file literal and the write live in DIFFERENT non-helper
    // segments, so no single segment matches both patterns; the write in a
    // non-helper segment plus a line-wide state-file reference must block.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase && F=active_task_graph.json && sed -i s/x/y/ .claude/state/$F",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper cleanup-state; G=review-invocations.json; sponge .claude/state/$G < /tmp/forged.json",
      ),
    ).toBe("block");
  });

  it("ln / truncate / install on a state file → block (round-13 WRITE_PATTERNS gap)", () => {
    expect(guardDecision("truncate -s0 .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("ln -sf /tmp/forged.json .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("install -m644 /tmp/forged.json .claude/state/active_task_graph.json")).toBe("block");
    // The same tokens smuggled behind a helper prefix also block.
    expect(
      guardDecision("bun cli.ts helper set-phase && truncate -s0 active_task_graph.json"),
    ).toBe("block");
  });

  it("forged appends to the evidence ledger are blocked regardless of helper-shaped noise", () => {
    expect(
      guardDecision(
        `true "; bun cli.ts helper cleanup-state"; echo '{"epoch":"a:b"}' >> ${SUBAGENT_DIR}/s.evidence.jsonl`,
      ),
    ).toBe("block");
  });

  it("helper-invocation matching requires the documented bun/cli.ts/helper head shape", () => {
    // Right helper name, wrong invocation shape → no bypass.
    expect(guardDecision("cleanup-state > active_task_graph.json")).toBe("block");
    expect(guardDecision("bun other.ts helper cleanup-state > active_task_graph.json")).toBe("block");
    expect(guardDecision("bun cli.ts run cleanup-state > active_task_graph.json")).toBe("block");
    expect(guardDecision("bun cli.ts helper not-whitelisted > active_task_graph.json")).toBe("block");
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

describe("guard-state-file handler — malformed stdin fails CLOSED (round-11)", () => {
  it("non-JSON stdin → block, never a rethrow or a silent allow", async () => {
    // A parse crash exits 1 which is NON-blocking for PreToolUse — it would
    // wave the Bash call past the guard. The handler must fail CLOSED instead.
    const result = await runGuardStateFile("{not json", inMemorySessionRegistry());
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("malformed hook input");
    }
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
