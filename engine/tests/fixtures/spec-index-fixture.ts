/**
 * An indexed Spec Index for tests that populate or amend a TaskGraph: the
 * canonical specification below parsed by the production parser, so a Task's
 * Requirement trace is proven against the same index population requires.
 */

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

/** The Spec Index of `source` observed at `path`. */
export function indexedSpec(path: string, source: string = CANONICAL_SPEC): SpecIndexAvailability {
  const parsed = parseSpec(source);
  if (!parsed.ok) throw new Error("spec fixture must parse");
  const digest = parseArtifactDigest("c".repeat(64));
  if (!digest.ok) throw new Error("spec fixture digest must parse");
  return Object.freeze({ kind: "indexed", path, contentDigest: digest.value, index: parsed.value });
}
