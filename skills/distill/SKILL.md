---
name: distill
version: "1.0.0"
description: "Behavior- and interface-preserving simplification of existing code: duplication, dead code, redundant states, control-flow noise. Run after implementing. Anything that changes what callers see is deepen."
---

# Distill — Behavior-Preserving Simplification

Remove **incidental complexity** — complexity that isn't paying for itself — while preserving exact behavior and existing interfaces.

**Complexity is measured in representable states and concepts, not lines.** The yardstick is the project's own architecture rule: functional core / imperative shell, ADTs, parse-don't-validate, illegal states unrepresentable. The strongest simplification is not a shorter function; it is a branch **deleted because the state it guarded can no longer be written**. When you cannot decide whether something is simpler, count what a reader must hold: how many states can this represent, how many concepts must I know? Fewer wins.

**The deepen/distill boundary.** Distill may change a symbol only when every caller of it is inside the scope it was given. Anything a caller outside the scope can see (signature, type, error mode, import path) is deepen: name it, recommend the `deepen` skill, and move on. Every move below carries this condition. The two skills share vocabulary (deepen's `references/LANGUAGE.md`).

## Context Loading

If not already in context this session, read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` and the one language rule matching the files in scope.

Also read `CONTEXT.md` at the repo root if it exists. Idiom is project-relative: code that matches the loaded patterns is already simple by this project's definition, even if you would write it differently.

## Vocabulary

- **Essential complexity** — complexity the problem itself demands. Untouchable.
- **Incidental complexity** — complexity the current *expression* of the solution added: extra representable states, duplication, dead branches, speculative generality, noise. This is what distill removes.
- **State space** — the set of states a value or module can represent. The legal states are essential; every representable-but-illegal state is incidental complexity that some branch, check, or comment now has to pay for. Shrinking the state space to exactly the legal states is the highest form of simplification.
- **Altitude** — the abstraction level a reader must hold to follow the code. Wrong altitude reads as either a wall of low-level detail inside high-level orchestration, or a stack of trivial wrappers hiding one real operation.
- **Semantic compression** — fewer *concepts* and fewer *representable states*, not fewer lines. Golfing three statements into one expression is not compression.
- **The reader test** — would a maintainer seeing this file for the first time understand it faster after the change? If not, it is not a simplification, whatever the diff stat says.

**Key asymmetry:** behavior is sacred, expression is not. Any change that could alter observable behavior — output, error modes, ordering, timing-sensitive effects — is out of scope, even if the current behavior looks accidental. Wrong-looking behavior is a *finding to report*, never a thing to silently "fix" mid-simplification.

## The Move Catalog

The moves, with examples and each move's boundary, are in [references/CATALOG.md](./references/CATALOG.md). Highest leverage first:

1. **Reuse before rewrite** — an existing helper, stdlib call or project utility instead of hand-rolled logic
2. **Compress with types** — make illegal states unrepresentable, then delete every branch that guarded them
3. **Delete dead and speculative code** — unreachable branches, unused parameters, configurability nothing configures
4. **Collapse pass-throughs** — wrappers that add no invariant, no translation, no seam
5. **Flatten control flow** — early returns over nesting, exhaustive match over else-chains, never nested ternaries
6. **Restore altitude** — inline trivial indirection, extract genuinely separate concerns
7. **Apply FP shape** — extract the pure part of mixed code, immutable transformations
8. **Cut comment noise** — keep only comments that carry a constraint the code cannot show

## Two Modes

The skill runs in exactly one of two modes. Decide which before touching anything.

### Review mode — propose, never edit

Active when preloaded by the `code-simplifier` reviewer (standalone `/review-pr` or any engine-issued review), or whenever the user asks for an assessment rather than changes.

- Scope is the exact frozen scope you were given — never widen it.
- Report each opportunity as: **location**, **current shape**, **distilled shape**, **why the reader wins**.
- Never edit files. The output is findings.

**Severity discipline.** Simplification findings are almost always **advisory**. Reserve **critical** for simplification pressure that exposed *wrongness*: duplicated branches that have already diverged, a condition that cannot be reached, an abstraction whose callers disagree about its contract. "This could be tidier" is advisory, always. In an engine-issued review, the issued schema and rubric override this paragraph.

### Apply mode — edit, test-gated

Active when the user asks you to simplify, or as the pass after an implementation.

1. **Baseline** — run the tests that cover the scope. If they are not green, stop: distilling on a red baseline destroys the only behavior oracle you have.
2. **One move at a time** — apply a single catalog move, re-run the covering tests, then the next. Never batch unrelated moves into one unverifiable diff.
3. **Tests are code too** — distill test files with the same moves, but never weaken an assertion to make a simplification fit.
4. **Report** — list each move applied, each opportunity deliberately skipped (with the reason), and any wrongness discovered (reported, not silently fixed).

## What NOT to Distill

- **Anything requiring an interface change** — signature, error type, module boundary, seam placement. That is deepen's territory; recommend it instead.
- **Code outside the requested scope** — opportunistic drive-by churn makes diffs unreviewable.
- **Working idiom you merely dislike** — project patterns win over personal taste.
- **Clarity into cleverness** — a dense one-liner that needs a comment lost the trade.
- **Performance-critical paths** where the clear form is measurably slower — note the tension, keep the fast form.
- **Abstractions with two-plus real callers that agree** — that abstraction is earning its keep (the deletion test cuts both ways).
- **Behavior, ever** — including "obviously wrong" behavior. Report it; don't fix it under the banner of simplification.

## Completion

**Review mode output:** the findings, each anchored to file/line, severity-disciplined as above.

**Apply mode output:**
- Moves applied, with the covering tests that stayed green after each
- Opportunities skipped and why (interface-bound → deepen; taste; performance)
- Wrongness discovered and reported
- Whether anything surfaced that warrants a `deepen` session (shallow modules, misplaced seams)
