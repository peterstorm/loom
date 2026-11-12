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
 * Usage: bun scripts/stamp-wire-contract.ts [--check]
 *   --check  exit 1 if any stamped text differs from its fragment (no writes)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOfKind } from "../engine/src/core/agent-catalog-projections";
import { renderReviewerWireContract } from "../engine/src/core/reviewer-protocol";
import {
  READ_COVERAGE_BULLET_ANCHOR,
  REVIEWER_BOOTSTRAP_REGION,
  REVIEWER_PREFLIGHT_REGION,
  WIRE_CONTRACT_REGION,
  stampReadCoverageBullet,
  stampRegion,
  type StampedRegion,
} from "../engine/src/core/wire-contract";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENTS = "references/reviewer-wire";
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

/** Each stamped region with the fragment that owns it, in file order. */
const regions: readonly Readonly<{ region: StampedRegion; file: string; text: string }>[] = [
  { region: REVIEWER_BOOTSTRAP_REGION, file: "bootstrap.md", text: readFragment("bootstrap.md") },
  { region: REVIEWER_PREFLIGHT_REGION, file: "before-you-emit.md", text: readFragment("before-you-emit.md") },
  { region: WIRE_CONTRACT_REGION, file: "wire-contract.md", text: wireContract },
];
const readCoverage = readFragment("read-coverage.md");

for (const agent of agentsOfKind("reviewer")) {
  const path = join(ROOT, "agents", `${agent}.md`);
  const current = readFileSync(path, "utf-8");
  let stamped = current;
  const differing: string[] = [];
  for (const { region, file, text } of regions) {
    const next = stampRegion(stamped, region, text);
    if (!next.ok) {
      console.error(`${agent}: ${next.error} (expected ${region.start} … ${region.end})`);
      process.exit(1);
    }
    if (next.value !== stamped) differing.push(`${region.name} region differs from ${FRAGMENTS}/${file}`);
    stamped = next.value;
  }
  const bullet = stampReadCoverageBullet(stamped, readCoverage);
  if (!bullet.ok) {
    console.error(`${agent}: ${bullet.error} (expected one line starting ${READ_COVERAGE_BULLET_ANCHOR})`);
    process.exit(1);
  }
  if (bullet.value !== stamped) differing.push(`read-coverage bullet differs from ${FRAGMENTS}/read-coverage.md`);
  if (differing.length === 0) continue;
  drifted += 1;
  if (check) {
    for (const difference of differing) console.error(`${agent}: ${difference}`);
  } else {
    writeFileSync(path, bullet.value);
    process.stdout.write(`stamped ${agent}\n`);
  }
}

if (check && drifted > 0) process.exit(1);
process.stdout.write(
  check ? "reviewer regions and read-coverage bullets match their fragments\n" : `done (${drifted} file(s) updated)\n`,
);
