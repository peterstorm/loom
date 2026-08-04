# PR Remediation — Standalone Review run.luCY2HUJ8Z

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.luCY2HUJ8Z`
- **Exact scope:** the immutable 205-path `scope` array in `.claude/reviews/review-and-fix-runs/run.luCY2HUJ8Z/result.json` (identical to `session.json.scope` and `review-plan.json.scope`)
- **Diff reviewed:** 32,615 insertions, 2,267 deletions across TypeScript, shell, Markdown, and JSON
- **Adjudication:** 8 critical findings survived; 0 were refuted; all 10 advisories are accepted for this remediation.

## Surviving critical fixes

### C1 — Restore Loom-owned Pi spawn preflight

**Sources**

- `code-reviewer-1` — code-reviewer — `pi/extension.ts:164` — Every Loom-owned Pi subagent spawn is blocked because the parsed item array is iterated through `.value` at lines 164 and 219.
- `silent-failure-hunter-1` — silent-failure-hunter — `pi/extension.ts:164` — The same array/PolicyResult shape confusion throws before validation and tracking.
- `type-design-analyzer-1` — type-design-analyzer — `pi/extension.ts:164` — Every user-scoped Loom-owned Pi call throws before model, skill, phase, and task validation.
- `architecture-tech-lead-1` — architecture-tech-lead — `pi/extension.ts:164` — The Pi shell treats the parsed array as a PolicyResult and blocks every spawn.

**Fix:** Iterate `parsedItems` directly in both validation and lifecycle-registration loops. Add a real Pi extension `tool_call` regression covering a valid `agentScope: "user"` Loom-owned spawn and its active roster registration.

**Validation:**

```bash
cd engine && bunx vitest run tests/pi-extension-review-events.test.ts
```

### C2 — Fail closed when lifecycle tracking cannot be recorded

**Source:** `silent-failure-hunter-2` — silent-failure-hunter — `pi/extension.ts:232` — Tracking write failures are logged while the Loom-owned spawn is still allowed without lifecycle/session evidence.

**Fix:** Convert unsafe session ids and tracking write errors into explicit blocking `tool_call` results after validation, rather than logging and continuing. Preserve the diagnostic cause. Add a regression that forces the tracking boundary to fail and proves the spawn is blocked.

**Validation:**

```bash
cd engine && bunx vitest run tests/pi-extension-review-events.test.ts
```

### C3 — Make graphless Loom completion loss operator-visible

**Source:** `silent-failure-hunter-3` — silent-failure-hunter — `pi/extension.ts:408` — A null `StateManager.fromSession` silently discards Loom-owned completion results.

**Fix:** Classify Loom-owned result agents before the graphless branch and emit a precise stderr diagnostic naming the agent and session when no orchestration state can be updated. Keep external graphless subagents as pass-through.

**Validation:**

```bash
cd engine && bunx vitest run tests/pi-extension-review-events.test.ts
```

### C4 — Pin backgrounded-report suppression

**Source:** `pr-test-analyzer-1` — pr-test-analyzer — `engine/src/machine/extract-evidence.ts:628` — Existing background-command tests only prove exit attribution and would not detect a regression that retained a parsed green report.

**Fix:** Add a behavioral test whose report callback returns a green report and prove backgrounded test commands mint `report: null`, while foreground test commands retain the report.

**Validation:**

```bash
cd engine && bunx vitest run tests/machine/extract-evidence.test.ts
```

### C5 — Clarify mandatory advisory triage versus gate polarity

**Source:** `comment-analyzer-1` — comment-analyzer — `commands/wave-gate.md:244` — The documentation calls advisory triage MUST-level although the completion helper does not block on advisory findings.

**Fix:** State explicitly that classification/reporting of every advisory is a mandatory workflow step, but an advisory is non-blocking and the deterministic completion helper gates only unresolved critical findings.

**Validation:**

```bash
cd engine && bunx vitest run tests/runbook-contract.test.ts tests/prose-contract-round14.test.ts
```

## Accepted advisory fixes

### A1 — Preserve model-binding read causes

**Source:** `silent-failure-hunter-4` — silent-failure-hunter — `engine/src/handlers/helpers/validate-task-graph.ts:452` — The production dependency collapses every plan/rule read error to `null`.

**Fix:** Preserve and report the concrete filesystem cause at the model-binding boundary without making the pure validator perform I/O.

**Validation:** `cd engine && bunx vitest run tests/handlers/validate-model-bindings.test.ts tests/handlers/validate-task-graph.test.ts`

### A2 — Pin standalone tally immutability

**Source:** `pr-test-analyzer-2` — pr-test-analyzer — `engine/src/handlers/helpers/review-panel.ts:429` — No test re-runs tally after standalone `result.json`/`outcomes.json` publication.

**Fix:** Add an end-to-end helper test proving a second tally fails and leaves both published artifacts byte-for-byte unchanged.

**Validation:** `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts`

### A3 — Pin spec-check transcript fallback

**Source:** `pr-test-analyzer-3` — pr-test-analyzer — `engine/src/handlers/subagent-stop/store-spec-check-findings.ts:97` — No handler test omits `agent_transcript_path` and exercises derived transcript resolution.

**Fix:** Add a real filesystem/session regression with the payload path omitted and verify the derived transcript is consumed rather than producing `EVIDENCE_CAPTURE_FAILED`.

**Validation:** `cd engine && bunx vitest run tests/handlers/store-spec-check-findings.test.ts`

### A4 — Complete the Task load-boundary parser

**Source:** `type-design-analyzer-2` — type-design-analyzer — `engine/src/state-manager.ts:132` — `parseTaskGraph` accepts non-string `description` or `agent` while asserting `TaskGraph`.

**Fix:** Extend `taskUnionError` to prove required task strings and integer-positive waves before the cast; add parser regressions.

**Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/validate-task-graph.test.ts`

### A5 — Remove validator/loader state-file drift

**Sources**

- `type-design-analyzer-3` — type-design-analyzer — `engine/src/handlers/helpers/validate-task-graph.ts:179` — State-file validation skips `taskUnionError` when status is absent.
- `architecture-tech-lead-2` — architecture-tech-lead — same location and invariant.

**Fix:** Run the authoritative task parser unconditionally for `state-file` scope while retaining decompose-payload leniency. Add lockstep tests for missing status and dependencies.

**Validation:** `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts tests/state-manager.test.ts`

### A6 — Parse decompose `file_list` before proof derivation

**Source:** `type-design-analyzer-4` — type-design-analyzer — `engine/src/handlers/helpers/populate-task-graph.ts:76` — Agent-controlled `file_list` can reach proof derivation without being proven a string array.

**Fix:** Make decompose-payload validation prove `file_list` is an array of non-empty strings before sanitization/proof construction. Add handler/validator regressions.

**Validation:** `cd engine && bunx vitest run tests/handlers/populate-task-graph.test.ts tests/handlers/validate-task-graph.test.ts`

### A7 — Correct review arbitration wording

**Source:** `comment-analyzer-2` — comment-analyzer — `commands/review-pr.md:220` — “Counts, not claim text” overstates the implementation because claim values still drive reconciliation and carry-over.

**Fix:** Explain that counts choose the primary source while claim values reconcile both sources and preserve disjoint claims.

**Validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts tests/review-agent-contract.test.ts`

### A8 — Correct finding identity/location wording

**Source:** `comment-analyzer-3` — comment-analyzer — `agents/comment-analyzer.md:117` — The prose says the optional fenced block gives stable identity and is required for panel adjudication.

**Fix:** State that the engine derives identity from agent/emission order; the block supplies preferred location metadata, and null locations remain adjudicable. Update duplicate contract wording where required by contract tests.

**Validation:** `cd engine && bunx vitest run tests/review-agent-contract.test.ts tests/review-panel-templates.test.ts`

### A9 — Accept null-location findings in standalone aggregation

**Source:** `architecture-tech-lead-3` — architecture-tech-lead — `engine/src/core/standalone-review.ts:84` — Standalone aggregation rejects null locations although reviewer and panel contracts allow them.

**Fix:** Enforce frozen scope only when a finding carries a file; preserve null-location findings and test initial aggregation plus stored aggregate parsing.

**Validation:** `cd engine && bunx vitest run tests/core/standalone-review.test.ts tests/handlers/helpers/standalone-review.test.ts`

## Refuted Findings (not fixing)

`result.json.refuted_critical_findings` is empty. The three-lens panel published no threshold-level refutations, so there are no refuted findings or hidden refutation evidence to omit.

## Full validation

```bash
cd engine && npm run typecheck
cd engine && npm test
```

The audited remediation path set begins with every path in `result.json.scope`; newly created regression/support files and this plan are added explicitly before staging. Run evidence under `.claude/reviews/review-and-fix-runs/` is never staged.
