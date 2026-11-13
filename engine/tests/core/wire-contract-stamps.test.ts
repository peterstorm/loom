/**
 * Which stamps an agent of each kind carries, and how a list of them is
 * applied to one file: the composition scripts/stamp-wire-contract.ts runs,
 * tested here on text with no filesystem. The last block reads the agent files
 * once, to prove the kinds `stampsFor` knows are every kind that carries
 * stamped text.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentsOfKind } from "../../src/core/agent-catalog-projections";
import { AGENT_POLICIES } from "../../src/core/model-profiles";
import {
  READ_COVERAGE_BULLET_ANCHOR,
  REVIEW_LENSES_REGION,
  REVIEWER_BOOTSTRAP_REGION,
  REVIEWER_PREFLIGHT_REGION,
  WIRE_CONTRACT_REGION,
  applyStamps,
  stampsFor,
  type StampSources,
  type StampedRegion,
} from "../../src/core/wire-contract";

type ReviewerSources = Extract<StampSources, { kind: "reviewer" }>;

const bullet = (text: string): string => `${READ_COVERAGE_BULLET_ANCHOR}${text}`;
const region = ({ start, end }: StampedRegion, text: string): string => `${start}\n${text}\n${end}`;

/** A reviewer file holding `texts` in its four stamped places, in file order. */
const reviewerFile = (texts: Omit<ReviewerSources, "kind">): string =>
  [
    "---\nname: some-reviewer\n---",
    region(REVIEWER_BOOTSTRAP_REGION, texts.bootstrap),
    "You are a reviewer.",
    texts.readCoverage,
    region(REVIEWER_PREFLIGHT_REGION, texts.preflight),
    region(WIRE_CONTRACT_REGION, texts.wireContract),
    "",
  ].join("\n");

const CURRENT = { bootstrap: "boot", preflight: "check", wireContract: "contract", readCoverage: bullet("read it all`") };
const REVIEWER: ReviewerSources = { kind: "reviewer", ...CURRENT };

describe("stampsFor", () => {
  it("gives a reviewer its bootstrap, preflight, wire contract and read-coverage bullet, in that order", () => {
    expect(stampsFor(REVIEWER).map(({ difference }) => difference)).toEqual([
      "reviewer-bootstrap region differs from references/reviewer-wire/bootstrap.md",
      "reviewer-preflight region differs from references/reviewer-wire/before-you-emit.md",
      "wire-contract region differs from references/reviewer-wire/wire-contract.md",
      "read-coverage bullet differs from references/reviewer-wire/read-coverage.md",
    ]);
  });

  it("names what each reviewer stamp expects to find in the file", () => {
    expect(stampsFor(REVIEWER).map(({ expected }) => expected)).toEqual([
      `${REVIEWER_BOOTSTRAP_REGION.start} … ${REVIEWER_BOOTSTRAP_REGION.end}`,
      `${REVIEWER_PREFLIGHT_REGION.start} … ${REVIEWER_PREFLIGHT_REGION.end}`,
      `${WIRE_CONTRACT_REGION.start} … ${WIRE_CONTRACT_REGION.end}`,
      `one line starting ${READ_COVERAGE_BULLET_ANCHOR}`,
    ]);
  });

  it("gives the refutation verifier its lens sections and nothing else", () => {
    const stamps = stampsFor({ kind: "review-verifier", lensSections: "### intent" });

    expect(stamps.map(({ difference, expected }) => ({ difference, expected }))).toEqual([{
      difference: "review-lenses region differs from references/review-lenses.md",
      expected: `${REVIEW_LENSES_REGION.start} … ${REVIEW_LENSES_REGION.end}`,
    }]);
    expect(stamps[0]?.apply(region(REVIEW_LENSES_REGION, "stale")))
      .toEqual({ ok: true, value: region(REVIEW_LENSES_REGION, "### intent") });
  });

  it("stamps each source into its own place and no other", () => {
    const stale = reviewerFile({ bootstrap: "a", preflight: "b", wireContract: "c", readCoverage: bullet("d`") });

    expect(applyStamps(stale, stampsFor(REVIEWER))).toMatchObject({ ok: true, value: reviewerFile(CURRENT) });
  });
});

describe("applyStamps", () => {
  const stamps = stampsFor(REVIEWER);

  it("reports a current file as not differing and leaves it byte-identical", () => {
    const current = reviewerFile(CURRENT);

    expect(applyStamps(current, stamps)).toEqual({ ok: true, value: current, differing: [] });
  });

  it("reports exactly the stamps that changed the file, in stamp order, with the stamped text", () => {
    const drifted = reviewerFile({ ...CURRENT, preflight: "stale check", readCoverage: bullet("stale`") });

    expect(applyStamps(drifted, stamps)).toEqual({
      ok: true,
      value: reviewerFile(CURRENT),
      differing: [
        "reviewer-preflight region differs from references/reviewer-wire/before-you-emit.md",
        "read-coverage bullet differs from references/reviewer-wire/read-coverage.md",
      ],
    });
  });

  it("is idempotent: a stamped file has nothing left to stamp", () => {
    const once = applyStamps(reviewerFile({ ...CURRENT, bootstrap: "stale" }), stamps);
    if (!once.ok) throw new Error(once.error.reason);

    expect(applyStamps(once.value, stamps)).toEqual({ ok: true, value: once.value, differing: [] });
  });

  it("refuses a file missing a marker, naming the marker and what the stamp expected", () => {
    const missing = reviewerFile(CURRENT).replace(REVIEWER_PREFLIGHT_REGION.end, "");

    expect(applyStamps(missing, stamps)).toEqual({
      ok: false,
      error: {
        reason: "missing reviewer-preflight end marker",
        expected: `${REVIEWER_PREFLIGHT_REGION.start} … ${REVIEWER_PREFLIGHT_REGION.end}`,
      },
    });
  });

  it("refuses a file without the read-coverage bullet", () => {
    const missing = reviewerFile({ ...CURRENT, readCoverage: "- some other bullet" });

    expect(applyStamps(missing, stamps)).toEqual({
      ok: false,
      error: { reason: "missing read-coverage bullet", expected: `one line starting ${READ_COVERAGE_BULLET_ANCHOR}` },
    });
  });

  it("stops at the first refusal: the first unstampable place is the one reported", () => {
    const missingTwo = reviewerFile(CURRENT)
      .replace(REVIEWER_BOOTSTRAP_REGION.start, "")
      .replace(WIRE_CONTRACT_REGION.end, "");

    expect(applyStamps(missingTwo, stamps)).toMatchObject({ ok: false, error: { reason: "missing reviewer-bootstrap start marker" } });
  });

  it("applies no stamps to a file as the file itself", () => {
    expect(applyStamps("anything", [])).toEqual({ ok: true, value: "anything", differing: [] });
  });
});

describe("the kinds that carry stamped text", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  /** Every kind `stampsFor` accepts. A kind added to StampSources and left out here does not compile. */
  const STAMPED_KINDS = Object.keys({
    reviewer: true,
    "review-verifier": true,
  } satisfies Record<StampSources["kind"], true>);

  const STAMPED_TEXT_MARKS = [
    REVIEWER_BOOTSTRAP_REGION.start,
    REVIEWER_PREFLIGHT_REGION.start,
    WIRE_CONTRACT_REGION.start,
    REVIEW_LENSES_REGION.start,
    READ_COVERAGE_BULLET_ANCHOR,
  ];

  const agentFiles = AGENT_POLICIES.flatMap(({ agent, kind }) => {
    const path = join(REPO_ROOT, "agents", `${agent}.md`);
    return existsSync(path) ? [{ agent, kind: kind.kind, markdown: readFileSync(path, "utf-8") }] : [];
  });

  it("reads the agent files of every kind (a vacuous pass would prove nothing)", () => {
    expect(new Set(agentFiles.map(({ kind }) => kind)).size).toBeGreaterThan(STAMPED_KINDS.length);
    for (const kind of ["reviewer", "review-verifier"] as const) {
      expect(agentFiles.filter((file) => file.kind === kind).map(({ agent }) => agent)).toEqual([...agentsOfKind(kind)]);
    }
  });

  it("no agent of another kind carries a stamp marker: it would never be restamped", () => {
    const unstamped = agentFiles
      .filter(({ kind, markdown }) => !STAMPED_KINDS.includes(kind) && STAMPED_TEXT_MARKS.some((mark) => markdown.includes(mark)))
      .map(({ agent, kind }) => `${agent} (${kind})`);

    expect(unstamped).toEqual([]);
  });

  it("every reviewer and verifier file takes every stamp of its kind", () => {
    const sources: readonly StampSources[] = [REVIEWER, { kind: "review-verifier", lensSections: "### intent" }];
    const refused = sources.flatMap((source) =>
      agentFiles
        .filter(({ kind }) => kind === source.kind)
        .flatMap(({ agent, markdown }) => {
          const stamped = applyStamps(markdown, stampsFor(source));
          return stamped.ok ? [] : [`${agent}: ${stamped.error.reason}`];
        }));

    expect(refused).toEqual([]);
  });
});
