/**
 * Owned-Invariant families the owner-verification tests share, and the
 * paragraph matcher their rendered-text assertions use. Every obligation is
 * built through `ownerObligation`, the engine's own constructor, so a change
 * to the stamp's shape is edited here once.
 *
 * - FEES / CLOCK: a verified fee family (two noted siblings) and an exempt
 *   clock family, with the plan text that declares them.
 * - ADMISSION / FEE_TABLE: a verified admission family (one noted, one bare
 *   sibling) and an exempt sibling-less fee table, with their plan text.
 */

import type { OwnerObligation } from "../../src/core/owner-verification/types";
import { ownerObligation } from "./owner-obligation";

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
export const FEES_CLOCK_PLAN_TEXT = [
  "# Plan: fees", "",
  "## Invariants", "",
  `### ${FEES.invariant}: ${FEES.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** \`${FEES.owner}\``,
  "**Sibling entry points:**",
  ...FEES.siblings.map(({ path, note }) => `- \`${path}\` — ${note}`),
  `**Matrix test:** \`${FEES.matrixTest}\``,
  `**Statement:** ${FEES.statement}`, "",
  `### ${CLOCK.invariant}: ${CLOCK.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** \`${CLOCK.owner}\``,
  "**Sibling entry points:**",
  ...CLOCK.siblings.map(({ path }) => `- \`${path}\``),
  `**Matrix test:** \`${CLOCK.matrixTest}\``,
  `**Mutation exemption:** ${CLOCK_EXEMPTION}`,
  `**Statement:** ${CLOCK.statement}`, "",
].join("\n");

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
export const ADMISSION_FEE_TABLE_PLAN_TEXT = [
  "# Plan: duties", "",
  "## Invariants", "",
  `### ${ADMISSION.invariant}: ${ADMISSION.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** \`${ADMISSION.owner}\``,
  "**Sibling entry points:**",
  ...ADMISSION.siblings.map(({ path, note }) => note === null ? `- \`${path}\`` : `- \`${path}\` — ${note}`),
  `**Matrix test:** \`${ADMISSION.matrixTest}\``,
  `**Statement:** ${ADMISSION.statement}`, "",
  `### ${FEE_TABLE.invariant}: ${FEE_TABLE.title}`, "",
  "**Tier:** advisory",
  `**Owner module:** ${FEE_TABLE.owner}`,
  "**Sibling entry points:** none",
  `**Matrix test:** ${FEE_TABLE.matrixTest}`,
  "**Mutation exemption:** generated lookup table", "",
].join("\n");

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
