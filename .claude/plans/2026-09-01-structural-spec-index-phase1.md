# Structural Spec Index — issue #11, phases 1–2

Date: 2026-09-01
Issue: https://github.com/peterstorm/loom/issues/11
Branch: `feat/structural-spec-index`
Base: `64b1ab38587304e88ed6ea423a0ad356aa9849d4`

## Scope

Deliver the standalone structural foundation before changing `/spec-check` authority:

1. Add a pure total parser for canonical specification Markdown.
2. Return immutable FR, Acceptance Scenario, Out-of-Scope, and glossary entries with deterministic canonical-content SHA-256 hashes.
3. Fail closed on missing sections, malformed or duplicate IDs, malformed glossary rows, and unterminated fences.
4. Add canonical `AS-NNN:` and `OOS-NNN:` IDs to the specification template and specify skill.
5. Export the parser through the parser barrel and define Spec Index in ubiquitous language.

## Deliberate boundary

This increment does not persist a cache, mutate TaskGraph schema, or change `/spec-check` verdicts. Those consumers follow only after the parser/identifier contract is reviewed and shipped. The parser is the pure functional core; later file reading and cache publication remain shell work.

## Invariants

- `FR-NNN`, `AS-NNN`, and `OOS-NNN` identities are unique within their collections.
- Fenced examples cannot mint structural entries.
- Content hashes are deterministic and insensitive to formatting-only whitespace.
- Any malformed required structural entry produces a typed non-empty error set.
- Returned entries and collections are immutable.

## Validation

Focused example/property tests, typecheck/unused, full-tier lint, authoritative unit/smoke suites, and diff check.

## Validation receipt

- Parser, parser-property, and template-contract suites: 13 passed, 0 failures.
- Parser neighborhood suites: 46 passed, 0 failures.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 2 production parser files, 0 violations.
- Authoritative unit suite: 235 files, 6,069 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.
