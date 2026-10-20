import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { drainStopCheckNotes, publishStopCheckNote, stopCheckNotePath } from "../src/stop-check-note-sidecar";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const directory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "loom-stop-check-notes-"));
  dirs.push(dir);
  return dir;
};

describe("stop-check note sidecars", () => {
  it("delivers each published note once, to its own session only, and leaves nothing behind", () => {
    const dir = directory();
    expect(publishStopCheckNote("session-a", "agent-1", { taskId: "T2", message: "timed out" }, dir)).toEqual({ ok: true });
    expect(publishStopCheckNote("session-a", "agent-2", { taskId: "T3", message: "lock held" }, dir)).toEqual({ ok: true });
    expect(publishStopCheckNote("session-b", "agent-9", { taskId: "T9", message: "budget exhausted" }, dir)).toEqual({ ok: true });

    expect(drainStopCheckNotes("session-a", dir)).toEqual({
      notes: [{ taskId: "T2", message: "timed out" }, { taskId: "T3", message: "lock held" }],
      faults: [],
    });
    expect(drainStopCheckNotes("session-a", dir)).toEqual({ notes: [], faults: [] });
    expect(readdirSync(dir)).toEqual([`session-b.agent-9.stop-check-note.json`]);
    expect(drainStopCheckNotes("session-b", dir).notes).toEqual([{ taskId: "T9", message: "budget exhausted" }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a later stop of the same agent replaces its note", () => {
    const dir = directory();
    publishStopCheckNote("s", "a", { taskId: "T2", message: "first" }, dir);
    publishStopCheckNote("s", "a", { taskId: "T2", message: "second" }, dir);
    expect(drainStopCheckNotes("s", dir).notes).toEqual([{ taskId: "T2", message: "second" }]);
  });

  it("a session id that prefixes another's never drains the other's notes", () => {
    const dir = directory();
    publishStopCheckNote("abc.def", "agent", { taskId: "T1", message: "other" }, dir);
    publishStopCheckNote("abc", "agent.x", { taskId: "T2", message: "mine" }, dir);
    expect(drainStopCheckNotes("abc", dir).notes).toEqual([{ taskId: "T2", message: "mine" }]);
    expect(drainStopCheckNotes("abc.def", dir).notes).toEqual([{ taskId: "T1", message: "other" }]);
  });

  it("reports an unreadable sidecar as a fault once, and removes it", () => {
    const dir = directory();
    writeFileSync(stopCheckNotePath("s", "broken", dir), "{not json");
    writeFileSync(stopCheckNotePath("s", "shapeless", dir), JSON.stringify({ taskId: "T1" }));
    const drained = drainStopCheckNotes("s", dir);
    expect(drained.notes).toEqual([]);
    expect(drained.faults).toHaveLength(2);
    expect(drained.faults.join("\n")).toContain("holds no stop-check note");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a missing directory drains nothing; an unwritable one refuses the publish with its reason", () => {
    expect(drainStopCheckNotes("s", join(directory(), "absent"))).toEqual({ notes: [], faults: [] });
    const locked = directory();
    chmodSync(locked, 0o500);
    try {
      const published = publishStopCheckNote("s", "a", { taskId: "T1", message: "m" }, locked);
      if (process.getuid?.() !== 0) expect(published).toMatchObject({ ok: false, reason: expect.stringContaining(locked) });
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
