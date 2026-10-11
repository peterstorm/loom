/**
 * The type-diagnostics run slot: one check per tsconfig at a time. The
 * acquire decision is pure (slotDecision); the file protocol around it is
 * exercised against a real temp cache directory.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STALE_RUN_MS,
  acquireRunSlot,
  handSlotTo,
  releaseRunSlot,
  slotDecision,
  type RunSlotPaths,
  type SlotRecord,
} from "../../src/handlers/type-diagnostics-run-slot";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function cache(): RunSlotPaths {
  const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), "loom-run-slot-")));
  temporary.push(cacheDir);
  return { cacheDir, slot: join(cacheDir, "k.slot") };
}

const T0 = 1_800_000_000_000;
const record = (overrides: Partial<SlotRecord> = {}, paths?: RunSlotPaths): SlotRecord =>
  ({ pid: process.pid, startedAt: T0, output: join(paths?.cacheDir ?? "/cache", "k.run.out"), ...overrides });

/** A pid that is certainly not alive: a child that already exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid!;

const held = (paths: RunSlotPaths): unknown => JSON.parse(readFileSync(paths.slot, "utf-8"));

describe("slotDecision", () => {
  it.each<[string, SlotRecord | null, boolean, number, "busy" | "reclaim"]>([
    ["a live, fresh owner", record(), true, T0 + 1_000, "busy"],
    ["a live owner exactly at the stale age", record(), true, T0 + STALE_RUN_MS, "busy"],
    ["a live owner past the stale age (its pid may be recycled)", record(), true, T0 + STALE_RUN_MS + 1, "reclaim"],
    ["a dead owner", record(), false, T0 + 1_000, "reclaim"],
    ["an unreadable record", null, true, T0, "reclaim"],
  ])("%s → %s", (_label, current, ownerAlive, now, expected) => {
    expect(slotDecision(current, ownerAlive, now)).toBe(expected);
  });
});

describe("acquireRunSlot", () => {
  it("takes a free slot and records the owner", () => {
    const paths = cache();
    const mine = record({}, paths);
    expect(acquireRunSlot(paths, mine)).toEqual({ kind: "acquired" });
    expect(held(paths)).toEqual(mine);
  });

  it("is busy while a live, fresh owner holds it, and leaves that owner's record alone", () => {
    const paths = cache();
    const owner = record({ output: join(paths.cacheDir, "owner.out") });
    writeFileSync(paths.slot, JSON.stringify(owner));
    expect(acquireRunSlot(paths, record({ startedAt: T0 + 1_000 }, paths))).toEqual({ kind: "busy" });
    expect(held(paths)).toEqual(owner);
  });

  it.each<[string, (paths: RunSlotPaths) => string]>([
    ["a dead owner", (paths) => JSON.stringify(record({ pid: deadPid(), output: join(paths.cacheDir, "old.out") }))],
    ["a stale live owner", (paths) => JSON.stringify(record({ startedAt: T0 - STALE_RUN_MS - 1, output: join(paths.cacheDir, "old.out") }))],
    ["an unreadable record", () => "not json"],
  ])("reclaims a slot held by %s, removing the old run's output", (_label, previous) => {
    const paths = cache();
    const leftover = join(paths.cacheDir, "old.out");
    writeFileSync(leftover, "old");
    writeFileSync(paths.slot, previous(paths));
    const mine = record({}, paths);

    expect(acquireRunSlot(paths, mine)).toEqual({ kind: "acquired" });
    expect(held(paths)).toEqual(mine);
    if (previous(paths).startsWith("{")) expect(existsSync(leftover)).toBe(false);
  });

  it("never removes a file outside the cache directory that a slot record names", () => {
    const paths = cache();
    const outsideDir = mkdtempSync(join(tmpdir(), "loom-run-slot-outside-"));
    temporary.push(outsideDir);
    const outside = join(outsideDir, "keep.out");
    writeFileSync(outside, "keep");
    writeFileSync(paths.slot, JSON.stringify(record({ pid: deadPid(), output: outside })));
    acquireRunSlot(paths, record({}, paths));
    expect(readFileSync(outside, "utf-8")).toBe("keep");
  });

  it("leaves no staging files behind", () => {
    const paths = cache();
    acquireRunSlot(paths, record({}, paths));
    acquireRunSlot(paths, record({ startedAt: T0 + 1 }, paths));
    expect(spawnSync("ls", [paths.cacheDir], { encoding: "utf-8" }).stdout.trim().split("\n")).toEqual(["k.slot"]);
  });
});

describe("handSlotTo and releaseRunSlot", () => {
  it("hands the held slot to the detached compiler", () => {
    const paths = cache();
    const mine = record({}, paths);
    acquireRunSlot(paths, mine);
    handSlotTo(paths, { ...mine, pid: 4242 });
    expect(held(paths)).toEqual({ ...mine, pid: 4242 });
  });

  it("releases its own slot and output", () => {
    const paths = cache();
    const mine = record({}, paths);
    writeFileSync(mine.output, "result");
    acquireRunSlot(paths, mine);
    releaseRunSlot(paths, mine.output);
    expect(existsSync(paths.slot)).toBe(false);
    expect(existsSync(mine.output)).toBe(false);
  });

  it("leaves a slot another run reclaimed in the meantime", () => {
    const paths = cache();
    const mine = record({}, paths);
    acquireRunSlot(paths, mine);
    const successor = record({ startedAt: T0 + STALE_RUN_MS + 1, output: join(paths.cacheDir, "successor.out") });
    writeFileSync(paths.slot, JSON.stringify(successor));

    releaseRunSlot(paths, mine.output);
    expect(held(paths)).toEqual(successor);
  });
});
