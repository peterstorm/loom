import { describe, expect, it } from "vitest";
import {
  classifyScope,
  parseRegisteredFacadeProgram,
} from "../../../src/handlers/helpers/programs/helpers";

const classify = (scope: readonly string[], created: readonly string[] = []) =>
  classifyScope("all", scope, new Set(created), 0);

/**
 * The docsOnly classifier drives reviewer-roster selection, so a false
 * positive silently drops silent-failure-hunter from a real code change. The
 * `docs?`/`README` alternatives must match a FULL path segment — historically
 * the alternative was unanchored at the end, so any path merely starting with
 * "doc" (docker-compose.yml, src/docker/build.ts) classified as documentation.
 */
describe("classifyScope docsOnly is a segment match, not a prefix match", () => {
  it.each([
    ["docs/guide.md", true],
    ["doc/notes.txt", true],
    ["README.md", true],
    ["nested/README.md", true],
    ["nested/docs/api.md", true],
    ["CHANGELOG.md", true],
  ])("%s is documentation", (path, expected) => {
    expect(classify([path]).docsOnly).toBe(expected);
  });

  it.each([
    "docker-compose.yml",
    "docker/entrypoint.sh",
    "src/docker/build.ts",
    "documented-api.ts",
    "READMEISH.yml",
    "package.json",
  ])("%s is NOT documentation", (path) => {
    expect(classify([path]).docsOnly).toBe(false);
  });

  it("a source file under a docker/ directory never produces the contradictory docsOnly+source pair", () => {
    const metadata = classify(["src/docker/build.ts"]);
    expect(metadata.docsOnly).toBe(false);
    expect(metadata.sourceOrTestChanged).toBe(true);
  });
});

describe("classifyScope newStructure means newly created deep paths", () => {
  it("an ordinary edit to an existing deeply nested file is not new structure", () => {
    expect(classify(["engine/src/handlers/helpers/programs/helpers.ts"]).newStructure).toBe(false);
  });

  it("a newly created deep path is new structure", () => {
    const path = "engine/src/services/billing/invoice.ts";
    expect(classify([path], [path]).newStructure).toBe(true);
  });

  it("a newly created shallow file is not new structure", () => {
    expect(classify(["NOTES.txt"], ["NOTES.txt"]).newStructure).toBe(false);
  });
});

/**
 * A registration whose facade `kind` has already matched must fail with the
 * nested parser's exact diagnostic — never collapse to a bare null that a
 * caller then reports as "malformed" or, worse, "not a wave-gate run".
 */
describe("parseRegisteredFacadeProgram preserves variant diagnostics", () => {
  it("passes a valid remediation registration through", () => {
    const parsed = parseRegisteredFacadeProgram({
      schemaVersion: 1,
      kind: "remediation",
      input: { sourceRunsRoot: "roots", sourceRun: "run.x", supportPaths: [] },
    });
    expect(parsed.kind).toBe("registered");
    if (parsed.kind === "registered") expect(parsed.program.kind).toBe("remediation");
  });

  it("an invalid remediation input keeps the nested parser's message", () => {
    const parsed = parseRegisteredFacadeProgram({
      schemaVersion: 1,
      kind: "remediation",
      input: { sourceRunsRoot: "", sourceRun: "run.x", supportPaths: [] },
    });
    expect(parsed).toEqual({
      kind: "invalid",
      message: "remediation input must contain sourceRunsRoot, sourceRun, and supportPaths",
    });
  });

  it("an invalid wave-gate wave keeps the nested parser's message", () => {
    const parsed = parseRegisteredFacadeProgram({
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 0 },
      taskIds: ["T1"],
      authorityDigest: "d".repeat(64),
    });
    expect(parsed).toEqual({
      kind: "invalid",
      message: "wave-gate input must contain exactly wave (null or a positive integer)",
    });
  });

  it("an invalid standalone-review input keeps the nested parser's message", () => {
    const parsed = parseRegisteredFacadeProgram({
      schemaVersion: 1,
      kind: "standalone-review",
      input: { kind: "all", files: [], dryRun: false },
      authority: {},
    });
    expect(parsed).toEqual({
      kind: "invalid",
      message: "standalone-review files must be null or a non-empty string array",
    });
  });

  it("a record with a foreign kind stays unclaimed for the panel parser", () => {
    expect(parseRegisteredFacadeProgram({ schemaVersion: 1, kind: "architecture" })).toEqual({ kind: "unclaimed" });
    expect(parseRegisteredFacadeProgram(null)).toEqual({ kind: "unclaimed" });
    expect(parseRegisteredFacadeProgram("wave-gate")).toEqual({ kind: "unclaimed" });
  });

  it("a wave-gate registration carrying BOTH recovery audits is invalid, not unclaimed", () => {
    const parsed = parseRegisteredFacadeProgram({
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1"],
      authorityDigest: "d".repeat(64),
      restart: { previousRunId: "run.a", exhaustedSlots: ["s1"] },
      orphanRecovery: { previousRunId: "run.b", previousAuthorityDigest: "e".repeat(64) },
    });
    expect(parsed.kind).toBe("invalid");
  });
});
