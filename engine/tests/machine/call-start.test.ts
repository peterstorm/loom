/**
 * Call-start stamps — the PreToolUse half of call-scoped report freshness.
 *
 * Pins, for the pure vocabulary AND both SessionRegistry implementations
 * (fs adapter, in-memory fake):
 *   - roundtrip: recordCallStart → callStartFor returns the stamp
 *   - re-stamping a toolUseId refreshes it (delete-then-set recency)
 *   - retention is bounded to CALL_START_CAP most-recent entries — the
 *     OLDEST stamps are pruned first, so interleaved calls in a session
 *     don't evict each other instantly
 *   - missing/corrupt state reads as null (fail closed downstream)
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import {
  CALL_START_CAP,
  CALL_START_SUFFIX,
  callStartOf,
  parseCallStartEntries,
  parseSessionId,
  pruneCallStarts,
  type SessionRegistry,
} from "../../src/machine/evidence";
import { fsSessionRegistry } from "../../src/machine/session-registry";
import { SUBAGENT_DIR } from "../../src/config";
import { inMemorySessionRegistry } from "./fake-session-registry";

const run = `call-start-${process.pid}-${Date.now()}`;
const sid = (name: string) => parseSessionId(`${run}-${name}`)!;
const sessions = ["roundtrip", "prune", "restamp", "corrupt"].map(sid);

afterAll(() => {
  for (const s of sessions) {
    try {
      unlinkSync(`${SUBAGENT_DIR}/${s}${CALL_START_SUFFIX}`);
    } catch {}
  }
});

describe("pure call-start vocabulary", () => {
  it("parseCallStartEntries accepts what recordCallStart writes and drops malformed entries", () => {
    expect(
      parseCallStartEntries('[{"id":"toolu_1","startMs":1000},{"id":"toolu_2","startMs":2000}]'),
    ).toEqual([
      { id: "toolu_1", startMs: 1000 },
      { id: "toolu_2", startMs: 2000 },
    ]);
    // Malformed ENTRIES are dropped one-by-one (fail closed: a dropped
    // stamp only ever rejects artifacts)…
    expect(
      parseCallStartEntries(
        '[{"id":"a","startMs":1},{"id":"neg","startMs":-5},{"id":"frac","startMs":1.5},' +
          '{"id":"str","startMs":"9"},{"id":"","startMs":3},{"id":"huge","startMs":9007199254740993},' +
          '1,"x",null,{"startMs":4},{"id":"nostamp"}]',
      ),
    ).toEqual([{ id: "a", startMs: 1 }]);
    // …while a non-array file is corruption the caller must log — INCLUDING
    // the pre-array Record shape, which fails closed instead of being read
    // through JS key-ordering semantics.
    expect(parseCallStartEntries('{"toolu_1":1000,"toolu_2":2000}')).toBeNull();
    expect(parseCallStartEntries("not json")).toBeNull();
    expect(parseCallStartEntries('"str"')).toBeNull();
    expect(parseCallStartEntries("null")).toBeNull();
  });

  it("pruneCallStarts keeps the LAST cap entries in order (oldest dropped first)", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: `t-${i}`, startMs: i }));
    expect(pruneCallStarts(entries, 3).map((e) => e.id)).toEqual(["t-2", "t-3", "t-4"]);
    expect(pruneCallStarts(entries, 10)).toEqual(entries);
    expect(pruneCallStarts([], 3)).toEqual([]);
  });

  it("callStartOf scans from the END so a duplicate id resolves to the most recent stamp", () => {
    const entries = [
      { id: "t", startMs: 100 },
      { id: "other", startMs: 150 },
      { id: "t", startMs: 200 },
    ];
    expect(callStartOf(entries, "t")).toBe(200);
    expect(callStartOf(entries, "other")).toBe(150);
    expect(callStartOf(entries, "missing")).toBeNull();
    expect(callStartOf([], "t")).toBeNull();
  });
});

/** Shared contract suite — both implementations must agree. */
function registryContract(name: string, registry: SessionRegistry) {
  describe(`call-start stamps — ${name}`, () => {
    it("roundtrip: a recorded stamp is readable; unknown ids are null", async () => {
      const s = sid("roundtrip");
      expect(registry.callStartFor(s, "toolu_a")).toBeNull();
      await registry.recordCallStart(s, "toolu_a", 12345);
      expect(registry.callStartFor(s, "toolu_a")).toBe(12345);
      expect(registry.callStartFor(s, "toolu_missing")).toBeNull();
    });

    it("re-stamping the same toolUseId refreshes the stamp", async () => {
      const s = sid("restamp");
      await registry.recordCallStart(s, "toolu_r", 100);
      await registry.recordCallStart(s, "toolu_r", 200);
      expect(registry.callStartFor(s, "toolu_r")).toBe(200);
    });

    it(`retention is bounded to CALL_START_CAP (${CALL_START_CAP}) — oldest pruned first`, async () => {
      const s = sid("prune");
      for (let i = 0; i < CALL_START_CAP + 5; i++) {
        await registry.recordCallStart(s, `toolu_${i}`, 1000 + i);
      }
      // The 5 oldest are gone…
      for (let i = 0; i < 5; i++) {
        expect(registry.callStartFor(s, `toolu_${i}`), `toolu_${i}`).toBeNull();
      }
      // …and the CAP most-recent survive, including the newest and the
      // oldest survivor (so interleaved calls aren't evicted instantly).
      expect(registry.callStartFor(s, "toolu_5")).toBe(1005);
      expect(registry.callStartFor(s, `toolu_${CALL_START_CAP + 4}`)).toBe(1000 + CALL_START_CAP + 4);
    });
  });
}

registryContract("fs adapter", fsSessionRegistry);
registryContract("in-memory fake", inMemorySessionRegistry());

describe("call-start stamps — fs corruption handling", () => {
  it("a corrupt stamp file reads as null (loudly) and is replaced by the next stamp", async () => {
    const s = sid("corrupt");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}${CALL_START_SUFFIX}`, "{corrupt");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(fsSessionRegistry.callStartFor(s, "toolu_x")).toBeNull();
      await fsSessionRegistry.recordCallStart(s, "toolu_x", 777);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("corrupt call-start file");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(fsSessionRegistry.callStartFor(s, "toolu_x")).toBe(777);
  });

  it("an old Record-shaped stamp file fails closed as corruption and is replaced by the next stamp", async () => {
    const s = sid("corrupt");
    mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(`${SUBAGENT_DIR}/${s}${CALL_START_SUFFIX}`, '{"toolu_old":123}');

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(fsSessionRegistry.callStartFor(s, "toolu_old")).toBeNull();
      await fsSessionRegistry.recordCallStart(s, "toolu_new", 999);
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("corrupt call-start file");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(fsSessionRegistry.callStartFor(s, "toolu_new")).toBe(999);
    expect(fsSessionRegistry.callStartFor(s, "toolu_old")).toBeNull();
  });
});
