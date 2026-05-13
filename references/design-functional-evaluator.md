# Functional Evaluator — Universal Build-and-Run Verification

> Design doc — not yet implemented. Inspired by [Anthropic's harness design article](https://www.anthropic.com/engineering/harness-design-long-running-apps).

## Problem

Loom's current evaluators all operate by **reading code**:
- `spec-check` verifies FR alignment by reading source files
- `code-reviewer` checks quality/patterns by reading source files
- `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer` — all static

None of them answer: **"does the built artifact actually work?"**

You can pass every static reviewer and still have broken functionality — wrong API endpoint wiring, a state machine that deadlocks, stubbed-out methods that compile but do nothing. The article specifically calls out catching "stubbed-out functionality" via live testing.

## Core idea

Add a functional evaluator that **builds the project and exercises its behavior** against the spec's acceptance scenarios. Universality comes from the LLM's ability to adapt to any project type — not from hardcoded project-type logic.

## Architecture: Mirror the spec-check pattern

The functional evaluator follows the same per-wave, own-state, own-gate-check pattern as `spec-check-invoker`. This is the cleanest fit because:
- Functional tests often span multiple tasks (T1 creates model, T2 creates endpoint — you test via the endpoint)
- Building the project should happen once per wave, not once per task
- The infrastructure already has this exact pattern proven

```
                     wave-gate skill
                          |
         +----------------+-----------------+
         |                |                 |
   spec-check       functional-check    review agents
   (per-wave)        (per-wave)         (per-task × 5)
         |                |                 |
   store-spec-check  store-functional-  store-reviewer-
   -findings.ts      check-findings.ts  findings.ts
         |                |                 |
         +-------+--------+--------+-------+
                 |                  |
           complete-wave-gate (6 checks now)
```

## Changes required

### 1. New type: `FunctionalCheck` — `engine/src/types.ts`

```typescript
export interface FunctionalCheck {
  wave: number;
  run_at: string;
  critical_count?: number;
  critical_findings?: string[];
  advisory_findings?: string[];
  verdict: string;  // "PASSED" | "BLOCKED" | "SKIPPED" | "EVIDENCE_CAPTURE_FAILED"
  error?: string;
  build_output?: string;  // truncated build log on failure
}
```

Add `functional_check?: FunctionalCheck` to `TaskGraph`.

### 2. New agent: `agents/functional-evaluator.md`

```yaml
---
name: functional-evaluator
model: sonnet
tools:
  - Bash
  - Read
  - Grep
  - Glob
skills:
  - functional-check
---
```

Key agent instructions:
- Read CLAUDE.md / package.json / pom.xml / Cargo.toml / Makefile to figure out build/run commands
- Build the project first (build failure = CRITICAL)
- For each acceptance scenario: write and execute a verification via Bash
- For APIs: start server in background, curl endpoints, kill server
- For CLIs: run with test inputs, check output
- For libraries: `node -e` / `bun -e` / `python -c` inline scripts that import and call
- For services: start, exercise, stop
- If project type is unrecognizable or not runnable: emit `FUNCTIONAL_CHECK_VERDICT: SKIPPED`

### 3. New skill: `commands/functional-check.md`

Structured 5-step process (mirrors spec-check's determinism):

1. **Load artifacts** — spec, wave tasks, acceptance scenarios (Given/When/Then)
2. **Detect project** — read CLAUDE.md for build/run commands; fall back to detecting package.json/pom.xml/Cargo.toml/Makefile
3. **Build** — run build command. If fails: CRITICAL finding, skip remaining steps
4. **Verify scenarios** — for each acceptance scenario in scope for this wave:
   - Translate to executable verification (the LLM figures out *how* based on project type)
   - Execute via Bash
   - Emit per-scenario verdict: `PASS` / `FAIL — <reason>`
5. **Report** — machine-readable footer:
   ```
   FUNCTIONAL_CHECK_WAVE: N
   CRITICAL: Build failed — exit code 1, missing dependency X
   CRITICAL: POST /api/users returns 500, expected 201
   ADVISORY: GET /api/health responds in 3.2s (may indicate perf issue)
   FUNCTIONAL_CHECK_CRITICAL_COUNT: 2
   FUNCTIONAL_CHECK_VERDICT: BLOCKED
   ```

### 4. New dispatch category — `engine/src/handlers/subagent-stop/dispatch.ts`

Add `"functional-check"` to `AgentCategory` union:

```typescript
type AgentCategory = "phase" | "impl" | "review" | "spec-check" | "functional-check" | "unknown";
```

In `categorize()`:
```typescript
if (agentType === "functional-evaluator") return "functional-check";
```

In the `match()`: route to `storeFunctionalCheckFindings`.

### 5. New SubagentStop handler: `engine/src/handlers/subagent-stop/store-functional-check-findings.ts`

Near-copy of `store-spec-check-findings.ts` but parsing `FUNCTIONAL_CHECK_*` markers instead of `SPEC_CHECK_*`. Stores into `state.functional_check`.

Special handling for `SKIPPED` verdict: treat as non-blocking (don't set `wave_gates[wave].blocked = true`).

### 6. New gate check — `engine/src/handlers/helpers/complete-wave-gate.ts`

Add `checkFunctionalCheck(state, wave)` — mirrors `checkSpecAlignment()`:

```typescript
export function checkFunctionalCheck(state: TaskGraph, wave: number): GateCheck {
  if (!state.functional_check) {
    return { passed: true, message: "5. Functional check: skipped (no data)." };
  }
  if (state.functional_check.verdict === "SKIPPED") {
    return { passed: true, message: "5. Functional check: skipped (project not runnable)." };
  }
  if (state.functional_check.wave !== wave) {
    return { passed: false, message: `FAILED: Functional check ran for wave ${state.functional_check.wave}, not ${wave}.` };
  }
  if ((state.functional_check.critical_count ?? 0) > 0) {
    const findings = (state.functional_check.critical_findings ?? []).map(f => `  - ${f}`).join("\n");
    return { passed: false, message: `FAILED: Functional check has ${state.functional_check.critical_count} critical findings.\n${findings}` };
  }
  return { passed: true, message: `5. Functional check verified (verdict: ${state.functional_check.verdict}).` };
}
```

### 7. Config updates — `engine/src/config.ts`

- Add `"functional-evaluator"` to `REVIEW_AGENTS` set (recognized as execute-phase agent)
- Do NOT add to `REVIEW_SUB_AGENTS` (it's not a per-task reviewer)

### 8. Wave-gate skill update — `commands/wave-gate.md`

Add functional-evaluator spawn alongside spec-check in Step 3 (single message, parallel).

### 9. GitHub issue summary — `complete-wave-gate.ts`

Add functional check results to `generateWaveGateSummary()` output.

## Files to modify

| File | Change |
|---|---|
| `engine/src/types.ts` | Add `FunctionalCheck` interface, add to `TaskGraph` |
| `engine/src/config.ts` | Add `"functional-evaluator"` to `REVIEW_AGENTS` |
| `engine/src/handlers/subagent-stop/dispatch.ts` | New category + route |
| `engine/src/handlers/subagent-stop/store-functional-check-findings.ts` | **New file** |
| `engine/src/handlers/helpers/complete-wave-gate.ts` | Add `checkFunctionalCheck()` |
| `agents/functional-evaluator.md` | **New file** |
| `commands/functional-check.md` | **New file** |
| `commands/wave-gate.md` | Add to spawn list |

## What makes it universal (no project-type hardcoding)

The agent reads context clues to figure out how to build and verify:

| Signal | What it tells the agent |
|---|---|
| `CLAUDE.md` | Build commands, run commands, project conventions |
| `package.json` | Node/TS project — `npm run build`, `npm start` |
| `pom.xml` / `build.gradle` | Java project — `mvn package`, `java -jar` |
| `Cargo.toml` | Rust — `cargo build`, `./target/debug/binary` |
| `Makefile` | Generic — `make build`, `make run` |
| Acceptance scenarios | What behavior to verify |

The LLM adapts its verification approach. No switch statements, no project type enums.

## Graceful degradation

- No build command found → `FUNCTIONAL_CHECK_VERDICT: SKIPPED` → gate passes
- Build succeeds but no acceptance scenarios → `SKIPPED`
- Build fails → `CRITICAL` → gate blocks
- Scenario verification fails → `CRITICAL` → gate blocks
- Agent output malformed → `EVIDENCE_CAPTURE_FAILED` (same as spec-check)

## Relationship to spec-check

Spec-check and functional-check are complementary, not overlapping:

| | Spec-check | Functional-check |
|---|---|---|
| Question | Does the code match the spec? | Does the code actually work? |
| Method | Reads source files | Builds and runs the artifact |
| Catches | Missing implementations, scope creep, terminology drift | Runtime failures, integration bugs, stubbed functionality |
| Medium | Static analysis | Dynamic execution |

## Open questions

- Should the functional evaluator also verify that **existing functionality** still works (regression), or only new acceptance scenarios?
- Should there be a way for projects to declare a `functional_check.run_command` in CLAUDE.md to short-circuit the detection step?
- Should the evaluator have a time budget (e.g., 5 min max) to prevent runaway server starts?
