import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_MANIFEST_SOURCE_BYTES,
  REPLACE_FLAG,
  canonicalizeManifestSource,
  manifestExecutables,
  manifestReportPaths,
  parseManifestInstallArgs,
  planManifestInstall,
  unignoredReportRefusal,
  unresolvedExecutablesWarning,
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

const REPORT = ".loom/completion-reports/unit.junit.xml";

/** A schema-1 check that writes a required JUnit report at `path`. */
function reportingCheck(id: string, path: string): Record<string, unknown> {
  return {
    id,
    scope: "wave",
    executable: "bun",
    args: ["test", "--reporter=junit", `--reporter-outfile=${path}`],
    cwd: ".",
    timeoutMs: 60_000,
    report: { kind: "required-file", path },
  };
}

describe("manifestReportPaths", () => {
  it("names no path for checks that require no report", () => {
    fc.assert(fc.property(checkSpecs, (checks) => {
      expect(manifestReportPaths(canonical(manifest(checks)))).toEqual([]);
    }));
  });

  it("names each required report path once, sorted", () => {
    const other = ".loom/completion-reports/a.junit.xml";
    const data = {
      schemaVersion: 1,
      kind: "loom-verification-manifest",
      checks: [
        reportingCheck("project:unit", REPORT),
        reportingCheck("project:again", REPORT),
        reportingCheck("project:other", other),
      ],
    };
    expect(manifestReportPaths(canonical(data))).toEqual([other, REPORT]);
  });
});

describe("unignoredReportRefusal", () => {
  it("allows a manifest whose every report path is ignored", () => {
    expect(unignoredReportRefusal([])).toBeNull();
  });

  it("names every path that is not ignored and the rule to add", () => {
    const refusal = unignoredReportRefusal([REPORT, ".loom/completion-reports/b.xml"]);
    expect(refusal).toContain(REPORT);
    expect(refusal).toContain(".loom/completion-reports/b.xml");
    expect(refusal).toContain("`.loom/completion-reports/`");
    expect(refusal).toContain("out-of-scope");
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

describe("manifestExecutables (loom#198, Cause 5)", () => {
  const canonical = (document: Record<string, unknown>): CanonicalManifest => {
    const parsed = canonicalizeManifestSource(JSON.stringify(document));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const runner = (executable: string, cwd = ".") => ({
    executable, args: ["{files}"], cwd, timeoutMs: 60_000,
    report: { kind: "required-file", path: ".loom/completion-reports/affected.junit.xml" },
  });

  it("names every declared executable with where the engine would find it", () => {
    const manifest = canonical({
      schemaVersion: 2, kind: "loom-verification-manifest",
      checks: [{ id: "project:test", scope: "wave", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 60_000, report: { kind: "not-required" } }],
      affectedRunner: runner("node_modules/.bin/vitest", "engine"),
    });
    expect(manifestExecutables(manifest, ["/usr/bin", "", "/opt/bin/"])).toEqual([
      { label: "project:test", executable: "bun", candidates: [{ kind: "absolute", path: "/usr/bin/bun" }, { kind: "absolute", path: "/opt/bin/bun" }] },
      { label: "affectedRunner", executable: "node_modules/.bin/vitest", candidates: [{ kind: "project", path: "engine/node_modules/.bin/vitest" }] },
    ]);
  });

  it("refuses an absolute executable at parse, so no candidate is ever absolute by spelling", () => {
    expect(canonicalizeManifestSource(JSON.stringify({
      schemaVersion: 1, kind: "loom-verification-manifest",
      checks: [{ id: "project:env", scope: "wave", executable: "/usr/bin/env", args: ["true"], cwd: ".", timeoutMs: 60_000, report: { kind: "not-required" } }],
    })).ok).toBe(false);
  });

  it("warns about exactly the executables no candidate of which exists, and stays quiet when all resolve", () => {
    const manifest = canonical({
      schemaVersion: 2, kind: "loom-verification-manifest",
      checks: [{ id: "project:test", scope: "wave", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 60_000, report: { kind: "not-required" } }],
      affectedRunner: runner("node_modules/.bin/vitest", "engine"),
      acceptanceRunner: { ...runner("node_modules/.bin/vitest"), report: { kind: "required-file", path: ".loom/completion-reports/acceptance.junit.xml" } },
    });
    const present = new Set(["/opt/bin/bun", "node_modules/.bin/vitest"]);
    const exists = ({ path }: { path: string }) => present.has(path);
    const warning = unresolvedExecutablesWarning(manifest, ["/usr/bin", "/opt/bin"], exists);
    expect(warning).toContain("affectedRunner runs node_modules/.bin/vitest, which does not resolve");
    expect(warning).not.toContain("project:test");
    expect(warning).not.toContain("acceptanceRunner");
    expect(unresolvedExecutablesWarning(manifest, ["/opt/bin"], () => true)).toBeNull();
  });
});
