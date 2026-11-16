/**
 * The Verify Slice: `npm run verify` unset runs every tier, and CI's slices
 * (static, every unit shard, smoke) together run exactly the whole command.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseVerifySlice, verifySteps, type VerifySlice } from "../../src/core/verify-slice";
import { REPOSITORY } from "../fixtures/repository-roots";

const parsed = (raw: string | undefined): VerifySlice => {
  const result = parseVerifySlice(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("parseVerifySlice", () => {
  it.each([undefined, ""])("reads %j as the whole command", (raw) => {
    expect(parsed(raw)).toEqual({ kind: "all" });
  });

  it("reads the named slices", () => {
    expect(parsed("static")).toEqual({ kind: "static" });
    expect(parsed("smoke")).toEqual({ kind: "smoke" });
    expect(parsed("unit:3/4")).toEqual({ kind: "unit", index: 3, total: 4 });
  });

  it.each(["unit:0/4", "unit:5/4", "unit:1", "unit:a/b", "unit:01/4", "lint", "all", " static"])("refuses %j", (raw) => {
    const result = parseVerifySlice(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("LOOM_VERIFY_SLICE must be");
  });

  it("accepts exactly the shards 1..n of n", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 40 }), (index, total) => {
      expect(parseVerifySlice(`unit:${index}/${total}`).ok).toBe(index >= 1 && index <= total);
    }));
  });
});

describe("verifySteps", () => {
  it("runs every tier in order when unset", () => {
    expect(verifySteps(parsed(undefined)).map(({ script }) => script)).toEqual(["typecheck", "lint", "test:unit", "test:smoke"]);
  });

  it("covers the whole command with static, every unit shard and smoke", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), (total) => {
      const slices = ["static", ...Array.from({ length: total }, (_, index) => `unit:${index + 1}/${total}`), "smoke"];
      const steps = slices.flatMap((raw) => verifySteps(parsed(raw)));
      const scripts = [...new Set(steps.map(({ script }) => script))];
      expect(scripts).toEqual(verifySteps(parsed(undefined)).map(({ script }) => script));
      const shards = steps.filter(({ script }) => script === "test:unit").map(({ args }) => args.join(" "));
      expect(shards).toEqual(Array.from({ length: total }, (_, index) => `--shard=${index + 1}/${total}`));
    }));
  });

  it("plans only scripts engine/package.json defines", () => {
    const manifest: unknown = JSON.parse(readFileSync(join(REPOSITORY, "engine", "package.json"), "utf8"));
    const scripts = typeof manifest === "object" && manifest !== null && "scripts" in manifest ? manifest.scripts : {};
    for (const raw of [undefined, "static", "unit:1/2", "smoke"]) {
      for (const { script } of verifySteps(parsed(raw))) expect(Object.keys(scripts ?? {})).toContain(script);
    }
  });
});
