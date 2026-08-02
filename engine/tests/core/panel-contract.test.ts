import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseInterviewDigest,
  parseInterviewDigestJson,
  parseJudgeVerdict,
  parsePanelManifest,
  selectPanelLenses,
  serializeJudgeVerdict,
} from "../../src/core/panel-contract";

const VALID_DIGEST = [
  "**Primary axis:** simplicity",
  "**Testability bar:** pure functional core",
  "**Sensitive boundaries:** none",
  "**Codebase maturity:** brownfield",
  "**Codebase constraints:** follow engine core/shell split",
  "**Error-handling philosophy:** Either/Result end-to-end",
  "**Concurrency & state:** stateless and synchronous",
  "**Data & persistence:** reuse existing files",
  "**Tech preferences:** TypeScript",
  "**Observability:** structured errors",
  "**Backwards compatibility:** preserve current commands",
  "**Deployment:** no change",
  "**Out-of-scope:** executable orchestration rewrite",
  "**Executable-model signal:** none",
  "",
  "## Notes",
  "Keep the panel opt-in.",
].join("\n");

const CANDIDATES = ["candidate-simplicity-first.md", "candidate-type-driven-fp.md"] as const;

function verdict(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    criterion: "simplicity",
    rankings: [
      {
        candidate: CANDIDATES[0],
        score: 9,
        fatal_flaw: null,
        strongest_idea: "one {pure} boundary",
      },
      {
        candidate: CANDIDATES[1],
        score: 7,
        fatal_flaw: "too much {ceremony}",
        strongest_idea: "typed errors",
      },
    ],
    ...overrides,
  });
}

describe("parseInterviewDigest", () => {
  it("returns a typed digest for the complete canonical contract", () => {
    const parsed = parseInterviewDigest(VALID_DIGEST);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.primaryAxis).toBe("simplicity");
      expect(parsed.value.testabilityBar).toBe("pure functional core");
      expect(parsed.value.codebaseMaturity).toBe("brownfield");
    }
  });

  it("rejects missing, duplicate, empty, and invalid enum fields together", () => {
    const malformed = VALID_DIGEST
      .replace("**Primary axis:** simplicity", "**Primary axis:** novelty\n**Primary axis:** performance")
      .replace("**Testability bar:** pure functional core", "**Testability bar:**")
      .replace("**Codebase maturity:** brownfield\n", "");
    const parsed = parseInterviewDigest(malformed);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toMatch(/Primary axis.*exactly once/);
      expect(parsed.errors.join("\n")).toMatch(/Testability bar.*non-empty/);
      expect(parsed.errors.join("\n")).toMatch(/Codebase maturity.*found 0/);
    }
  });

  it("rejects invalid enum values without relying on duplicate-label errors", () => {
    const parsed = parseInterviewDigest(VALID_DIGEST.replace("**Primary axis:** simplicity", "**Primary axis:** novelty"));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain("Primary axis must be one of");
  });

  it("normalizes accepted sensitive-boundary casing for deterministic lens selection", () => {
    const parsed = parseInterviewDigest(VALID_DIGEST.replace("**Sensitive boundaries:** none", "**Sensitive boundaries:** Flagged — authentication"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.sensitiveBoundaries).toBe("flagged — authentication");
  });

  it("rejects an invalid sensitive-boundary prefix", () => {
    const parsed = parseInterviewDigest(VALID_DIGEST.replace("**Sensitive boundaries:** none", "**Sensitive boundaries:** maybe"));
    expect(parsed.ok).toBe(false);
  });

  it("property: removing any required labeled line always fails", () => {
    const lines = VALID_DIGEST.split("\n");
    const requiredIndexes = lines
      .map((line, index) => line.startsWith("**") ? index : -1)
      .filter((index) => index >= 0);
    fc.assert(fc.property(fc.constantFrom(...requiredIndexes), (removed) => {
      const parsed = parseInterviewDigest(lines.filter((_, index) => index !== removed).join("\n"));
      return !parsed.ok;
    }));
  });
});

describe("selectPanelLenses", () => {
  it("derives the exact count and interview-prioritized lens order", () => {
    const digest = parseInterviewDigest(
      VALID_DIGEST
        .replace("**Sensitive boundaries:** none", "**Sensitive boundaries:** flagged — auth")
        .replace("**Primary axis:** simplicity", "**Primary axis:** performance"),
    );
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(selectPanelLenses(digest.value, 3)).toEqual({
      ok: true,
      value: ["simplicity-first", "type-driven-fp", "risk-security-first"],
    });
    expect(selectPanelLenses(digest.value, 4)).toEqual({
      ok: true,
      value: ["simplicity-first", "type-driven-fp", "risk-security-first", "performance-first"],
    });
  });

  it("re-parses canonical interview JSON and rejects invalid counts", () => {
    const parsed = parseInterviewDigestJson({
      primaryAxis: "simplicity",
      testabilityBar: "pure functional core",
      sensitiveBoundaries: "none",
      codebaseMaturity: "brownfield",
      codebaseConstraints: "existing engine boundaries",
      errorHandlingPhilosophy: "Either/Result end-to-end",
      concurrencyAndState: "stateless",
      dataAndPersistence: "none",
      techPreferences: "TypeScript",
      observability: "diagnostics",
      backwardsCompatibility: "preserve CLI",
      deployment: "none",
      outOfScope: "state migration",
      executableModelSignal: "none",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(selectPanelLenses(parsed.value, 1).ok).toBe(false);
  });
});

describe("parsePanelManifest", () => {
  it("accepts an exact unique candidate set", () => {
    const parsed = parsePanelManifest({
      run_id: "run-1",
      interview_file: "/tmp/run-1/interview.md",
      interview_json: "/tmp/run-1/interview.json",
      candidates: CANDIDATES.map((filename) => ({
        lens: filename.slice("candidate-".length, -".md".length),
        path: `/tmp/run-1/candidates/${filename}`,
        filename,
      })),
    }, "/tmp/run-1", ["simplicity-first", "type-driven-fp"]);
    expect(parsed.ok).toBe(true);
  });

  it("rejects fewer than two and cross-run paths", () => {
    const parsed = parsePanelManifest({
      run_id: "old-run",
      interview_file: "/tmp/old-run/interview.md",
      interview_json: "/tmp/old-run/interview.json",
      candidates: [
        { lens: "simplicity-first", path: "/tmp/old-run/candidates/candidate-simplicity-first.md", filename: "candidate-simplicity-first.md" },
      ],
    }, "/tmp/new-run", ["simplicity-first", "type-driven-fp"]);
    expect(parsed.ok).toBe(false);
  });

  it("rejects lexical path aliases instead of normalizing them into the run", () => {
    const parsed = parsePanelManifest({
      run_id: "run-1",
      interview_file: "/tmp/run-1/alias/../interview.md",
      interview_json: "/tmp/run-1/interview.json",
      candidates: [
        { lens: "simplicity-first", path: "/tmp/run-1/candidates/link/../candidate-simplicity-first.md", filename: "candidate-simplicity-first.md" },
        { lens: "type-driven-fp", path: "/tmp/run-1/candidates/candidate-type-driven-fp.md", filename: "candidate-type-driven-fp.md" },
      ],
    }, "/tmp/run-1", ["simplicity-first", "type-driven-fp"]);
    expect(parsed.ok).toBe(false);
  });

  it("rejects duplicate lenses and lens/filename drift", () => {
    const parsed = parsePanelManifest({
      run_id: "run-1",
      interview_file: "/tmp/run-1/interview.md",
      interview_json: "/tmp/run-1/interview.json",
      candidates: [
        { lens: "simplicity-first", path: "/tmp/run-1/candidates/candidate-performance-first.md", filename: "candidate-performance-first.md" },
        { lens: "simplicity-first", path: "/tmp/run-1/candidates/candidate-simplicity-first.md", filename: "candidate-simplicity-first.md" },
      ],
    }, "/tmp/run-1", ["simplicity-first", "type-driven-fp"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toMatch(/filename|unique/);
  });

  it("rejects a manifest that omits either mandatory baseline lens", () => {
    const parsed = parsePanelManifest({
      run_id: "run-1",
      interview_file: "/tmp/run-1/interview.md",
      interview_json: "/tmp/run-1/interview.json",
      candidates: [
        { lens: "risk-security-first", path: "/tmp/run-1/candidates/candidate-risk-security-first.md", filename: "candidate-risk-security-first.md" },
        { lens: "performance-first", path: "/tmp/run-1/candidates/candidate-performance-first.md", filename: "candidate-performance-first.md" },
      ],
    }, "/tmp/run-1", ["simplicity-first", "type-driven-fp"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain("must exactly match");
  });
});

describe("parseJudgeVerdict", () => {
  it("validates the full contract and sanitizes brace characters from prose", () => {
    const parsed = parseJudgeVerdict(verdict(), "simplicity", CANDIDATES);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.rankings[0]!.strongestIdea).toBe("one pure boundary");
      expect(parsed.value.rankings[1]!.fatalFlaw).toBe("too much ceremony");
      expect(serializeJudgeVerdict(parsed.value)).not.toContain("{pure}");
    }
  });

  it.each([
    ["malformed JSON", "not json"],
    ["criterion mismatch", verdict({ criterion: "performance" })],
    ["missing candidate", JSON.stringify({ criterion: "simplicity", rankings: JSON.parse(verdict()).rankings.slice(0, 1) })],
    ["duplicate candidate", JSON.stringify({ criterion: "simplicity", rankings: [JSON.parse(verdict()).rankings[0], JSON.parse(verdict()).rankings[0]] })],
    ["foreign candidate", verdict({ rankings: [{ ...JSON.parse(verdict()).rankings[0], candidate: "candidate-foreign.md" }, JSON.parse(verdict()).rankings[1]] })],
    ["out-of-range score", verdict({ rankings: [{ ...JSON.parse(verdict()).rankings[0], score: 11 }, JSON.parse(verdict()).rankings[1]] })],
    ["fractional score", verdict({ rankings: [{ ...JSON.parse(verdict()).rankings[0], score: 8.5 }, JSON.parse(verdict()).rankings[1]] })],
    ["invalid fatal flaw", verdict({ rankings: [{ ...JSON.parse(verdict()).rankings[0], fatal_flaw: 42 }, JSON.parse(verdict()).rankings[1]] })],
    ["brace-only fatal flaw", verdict({ rankings: [{ ...JSON.parse(verdict()).rankings[0], fatal_flaw: "{}" }, JSON.parse(verdict()).rankings[1]] })],
    ["brace-only strongest idea", verdict({ rankings: [{ ...JSON.parse(verdict()).rankings[0], strongest_idea: "{}" }, JSON.parse(verdict()).rankings[1]] })],
    ["ascending score order", verdict({ rankings: [{ ...JSON.parse(verdict()).rankings[0], score: 2 }, { ...JSON.parse(verdict()).rankings[1], score: 8 }] })],
  ])("rejects %s", (_label, raw) => {
    expect(parseJudgeVerdict(raw, "simplicity", CANDIDATES).ok).toBe(false);
  });
});
