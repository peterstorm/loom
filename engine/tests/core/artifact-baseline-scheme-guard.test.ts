import { describe, expect, it } from "vitest";
import * as baselineModule from "../../src/core/artifact-baseline";
import {
  changedDeclaredArtifacts,
  parseTaskBaselineField,
  DECLARED_ARTIFACT_BASELINE,
  REPOSITORY_CHANGE_BASELINE,
  UNKNOWN_SCHEME_BASELINE,
  type ArtifactBaselineScheme,
  type ArtifactBaseline,
  type SnapshotScheme,
} from "../../src/core/artifact-baseline";
import { parseCanonicalArtifactBaseline } from "../../src/core/implementation-completion";

function parsed<Scheme extends SnapshotScheme>(scheme: ArtifactBaselineScheme<Scheme>, raw: unknown): ArtifactBaseline<Scheme> {
  const result = scheme.parse(raw);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

describe("artifact baseline parse diagnostics", () => {
  it("reports a duplicate inline at its raw index even when that entry's snapshot also fails", () => {
    const result = DECLARED_ARTIFACT_BASELINE.parse([
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
    expect(DECLARED_ARTIFACT_BASELINE.parse([
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
    const declared = parsed(DECLARED_ARTIFACT_BASELINE, [{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    const repository = parsed(REPOSITORY_CHANGE_BASELINE, [{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    const wide: ArtifactBaseline<SnapshotScheme> = declared;
    // @ts-expect-error a wide-scheme baseline could otherwise accept a repository-change current.
    changedDeclaredArtifacts(wide, repository);
    // @ts-expect-error nor a wide baseline against a wide current.
    changedDeclaredArtifacts(wide, wide);
    const digestOnly = parseCanonicalArtifactBaseline(
      [{ artifact: "a.ts", snapshot: { kind: "missing" } }], "baseline", UNKNOWN_SCHEME_BASELINE);
    if (!digestOnly.ok) throw new Error("expected the canonical parse to succeed");
    // @ts-expect-error the digest-only canonical parse is wide and cannot reach a comparison.
    changedDeclaredArtifacts(digestOnly.value, declared);
    expect(changedDeclaredArtifacts(declared, declared)).toEqual({ ok: true, value: [] });
    expect(changedDeclaredArtifacts(repository, repository)).toEqual({ ok: true, value: [] });
  });

  it("refuses at compile time a comparison across the two named schemes", () => {
    const declared = parsed(DECLARED_ARTIFACT_BASELINE, [{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    const repository = parsed(REPOSITORY_CHANGE_BASELINE, [{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    // @ts-expect-error a declared-artifact baseline never compares against a repository-change current.
    changedDeclaredArtifacts(declared, repository);
    const canonical = parseCanonicalArtifactBaseline(
      [{ artifact: "a.ts", snapshot: { kind: "missing" } }], "baseline", DECLARED_ARTIFACT_BASELINE);
    if (!canonical.ok) throw new Error("expected the canonical parse to succeed");
    expect(changedDeclaredArtifacts(canonical.value, declared)).toEqual({ ok: true, value: [] });
    // @ts-expect-error the scheme a canonical parse names carries through to the comparison.
    changedDeclaredArtifacts(canonical.value, repository);
  });
});

describe("a digest-scheme claim is unforgeable outside the baseline module", () => {
  it("admits no structural stand-in for an issued scheme", () => {
    const entries = parsed(UNKNOWN_SCHEME_BASELINE, [{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    // @ts-expect-error an object literal lacks the module-private brand, even with matching members.
    const literal: ArtifactBaselineScheme<"declared-artifact"> = {
      fromEntries: DECLARED_ARTIFACT_BASELINE.fromEntries,
      capture: DECLARED_ARTIFACT_BASELINE.capture,
      parse: DECLARED_ARTIFACT_BASELINE.parse,
    };
    // @ts-expect-error a spread copies members, never the private brand.
    const spread: ArtifactBaselineScheme<"declared-artifact"> = { ...DECLARED_ARTIFACT_BASELINE };
    // @ts-expect-error the class is exported as a type only, so no caller constructs one.
    expect(() => new baselineModule.ArtifactBaselineScheme("declared-artifact")).toThrow(TypeError);
    expect(Object.hasOwn(baselineModule, "ArtifactBaselineScheme")).toBe(false);
    expect([literal, spread]).toHaveLength(2);
    expect(DECLARED_ARTIFACT_BASELINE.fromEntries(entries).ok).toBe(true);
  });

  it("refuses an issued scheme in place of a different one", () => {
    // @ts-expect-error a repository-change scheme never stands in for declared-artifact.
    const swapped: ArtifactBaselineScheme<"declared-artifact"> = REPOSITORY_CHANGE_BASELINE;
    // @ts-expect-error nor does the wide unknown scheme.
    const widened: ArtifactBaselineScheme<"declared-artifact"> = UNKNOWN_SCHEME_BASELINE;
    // @ts-expect-error a canonical parse cannot claim a scheme its issued entry points do not prove.
    parseCanonicalArtifactBaseline<"declared-artifact">([], "baseline", UNKNOWN_SCHEME_BASELINE);
    expect([swapped, widened]).toHaveLength(2);
  });

  it("carries the scheme in the type alone: an issued instance exposes only its entry points", () => {
    for (const scheme of [DECLARED_ARTIFACT_BASELINE, REPOSITORY_CHANGE_BASELINE, UNKNOWN_SCHEME_BASELINE]) {
      expect(Object.isFrozen(scheme)).toBe(true);
      expect(Object.keys(scheme)).toEqual([]);
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(scheme)).sort()).toEqual(["capture", "constructor", "fromEntries", "parse"]);
    }
    expect(new Set([DECLARED_ARTIFACT_BASELINE, REPOSITORY_CHANGE_BASELINE, UNKNOWN_SCHEME_BASELINE]).size).toBe(3);
  });
});

describe("a Task baseline field selects its own digest scheme", () => {
  const raw = [{ artifact: "src/a.ts", snapshot: { kind: "missing" } }];

  it("parses a present field under the scheme that field owns", () => {
    const repository = parseTaskBaselineField({ repository_baseline: raw }, "repository_baseline", "T1 repository_baseline");
    const declared = parseTaskBaselineField({ artifact_baseline: raw }, "artifact_baseline", "T1 artifact_baseline");
    if (repository === undefined || !repository.ok || declared === undefined || !declared.ok) {
      throw new Error("expected both fields to parse");
    }
    expect(changedDeclaredArtifacts(repository.value, parsed(REPOSITORY_CHANGE_BASELINE, raw))).toEqual({ ok: true, value: [] });
    expect(changedDeclaredArtifacts(declared.value, parsed(DECLARED_ARTIFACT_BASELINE, raw))).toEqual({ ok: true, value: [] });
    // @ts-expect-error a repository_baseline field never compares against a declared-artifact current.
    changedDeclaredArtifacts(repository.value, parsed(DECLARED_ARTIFACT_BASELINE, raw));
  });

  it("is undefined for an absent field and names the field path in a refusal", () => {
    expect(parseTaskBaselineField({}, "attempt_repository_baseline", "T1 attempt_repository_baseline")).toBeUndefined();
    expect(parseTaskBaselineField({ attempt_artifact_baseline: "bogus" }, "attempt_artifact_baseline", "T1 attempt"))
      .toEqual({ ok: false, errors: ["T1 attempt must be an array"] });
  });
});

describe("scheme selection lives in the named entry points", () => {
  it("exports no constructor whose digest scheme a caller chooses by type argument", () => {
    for (const name of ["artifactBaseline", "provenArtifactBaseline", "capturedArtifactBaseline", "parseArtifactBaseline"]) {
      expect(Object.hasOwn(baselineModule, name), name).toBe(false);
    }
    // @ts-expect-error the generic parse is module-private.
    expect(baselineModule.parseArtifactBaseline).toBeUndefined();
    for (const scheme of [DECLARED_ARTIFACT_BASELINE, REPOSITORY_CHANGE_BASELINE, UNKNOWN_SCHEME_BASELINE]) {
      expect(Object.isFrozen(scheme)).toBe(true);
    }
  });

  it("applies identical set, path and snapshot proof under every scheme", () => {
    const raw = [
      { artifact: "src/b.ts", snapshot: { kind: "sha256", digest: "b".repeat(64) } },
      { artifact: "src/a.ts", snapshot: { kind: "missing" } },
    ];
    const duplicate = [...raw, raw[0]];
    for (const scheme of [DECLARED_ARTIFACT_BASELINE, REPOSITORY_CHANGE_BASELINE, UNKNOWN_SCHEME_BASELINE]) {
      expect(scheme.parse(raw)).toEqual({ ok: true, value: raw });
      expect(scheme.parse(duplicate)).toEqual({ ok: false, errors: ['artifact_baseline[2].artifact duplicates "src/b.ts"'] });
      expect(scheme.capture(["src/a.ts", "src/a.ts"], () => ({ kind: "missing" }), "capture"))
        .toEqual({ ok: true, value: [{ artifact: "src/a.ts", snapshot: { kind: "missing" } }] });
      expect(scheme.capture(["../escape.ts"], () => ({ kind: "missing" }), "capture").ok).toBe(false);
    }
  });
});
