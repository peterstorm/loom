/**
 * The one specification both Requirement trace amendment suites (pure core and
 * helper shell) amend against, so their hash and unknown-id assertions always
 * describe the same Spec Index.
 */
export const AMENDMENT_SPEC = `# Feature: Amendment

## User Scenarios

### US1: [P1] Amend a trace

**Acceptance Scenarios:**
- AS-001: Given a populated graph, When the trace is amended, Then settled work survives

## Functional Requirements

- FR-001: System MUST amend a Requirement trace in place
- FR-002: System MUST retire review authority derived from the old trace

## Out of Scope

- OOS-001: Amending completed Waves

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Trace | Requirement ownership |
`;
