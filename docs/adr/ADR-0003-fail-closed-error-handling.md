# ADR-0003: Fail-Closed Error Handling

## Status
Accepted

## Context
The linter runs as a PostToolUse hook that gates file edits in both Claude Code and Pi. When the linter engine encounters an unexpected error — a malformed rule file, an uncaught exception in the regex executor, or any other fault — the system must decide what to do with the pending edit.

There are two fundamental postures: **fail-open** (allow the edit and hope it's fine) or **fail-closed** (block the edit and surface the error). This is a classic security/reliability tradeoff. A wrong answer in one direction silently accumulates technical debt; a wrong answer in the other direction blocks developer flow.

The stakes are asymmetric. A blocked valid edit is immediately visible: the developer sees an error message, understands why the edit was blocked, and can fix the issue or disable the rule within seconds. A passed violation is invisible — it slips into the codebase unnoticed and may not be caught until much later, compounding with other violations over time.

## Options Considered

1. **Fail-open (allow edits on error)**
   - Pros: Never interrupts developer flow; engine bugs are invisible to users; no false-positive blocking
   - Cons: Violates security principle of denying access when uncertain; violations slip through on any engine bug; accumulated violations are invisible and costly to find later; undermines the entire purpose of having a linter gate

2. **Fail-closed (block edits on error)**
   - Pros: Guarantees no violation passes silently; security-principle aligned (deny when uncertain); errors are immediately visible and actionable; forces high reliability standards on the engine itself
   - Cons: Engine bugs block ALL edits until fixed (high severity); overly strict rules or misconfigurations cause friction; demands thorough testing and fault injection

3. **Configurable (let users choose fail-open or fail-closed)**
   - Pros: Flexibility for different risk tolerances; teams can choose their own tradeoff
   - Cons: Adds configuration complexity; users might set fail-open "temporarily" and forget to revert; split behavior makes reasoning about guarantees harder; undermines the value proposition of the linter as a reliable gate

4. **Hybrid (fail-open for engine errors, fail-closed for detected violations)**
   - Pros: Only blocks when the linter positively identifies a problem; engine crashes don't interrupt flow
   - Cons: Confusing semantics — an engine error might mask a violation that would have been caught; creates a perverse incentive to not fix engine bugs (they "silently pass"); impossible to distinguish "no violations found" from "couldn't check"

## Decision
**All error paths in the linter system result in blocked edits (fail-closed); never silent passes (fail-open).**

Implementation details:

- **Orchestration layer:** `lintFile` wraps its entire body in a try/catch. Any exception produces a `lintErrorResult(message)` with `kind: "error"` rather than `kind: "pass"` or `kind: "violations"`.
- **Handler mapping:** The Claude Code PostToolUse handler maps `kind: "error"` → `{ kind: "block" }`. The Pi extension adapter maps `kind: "error"` → `{ isError: true }` to signal failure. There is no code path where an error result produces a pass response.
- **Error messages:** When an edit is blocked due to an engine error (as opposed to a lint violation), the block message clearly states this is an internal error, not a code quality issue, so the developer knows to investigate the linter configuration rather than the edit content.
- **Rule loading errors:** Invalid rule configurations (malformed JSON, unsafe regex patterns) produce error results at load time, blocking edits with messages that explain which rule file is misconfigured and how to fix it.

Key invariant: **No code path through `lintFile` can return a "pass" result without having successfully executed all applicable rules to completion.**

## Consequences

**Positive:**
- Zero silent violation pass-through — the fundamental guarantee users expect from a lint gate
- Engine bugs surface immediately rather than hiding as invisible quality degradation
- Aligns with security best practice (deny by default)
- A blocked valid edit is recoverable in seconds (fix the rule, fix the config, or disable the rule)
- Forces the engine to be highly reliable, improving overall code quality of the linter itself
- Clear mental model: if the linter didn't explicitly pass the edit, the edit is blocked

**Negative:**
- Engine bugs have high blast radius — a single crash blocks ALL edits across all files until fixed
- Invalid rule configurations (e.g., a user adding a malformed project-local rule) block all edits matching that rule's extensions
- Testing burden is higher: must include fault injection to verify fail-closed behavior on every code path
- The linter must maintain very high reliability standards — any crash is directly user-facing friction
- During development/iteration on rules, misconfigurations cause immediate blocking rather than graceful degradation
