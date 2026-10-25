/**
 * Owned-Invariant families the owner-verification tests share, and the
 * paragraph matcher their rendered-text assertions use. Every obligation is
 * built through `ownerObligation`, the engine's own constructor, so a change
 * to the stamp's shape is edited here once; every plan text is derived from
 * its obligations through `invariantPlanBlock`, so the two agree by construction.
 *
 * - FEES / CLOCK: a verified fee family (two noted siblings) and an exempt
 *   clock family, with the plan text that declares them.
 * - ADMISSION / FEE_TABLE: a verified admission family (one noted, one bare
 *   sibling) and an exempt sibling-less fee table, with their plan text.
 */

import type { OwnerObligation } from "../../src/core/owner-verification/types";
import { ownerObligation } from "./owner-obligation";

// ---------------------------------------------------------------------------
// Plan text derived from obligations
// ---------------------------------------------------------------------------

/**
 * The plan-grammar block that declares `obligation`: Tier, Owner module,
 * Sibling entry points (or none), Matrix test, the Mutation exemption when
 * exempt, and the Statement when it has one. Every fixture plan is derived
 * through it, so a stamp and its plan text agree by construction.
 */
function invariantPlanBlock(obligation: OwnerObligation): readonly string[] {
  const { invariant, title, statement, owner, siblings, matrixTest, mutation } = obligation;
  return [
    `### ${invariant}: ${title}`, "",
    "**Tier:** advisory",
    `**Owner module:** \`${owner}\``,
    ...(siblings.length === 0
      ? ["**Sibling entry points:** none"]
      : ["**Sibling entry points:**", ...siblings.map(({ path, note }) => note === null ? `- \`${path}\`` : `- \`${path}\` — ${note}`)]),
    `**Matrix test:** \`${matrixTest}\``,
    ...(mutation.kind === "exempt" ? [`**Mutation exemption:** ${mutation.reason}`] : []),
    ...(statement === null ? [] : [`**Statement:** ${statement}`]),
    "",
  ];
}

/** A whole plan declaring `obligations` under `## Invariants`, in order. */
const planText = (name: string, obligations: readonly OwnerObligation[]): string =>
  [`# Plan: ${name}`, "", "## Invariants", "", ...obligations.flatMap(invariantPlanBlock)].join("\n");

// ---------------------------------------------------------------------------
// FEES / CLOCK
// ---------------------------------------------------------------------------

/** The plan path a FEES / CLOCK graph records. */
export const FEES_CLOCK_PLAN_FILE = ".claude/plans/2026-10-21-fees.md";

export const FEES = ownerObligation({
  invariant: "INV-1",
  title: "Fees are computed only by the fee calculator",
  statement: "Every fee is computed by computeFee; no entry point rounds or discounts a fee inline.",
  owner: "src/core/fees.ts",
  siblings: [
    { path: "src/api/quote.ts", note: "quote endpoint" },
    { path: "src/jobs/invoice.ts", note: "nightly invoicing" },
  ],
  matrixTest: "tests/fees.matrix.test.ts",
  mutation: { kind: "verify" },
});

/** INV-2's declared mutation exemption, as the plan states it. */
export const CLOCK_EXEMPTION = "timing-only code; every mutant only changes a sleep";

export const CLOCK = ownerObligation({
  invariant: "INV-2",
  title: "Time is read only through the clock port",
  statement: "No module reads Date.now outside the clock port.",
  owner: "src/core/clock.ts",
  siblings: [{ path: "src/jobs/schedule.ts", note: null }],
  matrixTest: "tests/clock.matrix.test.ts",
  mutation: { kind: "exempt", reason: CLOCK_EXEMPTION },
});

/** The plan declaring FEES (noted siblings) and CLOCK (bare sibling, exemption). */
export const FEES_CLOCK_PLAN_TEXT = planText("fees", [FEES, CLOCK]);

// ---------------------------------------------------------------------------
// ADMISSION / FEE_TABLE
// ---------------------------------------------------------------------------

export const ADMISSION = ownerObligation({
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: "Every entry point admits through decide().",
  owner: "src/rules/owner.ts",
  siblings: [
    { path: "src/rules/sibling-a.ts", note: "admits members" },
    { path: "src/rules/sibling-b.ts", note: null },
  ],
  matrixTest: "tests/rules.matrix.test.ts",
  mutation: { kind: "verify" },
});

export const FEE_TABLE = ownerObligation({
  invariant: "INV-4",
  title: "Fees are computed only by the fee table",
  statement: null,
  owner: "src/fees/table.ts",
  siblings: [],
  matrixTest: "tests/fees.matrix.test.ts",
  mutation: { kind: "exempt", reason: "generated lookup table" },
});

/** The population stamp of the ADMISSION / FEE_TABLE plan. */
export const ADMISSION_FEE_TABLE_STAMP: readonly OwnerObligation[] = [ADMISSION, FEE_TABLE];

/** The plan ADMISSION_FEE_TABLE_STAMP is derived from. */
export const ADMISSION_FEE_TABLE_PLAN_TEXT = planText("duties", ADMISSION_FEE_TABLE_STAMP);

// ---------------------------------------------------------------------------
// Paragraph matcher
// ---------------------------------------------------------------------------

/** What a paragraph must hold: a pattern it matches, or text it contains verbatim. */
export type ParagraphNeedle = RegExp | string;

/** The blank-line-separated paragraphs of `text`. */
export const paragraphs = (text: string): readonly string[] => text.split(/\n\s*\n/);

const holds = (paragraph: string) => (needle: ParagraphNeedle): boolean =>
  typeof needle === "string" ? paragraph.includes(needle) : needle.test(paragraph);

/** True when some paragraph of `text` holds every needle. */
export const someParagraph = (text: string, ...needles: readonly ParagraphNeedle[]): boolean =>
  paragraphs(text).some((paragraph) => needles.every(holds(paragraph)));
