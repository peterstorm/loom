---
name: distill
version: "1.0.0"
description: "This skill should be used when the user asks to 'simplify this code', 'clean this up', 'reduce complexity', 'remove duplication', 'tighten this up', 'this feels over-engineered', 'make this readable', 'distill this', or after implementing a feature when the code works but carries incidental complexity. Removes complexity that isn't paying for itself while preserving behavior AND interfaces. Also preloaded by the code-simplifier reviewer during review passes. NOT for interface redesign or module consolidation (use deepen), NOT for finding bugs (use /review-pr)."
---

# Distill — Behavior-Preserving Simplification

Remove **incidental complexity** — complexity that isn't paying for itself — while preserving exact behavior and existing interfaces. The goal is that the next reader spends their attention on the problem, not on the code.

**Scope discipline:** distill works *within* interfaces; deepen *changes* them. If the fix requires moving a seam, changing a signature callers see, or merging modules, that is a deepening — name it, recommend the `deepen` skill, and move on. The two skills share vocabulary (see deepen's `references/LANGUAGE.md`); distill is the smaller knife.

---

## Context Loading

Before distilling, load the project's standards — they define what "simple" means here:

**Always read:**
- `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` — FC/IS, DDD, ports, immutability
- `CONTEXT.md` at the repo root (if it exists) — ubiquitous language

**Language-specific (match the files in scope):**
- `${CLAUDE_PLUGIN_ROOT}/rules/java-patterns.md`
- `${CLAUDE_PLUGIN_ROOT}/rules/typescript-patterns.md`
- `${CLAUDE_PLUGIN_ROOT}/rules/rust-patterns.md`

Idiom is project-relative: code that matches the loaded patterns is already simple by this project's definition, even if you would write it differently.

---

## Vocabulary

- **Essential complexity** — complexity the problem itself demands. Untouchable.
- **Incidental complexity** — complexity the current *expression* of the solution added: duplication, dead branches, speculative generality, noise. This is what distill removes.
- **Altitude** — the abstraction level a reader must hold to follow the code. Wrong altitude reads as either a wall of low-level detail inside high-level orchestration, or a stack of trivial wrappers hiding one real operation. Right altitude: each function reads as one coherent level.
- **Semantic compression** — fewer *concepts*, not fewer lines. Removing a redundant concept is compression; golfing three statements into one expression is not.
- **The reader test** — would a maintainer seeing this file for the first time understand it faster after the change? If not, it is not a simplification, whatever the diff stat says.

**Key asymmetry:** behavior is sacred, expression is not. Any change that could alter observable behavior — output, error modes, ordering, timing-sensitive effects — is out of scope, even if the current behavior looks accidental. Wrong-looking behavior is a *finding to report*, never a thing to silently "fix" mid-simplification.

---

## The Move Catalog

Concrete simplification moves, ordered by leverage, live in [references/CATALOG.md](./references/CATALOG.md). Highest-leverage first:

1. **Reuse before rewrite** — replace hand-rolled logic with an existing helper, stdlib call, or established project utility
2. **Delete dead and speculative code** — unreachable branches, unused parameters, configurability nothing configures
3. **Collapse pass-throughs** — wrappers that add no invariant, no translation, no seam
4. **Flatten control flow** — early returns over nesting, exhaustive switch/match over else-chains, never nested ternaries
5. **Restore altitude** — inline trivial indirection, extract genuinely separate concerns
6. **Apply FP shape** — extract pure functions from mixed code, immutable transformations, map/filter/reduce where they clarify
7. **Cut comment noise** — comments restating code; keep only constraint-carrying comments

---

## Two Modes

The skill runs in exactly one of two modes. Decide which before touching anything.

### Review mode — propose, never edit

Active when preloaded by the `code-simplifier` reviewer (standalone `/review-pr` or any engine-issued review), or whenever the user asks for an assessment rather than changes.

- Scope is the exact frozen scope you were given — never widen it.
- Report each opportunity as: **location**, **current shape**, **distilled shape**, **why the reader wins**.
- Never edit files. The output is findings.

**Severity discipline.** Simplification findings are almost always **advisory**. Reserve **critical** for simplification pressure that exposed *wrongness*: duplicated branches that have already diverged, a condition that cannot be reached, an abstraction whose callers disagree about its contract. "This could be tidier" is advisory, always. When the reviewer wire contract applies (Machine Summary), the agent shim defines it — the skill defines judgment, not wire format.

### Apply mode — edit, test-gated

Active when the user asks you to simplify, or as a post-implementation pass after `code-implementer` work.

1. **Baseline** — run the tests that cover the scope. If they are not green, stop: distilling on a red baseline destroys the only behavior oracle you have.
2. **One move at a time** — apply a single catalog move, re-run the covering tests, then the next. Never batch unrelated moves into one unverifiable diff.
3. **Tests are code too** — distill test files with the same moves, but never weaken an assertion to make a simplification fit.
4. **Report** — list each move applied, each opportunity deliberately skipped (with the reason), and any wrongness discovered (reported, not silently fixed).

---

## What NOT to Distill

- **Anything requiring an interface change** — signature, error type, module boundary, seam placement. That is deepen's territory; recommend it instead.
- **Code outside the requested scope** — opportunistic drive-by churn makes diffs unreviewable.
- **Working idiom you merely dislike** — project patterns win over personal taste.
- **Clarity into cleverness** — a dense one-liner that needs a comment lost the trade.
- **Performance-critical paths** where the clear form is measurably slower — note the tension, keep the fast form.
- **Abstractions with two-plus real callers that agree** — that abstraction is earning its keep (the deletion test cuts both ways).
- **Behavior, ever** — including "obviously wrong" behavior. Report it; don't fix it under the banner of simplification.

---

## Completion

**Review mode output:** the findings, each anchored to file/line, severity-disciplined as above.

**Apply mode output:**
- Moves applied, with the covering tests that stayed green after each
- Opportunities skipped and why (interface-bound → deepen; taste; performance)
- Wrongness discovered and reported
- Whether anything surfaced that warrants a `deepen` session (shallow modules, misplaced seams)
