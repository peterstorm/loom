/**
 * Runtime seams (ADR-0088, loom#199 Cause 5): a contract names the production
 * symbols its requests pass through, the plan grammar parses them, the
 * contract persists them, and the State File proves them.
 */
import { describe, expect, it } from "vitest";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceContractsFromPlan,
  contractBindingErrors,
  parseAcceptanceContracts,
  renderRuntimeSeamGaps,
  runtimeSeamGaps,
  type FrozenPathObservation,
} from "../../src/core/acceptance-contract";
import { observeFrozenDigests } from "../../src/orchestration/frozen-path-observation";
import type { CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { digest, seen } from "../fixtures/acceptance-fixtures";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import type { PlanContract } from "../../src/types";

const TYPES = "engine/src/core/payload-types.ts";
const ACCEPTANCE = "tests/acceptance/payload.acceptance.test.ts";

const seenText = (text: string): FrozenPathObservation => seen(digest("b"), text);
const observationsOf = (entries: readonly (readonly [string, FrozenPathObservation])[]): ReadonlyMap<string, FrozenPathObservation> => new Map(entries);

const contractsOf = (block: string): readonly PlanContract[] =>
  parsePlanModels(`# Plan\n\n## Contracts\n\n### CT-1: Payload ingestion\n\n${block}\n`).contracts;
const base = [`**Types file:** \`${TYPES}\``, "**Acceptance tests:**", `- \`${ACCEPTANCE}\` — AS-003`];
const withSeams = (...lines: string[]) => contractsOf([...base, "**Runtime seams:**", ...lines, "**Statement:** Wins."].join("\n"));

describe("**Runtime seams:** parsing", () => {
  it("declares each seam with its source, in both item forms", () => {
    const [contract] = withSeams("- `encodeNodeCheckpoint` (`@fuguejs/host`)", "- `toJson` — response serialization");
    expect(contract?.declaration).toMatchObject({
      kind: "declared",
      runtimeSeams: [{ symbol: "encodeNodeCheckpoint", source: "`@fuguejs/host`" }, { symbol: "toJson", source: "response serialization" }],
    });
  });

  it("declares no seams when the label is absent, and a seam with no source", () => {
    expect(contractsOf([...base, "**Statement:** Wins."].join("\n"))[0]?.declaration).toMatchObject({ kind: "declared", runtimeSeams: [] });
    expect(withSeams("- `serve`")[0]?.declaration).toMatchObject({ runtimeSeams: [{ symbol: "serve", source: null }] });
  });

  it("refuses a malformed item, an inline value and a repeated symbol", () => {
    expect(withSeams("- encodeNodeCheckpoint")[0]?.declaration)
      .toEqual({ kind: "malformed", problems: [{ kind: "malformed-runtime-seam", line: "- encodeNodeCheckpoint" }] });
    expect(contractsOf([...base, "**Runtime seams:** `serve`", "**Statement:** Wins."].join("\n"))[0]?.declaration)
      .toEqual({ kind: "malformed", problems: [{ kind: "malformed-runtime-seam", line: "`serve`" }] });
    expect(withSeams("- `serve`", "- `serve` (again)")[0]?.declaration)
      .toEqual({ kind: "malformed", problems: [{ kind: "duplicate-runtime-seam", symbol: "serve" }] });
  });

  it("renders a malformed seam as a binding error, and reports the label outside ## Contracts as a stray", () => {
    expect(contractBindingErrors(withSeams("- encode"), [{ id: "T1", file_list: [TYPES, ACCEPTANCE], spec_anchors: [], depends_on: [], newTestWaiver: null }]))
      .toEqual([expect.stringContaining("runtime seam line '- encode'")]);
    expect(parsePlanModels("# Plan\n\n**Runtime seams:**\n- `x`\n").strays)
      .toContainEqual({ kind: "misplaced-label", label: "Runtime seams", home: "Contracts" });
  });
});

describe("the contract persists its runtime seams", () => {
  const tasks = [{ id: "T1", wave: 1, file_list: [TYPES, ACCEPTANCE], spec_anchors: [] }] as const;

  it("carries declared seams and omits the field when there are none; the State File loads both", () => {
    const seamed = acceptanceContractsFromPlan(withSeams("- `encodeNodeCheckpoint` (host)"), tasks);
    const plain = acceptanceContractsFromPlan(contractsOf([...base, "**Statement:** Wins."].join("\n")), tasks);
    if (!seamed.ok || !plain.ok) throw new Error("expected contracts");
    expect(seamed.value[0]?.runtimeSeams).toEqual([{ symbol: "encodeNodeCheckpoint", source: "host" }]);
    expect(plain.value[0]).not.toHaveProperty("runtimeSeams");
    // Two contracts may not freeze the same paths, so each loads on its own.
    const roundTrip = (contracts: unknown) => parseAcceptanceContracts(JSON.parse(JSON.stringify(contracts)));
    expect(roundTrip(seamed.value)).toEqual({ ok: true, value: seamed.value });
    expect(roundTrip(plain.value)).toEqual({ ok: true, value: plain.value });
  });

  it.each<[string, unknown, string]>([
    ["an empty list", [], "runtimeSeams"],
    ["a non-identifier symbol", [{ symbol: "not an id", source: null }], "symbol must be an identifier"],
    ["a blank source", [{ symbol: "serve", source: " " }], "source must be null or a non-empty string"],
    ["a repeated symbol", [{ symbol: "serve", source: null }, { symbol: "serve", source: "x" }], "names one symbol twice"],
    ["an extra key", [{ symbol: "serve", source: null, extra: 1 }], "runtimeSeams"],
    ["null", null, "runtimeSeams"],
    ["a string", "serve", "runtimeSeams"],
    ["a non-object entry", ["serve"], "runtimeSeams"],
  ])("the State File refuses %s", (_label, runtimeSeams, message) => {
    const built = acceptanceContractsFromPlan(withSeams("- `encodeNodeCheckpoint`"), tasks);
    if (!built.ok) throw new Error("expected a contract");
    const loaded = parseAcceptanceContracts([{ ...JSON.parse(JSON.stringify(built.value[0])), runtimeSeams }]);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });
});

describe("runtimeSeamGaps reads only code", () => {
  const seamed = {
    acceptance: [{ path: "a.test.ts", anchors: ["AS-001"] }, { path: "b.test.ts", anchors: ["AS-002"] }],
    runtimeSeams: [{ symbol: "encodeNodeCheckpoint", source: "host" }, { symbol: "toJson", source: null }],
  } as const;
  const text = (a: string, b: string) => observationsOf([["a.test.ts", seenText(a)], ["b.test.ts", seenText(b)]]);

  it("does not count a comment or a string literal as a reference", () => {
    const only = (body: string) => runtimeSeamGaps(seamed, text(body, "encodeNodeCheckpoint(x); toJson(y);")).map(({ seam }) => seam.symbol);
    expect(only("// encodeNodeCheckpoint toJson\nrun();")).toEqual(["encodeNodeCheckpoint", "toJson"]);
    expect(only("/* encodeNodeCheckpoint */ const s = 'toJson';")).toEqual(["encodeNodeCheckpoint", "toJson"]);
    expect(only("import { encodeNodeCheckpoint, toJson } from '@fuguejs/host';")).toEqual([]);
  });

  it("names every missing seam of every file in declaration order, and leaves an unreadable file to the frozen-path check", () => {
    const gaps = runtimeSeamGaps(seamed, observationsOf([
      ["a.test.ts", { kind: "unreadable", reason: "ENOENT" }],
      ["b.test.ts", seenText("run(input)")],
    ]));
    expect(gaps.map(({ path, seam }) => `${path}:${seam.symbol}`)).toEqual(["b.test.ts:encodeNodeCheckpoint", "b.test.ts:toJson"]);
    expect(renderRuntimeSeamGaps(gaps)).toBe("acceptance tests must run through the production path; 'b.test.ts' does not reference " +
      "runtime seam encodeNodeCheckpoint (host); 'b.test.ts' does not reference runtime seam toJson");
    expect(runtimeSeamGaps(seamed, observationsOf([]))).toEqual([]);
  });
});

describe("observeFrozenDigests", () => {
  it("returns each file's decoded text beside its digest, and refuses a link", () => {
    const root = canonicalTempDir("loom-seam-observation-");
    try {
      writeFileSync(join(root, "a.test.ts"), "encodeNodeCheckpoint(x)\n");
      symlinkSync(join(root, "a.test.ts"), join(root, "link.test.ts"));
      const observed = observeFrozenDigests(root as CanonicalRepositoryRoot, ["a.test.ts", "link.test.ts"]);
      expect(observed.get("a.test.ts")).toMatchObject({ kind: "digest", text: "encodeNodeCheckpoint(x)\n" });
      expect(observed.get("link.test.ts")?.kind).toBe("unreadable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
