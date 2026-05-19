# ADR-0002: Defense-in-Depth ReDoS Protection

## Status
Accepted

## Context

The linter hook extension executes user-authored regex patterns from declarative JSON rule files against every file edit in real time. These rules are authored by developers and loaded from both default (shipped with Loom) and project-local override paths. Because rule authors can write arbitrary regex patterns, the engine is exposed to Regular Expression Denial of Service (ReDoS) — catastrophic backtracking patterns such as `(a+)+$` that exhibit exponential or super-linear matching time on certain inputs.

A single ReDoS-vulnerable pattern could freeze the PostToolUse hook indefinitely, blocking all subsequent edits and rendering the coding agent unusable. The latency budget for the entire lint pass is 50ms per edit, leaving no room for even brief backtracking episodes.

The challenge is that ReDoS detection is undecidable in the general case — no static analysis can identify all vulnerable patterns. Conversely, relying solely on runtime timeouts means every invocation of a bad rule wastes CPU time and introduces latency before the timeout fires. The system needs a strategy that provides strong guarantees without over-constraining legitimate rule authors or degrading edit-time performance.

## Options Considered

1. **Static analysis only (reject unsafe patterns at load time)**
   - Pros: Zero runtime overhead for safe patterns; fast feedback at rule authoring time; bad rules never execute
   - Cons: Known false negatives — cannot catch all ReDoS patterns statically (undecidable in general); complex backreference patterns and novel attack vectors will slip through; provides no safety net at execution time

2. **Runtime timeout only (kill execution after deadline)**
   - Pros: Catches all patterns regardless of complexity; simple implementation; no false positives at load time
   - Cons: Wastes CPU before timeout fires; poor UX (up to 50ms delay on every edit for a bad rule before it is detected); does not prevent the bad rule from being tried on every subsequent edit; no upfront feedback to rule authors

3. **Sandbox/Worker isolation (run regex in separate thread/process)**
   - Pros: Full isolation; can hard-kill without cooperative checking; prevents main thread starvation
   - Cons: Bun Worker startup exceeds 50ms latency budget; IPC overhead for every regex match is prohibitive; dramatically increases complexity for a sub-50ms operation; overkill for single-pattern matching

4. **Two-layer defense-in-depth (static analysis + runtime timeout)**
   - Pros: Static analysis catches known-bad patterns at zero runtime cost; runtime timeout catches patterns that evade static analysis; together they eliminate single-point-of-failure; provides both fast feedback (load time) and guaranteed safety (runtime)
   - Cons: Some safe-but-complex patterns may be rejected by static analysis (false positives); two systems to maintain; runtime timeout granularity is amortized, not per-character

## Decision
**Two-layer defense-in-depth: static analysis at rule load time rejects known-unsafe patterns; runtime amortized timeout at execution time provides a safety net for patterns that pass static analysis.**

### Layer 1: Static Analysis at Load Time (`engine/src/linter/safety.ts`)

When rules are loaded from JSON, each regex pattern is analyzed for structural indicators of super-linear behavior:
- Nested quantifiers (e.g., `(a+)+`, `(a*)*`)
- Large character classes with unbounded repetition adjacent to overlapping alternatives
- Backreference patterns known to cause exponential blowup

Patterns that fail static analysis are rejected immediately. The rule is marked invalid with a diagnostic message, and the linter refuses to execute it. This gives rule authors immediate feedback without consuming any runtime budget.

### Layer 2: Runtime Amortized Timeout (`engine/src/linter/executor.ts`)

During execution, the rule executor tracks elapsed time with an amortized deadline check every N lines (rather than per-regex-match, which would add unacceptable overhead). If the cumulative time exceeds the 50ms budget, execution halts and the linter returns a fail-closed timeout error identifying the offending rule.

The amortized approach balances safety with performance: checking `Date.now()` on every single regex match would add measurable overhead to the fast path, while checking every N lines keeps overhead negligible while bounding worst-case latency to N × (single-line worst case).

### Invariants
- A pattern rejected by static analysis never executes at runtime
- A pattern that passes static analysis but exhibits catastrophic behavior on specific input is caught by the runtime timeout
- No single failure in either layer can cause an indefinite hang — the layers are independent

## Consequences

**Positive:**
- The system cannot hang indefinitely regardless of regex pattern or input content
- Rule authors get immediate feedback on obviously unsafe patterns (load-time rejection) without waiting for a runtime failure
- Runtime cost of static analysis is zero — it runs once at load time, not on every edit
- The amortized timeout keeps fast-path overhead negligible (no per-match clock check)
- Defense-in-depth means a false negative in static analysis is caught at runtime, and a bug in the timeout logic is mitigated by static rejection

**Negative:**
- Some safe-but-complex patterns (e.g., patterns with nested quantifiers that are actually linear due to possessive/atomic semantics) may be rejected by static analysis — rule authors must simplify or restructure these patterns
- Runtime timeout granularity is per-N-lines (amortized), not per-line — a single catastrophic line could take up to N× expected time before detection, briefly exceeding the target latency
- The safety module requires ongoing maintenance as new ReDoS attack patterns are discovered in the wild
- Two layers means two sets of tests and two potential sources of false positives/negatives to reason about
