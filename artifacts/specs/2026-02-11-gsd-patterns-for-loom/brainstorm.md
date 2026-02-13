# Brainstorm Summary

**Building:** Integrating GSD framework patterns into loom — enhanced brainstorm with parallel research + decision-locking, plan validation, deviation logging, and archive-on-complete.

**Approach:** Targeted GSD adoption — take 4 high-value patterns, merge discussion phase into brainstorm enhancement, add 3 parallel research agents, skip substance verification.

**Decisions (locked):**
- Discussion phase merged into brainstorm (not separate phase) — add decision-locking step to brainstorm template outputting locked/discretion/deferred buckets
- 3 parallel research agents: codebase explorer, external researcher (web search), risk/pitfall analyst
- Goal-backward verification skipped — reviewer + spec-check + test evidence sufficient
- Archive on complete: move specs and plans to .claude/archive/ on --complete
- advance-phase scoping bug already fixed (committed separately)

**Key Constraints:**
- Existing hook architecture preserved (TypeScript handlers, StateManager, chmod 444)
- Parallel research agents use existing Task tool spawning (single message, multiple calls)
- No new phases added to PHASE_ORDER — brainstorm enhanced in-place, plan validation as helper/hook
- Archive must handle both specs/ and plans/ directories

**In Scope:**
- Enhanced brainstorm template: 3 parallel research agents + decision-locking step
- Plan validation: new check between decompose and execute (requirement coverage, dependency correctness, task specificity)
- Deviation logging: new `deviations` field in task state, deviation rules in impl-agent-context.md template, parsed from transcripts via SubagentStop
- Archive on complete: --complete implementation moving artifacts to .claude/archive/

**Out of Scope:**
- Phase 1 quick wins (quick mode, atomic commit check, task specificity requirement)
- Phase 3 polish (checkpoints, metrics, model profiles)
- Goal-backward verification / anti-stub detection
- Separate discuss-agent / discuss phase
- 4-agent GSD-style research (using 3 instead)

**Open Questions:**
- Plan validation: PreToolUse hook before execute vs helper called by orchestrator after decompose?
- Deviation rules: exact patterns to scan for in impl agent transcripts?
- Research agent synthesis: orchestrator merges outputs or agents write to shared brainstorm dir?
- Archive directory structure: flat (.claude/archive/slug/) or nested?
