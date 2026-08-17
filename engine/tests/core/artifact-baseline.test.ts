import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributedChangedArtifacts,
  changedDeclaredArtifacts,
  parseDeclaredArtifactBaseline,
} from "../../src/core/artifact-baseline";
import {
  captureDeclaredArtifactBaseline,
  changedDeclaredArtifactsSince,
} from "../../src/utils/artifact-baseline";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-artifact-baseline-")));
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

  it("rejects malformed snapshots and exact-set drift", () => {
    const malformed = parseDeclaredArtifactBaseline([{
      artifact: "src/a.ts",
      snapshot: { kind: "sha256", digest: "not-a-digest" },
    }]);
    expect(malformed.ok).toBe(false);

    const baseline = [{ artifact: "src/a.ts", snapshot: { kind: "missing" as const } }];
    const compared = changedDeclaredArtifacts(baseline, []);
    expect(compared.ok).toBe(false);
    expect(!compared.ok && compared.errors.join("\n")).toContain("missing declared artifact");
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
