# Feature: PostEdit Linter Hook Extension

**Spec ID:** 2026-05-18-linter-hook-extension
**Created:** 2026-05-18
**Status:** Draft
**Owner:** hansen142

## Summary

A platform-agnostic PostEdit linter that catches bad code patterns immediately after edits, blocking violations before they compound. A shared rule engine powers both Claude Code (PostToolUse hook) and Pi (extension event API) with identical behavior: declarative regex rules execute in < 50ms on every edit, while a wave-gate tier runs the full rule suite at phase boundaries.

---

## User Scenarios

### US1: [P1] Immediate Violation Blocking via Claude Code

**As a** developer using Claude Code with coding agents
**I want** bad patterns flagged and blocked immediately when an agent edits a file
**So that** agents fix violations at the point of introduction rather than accumulating technical debt

**Why P1:** Core value prop — without immediate blocking, violations propagate across edits and become exponentially harder to fix.

**Acceptance Scenarios:**
- Given a .ts file is edited and a regex rule matches a line, When the PostToolUse hook fires, Then the edit is blocked with a structured violation message containing rule name, file, line number, violation text, and fix hint
- Given multiple violations in a single edit, When the hook fires, Then all violations are batched into a single structured message
- Given an edit to a file type with no matching rules, When the hook fires, Then the edit passes silently with no output
- Given a binary file is edited, When the hook fires, Then the file is skipped entirely (pass)
- Given the rule engine crashes, When the hook fires, Then the edit is blocked (fail-closed) with an error message indicating engine failure

### US2: [P1] Shared Rule Engine with Declarative Regex Rules

**As a** rule author
**I want** to define lint rules as declarative regex patterns scoped by file extension
**So that** I can enforce coding standards without writing procedural code

**Why P1:** Foundation for all other scenarios — nothing works without the engine.

**Acceptance Scenarios:**
- Given a rule defined with a regex pattern and file-extension scope, When a matching file is linted, Then lines matching the regex produce violations
- Given multiple rules matching the same file extension, When the file is linted, Then all matching rules are evaluated and all violations reported
- Given a rule targets .ts files and a .java file is edited, When the engine runs, Then that rule is not evaluated
- Given loom ships default rules and a project provides local rules, When both exist, Then project-local rules extend the defaults
- Given a project-local rule sets "enabled": false for a default rule, When that rule would fire, Then it is skipped

### US3: [P1] Structured JSON Violation Output

**As a** consuming platform (Claude Code or Pi)
**I want** violations returned as structured JSON
**So that** they can be parsed, displayed, and acted upon programmatically

**Why P1:** Both platforms need machine-readable output to present errors and drive fix-agent workflows.

**Acceptance Scenarios:**
- Given one or more violations, When results are returned, Then output is a single JSON object with an array of violation entries
- Given a violation, Then each entry includes: rule name, file path, line number, violation text, and fix hint
- Given zero violations, When results are returned, Then output is a JSON object indicating success (no violations array or empty array)

### US4: [P1] File-Extension Scoping

**As a** rule author
**I want** rules scoped to specific file extensions
**So that** language-specific patterns only fire on relevant files

**Why P1:** Without scoping, regex rules produce false positives on unrelated file types.

**Acceptance Scenarios:**
- Given a rule scoped to .ts,.tsx, When a .java file is linted, Then the rule does not execute
- Given a rule scoped to .java, When a .java file is linted, Then the rule executes
- Given a file with no extension, When linted, Then only rules with no extension filter (if any) apply

### US5: [P2] Programmatic TypeScript Function Rules

**As a** rule author with complex validation needs
**I want** to define rules as TypeScript functions that receive file content
**So that** I can express patterns that go beyond simple regex matching

**Why P2:** Significant value for complex rules, but regex covers the common case.

**Acceptance Scenarios:**
- Given a rule defined as a TypeScript function, When a matching file is linted, Then the function receives the file content and returns violations in the same structured format
- Given a programmatic rule throws an exception, When evaluated, Then the edit is blocked (fail-closed) with an error identifying the failing rule

### US6: [P2] Pi Extension Adapter

**As a** developer using Pi with wave-based agents
**I want** the same rule engine available as a Pi extension
**So that** violations are caught in the Pi workflow with identical behavior

**Why P2:** Platform parity — Pi is the second platform, but Claude Code is primary.

**Acceptance Scenarios:**
- Given an agent edits a file in Pi, When the extension fires, Then the shared rule engine evaluates the file and returns structured violations
- Given violations are found at wave gate, When the gate fires, Then fix agents are spawned and the gate re-runs after fixes
- The Pi adapter uses the `tool_result` event for edit/write tools, injecting violation messages with `isError: true` into the result so the agent sees and fixes violations immediately

### US7: [P2] Two-Tier Execution Model

**As a** workflow orchestrator
**I want** fast regex rules in the immediate tier and the full rule suite (including programmatic rules) at wave-gate boundaries
**So that** per-edit latency stays minimal while comprehensive checks run at natural pause points

**Why P2:** Architectural enabler for P2 programmatic rules without sacrificing P1 latency.

**Acceptance Scenarios:**
- Given an edit triggers the immediate tier, When only declarative regex rules are evaluated, Then execution completes in < 50ms
- Given a wave boundary triggers the gate tier, When all rules (declarative + programmatic) are evaluated, Then execution completes in < 2s
- Given the wave gate finds violations, When violations are reported, Then fix agents are spawned and the gate re-runs

### US8: [P3] Dry-Run Mode for Rule Development

**As a** rule author developing new rules
**I want** a dry-run mode that shows what would be flagged without blocking
**So that** I can iterate on rule accuracy before enabling enforcement

**Why P3:** Developer experience improvement, not required for core value.

**Acceptance Scenarios:**
- Given dry-run mode is active, When violations are found, Then they are reported but the edit is NOT blocked
- Given dry-run mode is active, Then the output is clearly marked as dry-run

---

## Functional Requirements

### Core Rule Engine

- FR-001: System MUST provide a shared rule engine that loads, matches, executes, and formats rule violations
- FR-002: System MUST support declarative rules defined as regex patterns with file-extension scoping
- FR-003: System MUST match rules to files by file extension before evaluation
- FR-004: System MUST return violations as structured JSON containing: rule name, file path, line number, violation text, fix hint
- FR-005: System MUST batch all violations from a single file into one response message
- FR-006: System MUST block the edit on any violation (always-block semantics, no warnings)
- FR-007: System MUST fail closed — if the engine itself crashes, the edit is blocked
- FR-008: System MUST pass silently when no rules match the edited file's extension
- FR-009: System MUST skip binary files entirely (pass without evaluation)
- FR-010: System MUST operate statelessly — each invocation evaluates from scratch with no persistence
- FR-011: System MUST have zero external npm dependencies

### Rule Authoring & Precedence

- FR-012: System MUST ship default rules bundled with loom
- FR-013: System MUST allow projects to define local rules that extend the defaults
- FR-014: System MUST allow project-local rules to disable default rules via explicit "enabled": false
- FR-015: System SHOULD define the rule interface to accommodate future command-based rules without implementing them now (extension point)
- FR-016: System SHOULD support programmatic rules as TypeScript functions receiving file content (P2)

### Platform Adapters

- FR-017: System MUST provide a Claude Code adapter that integrates via PostToolUse hook (shell shim invoking the engine via bun CLI)
- FR-018: System SHOULD provide a Pi extension adapter that integrates via Pi's event API (P2)

### Execution Tiers

- FR-019: System MUST execute declarative regex rules in the immediate (per-edit) tier
- FR-020: System SHOULD execute all rules (declarative + programmatic) at wave-gate boundaries (P2)

---

## Non-Functional Requirements

### Performance

- NFR-001: Immediate tier (PostEdit) MUST complete in < 50ms (p95) for a single file
- NFR-002: Wave-gate tier MUST complete in < 2s (p95) for a single file with full rule suite
- NFR-003: System MUST handle files > 1MB without skipping (run anyway)

### Reliability

- NFR-004: System MUST fail closed on all error paths (engine crash, rule crash, unexpected state)
- NFR-005: System MUST produce valid JSON output on all paths including error paths

### Portability

- NFR-006: Rule engine core MUST be platform-agnostic (no Claude Code or Pi specific code in the engine)
- NFR-007: System MUST run wherever bun is available (bun is always present in target environments)

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: Immediate tier evaluates 10 declarative regex rules against a 500-line TypeScript file in < 50ms (p95), measured over 100 consecutive runs
- SC-002: Zero violations are missed when a rule's regex matches a line in the target file (100% recall for regex rules)
- SC-003: Zero false positives from file-extension mismatch (rules never fire on wrong file types)
- SC-004: Engine crash on any code path results in a blocked edit 100% of the time (fail-closed verified by fault injection test)
- SC-005: Violation JSON output is parseable by both Claude Code and Pi consumers without transformation (validated by schema conformance test)
- SC-006: Project-local rule overrides disable default rules with zero leakage (disabled rule never produces a violation)
- SC-007: Binary file detection correctly skips binary files 100% of the time (no false evaluation attempts)

**Measurement approach:** Automated tests — unit tests for engine correctness, benchmark tests for latency, integration tests for platform adapter behavior, fault injection tests for fail-closed guarantee.

---

## Out of Scope

Explicitly NOT part of this feature:

- **Multi-file / project-wide analysis** — each invocation scopes to a single edited file
- **AST parsing** — rules operate on raw text content only (regex or string-based functions)
- **Auto-fix / code modification** — the engine reports violations; the agent performs fixes
- **Rule severity levels** — all violations block equally (no warn/error distinction)
- **Integration with external linters** (ESLint, Checkstyle, etc.) — this is a standalone engine
- **UI or dashboard for rule management** — rules are files in a directory
- **CI/CD integration** — this runs in the editor/agent loop only
- **Command-based rules** — interface accommodates future addition but no implementation now (P3 extension point)
- **Hot-reload or file-watching** — bun's import model handles freshness naturally
- **Rule analytics or violation history** — stateless, no persistence

---

## Open Questions

None remaining. All clarifications resolved.

### Resolved

1. **Pi extension event API shape** — Resolved 2026-05-18: Pi adapter uses `pi.on("tool_result", handler)` for edit/write tools. After the edit lands on disk, the handler reads the file, runs lint rules, and if violations exist, returns `{ content: [violation message], isError: true }` so the LLM sees the error and fixes immediately. The file is temporarily in a violated state until the agent's next edit — this is acceptable.

---

## Dependencies

External factors this feature depends on:

- **Bun runtime** — always available in target environments; used as the execution engine
- **Claude Code hooks.json** — PostToolUse hook mechanism must support shell shim invocation
- **Pi extension event API** — needed for P2 Pi adapter (exact shape TBD)

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Regex rules produce false positives on unusual code patterns | Med | Provide clear rule-disable mechanism; keep rules focused and well-scoped |
| 50ms latency budget too tight for large rule sets | Med | Limit immediate tier to declarative rules only; defer complex rules to wave gate |
| Fail-closed semantics block developer productivity on engine bugs | High | Prioritize engine reliability; provide clear error messages identifying the issue |
| Rule precedence conflicts between default and project-local rules | Low | Simple model: local extends defaults, explicit disable overrides |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Immediate tier | The per-edit execution path — fires on every file save/edit, must be < 50ms |
| Wave gate | The phase-boundary execution path — fires when agents complete a wave, can run full suite |
| Declarative rule | A rule defined as a JSON object with regex pattern and file-extension scope |
| Programmatic rule | A rule defined as a TypeScript function receiving file content (P2) |
| Command-based rule | A future rule type that invokes an external command (P3, interface only) |
| Fail-closed | On any error, treat as violation (block the edit) rather than silently passing |
| Shell shim | Thin script that Claude Code's PostToolUse hook invokes, which calls bun with the engine CLI |
| Rule scoping | Matching rules to files by file extension before evaluation |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-18 | Initial draft from brainstorm + interview | specify-agent |
| 2026-05-18 | Resolved Pi extension event API clarification — uses tool_result event with isError injection | clarify-agent |
