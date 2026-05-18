# Plan: PostEdit Linter Hook Extension

**Spec:** `.claude/specs/2026-05-18-linter-hook-extension/spec.md`
**Created:** 2026-05-18

## Summary

A platform-agnostic PostEdit linter engine that catches bad code patterns immediately after edits. Built as `engine/src/linter/` — a pure functional module with declarative JSON rules, ReDoS-safe regex execution, and structured JSON output. Two platform adapters (Claude Code PostToolUse hook + Pi extension) share the engine with identical behavior. A two-tier model runs fast regex rules per-edit (<50ms) and the full suite (including programmatic TS rules) at wave-gate boundaries.

---

## Architectural Decisions

### AD-1: Module within Engine (Approach B)

**Choice:** `engine/src/linter/` as a sibling to `engine/src/core/`, `engine/src/parsers/`
**Why:** Matches existing code organization. Engine already exports pure functions consumed by both CLI handlers and Pi extension. Avoids new package/workspace overhead while maintaining clear module boundary.
**Rejected:**
- Standalone package — unnecessary package.json, build step, versioning overhead for a single consumer
- Flat files in `engine/src/core/` — pollutes existing orchestration domain; linter is a distinct bounded context

### AD-2: Declarative JSON Rule Format

**Choice:** Rules defined as `.json` files with regex pattern, file-extension scope, metadata
**Why:** Zero-code authoring for common case. JSON is parseable without eval/import. Enables static analysis of regex patterns at load time (ReDoS detection). Future programmatic rules (P2) supplement but don't replace JSON rules.
**Rejected:**
- TypeScript-only rules — requires import/eval for every rule, harder to statically analyze for safety
- YAML — adds a parser dependency; JSON is native to bun/Node

### AD-3: Defense-in-Depth ReDoS Protection

**Choice:** Static analysis at rule load time (reject super-linear patterns) + runtime timeout per regex execution (50ms budget shared across all rules)
**Why:** Static analysis catches known-bad patterns early but has false negatives. Runtime timeout catches anything static analysis misses. Together they provide high confidence without over-rejecting valid rules.
**Rejected:**
- Static analysis only — known false negatives for complex backreference patterns
- Runtime timeout only — poor DX (rules silently time out instead of failing at load)
- No protection — unacceptable; a single rule can hang the entire edit pipeline

### AD-4: Fail-Closed Error Handling

**Choice:** Any unhandled exception, timeout, or invalid state blocks the edit with a structured error message
**Why:** Spec mandate (FR-007). Linter failures must never silently pass — that defeats the purpose. The structured error message identifies the failure so it can be fixed quickly.
**Rejected:**
- Fail-open (pass on error) — defeats purpose; violations slip through silently
- Partial results (report what succeeded, pass on errors) — complex state management, confusing semantics

### AD-5: Stateless Per-Invocation Model

**Choice:** Each lintFile() call loads rules fresh, evaluates, returns result. No caching, no memoization, no shared state between invocations.
**Why:** Bun's module resolution + file I/O is fast enough (<5ms for rule loading in practice). Statelessness eliminates cache invalidation bugs, simplifies testing, and matches the existing handler pattern.
**Rejected:**
- Rule caching with file-watcher invalidation — complex, bug-prone, unnecessary given bun's speed
- Process-level singleton — conflicts with test isolation; rules may change between invocations

### AD-6: PostToolUse Hook Type Addition

**Choice:** Add `PostToolUse` section to `hooks.json` matching Edit/Write/MultiEdit, invoking a new shell shim
**Why:** PostToolUse fires after the file is written to disk, giving the linter access to the final file content. Matches existing pattern: shell shim → bun CLI → handler → core module.
**Rejected:**
- PreToolUse with file content prediction — file isn't on disk yet; can't lint actual content
- Background process polling — latency, complexity, races

### AD-7: Project-Local Rules in `.claude/rules/`

**Choice:** Project-specific lint rules live in `.claude/rules/*.json` (or `.pi/rules/*.json` for Pi), merged with defaults from the loom package `lint-rules/` directory
**Why:** Follows existing loom convention (`.claude/state/`, `.claude/specs/`, `.claude/plans/`). Keeps project customization co-located with project config.
**Rejected:**
- `.loom/rules/` — new top-level dotdir not established in ecosystem
- `package.json` `"loom.rules"` field — JSON rule files already declarative; extra indirection

### AD-8: Two-Tier Execution (Immediate + Wave-Gate)

**Choice:** Immediate tier runs only declarative regex rules (P1). Wave-gate tier runs all rules including programmatic TS functions (P2). Tiers selected via `lintFile(path, "immediate" | "full")`.
**Why:** Guarantees <50ms budget for per-edit path. Programmatic rules may be expensive (file parsing, cross-reference checks) and belong at natural pause points only.
**Rejected:**
- Single tier for everything — violates 50ms NFR once programmatic rules exist
- Per-rule timeout classification — complex; simpler to split by rule type

---

## File Structure

### Linter Core (`engine/src/linter/`)

```
engine/src/linter/types.ts          — Rule, Violation, LintResult, LintOutput, Tier types
engine/src/linter/loader.ts         — load + merge rules from default + project dirs
engine/src/linter/safety.ts         — ReDoS static analysis + runtime timeout wrapper
engine/src/linter/executor.ts       — match rules to file by extension, run regex, collect violations
engine/src/linter/formatter.ts      — violations → structured JSON (LintOutput)
engine/src/linter/index.ts          — public API: lintFile(path, tier) → LintResult
```

### Linter Tests (`engine/tests/linter/`)

```
engine/tests/linter/types.test.ts       — type guard tests
engine/tests/linter/loader.test.ts      — rule loading, merging, override semantics
engine/tests/linter/safety.test.ts      — ReDoS detection, timeout behavior
engine/tests/linter/executor.test.ts    — rule matching, regex execution, violation collection
engine/tests/linter/formatter.test.ts   — JSON output shape conformance
engine/tests/linter/index.test.ts       — integration: lintFile end-to-end
engine/tests/linter/safety.property.test.ts — property tests for regex safety invariants
```

### Claude Code Integration (hooks)

```
hooks/scripts/lint-file.sh              — shell shim for PostToolUse hook
engine/src/handlers/post-tool-use/lint-file.ts — stdin → lintFile() → HookResult
```

### Pi Extension Integration

```
pi/extension.ts                         — add tool_result handler for edit/write → lintFile()
```

### Wave-Gate Integration

```
engine/src/handlers/helpers/lint-wave-gate.ts — wave-gate calls lintFile(path, "full") for all modified files
```

### Default Rules

```
lint-rules/no-console-log.json          — example: block console.log in .ts/.tsx
lint-rules/no-any-type.json             — example: block explicit `any` type annotations
lint-rules/no-todo-fixme.json           — example: block TODO/FIXME comments
lint-rules/README.md                    — rule authoring guide
```

### Config Changes

```
engine/src/config.ts                    — add DEFAULT_RULES_DIR, PROJECT_RULES_DIR constants
engine/src/cli.ts                       — add "post-tool-use" to KNOWN_HANDLERS, register lint-file
hooks/hooks.json                        — add PostToolUse section
```

---

## Component Design

### Types (`engine/src/linter/types.ts`)

**Responsibility:** Canonical type definitions for the linter domain
**Files:** `engine/src/linter/types.ts`
**Interface:**

```typescript
type Tier = "immediate" | "full";
type RuleKind = "regex" | "programmatic"; // "command" reserved for P3

interface RegexRule {
  kind: "regex";
  name: string;
  description: string;
  extensions: string[];      // e.g. [".ts", ".tsx"]
  pattern: string;           // regex source
  flags?: string;            // regex flags (default: none)
  fixHint: string;
  enabled: boolean;          // project-local can set false
  source: RuleSource;
}

interface ProgrammaticRule {
  kind: "programmatic";
  name: string;
  description: string;
  extensions: string[];
  handler: (content: string, filePath: string) => Violation[];
  fixHint: string;
  enabled: boolean;
  source: RuleSource;
}

type Rule = RegexRule | ProgrammaticRule;
type RuleSource = "default" | "project";

interface Violation {
  rule: string;              // rule name
  file: string;             // absolute path
  line: number;             // 1-indexed
  text: string;             // matched line content (trimmed)
  fixHint: string;
}

type LintResult =
  | { kind: "pass" }
  | { kind: "violations"; violations: Violation[] }
  | { kind: "error"; message: string };  // fail-closed

interface LintOutput {
  status: "pass" | "fail" | "error";
  file: string;
  violations?: Violation[];
  error?: string;
}
```

**Depends on:** none

### Loader (`engine/src/linter/loader.ts`)

**Responsibility:** Load JSON rule files from default + project dirs, merge with override semantics
**Files:** `engine/src/linter/loader.ts`
**Interface:**

```typescript
function loadRules(
  defaultDir: string,
  projectDir: string | null,
  tier: Tier
): RegexRule[] | Rule[];
// - Reads all *.json from defaultDir, tags source: "default"
// - Reads all *.json from projectDir (if exists), tags source: "project"
// - Project rules with same `name` override default (enabled: false disables)
// - For tier "immediate": returns only RegexRule[]
// - For tier "full": returns all Rule[] (regex + programmatic)
// - Throws on malformed JSON (fail-closed at caller)
```

**Depends on:** `types.ts`

### Safety (`engine/src/linter/safety.ts`)

**Responsibility:** ReDoS static analysis + runtime timeout wrapper for regex execution
**Files:** `engine/src/linter/safety.ts`
**Interface:**

```typescript
type SafetyResult =
  | { safe: true; regex: RegExp }
  | { safe: false; reason: string };

function analyzeRegex(pattern: string, flags?: string): SafetyResult;
// Static analysis: detect nested quantifiers, overlapping alternations,
// catastrophic backtracking patterns. Returns compiled RegExp if safe.

function execWithTimeout<T>(fn: () => T, timeoutMs: number): T;
// Wraps synchronous execution with a deadline. Throws on timeout.
// Uses performance.now() polling for per-line-batch checks.
```

**Depends on:** none

### Executor (`engine/src/linter/executor.ts`)

**Responsibility:** Match rules to file by extension, execute regex line-by-line, collect violations
**Files:** `engine/src/linter/executor.ts`
**Interface:**

```typescript
function executeRules(
  rules: Rule[],
  filePath: string,
  content: string
): Violation[];
// 1. Filter rules by file extension match
// 2. For each matching RegexRule: test each line, collect violations
// 3. For each matching ProgrammaticRule: invoke handler, collect violations
// 4. All execution wrapped in safety timeout
// 5. Returns aggregated violations (may be empty)
// Throws on timeout or rule handler exception (fail-closed at caller)
```

**Depends on:** `types.ts`, `safety.ts`

### Formatter (`engine/src/linter/formatter.ts`)

**Responsibility:** Convert LintResult to structured JSON output and human-readable block message
**Files:** `engine/src/linter/formatter.ts`
**Interface:**

```typescript
function formatOutput(result: LintResult, filePath: string): LintOutput;
// Maps LintResult → LintOutput JSON structure

function formatBlockMessage(output: LintOutput): string;
// Renders LintOutput as a human-readable multi-line string for hook stderr
// Format:
//   ❌ LINT VIOLATIONS in path/to/file.ts
//
//   [rule-name] line 42: matched text
//     Fix: fix hint text
//
//   [rule-name] line 87: matched text
//     Fix: fix hint text
```

**Depends on:** `types.ts`

### Public API (`engine/src/linter/index.ts`)

**Responsibility:** Single entry point orchestrating load → execute → format pipeline
**Files:** `engine/src/linter/index.ts`
**Interface:**

```typescript
function lintFile(filePath: string, tier: Tier): LintResult;
// 1. Check binary detection → pass
// 2. Read file content
// 3. Load rules (defaultDir from config, projectDir from config)
// 4. Execute rules against content
// 5. Return LintResult
// Entire function wrapped in try/catch → LintResult.error on any throw (fail-closed)

function isBinaryFile(filePath: string): boolean;
// Heuristic: check first 8KB for null bytes
```

**Depends on:** `loader.ts`, `executor.ts`, `formatter.ts`, `config.ts`

### CLI Handler (`engine/src/handlers/post-tool-use/lint-file.ts`)

**Responsibility:** Parse PostToolUse stdin JSON, extract file path, invoke lintFile, map to HookResult
**Files:** `engine/src/handlers/post-tool-use/lint-file.ts`
**Interface:**

```typescript
// Default export: HookHandler
// Stdin JSON shape (PostToolUse from Claude Code):
//   { tool_name: "Edit"|"Write"|"MultiEdit", tool_input: { file_path: string, ... } }
// Maps LintResult → HookResult:
//   pass → { kind: "allow" }
//   violations → { kind: "block", message: formatBlockMessage(...) }
//   error → { kind: "block", message: "Linter engine error: ..." }
```

**Depends on:** `linter/index.ts`, `linter/formatter.ts`

### Wave-Gate Handler (`engine/src/handlers/helpers/lint-wave-gate.ts`)

**Responsibility:** Run full-tier lint on all files modified in current wave
**Files:** `engine/src/handlers/helpers/lint-wave-gate.ts`
**Interface:**

```typescript
// Default export: HookHandler
// Reads task graph, finds files_modified for current wave tasks
// Runs lintFile(path, "full") for each
// Aggregates results:
//   all pass → { kind: "allow" }
//   any violations → { kind: "block", message: aggregated violations }
//   any error → { kind: "block", message: engine error }
```

**Depends on:** `linter/index.ts`, `state-manager.ts`

### Shell Shim (`hooks/scripts/lint-file.sh`)

**Responsibility:** Thin shell entry point for Claude Code PostToolUse hook invocation
**Files:** `hooks/scripts/lint-file.sh`
**Interface:**

```bash
#!/bin/bash
# PostToolUse hook — lint edited file
exec bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts post-tool-use lint-file
```

**Depends on:** CLI router (`engine/src/cli.ts`)

### Pi Extension Adapter (modification to `pi/extension.ts`)

**Responsibility:** Listen for tool_result events on edit/write, invoke lintFile, inject violations
**Files:** `pi/extension.ts`
**Interface:**

```typescript
// Add to existing extension:
pi.on("tool_result", async (event, ctx) => {
  // Only for edit/write tool results
  // Extract file path from event
  // Run lintFile(filePath, "immediate")
  // If violations: return { content: [formatBlockMessage(...)], isError: true }
  // If pass: return undefined (no injection)
});
```

**Depends on:** `linter/index.ts`, `linter/formatter.ts`

---

## Data Flow

```
File Edit → [Platform Adapter] → lintFile(path, tier)
                                       │
                        ┌──────────────┼──────────────┐
                        ▼              ▼              ▼
                  isBinaryFile   loadRules(dirs)   readFile
                        │              │              │
                        │    ┌─────────┘              │
                        │    ▼                        │
                        │  analyzeRegex (safety)      │
                        │    │                        │
                        ▼    ▼                        ▼
                   [skip] executeRules(rules, content)
                              │
                              ▼
                      Violation[] → LintResult
                              │
                              ▼
                   formatOutput / formatBlockMessage
                              │
                              ▼
              [Platform Adapter maps to HookResult / isError]
```

Key transformations: file content → per-line regex testing → Violation[] → structured JSON/block message

---

## Implementation Phases

### Phase 1: Types + Safety (no dependencies)

- Define all linter domain types (Rule, Violation, LintResult, LintOutput, Tier)
- Implement ReDoS static analysis (analyzeRegex)
- Implement runtime timeout wrapper (execWithTimeout)
- Write safety property tests (invariant: known-bad patterns always rejected)
- **Files:** `engine/src/linter/types.ts`, `engine/src/linter/safety.ts`, `engine/tests/linter/types.test.ts`, `engine/tests/linter/safety.test.ts`, `engine/tests/linter/safety.property.test.ts`

### Phase 2: Loader + Executor + Formatter (depends on Phase 1)

- Implement rule loading from JSON files with merge/override semantics
- Implement rule-to-file matching by extension
- Implement line-by-line regex execution with safety wrapping
- Implement structured JSON formatter and block message renderer
- Create default rule JSON files (3 starter rules)
- **Files:** `engine/src/linter/loader.ts`, `engine/src/linter/executor.ts`, `engine/src/linter/formatter.ts`, `lint-rules/no-console-log.json`, `lint-rules/no-any-type.json`, `lint-rules/no-todo-fixme.json`, `lint-rules/README.md`, `engine/tests/linter/loader.test.ts`, `engine/tests/linter/executor.test.ts`, `engine/tests/linter/formatter.test.ts`

### Phase 3: Public API + Config (depends on Phase 1+2)

- Implement `lintFile()` orchestrator with binary detection and fail-closed wrapping
- Add config constants (DEFAULT_RULES_DIR, PROJECT_RULES_DIR)
- Integration tests exercising full pipeline
- **Files:** `engine/src/linter/index.ts`, `engine/src/config.ts` (modify), `engine/tests/linter/index.test.ts`

### Phase 4: Claude Code Integration (depends on Phase 3)

- Create PostToolUse handler (`lint-file.ts`)
- Create shell shim (`lint-file.sh`)
- Register in CLI router (add "post-tool-use" to KNOWN_HANDLERS)
- Add PostToolUse section to hooks.json
- **Files:** `engine/src/handlers/post-tool-use/lint-file.ts`, `hooks/scripts/lint-file.sh`, `engine/src/cli.ts` (modify), `hooks/hooks.json` (modify), `engine/tests/handlers/post-tool-use/lint-file.test.ts`

### Phase 5: Pi Extension + Wave-Gate (depends on Phase 3)

- Add `tool_result` event handler to Pi extension for edit/write lint
- Implement wave-gate helper handler (full-tier lint on wave files)
- Register wave-gate handler in CLI router
- **Files:** `pi/extension.ts` (modify), `engine/src/handlers/helpers/lint-wave-gate.ts`, `engine/tests/handlers/helpers/lint-wave-gate.test.ts`

### Phase 6: Programmatic Rules — P2 (depends on Phase 3)

- Extend loader to discover + import `.ts` rule files
- Extend executor to invoke programmatic rule handlers
- Add programmatic rule to default set as example
- **Files:** `engine/src/linter/loader.ts` (modify), `engine/src/linter/executor.ts` (modify), `lint-rules/no-deeply-nested.ts` (example), `engine/tests/linter/executor-programmatic.test.ts`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| types | Type guard functions, smart constructors | — | — |
| safety | `analyzeRegex` accepts safe patterns, rejects known-bad | — | Invariant: all ReDoS corpus patterns rejected; all safe corpus accepted |
| loader | JSON parsing, merge semantics, override disable, missing dir handling, malformed file handling | Read from real temp dirs with fixture files | — |
| executor | Extension matching, line-by-line regex, multi-rule aggregation, timeout on slow regex | — | Invariant: violation count ≤ line count × rule count |
| formatter | Output shape matches LintOutput schema, block message includes all violations | — | — |
| index (lintFile) | Binary detection, fail-closed on throw, pass on no rules | Full pipeline with fixture files + rules | — |
| post-tool-use handler | Stdin parsing, HookResult mapping | CLI invocation with piped stdin | — |
| lint-wave-gate | Task graph reading, multi-file aggregation | — | — |
| Pi adapter | — | Extension event simulation with mock pi API | — |

**Testing philosophy:**
- 90%+ of logic tested as pure functions (no mocks needed)
- I/O boundaries (file reads, dir listing) tested with real temp fixtures via `vitest`
- No mock filesystem — use actual temp dirs created in `beforeEach`
- Property tests for safety module (regex corpus)
- E2E: one test that invokes the shell shim with piped JSON and asserts exit code + stderr

---

## Security & NFR Notes

- **Security:** ReDoS is the primary attack vector. Defense-in-depth (static + timeout) mitigates. Rule files are trusted (loaded from package or project `.claude/rules/`). No user-supplied regex at runtime.
- **Performance:** 50ms budget for immediate tier. Budget breakdown: ~2ms file read, ~3ms rule load (JSON parse), ~40ms regex execution, ~5ms formatting. If budget overruns, timeout kills execution and returns error (fail-closed).
- **Zero dependencies:** No new npm packages. Regex safety analysis is hand-rolled (~100 LOC). `ts-pattern` already in package.json.

---

## Integration Points

### hooks.json Addition

```json
"PostToolUse": [
  {
    "matcher": "Edit",
    "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lint-file.sh" }]
  },
  {
    "matcher": "Write",
    "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lint-file.sh" }]
  },
  {
    "matcher": "MultiEdit",
    "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lint-file.sh" }]
  }
]
```

### CLI Router Addition

```typescript
// In KNOWN_HANDLERS:
"post-tool-use": new Set(["lint-file"]),
// In "helper": add "lint-wave-gate"
```

### Pi Extension Addition

```typescript
// New event listener in pi/extension.ts:
pi.on("tool_result", async (event, ctx) => { /* lint integration */ });
```

### Wave-Gate Integration

The existing `complete-wave-gate.ts` helper gains a new check step that invokes `lint-wave-gate` before advancing the wave. This is a modification to the gate check sequence.

---

## Verification

1. `bun test engine/tests/linter/` — all linter unit + property tests pass
2. `echo '{"tool_name":"Edit","tool_input":{"file_path":"test.ts"}}' | bun engine/src/cli.ts post-tool-use lint-file` — exits 0 (no violations) or 2 (violations with stderr message)
3. Create a `.ts` file with `console.log`, run linter, verify structured violation output
4. Create a project `.claude/rules/` override that disables a default rule, verify it no longer fires
5. Feed a ReDoS pattern as a rule, verify static analysis rejects it at load time
6. Full e2e: edit a file via Claude Code with PostToolUse hook active, observe block message
