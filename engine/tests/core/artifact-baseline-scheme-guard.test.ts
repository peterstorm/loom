import { describe, expect, it } from "vitest";
import {
  changedDeclaredArtifacts,
  parseArtifactBaseline,
  type ArtifactBaseline,
  type SnapshotScheme,
} from "../../src/core/artifact-baseline";
import { parseCanonicalArtifactBaseline } from "../../src/core/implementation-completion";

function parsed<Scheme extends SnapshotScheme>(raw: unknown): ArtifactBaseline<Scheme> {
  const result = parseArtifactBaseline<Scheme>(raw);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

describe("artifact baseline parse diagnostics", () => {
  it("reports a duplicate inline at its raw index even when that entry's snapshot also fails", () => {
    const result = parseArtifactBaseline<"declared-artifact">([
      { artifact: "src/a.ts", snapshot: { kind: "bogus" } },
      { artifact: "src/b.ts", snapshot: { kind: "missing" } },
      { artifact: "src/b.ts", snapshot: { kind: "bogus" } },
    ]);
    expect(result).toEqual({
      ok: false,
      errors: [
        'artifact_baseline[0].snapshot must be {kind:"missing"} or {kind:"sha256", digest:<64 lowercase hex chars>}',
        'artifact_baseline[2].artifact duplicates "src/b.ts"',
        'artifact_baseline[2].snapshot must be {kind:"missing"} or {kind:"sha256", digest:<64 lowercase hex chars>}',
      ],
    });
  });

  it("names the raw index of a duplicate that follows a refused entry", () => {
    expect(parseArtifactBaseline<"declared-artifact">([
      { artifact: "src/a.ts", snapshot: { kind: "missing" } },
      "not a record",
      { artifact: "src/a.ts", snapshot: { kind: "missing" } },
    ])).toEqual({
      ok: false,
      errors: ["artifact_baseline[1] must be an object", 'artifact_baseline[2].artifact duplicates "src/a.ts"'],
    });
  });
});

describe("changedDeclaredArtifacts compares one concrete digest scheme only", () => {
  it("refuses at compile time a baseline typed with the wide scheme union", () => {
    const declared = parsed<"declared-artifact">([{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    const repository = parsed<"repository-change">([{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    const wide: ArtifactBaseline<SnapshotScheme> = declared;
    // @ts-expect-error a wide-scheme baseline could otherwise accept a repository-change current.
    changedDeclaredArtifacts(wide, repository);
    // @ts-expect-error nor a wide baseline against a wide current.
    changedDeclaredArtifacts(wide, wide);
    const digestOnly = parseCanonicalArtifactBaseline([{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    if (!digestOnly.ok) throw new Error("expected the canonical parse to succeed");
    // @ts-expect-error the default (digest-only) canonical parse is wide and cannot reach a comparison.
    changedDeclaredArtifacts(digestOnly.value, declared);
    expect(changedDeclaredArtifacts(declared, declared)).toEqual({ ok: true, value: [] });
    expect(changedDeclaredArtifacts(repository, repository)).toEqual({ ok: true, value: [] });
  });
});
