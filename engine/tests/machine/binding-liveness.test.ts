/**
 * Binding liveness: a binding released only by SubagentStop would gate a
 * session forever if the gated subagent died without the hook firing.
 * Each binding line carries its bind stamp; the binding file's mtime is the
 * activity anchor, refreshed on every SESSION tool call (tool calls carry
 * no agent identity, so this is session-activity liveness, not per-agent
 * liveness — a dead subagent's binding stays fresh while the parent
 * session is active). Bindings idle past STALE_SUBAGENT_TTL_MS — i.e. the
 * whole session idle that long — are treated as absent and reaped under
 * the binding lock.
 *
 * Isolation via unique session ids + targeted cleanup (SUBAGENT_DIR is
 * process-global), same pattern as ledger.test.ts.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import {
  bindMachineAgent,
  ledgerPath,
  machineBindingPath,
  readBindings,
  refreshBindingActivity,
  soleActiveBinding,
  unbindMachineAgent,
} from "../../src/machine/ledger";
import {
  formatBindingLine,
  isBindingFresh,
  parseAgentId,
  parseAgentType,
  parseBindingLine,
  epochOf,
  type MachineBinding,
} from "../../src/machine/evidence";
import { STALE_SUBAGENT_TTL_MS, SUBAGENT_DIR } from "../../src/config";
import enforce from "../../src/handlers/pre-tool-use/enforce-phase-tools";

const run = `liveness-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;
const sessions = ["stale", "fresh", "extend", "mixed", "gate-stale", "bind-reaps", "unbind-malformed"].map(sid);

afterAll(() => {
  for (const s of sessions) {
    for (const path of [ledgerPath(s), machineBindingPath(s), `${SUBAGENT_DIR}/${s}.active`]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

function binding(id: string, type: string): MachineBinding {
  const agentId = parseAgentId(id);
  const agentType = parseAgentType(type);
  if (!agentId || !agentType) throw new Error(`test fixture: invalid identity ${id}/${type}`);
  return { agentId, agentType, epoch: epochOf(agentId, agentType) };
}

/** Write a binding file whose bind stamp AND mtime anchor are both `atMs`. */
function writeBindingAt(session: string, b: MachineBinding, atMs: number): void {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const path = machineBindingPath(session);
  writeFileSync(path, formatBindingLine(b, atMs) + "\n");
  utimesSync(path, new Date(atMs), new Date(atMs));
}

const impl = "code-implementer-agent";

describe("pure liveness primitives", () => {
  it("formatBindingLine ↔ parseBindingLine roundtrip", () => {
    const b = binding("a-1", impl);
    expect(parseBindingLine(formatBindingLine(b, 12345))).toEqual({ binding: b, boundAtMs: 12345 });
  });

  it("parseBindingLine rejects missing/garbage bind stamps and old 2-field lines", () => {
    expect(parseBindingLine(`a-1\t${impl}`)).toBeNull();
    expect(parseBindingLine(`a-1\t${impl}\tnot-a-number`)).toBeNull();
    expect(parseBindingLine(`a-1\t${impl}\t-5`)).toBeNull();
    expect(parseBindingLine(`a-1\t${impl}\t1.5`)).toBeNull();
    expect(parseBindingLine(`a-1\t${impl}\t123\textra`)).toBeNull();
  });

  it("isBindingFresh uses the LATER of bind stamp and activity anchor", () => {
    const ttl = STALE_SUBAGENT_TTL_MS;
    const now = 1_000_000_000_000;
    expect(isBindingFresh(now - ttl, now - ttl, now, ttl)).toBe(true); // exactly at TTL
    expect(isBindingFresh(now - ttl - 1, now - ttl - 1, now, ttl)).toBe(false);
    // old bind stamp, recent activity → fresh
    expect(isBindingFresh(now - 2 * ttl, now - 1000, now, ttl)).toBe(true);
    // recent bind stamp, old anchor (clock skew) → fresh
    expect(isBindingFresh(now - 1000, now - 2 * ttl, now, ttl)).toBe(true);
  });
});

describe("stale bindings are absent and reaped", () => {
  it("readBindings / soleActiveBinding ignore a binding idle past the TTL", () => {
    const s = sid("stale");
    const staleAt = Date.now() - STALE_SUBAGENT_TTL_MS - 60_000;
    writeBindingAt(s, binding("a-dead", impl), staleAt);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(readBindings(s)).toEqual([]);
      expect(soleActiveBinding(s)).toBeNull();
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("ignored 1 stale binding(s)");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("refreshBindingActivity reaps a fully-stale binding file", async () => {
    const s = sid("stale");
    const staleAt = Date.now() - STALE_SUBAGENT_TTL_MS - 60_000;
    writeBindingAt(s, binding("a-dead", impl), staleAt);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await refreshBindingActivity(s);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("reaped 1 stale binding(s)");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(existsSync(machineBindingPath(s))).toBe(false);
  });

  it("a reap preserves malformed lines — corruption evidence is never laundered", async () => {
    const s = sid("mixed");
    const path = machineBindingPath(s);
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    const staleAt = Date.now() - STALE_SUBAGENT_TTL_MS - 60_000;
    writeFileSync(path, `garbage-no-tab\n${formatBindingLine(binding("a-dead", impl), staleAt)}\n`);
    utimesSync(path, new Date(staleAt), new Date(staleAt));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await refreshBindingActivity(s);
    } finally {
      stderrSpy.mockRestore();
    }
    // Stale binding gone, malformed line kept → the gate still fails closed.
    expect(readFileSync(path, "utf-8")).toBe("garbage-no-tab\n");
  });

  it("unbind preserves malformed lines — the file survives and the gate still fails closed", async () => {
    const s = sid("unbind-malformed");
    const path = machineBindingPath(s);
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    // One valid fresh binding plus one malformed line (old-format /
    // corrupt) — exactly what refreshBindingActivity preserves as
    // fail-closed evidence.
    writeFileSync(path, `${formatBindingLine(binding("a-1", impl), Date.now())}\ngarbage-no-tab\n`);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await unbindMachineAgent(s, impl, "a-1");
      // The valid binding is gone, but the malformed line is NOT laundered
      // away and the file is NOT unlinked…
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("garbage-no-tab\n");

      // …so the gate's file-present-but-zero-bindings check still fires.
      const result = await enforce(
        JSON.stringify({ session_id: s, tool_name: "Write", tool_input: {} }),
        [],
      );
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("no parseable bindings");
      }
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a fresh bind reaps stale leftovers and is honored as the sole binding", async () => {
    const s = sid("bind-reaps");
    const staleAt = Date.now() - STALE_SUBAGENT_TTL_MS - 60_000;
    writeBindingAt(s, binding("a-dead", impl), staleAt);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await bindMachineAgent(s, parseAgentType(impl)!, parseAgentId("a-live")!);
      writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-live\n"); // sole-active needs the bound agent rostered
      expect(readBindings(s)).toEqual([binding("a-live", impl)]);
      // NOT contended: the dead binding no longer voids attribution.
      expect(soleActiveBinding(s)?.agentId).toBe("a-live");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("fresh bindings and activity refresh", () => {
  it("a freshly-bound machine is honored", async () => {
    const s = sid("fresh");
    await bindMachineAgent(s, parseAgentType(impl)!, parseAgentId("a-1")!);
    writeFileSync(`${SUBAGENT_DIR}/${s}.active`, "a-1\n"); // sole-active needs the bound agent rostered
    expect(readBindings(s)).toEqual([binding("a-1", impl)]);
    expect(soleActiveBinding(s)?.epoch).toBe(`a-1:${impl}`);
    await refreshBindingActivity(s);
    expect(existsSync(machineBindingPath(s))).toBe(true);
    expect(readBindings(s)).toHaveLength(1);
  });

  it("activity refresh extends a binding's life past what its bind stamp allows", async () => {
    const s = sid("extend");
    const t0 = Date.now();
    writeBindingAt(s, binding("a-1", impl), t0);

    // Halfway to expiry the gate/recorder acts → anchor moves to t1.
    const t1 = t0 + STALE_SUBAGENT_TTL_MS / 2;
    await refreshBindingActivity(s, t1);

    // Past the ORIGINAL expiry: without the refresh this binding is stale…
    const t2 = t0 + STALE_SUBAGENT_TTL_MS + 60_000;
    expect(readBindings(s, t2)).toEqual([binding("a-1", impl)]); // …but the t1 activity keeps it alive

    // And past the REFRESHED expiry it is gone.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const t3 = t1 + STALE_SUBAGENT_TTL_MS + 60_000;
      expect(readBindings(s, t3)).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("gate behavior for expired bindings", () => {
  it("a stale binding no longer gates the session: passthrough + reap, not fail-closed", async () => {
    const s = sid("gate-stale");
    const staleAt = Date.now() - STALE_SUBAGENT_TTL_MS - 60_000;
    writeBindingAt(s, binding("a-dead", impl), staleAt);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await enforce(
        JSON.stringify({ session_id: s, tool_name: "Write", tool_input: {} }),
        [],
      );
      expect(result.kind).toBe("passthrough");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(existsSync(machineBindingPath(s))).toBe(false); // reaped
  });
});
