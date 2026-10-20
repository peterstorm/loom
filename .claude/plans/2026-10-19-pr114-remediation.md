# PR #114 remediation: the Claude adapter's invariants live in its types

- **Branch:** `fix/i6-claude-bash-exit` (base `main`). It fixes the defect the G4 slice 2 live pilot found: I6 could not be satisfied on Claude Code (`.claude/plans/2026-10-19-g4-slice-2-pilot.md`, issue #113).
- **Scope:** the PR's 14 files (`kind: all`), one registered review run.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261019-pr114`, result digest `71caa213f3349160aee661529a90c94c28ad0cd28f8c69a5dda34256d0dd5832`.
- **Counts (inspection renderer):** 0 critical and 6 advisory emitted and admitted. After refutation, 0 critical survive, 0 were refuted and 6 advisories remain. 7 slots were issued and 7 captured.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/disposition-20261019-pr114`, revision `initial`. `disposition.json` sha256 is `5dd4c7f13763dad6507832b59a086001f1819cfea391445e88021e74cfc536a2` (DECLARED).

## Surviving and refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| type-design-analyzer-1 | accepted | `claudeBashOutcome(result, input = {})` let a success be read without its tool input, which would drop the `run_in_background` check. The input now travels on the `succeeded` variant. The sub-point about a stray `error` field was already safe: a payload with no `tool_response` reads as an unknown exit. A test now pins that. |
| comment-analyzer-1 | accepted | "Neither harness hands over an exit code directly" contradicted the honoured explicit exit fields and Pi's `details.exitCode`. The header and the `docs/architecture.md` bullet now say "Claude Code's current Bash payloads carry no exit field", and both note the precedence. |
| comment-analyzer-2 | accepted | The file-tool test title implied that failed file tools are recorded. It is retitled to say the adapter reads a failure event for any tool, and that `hooks.json` wires the event for Bash only. |
| comment-analyzer-3 | accepted | The provenance claim is narrowed. Only `SUCCESS_SHAPE` and the `Exit code N` errors come from Claude Code 2.1.286; the other inputs are synthetic defensive shapes. |
| architecture-tech-lead-1 | accepted | The hook payload fields were declared twice and threaded field by field. `RecordEvidenceInput` now reuses `ClaudeToolPayload` (`Omit<ClaudeToolPayload, "tool_name" \| "cwd">`), and the handler passes the parsed record through with only the tool name and the cwd fallback. |
| architecture-tech-lead-2 | accepted | The adapter is total over a failure event for any tool, while the wiring records only Bash failures, because a failed file tool mints nothing. `claudeToolResult`'s doc says so, and so does the retitled test. |

## Validation

- `bun scripts/typecheck.ts` (engine): clean.
- Focused suites: claude-tool-response, the INV-4 matrix, hooks-sync, improvement-proof, post-tool-use and pi-ledger-capture. 11 files, 152 passed.
- `npm run verify` (root): exit 0, 542 files, 13,314 tests passed (1 skipped), all smoke suites
