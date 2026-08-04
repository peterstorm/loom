# PR Remediation — Standalone Review Round 16

- **Branch:** `feat/architecture-panel-mode-plan`
- **Scope:** the exact 196-path `scope` in `.claude/reviews/review-and-fix-runs/run.EGZG4QZ1XH/result.json`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.EGZG4QZ1XH`
- **Adjudication:** 5 critical findings survived the 3-lens panel (threshold 2); 0 critical findings were refuted. All 7 advisories are accepted because each is actionable and in scope; the two test-harness advisories were reproduced under `bun test`.

## Surviving Critical Fixes

### 1. Gate implementation/proof readiness before completing a wave

- **Source:** `code-reviewer-1` · `code-reviewer` · `engine/src/handlers/helpers/complete-wave-gate.ts:283`
- **Claim:** complete-wave-gate can complete a task whose proof is failed, producing state that parseTaskGraph rejects.
- **Fix:** add a pure gate check requiring every wave task to be `implemented` with a satisfied proof before any completion transform; add regression coverage for pending/failed-proof tasks and preserve idempotent passing behavior.
- **Validation:** `cd engine && bunx vitest run tests/handlers/complete-wave-gate.test.ts tests/state-manager.test.ts`

### 2. Parse Pi test commands and prove exit ownership

- **Source:** `code-reviewer-2` · `code-reviewer` · `pi/extension.ts:77`
- **Claim:** Pi accepts substring-matched Bash output as structured test proof, so a print-only command can satisfy regression testing.
- **Fix:** replace substring detection with the shared quote-aware `classifyTestCommandDetailed` parser and `attributeExit`; accept only paired tool results whose test segment owns the Bash result, and add spoofing/composition regression tests.
- **Validation:** `cd engine && bunx vitest run tests/pi-test-evidence.test.ts tests/machine/extract-evidence.test.ts`

### 3. Prove declared artifacts changed from a start snapshot

- **Source:** `code-reviewer-3` · `code-reviewer` · `engine/src/core/proof-obligations.ts:267`
- **Claim:** declared-artifact obligations are satisfied by attempted Write/Edit calls even when no file changed.
- **Fix:** capture an immutable digest/missing-state baseline for each declared artifact when task execution starts; at Stop, compare current artifact state to that baseline and feed only actually changed artifacts into proof evaluation while retaining transcript paths solely as lint targeting evidence. Fail closed when no baseline proves a change. Cover failed/no-op attempts, creation, modification, deletion, and state-boundary parsing.
- **Validation:** `cd engine && bunx vitest run tests/core/artifact-baseline.test.ts tests/handlers/pi-stop-toctou.test.ts tests/handlers/update-task-status.test.ts tests/state-manager.test.ts`

### 4. Fail closed when panel item directories cannot be listed

- **Source:** `silent-failure-hunter-1` · `silent-failure-hunter` · `engine/src/handlers/helpers/panel-run.ts:221`
- **Claim:** surplusItemErrors treats any readdirSync failure as an empty item directory, allowing unreadable item directories to hide surplus panel artifacts.
- **Fix:** tolerate only `ENOENT`; emit a concrete contract error for all other listing failures. Add an unreadable-directory regression test alongside the existing exact-set checks.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/panel-contract.test.ts tests/handlers/helpers/review-panel.test.ts`

### 5. Preserve marker claim identity by severity

- **Source:** `silent-failure-hunter-2` · `silent-failure-hunter` · `engine/src/core/review-output.ts:368`
- **Claim:** chooseSource consumes marker claims by claim text across severities, allowing a structured advisory entry to consume and drop an unstructured critical marker claim with the same text.
- **Fix:** carry over unconsumed marker claims with separate critical/advisory multisets after severity alignment; add the exact same-text cross-severity/other-critical regression.
- **Validation:** `cd engine && bunx vitest run tests/core/review-output.test.ts tests/core/round15.test.ts`

## Accepted Advisories

### 6. Behaviorally test Pi `agentScope` enforcement

- **Source:** `pr-test-analyzer-1` · `pr-test-analyzer` · `pi/extension.ts:170`
- **Fix:** drive the registered Pi `tool_call` handler and assert a Loom subagent request with non-`user` scope is blocked; replace the integration test's Bun-incompatible module reset/import APIs with a cache-isolated dynamic import.
- **Validation:** `bun test engine/tests/pi-extension-review-events.test.ts`

### 7. Test malformed standalone scope entries

- **Source:** `pr-test-analyzer-2` · `pr-test-analyzer` · `engine/src/core/standalone-review.ts:61`
- **Fix:** add table-driven negative tests for absolute, traversal, newline, and NUL scope paths.
- **Validation:** `cd engine && bunx vitest run tests/core/standalone-review.test.ts`

### 8. Preserve the Loom agent-name literal union

- **Source:** `type-design-analyzer-1` · `type-design-analyzer` · `engine/src/core/model-profiles.ts:122`
- **Fix:** define the frozen policy catalog with `as const satisfies readonly AgentPolicy[]` so `LoomAgentName` is the closed literal union; add a compile-time exhaustiveness assertion where practical.
- **Validation:** `cd engine && bun run typecheck && bunx vitest run tests/core/model-profiles.test.ts`

### 9. Restrict candidate filename construction to panel lenses

- **Source:** `type-design-analyzer-2` · `type-design-analyzer` · `engine/src/core/panel-contract.ts:263`
- **Fix:** accept `PanelLens`, not arbitrary `string`, at the only branded constructor and update invalid test fixtures to real panel-lens IDs.
- **Validation:** `cd engine && bun run typecheck && bunx vitest run tests/core/panel-contract.test.ts tests/panel-templates.test.ts`

### 10. Correct panel-count documentation

- **Source:** `comment-analyzer-1` · `comment-analyzer` · `commands/loom.md:65`
- **Fix:** change all in-scope claims that values above 5 are capped/clamped to the implemented behavior: values outside `[PANEL_DESIGNERS_MIN, PANEL_LENS_COUNT]` are rejected.
- **Validation:** `cd engine && bunx vitest run tests/panel-config.test.ts tests/runbook-contract.test.ts`

### 11. Make the Pi extension integration test executable under Bun

- **Source:** `architecture-tech-lead-1` · `architecture-tech-lead` · `engine/tests/pi-extension-review-events.test.ts:88`
- **Fix:** use cache-isolated dynamic ESM import rather than Vitest-only `vi.resetModules`/`vi.importActual`, retaining real extension registration behavior.
- **Validation:** `bun test engine/tests/pi-extension-review-events.test.ts`

### 12. Resolve the Pi resource module from the test module

- **Source:** `architecture-tech-lead-2` · `architecture-tech-lead` · `engine/tests/pi-resources.test.ts:116`
- **Fix:** derive `pi/resources.ts` from `import.meta.url`, not ambient `process.cwd()`.
- **Validation:** `bun test engine/tests/pi-resources.test.ts`

## Refuted Findings (not fixing)

None. The authoritative `result.json.refuted_critical_findings` array is empty.

## Project Validation

1. `cd engine && bun run typecheck`
2. `cd engine && bun run test:unit`
3. `cd engine && bun run test:smoke`
4. `bun test engine/tests/pi-extension-review-events.test.ts engine/tests/pi-resources.test.ts`
