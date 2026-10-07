import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { admitReviewedWorkspace, reviewedWorkspaceObservation } from "../../src/core/reviewed-workspace";
import { parseWaveFrozenSource, waveFrozenSource } from "../../src/core/wave-frozen-source";
import { observedWorkspace } from "../fixtures/reviewed-workspace";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("reviewedWorkspaceObservation", () => {
  it("keeps the persisted file and absent encodings byte-identical", () => {
    const bytes = Buffer.from("export const a = 1;\n");
    expect(observedWorkspace("T1", ["src/a.ts", "src/gone.ts"], [
      { path: "src/gone.ts", bytes: null },
      { path: "src/a.ts", bytes },
    ]).headSha).toBe(sha256(JSON.stringify([["src/a.ts", bytes.toString("base64")], ["src/gone.ts", null]])));
  });

  it("covers a scoped directory with the leaf files below it, encoded exactly like files", () => {
    const a = Buffer.from("export const a = 1;\n");
    const b = Buffer.from("export const b = 2;\n");
    expect(observedWorkspace("T1", ["calibration/run"], [
      { path: "calibration/run/nested/b.ts", bytes: b },
      { path: "calibration/run/a.ts", bytes: a },
    ]).headSha).toBe(sha256(JSON.stringify([
      ["calibration/run/a.ts", a.toString("base64")],
      ["calibration/run/nested/b.ts", b.toString("base64")],
    ])));
  });

  it("refuses, as a value, a leaf outside every scoped path and a scoped path with no artifact", () => {
    expect(reviewedWorkspaceObservation("T1", ["calibration/run"], [
      { path: "calibration/run-other/a.ts", bytes: Buffer.from("x") },
    ])).toEqual({ ok: false, error: "reviewed workspace contains out-of-scope artifact calibration/run-other/a.ts" });
    expect(reviewedWorkspaceObservation("T1", ["calibration/run", "src.ts"], [
      { path: "calibration/run/a.ts", bytes: Buffer.from("x") },
    ])).toEqual({ ok: false, error: "reviewed workspace snapshot omitted declared artifact src.ts" });
  });

  it.each([
    ["a trailing-slash directory scope", ["calibration/run/"], "calibration/run/a.ts"],
    ["a dot-segment scope", ["./calibration/run"], "calibration/run/a.ts"],
    ["an absolute artifact", ["calibration/run"], "/calibration/run/a.ts"],
    ["a traversal artifact", ["calibration/run"], "calibration/run/../a.ts"],
  ])("refuses %s as non-canonical instead of reporting an omitted artifact", (_name, scope, path) => {
    const observed = reviewedWorkspaceObservation("T1", scope, [{ path, bytes: Buffer.from("x") }]);
    expect(observed.ok).toBe(false);
    if (observed.ok) return;
    expect(observed.error).not.toContain("omitted declared artifact");
    expect(observed.error).toMatch(/reviewed workspace (scope|artifact) path must/);
  });

  it("owns its bytes: mutating the observed buffer cannot rewrite the observation", () => {
    const bytes = Buffer.from("first");
    const observed = observedWorkspace("T1", ["a.ts"], [{ path: "a.ts", bytes }]);
    bytes.write("xxxxx");
    const artifact = observed.artifacts[0]!;
    expect(Buffer.from(artifact.contentBase64!, "base64").toString()).toBe("first");
    // The content is a primitive string, immutable by construction; the
    // artifact holding it is frozen.
    expect(typeof artifact.contentBase64).toBe("string");
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(observed.artifacts)).toBe(true);
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it("encodes only a typed-array view's own window, never its backing buffer", () => {
    const backing = Buffer.from("xxfirstyy");
    const view = backing.subarray(2, 7);
    expect(observedWorkspace("T1", ["a.ts"], [{ path: "a.ts", bytes: view }]).headSha)
      .toBe(observedWorkspace("T1", ["a.ts"], [{ path: "a.ts", bytes: Buffer.from("first") }]).headSha);
  });

  it("property: the headSha of any bytes is the persisted encoding, whatever iterable carried them", () => {
    // The pre-base64 representation hashed `Buffer.from(Uint8Array.from(bytes))`
    // per file; persisted accepted-review authority stores that digest, so the
    // representation change must leave it byte-identical.
    fc.assert(fc.property(fc.uint8Array(), (bytes) => {
      const legacy = sha256(JSON.stringify([["a.ts", Buffer.from(Uint8Array.from(bytes)).toString("base64")]]));
      expect(observedWorkspace("T1", ["a.ts"], [{ path: "a.ts", bytes }]).headSha).toBe(legacy);
      expect(observedWorkspace("T1", ["a.ts"], [{ path: "a.ts", bytes: [...bytes] }]).headSha).toBe(legacy);
    }));
  });

  it("refuses, as a value, a duplicate artifact, a non-byte element and a throwing iterable", () => {
    expect(reviewedWorkspaceObservation("T1", ["a.ts"], [
      { path: "a.ts", bytes: Buffer.from("x") },
      { path: "a.ts", bytes: Buffer.from("x") },
    ])).toEqual({ ok: false, error: "reviewed workspace contains duplicate artifact a.ts" });
    expect(reviewedWorkspaceObservation("T1", ["a.ts"], [{ path: "a.ts", bytes: [1, 256] }]))
      .toEqual({ ok: false, error: "reviewed workspace artifact a.ts contains an invalid byte" });
    const throwing: Iterable<number> = { [Symbol.iterator]: () => { throw new Error("unreadable"); } };
    expect(reviewedWorkspaceObservation("T1", ["a.ts"], [{ path: "a.ts", bytes: throwing }]))
      .toEqual({ ok: false, error: "reviewed workspace artifact a.ts does not contain iterable bytes" });
  });

  it("freezes a directory's leaves as individually readable source files", () => {
    const observation = observedWorkspace("T13", ["calibration/run", "calibration/run/a.ts"], [
      { path: "calibration/run/a.ts", bytes: Buffer.from("a\n") },
      { path: "calibration/run/gone.ts", bytes: null },
    ]);
    const source = waveFrozenSource(observation);
    expect(source.files.map(({ path, kind }) => [path, kind])).toEqual([
      ["calibration/run/a.ts", "text"],
      ["calibration/run/gone.ts", "absent"],
    ]);
    expect(parseWaveFrozenSource(JSON.parse(JSON.stringify(source)))).toEqual({ ok: true, value: source });
  });

  it("freezes a binary leaf with the observation's own base64 text", () => {
    const binary = Uint8Array.from([0xff, 0x00, 0x61]);
    const source = waveFrozenSource(observedWorkspace("T1", ["a.bin"], [{ path: "a.bin", bytes: binary }]));
    expect(source.files).toEqual([{
      path: "a.bin",
      kind: "binary",
      digest: createHash("sha256").update(binary).digest("hex"),
      byteLength: 3,
      contentBase64: Buffer.from(binary).toString("base64"),
    }]);
  });
});

describe("admitReviewedWorkspace", () => {
  const minted = observedWorkspace("T1", ["src/b.ts", "src/a.ts"], [
    { path: "src/a.ts", bytes: Buffer.from("a") },
    { path: "src/b.ts", bytes: null },
  ]);

  it("admits the minted observation itself for its own Task and exact scope, in any scope order", () => {
    expect(admitReviewedWorkspace("T1", ["src/a.ts", "src/b.ts"], minted)).toEqual({ ok: true, value: minted });
    const admitted = admitReviewedWorkspace("T1", ["src/b.ts", "src/a.ts"], minted);
    expect(admitted.ok && admitted.value).toBe(minted);
  });

  it.each([
    // Each forgery keeps the brand's type through the spread, but not the proof.
    ["a rewritten digest", { ...minted, headSha: "f".repeat(64) }],
    ["dropped artifacts", { ...minted, artifacts: [] }],
    ["duplicated artifacts", { ...minted, artifacts: [...minted.artifacts, ...minted.artifacts] }],
    ["a byte-identical copy", { ...minted }],
  ] as const)("refuses %s built around the smart constructor", (_name, forged) => {
    expect(admitReviewedWorkspace("T1", ["src/a.ts", "src/b.ts"], forged)).toEqual({
      ok: false,
      error: "Task T1 workspace observation was not minted by the reviewed-workspace core",
    });
  });

  it("refuses a foreign Task, a different scope and a duplicate expected scope", () => {
    expect(admitReviewedWorkspace("T2", ["src/a.ts", "src/b.ts"], minted))
      .toEqual({ ok: false, error: "Task T2 workspace observation has mismatched Task identity" });
    expect(admitReviewedWorkspace("T1", ["src/a.ts"], minted))
      .toEqual({ ok: false, error: "Task T1 workspace observation differs from its exact review scope" });
    expect(admitReviewedWorkspace("T1", ["src/a.ts", "src/a.ts"], minted))
      .toEqual({ ok: false, error: "Task T1 expected review scope contains duplicate paths" });
  });
});
