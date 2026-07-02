/**
 * Fail-closed coverage for the PreToolUse gate:
 * - well-formed input missing session_id/tool_name (Fix 1)
 * - binding file present but unparseable (Fix 2)
 * - invalid machine definition → block (Fix 4)
 * - evaluation crash catch-all → block (Fix 4)
 *
 * Isolation via unique session ids + targeted cleanup (SUBAGENT_DIR is
 * process-global), same pattern as tests/machine/handlers-e2e.test.ts.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import enforce from "../../../src/handlers/pre-tool-use/enforce-phase-tools";
import {
  bindMachineAgent,
  ledgerPath,
  machineBindingPath,
  unbindMachineAgent,
} from "../../../src/machine/ledger";
import { SUBAGENT_DIR } from "../../../src/config";

const run = `gate-fail-closed-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;
const sessions = ["missing-fields", "corrupt-binding", "absent", "invalid-machine", "crash"].map(sid);

afterAll(() => {
  for (const s of sessions) {
    for (const path of [ledgerPath(s), machineBindingPath(s), `${SUBAGENT_DIR}/${s}.active`]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
    }
  }
});

const pre = (session: string, tool: string) =>
  JSON.stringify({ session_id: session, tool_name: tool, tool_input: {} });

describe("gate fails closed on unattributable input (Fix 1)", () => {
  it("valid JSON missing session_id/tool_name blocks while any binding exists", async () => {
    const s = sid("missing-fields");
    await bindMachineAgent(s, "code-implementer-agent", "a-1");
    try {
      const noSession = await enforce(JSON.stringify({ tool_name: "Write", tool_input: {} }), []);
      expect(noSession.kind).toBe("block");
      if (noSession.kind === "block") {
        expect(noSession.message).toContain("missing session_id/tool_name");
      }

      const noTool = await enforce(JSON.stringify({ session_id: s, tool_input: {} }), []);
      expect(noTool.kind).toBe("block");
    } finally {
      await unbindMachineAgent(s, "code-implementer-agent", "a-1");
    }
  });
});

describe("gate fails closed on corrupt binding files (Fix 2)", () => {
  it("binding file present but zero parseable bindings → block, never passthrough", async () => {
    const s = sid("corrupt-binding");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(machineBindingPath(s), "garbage-line-without-a-tab\n");
    const result = await enforce(pre(s, "Write"), []);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("no parseable bindings");
    }
  });

  it("no binding file for the session → passthrough (ungated session)", async () => {
    const s = sid("absent");
    const result = await enforce(pre(s, "Write"), []);
    expect(result.kind).toBe("passthrough");
  });
});

describe("gate fails closed on broken machinery (Fix 4)", () => {
  it("invalid machine definition → block with the parse error", async () => {
    const s = sid("invalid-machine");
    const machines = mkdtempSync(join(tmpdir(), "loom-bad-machines-"));
    process.env.LOOM_MACHINES_DIR = machines;
    try {
      writeFileSync(join(machines, "corrupt-agent.machine.json"), "{broken");
      await bindMachineAgent(s, "corrupt-agent", "a-1");
      const result = await enforce(pre(s, "Write"), []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("invalid machine definition");
      }
    } finally {
      delete process.env.LOOM_MACHINES_DIR;
      await unbindMachineAgent(s, "corrupt-agent", "a-1");
      rmSync(machines, { recursive: true, force: true });
    }
  });

  it("an evaluation crash → block (catch-all), never passthrough", async () => {
    const s = sid("crash");
    await bindMachineAgent(s, "code-implementer-agent", "a-1");
    // A DIRECTORY at the .active path makes attribution reading throw
    // mid-evaluation — the catch-all must fail closed, not open.
    mkdirSync(`${SUBAGENT_DIR}/${s}.active`, { recursive: true });
    try {
      const result = await enforce(pre(s, "Write"), []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("gate evaluation failed");
      }
    } finally {
      rmSync(`${SUBAGENT_DIR}/${s}.active`, { recursive: true, force: true });
      await unbindMachineAgent(s, "code-implementer-agent", "a-1");
    }
  });
});
