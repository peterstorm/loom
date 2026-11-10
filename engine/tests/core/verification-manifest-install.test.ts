import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_MANIFEST_SOURCE_BYTES,
  REPLACE_FLAG,
  canonicalizeManifestSource,
  parseManifestInstallArgs,
  planManifestInstall,
  type CanonicalManifest,
  type ManifestInstallMode,
} from "../../src/core/verification-manifest-install";

const PATH = ".loom/verification-manifest.json";

type CheckSpec = Readonly<{ id: string; timeoutMs: number; args: readonly string[] }>;

/** A valid schema-1 manifest as plain data. */
function manifest(checks: readonly CheckSpec[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: checks.map((check) => ({
      id: check.id,
      scope: "wave",
      executable: "bun",
      args: [...check.args],
      cwd: ".",
      timeoutMs: check.timeoutMs,
      report: { kind: "not-required" },
    })),
  };
}

/** Reverse every object's key order, recursively: same data, different bytes. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

function canonical(data: unknown): CanonicalManifest {
  const result = canonicalizeManifestSource(JSON.stringify(data));
  if (!result.ok) throw new Error(`fixture is not a valid manifest: ${result.error}`);
  return result.value;
}

const checkSpec: fc.Arbitrary<CheckSpec> = fc.record({
  id: fc.stringMatching(/^project:[a-z][a-z0-9-]{0,12}$/),
  timeoutMs: fc.integer({ min: 1_000, max: 1_800_000 }),
  // The manifest parser only admits bun invocations that select a mode or a
  // project script, so generate those: `bun test` or `bun run <script>`.
  args: fc.oneof(
    fc.constant<readonly string[]>(["test"]),
    fc.stringMatching(/^[a-z][a-z0-9:-]{0,10}$/).map((script): readonly string[] => ["run", script]),
  ),
});

const checkSpecs: fc.Arbitrary<readonly CheckSpec[]> = fc.uniqueArray(checkSpec, {
  minLength: 1,
  maxLength: 3,
  selector: (check) => check.id,
});

const mode: fc.Arbitrary<ManifestInstallMode> = fc.constantFrom("create-only", "replace");
const indent = fc.constantFrom<number | undefined>(undefined, 0, 1, 2, 4, 7);

describe("canonicalizeManifestSource", () => {
  it("is invariant to whitespace and key order (same authority, different bytes)", () => {
    fc.assert(fc.property(checkSpecs, indent, (checks, spaces) => {
      const data = manifest(checks);
      const reformatted = canonicalizeManifestSource(JSON.stringify(reverseKeys(data), null, spaces));
      expect(reformatted).toEqual({ ok: true, value: canonical(data) });
    }));
  });

  it("is idempotent: canonical text canonicalizes to itself", () => {
    fc.assert(fc.property(checkSpecs, (checks) => {
      const once = canonical(manifest(checks));
      expect(canonicalizeManifestSource(once)).toEqual({ ok: true, value: once });
    }));
  });

  it("names why non-JSON, non-manifest and oversized sources are refused", () => {
    const notJson = canonicalizeManifestSource("{not-json");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.error).toContain("source must be JSON");

    expect(canonicalizeManifestSource(JSON.stringify({ kind: "something-else" })).ok).toBe(false);

    const oversized = canonicalizeManifestSource(" ".repeat(MAX_MANIFEST_SOURCE_BYTES + 1));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error).toContain("exceeds");
  });
});

describe("planManifestInstall", () => {
  it("creates when nothing is installed, in either mode", () => {
    fc.assert(fc.property(checkSpecs, mode, (checks, m) => {
      const candidate = canonical(manifest(checks));
      expect(planManifestInstall(null, candidate, m, PATH)).toEqual({ kind: "create", manifest: candidate });
    }));
  });

  it("leaves equivalent installed authority unchanged however it is formatted, in either mode", () => {
    fc.assert(fc.property(checkSpecs, indent, mode, (checks, spaces, m) => {
      const data = manifest(checks);
      const installed = JSON.stringify(reverseKeys(data), null, spaces);
      expect(planManifestInstall(installed, canonical(data), m, PATH)).toEqual({ kind: "unchanged" });
    }));
  });

  it("refuses different authority without --replace and replaces it with --replace", () => {
    fc.assert(fc.property(checkSpecs, checkSpecs, (installedChecks, candidateChecks) => {
      const installed = canonical(manifest(installedChecks));
      const candidate = canonical(manifest(candidateChecks));
      fc.pre(installed !== candidate);

      const refused = planManifestInstall(installed, candidate, "create-only", PATH);
      expect(refused.kind).toBe("refuse");
      if (refused.kind === "refuse") {
        expect(refused.reason).toContain("different authority");
        expect(refused.reason).toContain(REPLACE_FLAG);
      }
      expect(planManifestInstall(installed, candidate, "replace", PATH))
        .toEqual({ kind: "replace", manifest: candidate });
    }));
  });

  it("treats an invalid installed manifest as replaceable only with --replace", () => {
    const candidate = canonical(manifest([{ id: "project:test", timeoutMs: 60_000, args: ["test"] }]));

    const refused = planManifestInstall("{broken", candidate, "create-only", PATH);
    expect(refused.kind).toBe("refuse");
    if (refused.kind === "refuse") expect(refused.reason).toContain("not a valid verification manifest");

    expect(planManifestInstall("{broken", candidate, "replace", PATH))
      .toEqual({ kind: "replace", manifest: candidate });
  });
});

describe("parseManifestInstallArgs", () => {
  it("accepts no arguments as create-only and the replace flag alone as replace", () => {
    expect(parseManifestInstallArgs([])).toEqual({ ok: true, value: "create-only" });
    expect(parseManifestInstallArgs([REPLACE_FLAG])).toEqual({ ok: true, value: "replace" });
  });

  it("refuses typos, extra arguments and repeated flags rather than defaulting", () => {
    for (const args of [["--replce"], [REPLACE_FLAG, "extra"], [REPLACE_FLAG, REPLACE_FLAG], ["-r"]]) {
      const parsed = parseManifestInstallArgs(args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(REPLACE_FLAG);
    }
  });
});
