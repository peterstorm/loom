---
name: code-implementer
version: "1.0.0"
description: "Write production code for Java/Spring Boot, TypeScript/Next.js or Rust under the project's architecture rules: tests first, functional core and imperative shell, typed errors. Not for design (architecture-tech-lead), exploring an idea (brainstorming) or test-only work (java-test-engineer, ts-test-engineer)."
---

# Code Implementer

The procedure for writing production code. What the code must look like is in the rules; this skill is the order of work and the two checks that close it.

## Context Loading

If not already in context this session, read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` and the one language rule matching the files in scope.

The rules are constraints on the code, not background reading. Before the first line, be able to answer from them: where does I/O happen and where is the pure logic; what must always be true, and which type makes the opposite unrepresentable; which failures are expected, and what typed error carries each.

## Tests First

Write the test that decides the behavior before the code that provides it, and watch it fail for the right reason — a failing assertion, not a missing import. A test written after the code tends to encode whatever the code happens to do.

- Pure core: unit tests with plain data, and property tests for what must always hold (see `${CLAUDE_PLUGIN_ROOT}/rules/property-testing.md`).
- Shell: a few tests through in-memory port fakes; integration tests only to prove the I/O works, never to test business logic.
- Stack-specific test technique is in the `java-test-engineer` and `ts-test-engineer` skills.

### Acceptance Scenario tests

- A claimed Acceptance Scenario needs at least one test whose name starts with its identifier and a colon: `it('AS-004: rejects a stale cursor', …)`, or `@DisplayName("AS-004: rejects a stale cursor")` in JUnit.
- `/spec-check` links scenarios to tests only by this name; a scenario without one is reported NOT COVERED.
- The implementation brief's "Acceptance Scenario Test Names" section lists the names this Task owes.

## Implement

Make the tests pass, in the shape the rules give: logic in pure functions that take data and return data, a thin shell that loads, calls and persists, expected failures returned as typed errors. Reuse an existing operation before writing a new one. Implement the whole behavior, not a part of it.

## Before You Finish

- [ ] **Distilled**: Tidy the new code with the `distill` lens before you finish — reuse before rewrite, no dead/speculative code, no pass-throughs, right altitude. Tests stay green after each move.
- [ ] **Deep enough**: Check the new modules with the `deepen` lens — deletion test on every wrapper, interfaces narrower than their implementations, no seam without two adapters (production + test). Interfaces you created in this task, fix now; shallowness in pre-existing interfaces, report as a recommended `deepen` session — never redesign it inline.
