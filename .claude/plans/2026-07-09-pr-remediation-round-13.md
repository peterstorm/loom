# PR Remediation Plan — Round 13 (loom) / Round 12 (fugue)

**Date:** 2026-07-09
**Branches:** loom `feat/deterministic-core-phase-c`, fugue `feat/deterministic-core-phase-b`
**Findings:** 3 critical (1 loom code, 1 loom docs, 2 fugue — 1 bug/1 docs), plus targeted advisories

12-agent cross-repo review (6 per repo). Prior rounds' remediations verified intact; only
genuinely new or incompletely-fixed items are actioned here. Large structural refactors already
deferred by design (Task evidence union, `runUpdateTaskStatus` decomposition, fugue scaffold-writer
consolidation, `LlmRequest` sampling union, `validateFull → ParseResult`) remain deferred.

## Critical Fixes

### Fix 1: guard-state-file helper allow bypassed by command substitution + variable indirection (LOOM)
- **Source:** code-reviewer + silent-failure-hunter (both verified live against `guardStateFileDecision`)
- **File:** engine/src/core/guard-state-file.ts:82-114
- **Issue:** Round-12 segment-scoping only blocks a *single* non-helper segment carrying BOTH a
  state-file token and a write pattern. Two vectors still return `allow` and forge verdicts in
  `active_task_graph.json` / `review-invocations.json`:
  - Command substitution inside the helper segment:
    `bun cli.ts helper set-phase "$(sed -i s/trusted-fail/trusted-pass/ active_task_graph.json)"`
    (backtick form identical) — the segment is a helper invocation, so the write is never inspected.
  - Cross-segment variable indirection:
    `bun cli.ts helper set-phase && F=active_task_graph.json && sed -i s/x/y/ .claude/state/$F`
    — the state-file literal and the write live in different non-helper segments, so neither
    segment matches both patterns.
- **Fix:** In the helper-allow branch, a state-file write is vouched for ONLY when it is confined to
  the single helper segment (the legitimate `helper … > active_task_graph.json` redirect). Block when
  a write pattern appears in any NON-helper segment (covers co-located AND variable-indirected writes)
  OR when command substitution (`$(…)` / backticks) co-occurs with a state-file write (the substitution
  body executes independently and is opaque to segment splitting). Add regression tests for `$(…)`,
  backtick, and `F=…$F` indirection against both state files.

### Fix 2: Documented `failed`/auto-retry lifecycle does not exist in the engine (LOOM docs)
- **Source:** comment-analyzer
- **File:** README.md:508-509, commands/loom.md:343-371,514-518,530-538
- **Issue:** Docs describe `pending → failed (retry_count incremented)` and `failed → pending
  (auto-retry, max 2)`. No engine code sets `status:"failed"`, increments `retry_count`, or writes
  `failure_reason`; `update-task-status.ts:455-465` explicitly refuses to mark crashed tasks failed
  (it only clears `executing_tasks`). The retry jq queries can never match.
- **Fix:** Document the real crash behavior: agent crash → task stays `pending`, `executing_tasks`
  cleared, orchestrator re-spawns pending tasks. Remove the phantom `failed`/`retry_count` transitions.

### Fix 3: `team` YAML-safety comment certifies a property the brand does not provide (FUGUE bug)
- **Source:** comment-analyzer (also flagged by type review)
- **File:** packages/framework/src/cli/new-templates.ts:847,63-66,880-883
- **Issue:** Comment says kebab-constrained `team` is "always safe" as a plain YAML scalar, but `KEBAB`
  admits `true`/`false`/`null`/`0`/`1e5`/`0x1f`, which YAML 1.2 core-schema coerces to boolean/null/
  number. `fugueYaml` emits `team: ${ctx.team}` raw, so `fugue new true/my-dag` writes `team: true`
  (non-string) into `fugue.yaml`; the host reads `team?: string`.
- **Fix:** Route team through the existing `yamlScalar` guard (`team: ${yamlScalar(ctx.team)}`) so the
  quoting is structural, and correct the "always safe" claim.

### Fix 4: `ComposeOutcome` `gauntlet-failed` contract doc is stale (FUGUE docs)
- **Source:** comment-analyzer
- **File:** packages/framework/src/cli/compose.ts:149
- **Issue:** Doc defines `gauntlet-failed` as "the proving machinery itself threw", but since the
  round-11 short-circuit the arm is also produced by non-throwing `import-failed`/`analyzer-failed`
  verdict errors (`problems` then carries formatted verdict strings, not a stack).
- **Fix:** Rewrite the arm doc to cover both producers.

## Advisory Fixes

### Fix 5: WRITE_PATTERNS omits `ln`/`truncate`/`install` (LOOM)
- **File:** engine/src/config.ts:134 — add tokens; add guard test rows.

### Fix 6: parseEvent embeds raw `o.report` instead of the re-minted summary (LOOM)
- **File:** engine/src/machine/evidence.ts:280 — make the report guard a parser returning the minted
  `TestReportSummary` so unknown extra fields cannot ride inside the brand.

### Fix 7: fugue compose unrepairable-verdict denylist → allowlist (FUGUE)
- **File:** packages/framework/src/cli/compose.ts:527 — invert to a `REPAIRABLE_KINDS` allowlist so
  `describe-failed`/`no-default-export`/`missing-dag-field` (framework bugs) short-circuit instead of
  burning paid repair rounds.

### Fix 8: bin/fugue.ts typecheck gap (FUGUE)
- **File:** packages/framework/bin/fugue.ts:183 + tsconfig — pass an explicit `ReadlineLike` adapter so
  the compose wiring satisfies the declared seam, and add `bin/` to a typechecked tsconfig.

### Fix 9: Loom doc-drift cluster (LOOM docs)
- evidence.ts:387-388 + guard-state-file.ts:22-23 — "JSON map key" → recency-ordered `{id,startMs}` array.
- machines/README.md:98-99 — "every tool call" → "every Bash call".
- commands/loom.md:495 — lint-file.sh "programmatic linter" → immediate/regex tier.
- machines/README.md:33-36 — `helper-reported` attributed to transcript fallback → store-test-evidence helper.
- evidence.ts:88-89 — SESSION_SUFFIXES "multi-dot wins" ordering rationale not honored; correct it.
- ledger.ts:6-14 — per-session inventory omits `<session>.task_graph`.
- README.md:495 — Task fields list omits `file_list`.

### Fix 10: fugue doc-drift cluster (FUGUE docs)
- lint.ts:2 — "Pure function" header vs the file's own imperative-shell comment.
- new-templates.ts:3-4 — golden-example list omits `10-human-review.ts`.
- compose.ts:342-343 — SYSTEM_PROMPT avoid-list mixes hard-reserved and conditionally-colliding ids.

### Fix 11: Test hardening (LOOM)
- Hoist dynamic `await import("vitest")` to static imports (lock.test.ts:114,
  store-spec-check-findings.test.ts:195) — currently 2 false failures under `bun test --coverage`.
- Add malformed-stdin fail-closed tests for guard-state-file + block-direct-edits handlers.
- Add negative prose tests for the round-12 anchored pytest/bun matchers.

## Deferred (unchanged from prior rounds)
- Task paired evidence fields → union (persisted-schema change).
- `runUpdateTaskStatus` decomposition; parseTaskGraph write-side re-parse + `skipped_phases`/`spec_check.verdict` proof.
- pi extension roster via SessionRegistry port; pi call-start behavioral coverage.
- fugue scaffold-writer consolidation; `describeError`/`httpStatusToError` single-sourcing; `LlmRequest` sampling union + temperature range brand; authored-codegen inExpr typestate.

## Validation Commands
```bash
# loom
cd engine && bunx tsc --noEmit && bun test
# fugue
cd packages/framework && bunx tsc --noEmit && bun test
```
