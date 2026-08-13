# ADR-0002: Defense-in-Depth ReDoS Protection

## Status
Accepted

## Context

The linter hook extension executes user-authored regex patterns from declarative JSON rule files against every file edit in real time. These rules are authored by developers and loaded from both default (shipped with Loom) and project-local override paths. Because rule authors can write arbitrary regex patterns, the engine is exposed to Regular Expression Denial of Service (ReDoS) — catastrophic backtracking patterns such as `(a+)+$` that exhibit exponential or super-linear matching time on certain inputs.

A single ReDoS-vulnerable pattern could freeze the PostToolUse hook indefinitely, blocking all subsequent edits and rendering the coding agent unusable. The latency budget for the entire lint pass is 50ms per edit, leaving no room for even brief backtracking episodes.

The challenge is that ReDoS detection is undecidable in the general case—no static analysis can identify all vulnerable patterns. Conversely, the in-process runtime can only check a deadline between synchronous matches; it cannot kill a match already blocking the event loop. The system needs layered risk reduction without pretending it has Worker/process isolation.

## Options Considered

1. **Static analysis only (reject unsafe patterns at load time)**
   - Pros: Zero runtime overhead for safe patterns; fast feedback at rule authoring time; bad rules never execute
   - Cons: Known false negatives — cannot catch all ReDoS patterns statically (undecidable in general); complex backreference patterns and novel attack vectors will slip through; provides no safety net at execution time

2. **Cooperative runtime deadline only (check elapsed time between matches)**
   - Pros: Bounds normal line-by-line work; simple implementation; no static false positives
   - Cons: Cannot interrupt a synchronous `RegExp.test()` already stuck in backtracking; wastes CPU before a later check fires; does not reject bad rules up front

3. **Sandbox/Worker isolation (run regex in separate thread/process)**
   - Pros: Full isolation; can hard-kill without cooperative checking; prevents main thread starvation
   - Cons: Bun Worker startup exceeds 50ms latency budget; IPC overhead for every regex match is prohibitive; dramatically increases complexity for a sub-50ms operation; overkill for single-pattern matching

4. **Two-layer defense-in-depth (static analysis + cooperative deadline)**
   - Pros: Static analysis catches known-bad patterns at zero runtime cost; the deadline catches excessive iterative work; provides fast feedback plus a secondary bound where execution yields
   - Cons: Some safe-but-complex patterns may be rejected by static analysis; neither layer can preempt one missed catastrophic synchronous match; two systems to maintain

## Decision
**Two-layer defense-in-depth: static analysis at rule load time rejects known-unsafe patterns; an amortized cooperative deadline at execution time provides a secondary safety net for work that returns control between checks.**

### Layer 1: Static Analysis at Load Time (`engine/src/linter/safety.ts`)

When rules are loaded from JSON, each regex pattern is analyzed for structural indicators of super-linear behavior:
- Nested quantifiers (e.g., `(a+)+`, `(a*)*`)
- Overlapping alternatives inside quantified groups
- Quantified groups containing unbounded dot repetition and ambiguous repeated dot-star forms

Patterns that fail static analysis are rejected immediately. The rule is marked invalid with a diagnostic message, and the linter refuses to execute it. This gives rule authors immediate feedback without consuming any runtime budget.

### Layer 2: Cooperative Runtime Deadline (`engine/src/linter/executor.ts`)

During execution, the rule executor tracks elapsed time with an amortized deadline check every 100 lines and after each regex rule. If cumulative time has exceeded 50ms when a check runs, execution halts and the linter returns a fail-closed error.

The checker is cooperative. It cannot preempt one synchronous JavaScript regex match already in progress, and programmatic handlers are checked before invocation but are not interrupted while running. The deadline therefore bounds ordinary iterative work, not the duration of arbitrary blocking regex or handler code.

### Invariants
- A pattern rejected by static analysis never executes at runtime
- A pattern that passes static analysis but accumulates excessive work across lines is caught when the cooperative deadline is checked
- A single blocking match remains a residual risk; this design is defense-in-depth, not process isolation

## Consequences

**Positive:**
- Known catastrophic structures are rejected before execution, and ordinary excessive multi-line work fails closed at the next deadline check
- Rule authors get immediate feedback on obviously unsafe patterns (load-time rejection) without waiting for a runtime failure
- Runtime cost of static analysis is zero — it runs once at load time, not on every edit
- The amortized timeout keeps fast-path overhead negligible (no per-match clock check)
- Defense-in-depth means some static false negatives that remain iterative are caught by the deadline, while static rejection prevents known blocking structures from reaching execution

**Negative:**
- Some safe-but-complex patterns (e.g., patterns with nested quantifiers that are actually linear due to possessive/atomic semantics) may be rejected by static analysis — rule authors must simplify or restructure these patterns
- Runtime deadline checks are amortized and non-preemptive — a single catastrophic synchronous match can exceed the target indefinitely; hard isolation would require a Worker/process design
- The safety module requires ongoing maintenance as new ReDoS attack patterns are discovered in the wild
- Two layers means two sets of tests and two potential sources of false positives/negatives to reason about
