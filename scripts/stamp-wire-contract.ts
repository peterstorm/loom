#!/usr/bin/env bun
/**
 * Stamp the shared reviewer text (see CONTEXT.md: Wire Contract) into every
 * finding-producing reviewer agent file.
 *
 * The fragments live in references/reviewer-wire/:
 *
 * - `wire-contract.md` is generated from renderReviewerWireContract(), the
 *   executable codec; a schema/rubric change requires an explicit supported
 *   contract revision. This script rewrites the fragment itself, then stamps
 *   it between each reviewer's wire-contract markers.
 * - `bootstrap.md` and `before-you-emit.md` are hand-written and stamped
 *   between their own markers.
 * - `read-coverage.md` is one hand-written bullet, stamped over each
 *   reviewer's one line that opens with the `LOOM_READ_COVERAGE` anchor.
 *
 * The reviewer roster is derived from the Agent Catalog (kind `reviewer`), so
 * a new reviewer is stamped the moment it is catalogued; a reviewer file
 * missing a marker or the anchored bullet fails loudly here and in
 * engine/tests/wire-contract.test.ts.
 *
 * The refutation verifier (kind `review-verifier`) carries one region of its
 * own: the lens sections of references/review-lenses.md, between the
 * review-lenses markers. It is issued its lens by name, so the definitions
 * travel in its own file.
 *
 * Usage: bun scripts/stamp-wire-contract.ts [--check]
 *   --check  exit 1 if any stamped text differs from its source (no writes)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOfKind } from "../engine/src/core/agent-catalog-projections";
import { renderReviewerWireContract } from "../engine/src/core/reviewer-protocol";
import { REVIEW_LENSES } from "../engine/src/core/review-panel";
import {
  READ_COVERAGE_BULLET_ANCHOR,
  REVIEW_LENSES_REGION,
  REVIEWER_BOOTSTRAP_REGION,
  REVIEWER_PREFLIGHT_REGION,
  WIRE_CONTRACT_REGION,
  reviewLensSections,
  stampReadCoverageBullet,
  stampRegion,
  type StampResult,
  type StampedRegion,
} from "../engine/src/core/wire-contract";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENTS = "references/reviewer-wire";
const LENS_REFERENCE = "references/review-lenses.md";
const check = process.argv.includes("--check");
const readFragment = (name: string): string => readFileSync(join(ROOT, FRAGMENTS, name), "utf-8");

const wireContract = renderReviewerWireContract();
const wireContractPath = join(ROOT, FRAGMENTS, "wire-contract.md");
let drifted = 0;
if (readFileSync(wireContractPath, "utf-8") !== wireContract) {
  drifted += 1;
  if (check) console.error(`${FRAGMENTS}/wire-contract.md differs from the executable reviewer contract`);
  else writeFileSync(wireContractPath, wireContract);
}

/** One source's replacement in an agent file, with the words that report it. */
type Stamp = Readonly<{
  apply: (agentMarkdown: string) => StampResult;
  /** What a refused stamp should have found in the file. */
  expected: string;
  /** What `--check` reports when the file differs. */
  difference: string;
}>;

const regionStamp = (region: StampedRegion, source: string, text: string): Stamp => ({
  apply: (agentMarkdown) => stampRegion(agentMarkdown, region, text),
  expected: `${region.start} … ${region.end}`,
  difference: `${region.name} region differs from ${source}`,
});

/** Apply every stamp to one agent file; a stamp the file cannot take is fatal. */
function stampAgent(agent: string, stamps: readonly Stamp[]): void {
  const path = join(ROOT, "agents", `${agent}.md`);
  let stamped = readFileSync(path, "utf-8");
  const differing: string[] = [];
  for (const { apply, expected, difference } of stamps) {
    const next = apply(stamped);
    if (!next.ok) {
      console.error(`${agent}: ${next.error} (expected ${expected})`);
      process.exit(1);
    }
    if (next.value !== stamped) differing.push(difference);
    stamped = next.value;
  }
  if (differing.length === 0) return;
  drifted += 1;
  if (check) {
    for (const difference of differing) console.error(`${agent}: ${difference}`);
  } else {
    writeFileSync(path, stamped);
    process.stdout.write(`stamped ${agent}\n`);
  }
}

/** Every reviewer's stamps, in file order. */
const readCoverage = readFragment("read-coverage.md");
const reviewerStamps: readonly Stamp[] = [
  regionStamp(REVIEWER_BOOTSTRAP_REGION, `${FRAGMENTS}/bootstrap.md`, readFragment("bootstrap.md")),
  regionStamp(REVIEWER_PREFLIGHT_REGION, `${FRAGMENTS}/before-you-emit.md`, readFragment("before-you-emit.md")),
  regionStamp(WIRE_CONTRACT_REGION, `${FRAGMENTS}/wire-contract.md`, wireContract),
  {
    apply: (agentMarkdown) => stampReadCoverageBullet(agentMarkdown, readCoverage),
    expected: `one line starting ${READ_COVERAGE_BULLET_ANCHOR}`,
    difference: `read-coverage bullet differs from ${FRAGMENTS}/read-coverage.md`,
  },
];
for (const agent of agentsOfKind("reviewer")) stampAgent(agent, reviewerStamps);

const lensSections = reviewLensSections(readFileSync(join(ROOT, LENS_REFERENCE), "utf-8"), REVIEW_LENSES);
if (!lensSections.ok) {
  console.error(`${LENS_REFERENCE}: ${lensSections.error}`);
  process.exit(1);
}
const verifierStamps = [regionStamp(REVIEW_LENSES_REGION, LENS_REFERENCE, lensSections.value)];
for (const agent of agentsOfKind("review-verifier")) stampAgent(agent, verifierStamps);

if (check && drifted > 0) process.exit(1);
process.stdout.write(
  check ? "stamped regions and read-coverage bullets match their sources\n" : `done (${drifted} file(s) updated)\n`,
);
