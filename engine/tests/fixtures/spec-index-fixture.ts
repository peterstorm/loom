/**
 * An indexed Spec Index for tests that populate or amend a TaskGraph: the
 * canonical specification below parsed by the production parser, so a Task's
 * Requirement trace is proven against the same index population requires.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSpec } from "../../src/core/parse-spec";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import type { SpecIndexAvailability } from "../../src/core/requirement-coverage";

/** Defines FR-001, FR-002, AS-001, AS-002 and OOS-001. */
export const CANONICAL_SPEC = `# Feature: Fixture

## User Scenarios

### US1: [P1] Exercise the fixture

**Acceptance Scenarios:**
- AS-001: Given a fixture, When it runs, Then it passes
- AS-002: Given a second fixture, When it runs, Then it passes too

## Functional Requirements

- FR-001: System MUST do the first thing
- FR-002: System MUST do the second thing

## Out of Scope

- OOS-001: Anything else

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Fixture | A test input |
`;

/** Writes the canonical specification as `spec.md` beside a plan file; its path.
 *  The decompose payload names it as `spec_file`, so population proves the trace. */
export function canonicalSpecBeside(planFile: string): string {
  const specFile = join(dirname(planFile), "spec.md");
  writeFileSync(specFile, CANONICAL_SPEC);
  return specFile;
}

/** The Spec Index of `source` observed at `path`. */
export function indexedSpec(path: string, source: string = CANONICAL_SPEC): SpecIndexAvailability {
  const parsed = parseSpec(source);
  if (!parsed.ok) throw new Error("spec fixture must parse");
  const digest = parseArtifactDigest("c".repeat(64));
  if (!digest.ok) throw new Error("spec fixture digest must parse");
  return Object.freeze({ kind: "indexed", path, contentDigest: digest.value, index: parsed.value });
}

/**
 * A canonical specification defining exactly `frs` and `scenarios` (at least
 * one: a specification has an Acceptance Scenarios block). Population refuses
 * a Requirement no Task completes (loom#198, Cause 3), so a suite whose roster
 * owns part of `CANONICAL_SPEC` indexes the part it owns instead.
 */
export function specDefining(frs: readonly string[], scenarios: readonly [string, ...string[]]): string {
  return [
    "# Feature: Fixture", "", "## User Scenarios", "", "### US1: [P1] Exercise the fixture", "", "**Acceptance Scenarios:**",
    ...scenarios.map((id) => `- ${id}: Given a fixture, When it runs, Then ${id} holds`),
    "", "## Functional Requirements", "",
    ...frs.map((id) => `- ${id}: System MUST satisfy ${id}`),
    "", "## Out of Scope", "", "- OOS-001: Anything else", "", "## Appendix: Glossary", "",
    "| Term | Definition |", "|------|------------|", "| Fixture | A test input |", "",
  ].join("\n");
}

/**
 * A decompose-payload Task that completes every Requirement `specSource`
 * defines and `claimed` does not, or null when nothing is left: population
 * refuses a Requirement no Task completes (loom#198, Cause 3), so a payload
 * exercising one Task's trace adds this owner for the rest.
 */
export function ownerOfRemaining(specSource: string, claimed: readonly string[], id = "T90", wave = 1): Readonly<Record<string, unknown>> | null {
  const parsed = parseSpec(specSource);
  if (!parsed.ok) return null;
  const remaining = [...parsed.value.frs, ...parsed.value.scenarios].map(({ id: requirement }) => requirement)
    .filter((requirement) => !claimed.includes(requirement));
  return remaining.length === 0 ? null : Object.freeze({
    id, description: "completes the remaining Requirements", agent: "code-implementer-agent", wave,
    depends_on: [], spec_anchors: remaining, spec_contributions: [],
    verification_policy: { regression: { kind: "required" }, new_tests: { kind: "waived", reason: "existing-tests-sufficient" } },
    plan_context: "", file_list: [`src/${id.toLowerCase()}-owner.ts`],
  });
}
