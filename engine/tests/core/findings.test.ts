import { describe, expect, it } from "vitest";
import {
  attributeFindings,
  claimsOfSeverity,
  draftsFromClaims,
  FINDING_SEVERITIES,
  makeDraftFinding,
  nextOrdinal,
  parseFindingSeverity,
  parseFindingsBlock,
  parseStoredFindings,
  parseStoredRefutations,
  type DraftFinding,
  type Finding,
} from "../../src/core/findings";

const draft = (over: Partial<DraftFinding> = {}): DraftFinding => ({
  severity: "critical",
  file: null,
  line: null,
  claim: "a claim",
  ...over,
});

describe("parseFindingSeverity", () => {
  it("accepts exactly the closed severity set", () => {
    for (const severity of FINDING_SEVERITIES) {
      expect(parseFindingSeverity(severity)).toBe(severity);
    }
  });

  it("rejects anything else", () => {
    for (const raw of ["CRITICAL", "high", "", null, 1, undefined, {}]) {
      expect(parseFindingSeverity(raw)).toBeNull();
    }
  });
});

describe("makeDraftFinding (smart constructor)", () => {
  it("drops empty and whitespace-only claims", () => {
    expect(makeDraftFinding({ severity: "critical", claim: "" })).toBeNull();
    expect(makeDraftFinding({ severity: "critical", claim: "   \n  " })).toBeNull();
  });

  it("drops no-finding sentinels — the same filter the string views always applied", () => {
    for (const claim of ["none", "(none)", "N/A", "nil", "none — prior critical fixed"]) {
      expect(makeDraftFinding({ severity: "advisory", claim })).toBeNull();
    }
  });

  it("keeps a real finding that merely starts with 'none'", () => {
    const finding = makeDraftFinding({
      severity: "critical",
      claim: "none of the callers check the result",
    });
    expect(finding?.claim).toBe("none of the callers check the result");
  });

  it("collapses whitespace so a claim never carries a line terminator", () => {
    const finding = makeDraftFinding({
      severity: "critical",
      claim: "the reducer\nswallows  the error",
    });
    expect(finding?.claim).toBe("the reducer swallows the error");
  });

  it("keeps a plausible file/line and nulls anything else", () => {
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: "src/a.ts", line: 42 }))
      .toMatchObject({ file: "src/a.ts", line: 42 });
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: "  ", line: 0 }))
      .toMatchObject({ file: null, line: null });
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: "a\nb", line: -3 }))
      .toMatchObject({ file: null, line: null });
    expect(makeDraftFinding({ severity: "critical", claim: "x", file: 7, line: 1.5 }))
      .toMatchObject({ file: null, line: null });
  });

  it("accepts a numeric-string line (agents emit JSON loosely)", () => {
    expect(makeDraftFinding({ severity: "critical", claim: "x", line: "42" })?.line).toBe(42);
  });
});

describe("draftsFromClaims / claimsOfSeverity", () => {
  it("round-trips the legacy severity-grouped view", () => {
    const drafts = draftsFromClaims(["c1", "c2"], ["a1"]);
    expect(claimsOfSeverity(drafts, "critical")).toEqual(["c1", "c2"]);
    expect(claimsOfSeverity(drafts, "advisory")).toEqual(["a1"]);
  });

  it("applies the sentinel filter on the way in", () => {
    const drafts = draftsFromClaims(["real", "none", ""], ["(n/a)"]);
    expect(claimsOfSeverity(drafts, "critical")).toEqual(["real"]);
    expect(claimsOfSeverity(drafts, "advisory")).toEqual([]);
  });
});

describe("attributeFindings — derived, never agent-chosen identity", () => {
  it("derives ids from agent and emission order", () => {
    const findings = attributeFindings([draft(), draft({ claim: "second" })], "code-reviewer");
    expect(findings.map((f) => f.id)).toEqual(["code-reviewer-1", "code-reviewer-2"]);
    expect(findings.every((f) => f.agent === "code-reviewer")).toBe(true);
  });

  it("is deterministic — same input, same ids", () => {
    const drafts = [draft(), draft({ claim: "b" }), draft({ claim: "c" })];
    expect(attributeFindings(drafts, "pr-test-analyzer").map((f) => f.id))
      .toEqual(attributeFindings(drafts, "pr-test-analyzer").map((f) => f.id));
  });

  it("collapses id-unsafe characters in the agent name", () => {
    expect(attributeFindings([draft()], "loom:code reviewer!")[0]!.id).toBe("loom-code-reviewer-1");
  });

  it("continues past an existing ordinal so a re-review cannot mint a duplicate", () => {
    const first = attributeFindings([draft(), draft({ claim: "b" })], "code-reviewer");
    const second = attributeFindings(
      [draft({ claim: "c" })],
      "code-reviewer",
      nextOrdinal(first, "code-reviewer"),
    );
    expect(second[0]!.id).toBe("code-reviewer-3");
    expect(new Set([...first, ...second].map((f) => f.id)).size).toBe(3);
  });

  it("counts ordinals per agent, not per task", () => {
    const existing: readonly Finding[] = [
      ...attributeFindings([draft()], "code-reviewer"),
      ...attributeFindings([draft(), draft({ claim: "b" })], "comment-analyzer"),
    ];
    expect(nextOrdinal(existing, "code-reviewer")).toBe(2);
    expect(nextOrdinal(existing, "comment-analyzer")).toBe(3);
    expect(nextOrdinal(existing, "type-design-analyzer")).toBe(1);
  });
});

describe("parseFindingsBlock — the optional structured Machine Summary block", () => {
  const block = (body: string) => "prose before\n```findings\n" + body + "\n```\nprose after";

  it("returns null when there is no block, so the caller falls back to the scraper", () => {
    expect(parseFindingsBlock("### Machine Summary\nCRITICAL_COUNT: 0\n")).toBeNull();
  });

  it("parses severity, file, line and claim", () => {
    const drafts = parseFindingsBlock(block(
      JSON.stringify([{ severity: "critical", file: "src/x.ts", line: 42, claim: "unchecked cast" }]),
    ));
    expect(drafts).toEqual([
      { severity: "critical", file: "src/x.ts", line: 42, claim: "unchecked cast" },
    ]);
  });

  it("treats an empty array as 'I found nothing', not as a malformed block", () => {
    expect(parseFindingsBlock(block("[]"))).toEqual([]);
  });

  it("returns null on invalid JSON so the line scraper still runs", () => {
    expect(parseFindingsBlock(block("[{severity: critical}]"))).toBeNull();
  });

  it("returns null when an entry has an unknown severity or a non-string claim", () => {
    expect(parseFindingsBlock(block(JSON.stringify([{ severity: "high", claim: "x" }])))).toBeNull();
    expect(parseFindingsBlock(block(JSON.stringify([{ severity: "critical", claim: 3 }])))).toBeNull();
  });

  it("returns null when the payload is not an array of objects", () => {
    expect(parseFindingsBlock(block('{"severity":"critical","claim":"x"}'))).toBeNull();
    expect(parseFindingsBlock(block('["x"]'))).toBeNull();
  });

  it("skips sentinel entries without discarding the block", () => {
    const drafts = parseFindingsBlock(block(JSON.stringify([
      { severity: "critical", claim: "none" },
      { severity: "advisory", claim: "prefer a named constant" },
    ])));
    expect(drafts).toEqual([
      { severity: "advisory", file: null, line: null, claim: "prefer a named constant" },
    ]);
  });

  it("uses the LAST block — agents echo the template before their real output", () => {
    const echoed = block(JSON.stringify([{ severity: "critical", claim: "TEMPLATE EXAMPLE" }]))
      + "\n" + block(JSON.stringify([{ severity: "advisory", claim: "the real one" }]));
    expect(parseFindingsBlock(echoed)?.map((f) => f.claim)).toEqual(["the real one"]);
  });

  it("tolerates indentation on the fence", () => {
    const indented = "  ```findings\n  " + JSON.stringify([{ severity: "critical", claim: "x" }]) + "\n  ```\n";
    expect(parseFindingsBlock(indented)?.map((f) => f.claim)).toEqual(["x"]);
  });
});

describe("parseStoredFindings — untrusted state file", () => {
  const stored: Finding = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: "src/x.ts",
    line: 4,
    claim: "unchecked cast",
  };

  it("returns [] for a missing or non-array field", () => {
    expect(parseStoredFindings(undefined)).toEqual([]);
    expect(parseStoredFindings({})).toEqual([]);
    expect(parseStoredFindings("[]")).toEqual([]);
  });

  it("round-trips a well-formed record", () => {
    expect(parseStoredFindings([stored])).toEqual([stored]);
  });

  it("drops entries missing identity rather than failing the whole task", () => {
    const parsed = parseStoredFindings([
      { ...stored, id: "" },
      { ...stored, agent: undefined },
      { ...stored, severity: "high" },
      { ...stored, claim: "" },
      stored,
    ]);
    expect(parsed).toEqual([stored]);
  });
});

describe("parseStoredRefutations", () => {
  const finding: Finding = {
    id: "code-reviewer-1",
    agent: "code-reviewer",
    severity: "critical",
    file: null,
    line: null,
    claim: "unchecked cast",
  };

  it("keeps a well-formed refutation record", () => {
    const raw = [{ finding, refutedBy: ["reproduction", "intent"], reasoning: ["cannot trigger", "deliberate"] }];
    expect(parseStoredRefutations(raw)).toEqual(raw);
  });

  it("drops a record whose reasoning does not align with its refuters", () => {
    expect(parseStoredRefutations([{ finding, refutedBy: ["reproduction"], reasoning: [] }])).toEqual([]);
    expect(parseStoredRefutations([{ finding, refutedBy: [], reasoning: [] }])).toEqual([]);
  });

  it("drops a record whose finding lost its identity", () => {
    expect(parseStoredRefutations([{ finding: { ...finding, id: "" }, refutedBy: ["x"], reasoning: ["y"] }]))
      .toEqual([]);
  });
});
