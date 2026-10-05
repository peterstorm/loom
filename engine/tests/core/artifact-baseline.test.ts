import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import fc from "fast-check";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactCovers } from "../../src/core/path-coverage";
import {
  attributedChangedArtifacts,
  changedDeclaredArtifacts,
  parseArtifactBaseline,
  parseDeclaredArtifactBaseline,
  treeSnapshotDigest,
  type TreeEntry,
} from "../../src/core/artifact-baseline";
import {
  captureDeclaredArtifactBaseline,
  changedDeclaredArtifactsSince,
} from "../../src/utils/declared-artifact-snapshot";

function parsed<Scheme extends "declared-artifact" | "repository-change">(raw: unknown) {
  const baseline = parseArtifactBaseline<Scheme>(raw);
  if (!baseline.ok) throw new Error(baseline.errors.join("; "));
  return baseline.value;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = canonicalTempDir("loom-artifact-baseline-");
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "existing.ts"), "before\n");
  writeFileSync(join(root, "src", "deleted.ts"), "delete me\n");
  return root;
}

describe("declared artifact baseline", () => {
  it("reports only byte/state changes, never a no-op tool attempt", () => {
    const root = fixture();
    const artifacts = ["src/existing.ts", "src/created.ts", "src/deleted.ts"];
    const baseline = captureDeclaredArtifactBaseline(root, artifacts);

    // A successful no-op write is still not a changed artifact.
    writeFileSync(join(root, "src", "existing.ts"), "before\n");
    expect(changedDeclaredArtifactsSince(root, baseline)).toEqual([]);

    writeFileSync(join(root, "src", "existing.ts"), "after\n");
    writeFileSync(join(root, "src", "created.ts"), "created\n");
    unlinkSync(join(root, "src", "deleted.ts"));
    expect(changedDeclaredArtifactsSince(root, baseline)).toEqual(artifacts);
  });

  it("fails closed when there is no pre-spawn baseline", () => {
    expect(changedDeclaredArtifactsSince(fixture(), undefined)).toEqual([]);
  });

  it("requires byte changes and the stopped task's own structured write evidence", () => {
    const byteChanges = ["src/shared.ts", "src/owned.ts"];
    expect(attributedChangedArtifacts(byteChanges, ["src/owned.ts"])).toEqual(["src/owned.ts"]);
    expect(attributedChangedArtifacts(byteChanges, ["src/other.ts"])).toEqual([]);
  });

  it("attributes a directory artifact from a write below it, never a name-prefix sibling", () => {
    expect(attributedChangedArtifacts(
      ["calibration/run", "calibration/runner.ts"],
      ["calibration/run/result.json"],
    )).toEqual(["calibration/run"]);
  });

  it("rejects malformed snapshots and exact-set drift", () => {
    const malformed = parseDeclaredArtifactBaseline([{
      artifact: "src/a.ts",
      snapshot: { kind: "sha256", digest: "not-a-digest" },
    }]);
    expect(malformed.ok).toBe(false);

    const baseline = parsed<"declared-artifact">([{ artifact: "src/a.ts", snapshot: { kind: "missing" } }]);
    const compared = changedDeclaredArtifacts(baseline, parsed<"declared-artifact">([]));
    expect(compared.ok).toBe(false);
    expect(!compared.ok && compared.errors.join("\n")).toContain("missing declared artifact");
  });

  it("proves a baseline once: unique canonical artifacts, then compares without re-parsing", () => {
    const duplicated = parseArtifactBaseline<"declared-artifact">([
      { artifact: "src/a.ts", snapshot: { kind: "missing" } },
      { artifact: "src/a.ts", snapshot: { kind: "missing" } },
    ]);
    expect(duplicated).toEqual({ ok: false, errors: ['artifact_baseline[1].artifact duplicates "src/a.ts"'] });

    const before = parsed<"declared-artifact">([
      { artifact: "src/a.ts", snapshot: { kind: "sha256", digest: "a".repeat(64) } },
      { artifact: "src/b.ts", snapshot: { kind: "missing" } },
    ]);
    const after = parsed<"declared-artifact">([
      { artifact: "src/b.ts", snapshot: { kind: "missing" } },
      { artifact: "src/a.ts", snapshot: { kind: "sha256", digest: "b".repeat(64) } },
    ]);
    expect(Object.isFrozen(before)).toBe(true);
    expect(changedDeclaredArtifacts(before, after)).toEqual({ ok: true, value: ["src/a.ts"] });
  });

  it("refuses at compile time to compare snapshots hashed under different digest schemes", () => {
    const declared = parsed<"declared-artifact">([{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    const repository = parsed<"repository-change">([{ artifact: "a.ts", snapshot: { kind: "missing" } }]);
    // @ts-expect-error a repository-change preimage is not a declared-artifact snapshot.
    changedDeclaredArtifacts(declared, repository);
    // @ts-expect-error and an unparsed wire array is not a proven baseline.
    changedDeclaredArtifacts([{ artifact: "a.ts", snapshot: { kind: "missing" } }], declared);
    expect(changedDeclaredArtifacts(repository, repository)).toEqual({ ok: true, value: [] });
  });

  it.each([
    "/tmp/outside.ts",
    "../outside.ts",
    "./src/a.ts",
    "src//a.ts",
    "src\\a.ts",
  ])("rejects non-canonical persisted artifact path %s", (artifact) => {
    const parsed = parseDeclaredArtifactBaseline([{
      artifact,
      snapshot: { kind: "missing" },
    }]);
    expect(parsed.ok).toBe(false);
  });
});

const segment = fc.stringMatching(/^[a-z0-9._-]{1,8}$/).filter((value) => value !== "." && value !== "..");
const relativePath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/"));
const sha256 = fc.stringMatching(/^[a-f0-9]{64}$/);
const treeEntry: fc.Arbitrary<TreeEntry> = fc.record({
  path: relativePath,
  kind: fc.constantFrom("file" as const, "symlink" as const),
  contentSha256: sha256,
});
const tree = fc.uniqueArray(treeEntry, { selector: (entry) => entry.path, maxLength: 8 });

describe("treeSnapshotDigest", () => {
  it("is a sha256 hex digest independent of enumeration order", () => {
    fc.assert(fc.property(
      tree.chain((entries) => fc.tuple(
        fc.constant(entries),
        fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
      )),
      ([entries, shuffled]) => {
        expect(treeSnapshotDigest(shuffled)).toBe(treeSnapshotDigest(entries));
        expect(treeSnapshotDigest(entries)).toMatch(/^[a-f0-9]{64}$/);
      },
    ));
  });

  it("does not mutate its input", () => {
    fc.assert(fc.property(tree, (entries) => {
      const before = JSON.stringify(entries);
      treeSnapshotDigest(entries);
      expect(JSON.stringify(entries)).toBe(before);
    }));
  });

  it("changes when any one entry's path, kind or content changes", () => {
    fc.assert(fc.property(
      tree.filter((entries) => entries.length > 0),
      fc.nat(),
      fc.constantFrom("path", "kind", "content"),
      (entries, pick, field) => {
        const index = pick % entries.length;
        const target = entries[index]!;
        const changed: TreeEntry = field === "path"
          ? { ...target, path: `${target.path}-renamed` }
          : field === "kind"
            ? { ...target, kind: target.kind === "file" ? "symlink" : "file" }
            : { ...target, contentSha256: target.contentSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) };
        fc.pre(!entries.some((entry, other) => other !== index && entry.path === changed.path));
        const edited = entries.map((entry, other) => other === index ? changed : entry);
        expect(treeSnapshotDigest(edited)).not.toBe(treeSnapshotDigest(entries));
      },
    ));
  });

  it("is stable for the empty tree, and adding an entry changes it", () => {
    expect(treeSnapshotDigest([])).toBe(treeSnapshotDigest([]));
    fc.assert(fc.property(treeEntry, (entry) => {
      expect(treeSnapshotDigest([entry])).not.toBe(treeSnapshotDigest([]));
    }));
  });
});

describe("artifactCovers", () => {
  it("covers the artifact and every path below it, never a name-prefix sibling or an ancestor", () => {
    fc.assert(fc.property(relativePath, relativePath, (artifact, below) => {
      expect(artifactCovers(artifact, artifact)).toBe(true);
      expect(artifactCovers(artifact, `${artifact}/${below}`)).toBe(true);
      expect(artifactCovers(artifact, `${artifact}x`)).toBe(false);
      expect(artifactCovers(artifact, `${artifact}x/${below}`)).toBe(false);
      expect(artifactCovers(`${artifact}/${below}`, artifact)).toBe(false);
    }));
  });
});
