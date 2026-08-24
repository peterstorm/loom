import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FULL_TIER_LINT_CHECK_ID_TEXT,
  parseAuthorizedWaveCompletionCheck,
} from "../../src/core/completion-suite";
import {
  VERIFICATION_MANIFEST_KIND,
  VERIFICATION_MANIFEST_SCHEMA_VERSION,
  VERIFICATION_MANIFEST_SOURCE_PATH,
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
  freezeVerificationManifest,
  parseFrozenVerificationManifest,
  parseVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { sha256Bytes } from "../../src/core/review-packet";

const digest = (character: string): string => character.repeat(64);
const activeAuthority = Object.freeze({
  runId: "run.verification-manifest",
  wave: 2,
  revision: 4,
  authorityDigest: digest("a"),
});

const noReport = () => Object.freeze({ kind: "not-required" as const });
const requiredReport = (path = ".loom/completion-reports/verification.json") => Object.freeze({
  kind: "required-file" as const,
  path,
});

function check(id = "project:test") {
  return {
    id,
    scope: "wave" as const,
    executable: "bun",
    args: ["test"],
    cwd: ".",
    timeoutMs: 60_000,
    report: noReport(),
  };
}

function document(checks: readonly unknown[] = [check()]) {
  return {
    schemaVersion: VERIFICATION_MANIFEST_SCHEMA_VERSION,
    kind: VERIFICATION_MANIFEST_KIND,
    checks,
  };
}

function bytes(raw: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(raw));
}

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("fixture parse failed");
  return result.value;
}

function deepFrozen(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return true;
  if (!Object.isFrozen(raw)) return false;
  return Object.values(raw).every(deepFrozen);
}

function suiteFor(manifest: FrozenVerificationManifest) {
  return valueOf(authorizeWaveCompletionSuite(manifest, activeAuthority, digest("b")));
}

const safeIdSuffix = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const validDocumentArbitrary = fc.uniqueArray(safeIdSuffix, { minLength: 0, maxLength: 8 })
  .map((ids) => document(ids.map((id, index) => ({
    ...check(`project:${id}`),
    executable: index % 2 === 0 ? "bun" : "node_modules/.bin/vitest",
    args: index % 2 === 0 ? ["test", `tests/${id}.test.ts`] : ["run", `tests/${id}.test.ts`],
    cwd: index % 3 === 0 ? "." : "engine",
    timeoutMs: index + 1,
    report: index % 2 === 0 ? noReport() : requiredReport(`.loom/completion-reports/${id}.json`),
  }))));

describe("verification manifest exact parsing", () => {
  it("is total over arbitrary unknown source, byte, frozen, and authorization input", () => {
    fc.assert(fc.property(fc.anything({ maxDepth: 5 }), (raw) => {
      expect(() => parseVerificationManifest(raw)).not.toThrow();
      expect(() => freezeVerificationManifest(raw)).not.toThrow();
      expect(() => parseFrozenVerificationManifest(raw)).not.toThrow();
      expect(() => authorizeWaveCompletionSuite(
        raw as FrozenVerificationManifest,
        raw as typeof activeAuthority,
        raw,
      )).not.toThrow();
    }), { numRuns: 500 });
  });

  it("round-trips valid documents and deeply freezes parsed and frozen authority", () => {
    fc.assert(fc.property(validDocumentArbitrary, (raw) => {
      const parsed = valueOf(parseVerificationManifest(raw));
      const frozen = valueOf(freezeVerificationManifest(bytes(raw)));
      const rehydrated = valueOf(parseFrozenVerificationManifest(JSON.parse(JSON.stringify(frozen))));

      expect(valueOf(parseVerificationManifest(JSON.parse(JSON.stringify(parsed))))).toEqual(parsed);
      expect(rehydrated).toEqual(frozen);
      expect(deepFrozen(parsed)).toBe(true);
      expect(deepFrozen(frozen)).toBe(true);
      expect(deepFrozen(rehydrated)).toBe(true);
      expect(frozen.source.kind).toBe("operator-file");
      if (frozen.source.kind === "operator-file") {
        expect(frozen.source.path).toBe(VERIFICATION_MANIFEST_SOURCE_PATH);
        expect(frozen.source.digest).toBe(sha256Bytes(bytes(raw)));
      }
    }));
  });

  it("retains only the exact source and frozen keys", () => {
    const parsed = valueOf(parseVerificationManifest(document([{ ...check(), report: requiredReport() }])));
    const frozen = valueOf(freezeVerificationManifest(bytes(document())));
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "kind", "checks"]);
    expect(Object.keys(parsed.checks[0]!)).toEqual([
      "id", "scope", "executable", "args", "cwd", "timeoutMs", "report",
    ]);
    expect(Object.keys(parsed.checks[0]!.report)).toEqual(["kind", "path"]);
    expect(Object.keys(frozen)).toEqual(["schemaVersion", "kind", "source", "manifestDigest", "projectChecks"]);
    expect(Object.keys(frozen.source)).toEqual(["kind", "path", "digest"]);
    expect(Object.keys(frozen.projectChecks[0]!)).toEqual([
      "kind", "checkId", "scope", "executable", "args", "cwd", "timeoutMs", "reportPolicy",
    ]);
  });

  it("rejects unknown keys at every source record level and decompose-like command surplus", () => {
    const cases = [
      { ...document(), verification_manifest: document([check("project:injected")]) },
      { ...document(), surplus: true },
      document([{ ...check(), surplus: true }]),
      document([{ ...check(), report: { ...noReport(), surplus: true } }]),
      document([{ ...check(), report: { ...requiredReport(), surplus: true } }]),
    ];
    for (const raw of cases) expect(parseVerificationManifest(raw).ok).toBe(false);
    expect(defaultVerificationManifest().projectChecks).toEqual([]);
  });

  it("accepts an empty source and default while keeping the authorized suite non-empty", () => {
    const operator = valueOf(freezeVerificationManifest(bytes(document([]))));
    for (const manifest of [defaultVerificationManifest(), operator]) {
      const suite = suiteFor(manifest);
      expect(suite.checks).toHaveLength(1);
      expect(suite.checks[0]).toMatchObject({
        kind: "engine-full-tier-lint",
        checkId: FULL_TIER_LINT_CHECK_ID_TEXT,
        scope: "wave",
      });
    }
    expect(parseFrozenVerificationManifest(JSON.parse(JSON.stringify(defaultVerificationManifest()))).ok).toBe(true);
  });

  it("rejects duplicate and engine-reserved project ids", () => {
    expect(parseVerificationManifest(document([check("project:same"), check("project:same")])).ok).toBe(false);
    for (const id of [FULL_TIER_LINT_CHECK_ID_TEXT, "loom:reserved-id"]) {
      expect(parseVerificationManifest(document([check(id)])).ok).toBe(false);
    }
  });

  it("rejects absolute, traversal, backslash, NUL, alias, and shell-string paths", () => {
    const attacks = ["/tmp/run", "../outside", "engine/../outside", "engine\\test", "engine\0test", "./engine"];
    for (const attack of attacks) {
      expect(parseVerificationManifest(document([{ ...check(), cwd: attack }])).ok, `cwd ${attack}`).toBe(false);
      expect(parseVerificationManifest(document([{
        ...check(), report: requiredReport(attack),
      }])).ok, `report ${attack}`).toBe(false);
      expect(parseVerificationManifest(document([{ ...check(), executable: attack }])).ok, `executable ${attack}`).toBe(false);
    }
    for (const executable of [".", "..", "bun test", "bun;rm", "bun&&npm", "$(bun)"]) {
      expect(parseVerificationManifest(document([{ ...check(), executable }])).ok, executable).toBe(false);
    }
  });

  it("rejects sparse and non-string argument arrays", () => {
    for (const args of [Array(1), ["test", 1], ["test", null], ["test", "bad\0arg"]]) {
      expect(parseVerificationManifest(document([{ ...check(), args }])).ok).toBe(false);
    }
  });
});

describe("fixed-command execution authority", () => {
  const unsafeCommands = [
    ["sh", ["-c", "npm test"]],
    ["bash", ["-lc", "npm test"]],
    ["fish", ["--command", "npm test"]],
    ["node", ["-e", "process.exit()"]],
    ["node", ["-p", "process.version"]],
    ["node", ["-pe", "process.version"]],
    ["node", ["--eval=process.exit()"]],
    ["node", ["--print", "process.version"]],
    ["node", ["--test", "--eval=process.exit()"]],
    ["bun", ["--eval", "process.exit()"]],
    ["bun", ["eval", "process.exit()"]],
    ["bun", ["-e", "process.exit()"]],
    ["bun", ["x", "vitest"]],
    ["bunx", ["vitest"]],
    ["deno", ["eval", "Deno.exit()"]],
    ["python", ["-c", "print(1)"]],
    ["python3.12", ["-cprint(1)"]],
    ["perl", ["-e", "exit"]],
    ["perl", ["-E", "exit"]],
    ["ruby", ["-e", "exit"]],
    ["ruby", ["-Eutf-8", "script.rb"]],
    ["npm", ["exec", "vitest"]],
    ["npm", ["x", "vitest"]],
    ["npx", ["vitest"]],
    ["pnpm", ["exec", "vitest"]],
    ["pnpm", ["dlx", "vitest"]],
    ["pnpm", ["x", "vitest"]],
    ["yarn", ["exec", "vitest"]],
    ["yarn", ["dlx", "vitest"]],
    ["yarn", ["vitest"]],
    ["powershell", ["-Command", "Get-ChildItem"]],
    ["pwsh", ["-EncodedCommand=AAAA"]],
    ["cmd", ["/c", "npm test"]],
    ["env", ["bun", "test"]],
    ["xargs", ["bun", "test"]],
    ["timeout", ["10", "bun", "test"]],
  ] as const;

  it("rejects every shell, inline runtime, package exec, and generic dispatch form", () => {
    for (const [executable, args] of unsafeCommands) {
      const source = document([{ ...check(), executable, args: [...args] }]);
      expect(parseVerificationManifest(source).ok, `${executable} ${args.join(" ")}`).toBe(false);
      expect(parseAuthorizedWaveCompletionCheck({
        kind: "project-command",
        checkId: "project:unsafe",
        scope: "wave",
        executable,
        args: [...args],
        cwd: ".",
        timeoutMs: 1_000,
        reportPolicy: noReport(),
      }).ok, `${executable} ${args.join(" ")}`).toBe(false);
    }
  });

  it("rejects bypasses equally through bare and project-local executable paths", () => {
    fc.assert(fc.property(
      fc.constantFrom(...unsafeCommands),
      fc.constantFrom("", "tools/", "node_modules/.bin/"),
      ([basename, args], prefix) => {
        expect(parseVerificationManifest(document([{
          ...check(), executable: `${prefix}${basename}`, args: [...args],
        }])).ok).toBe(false);
      },
    ));
  });

  it("allows only documented build, test, check, run, and project-script forms", () => {
    const allowedCommands = [
      ["npm", ["run", "typecheck"]],
      ["npm", ["test"]],
      ["pnpm", ["check"]],
      ["yarn", ["build"]],
      ["bun", ["run", "check"]],
      ["bun", ["test"]],
      ["node", ["scripts/check.mjs"]],
      ["node", ["--test", "tests/unit.test.mjs"]],
      ["deno", ["test", "tests/"]],
      ["python3.12", ["scripts/check.py"]],
      ["python", ["-m", "pytest"]],
      ["perl", ["scripts/check.pl"]],
      ["ruby", ["scripts/check.rb"]],
      ["node_modules/.bin/vitest", ["run"]],
      ["tools/gradlew", ["check"]],
    ] as const;
    for (const [executable, args] of allowedCommands) {
      expect(parseVerificationManifest(document([{
        ...check(), executable, args: [...args],
      }])).ok, `${executable} ${args.join(" ")}`).toBe(true);
    }
  });

  it("maps every source check to a canonical project command", () => {
    fc.assert(fc.property(validDocumentArbitrary, (raw) => {
      const manifest = valueOf(freezeVerificationManifest(bytes(raw)));
      const suite = suiteFor(manifest);
      expect(suite.checks.filter((candidate) => candidate.kind === "project-command"))
        .toEqual(manifest.projectChecks);
      expect(suite.manifestDigest).toBe(manifest.manifestDigest);
    }));
  });

  it("changes canonical manifest and suite digests when any check authority field changes", () => {
    const baseline = check("project:digest");
    const mutations = [
      { ...baseline, id: "project:other" },
      { ...baseline, executable: "npm" },
      { ...baseline, args: ["test", "--changed"] },
      { ...baseline, cwd: "engine" },
      { ...baseline, timeoutMs: baseline.timeoutMs + 1 },
      { ...baseline, report: requiredReport(".loom/completion-reports/changed.json") },
    ];
    const baselineManifest = valueOf(freezeVerificationManifest(bytes(document([baseline]))));
    const baselineSuite = suiteFor(baselineManifest);
    for (const mutation of mutations) {
      const manifest = valueOf(freezeVerificationManifest(bytes(document([mutation]))));
      const suite = suiteFor(manifest);
      expect(manifest.manifestDigest).not.toBe(baselineManifest.manifestDigest);
      expect(suite.suiteDigest).not.toBe(baselineSuite.suiteDigest);
    }
  });

  it("binds the operator raw-byte digest into manifest authority", () => {
    const compact = bytes(document());
    const pretty = new TextEncoder().encode(JSON.stringify(document(), null, 2));
    const compactManifest = valueOf(freezeVerificationManifest(compact));
    const prettyManifest = valueOf(freezeVerificationManifest(pretty));
    expect(compactManifest.projectChecks).toEqual(prettyManifest.projectChecks);
    expect(compactManifest.source.kind).toBe("operator-file");
    expect(prettyManifest.source.kind).toBe("operator-file");
    expect(compactManifest.manifestDigest).not.toBe(prettyManifest.manifestDigest);
  });

  it("rejects tampering with every frozen authority field", () => {
    const manifest = valueOf(freezeVerificationManifest(bytes(document())));
    const mutations = [
      { ...manifest, schemaVersion: 2 },
      { ...manifest, kind: "other" },
      { ...manifest, manifestDigest: digest("f") },
      { ...manifest, source: { kind: "engine-default" } },
      { ...manifest, source: { ...manifest.source, path: "other.json" } },
      { ...manifest, projectChecks: [{ ...manifest.projectChecks[0]!, executable: "npm" }] },
      { ...manifest, surplus: true },
    ];
    for (const mutation of mutations) expect(parseFrozenVerificationManifest(mutation).ok).toBe(false);
  });
});
