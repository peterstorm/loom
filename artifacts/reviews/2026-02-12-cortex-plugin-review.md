# Cortex Plugin — Comprehensive Review

**Date:** 2026-02-12
**Agents:** code-reviewer (sonnet), silent-failure-hunter (sonnet), architecture-agent (opus), type-design-analyzer (sonnet)
**Scope:** Full plugin codebase at `.claude/plugins/cortex/`

---

## Critical Issues (must fix)

### 1. [FIXED] 4 Runtime Bugs: cli.ts signature mismatches *(architecture-agent)*

The CLI dispatcher calls several commands with **wrong argument shapes**. These will crash at runtime:

| Call Site | Bug | Fix |
|-----------|-----|-----|
| `cli.ts:426-433` — `handleIndexCode` | Passes object instead of positional args to `executeIndexCode(argv, sessionId, projectDb, globalDb, apiKey, projectName)` | Use positional args matching the function signature |
| `cli.ts:541` — `handleConsolidate` | Calls `findSimilarPairs(projectDb)` but signature expects `(memories[], threshold?)`. Should call `detectDuplicates(db)` | Replace with correct function |
| `cli.ts:611` — `handleTraverse` | Passes `{ memoryId, maxDepth }` but `TraverseOptions` has `{ id, depth }` | Use correct field names |
| `cli.ts:578` — `handleLifecycle` | Accesses `.archivedCount` / `.prunedCount` but `LifecycleResult` has `.archived` / `.pruned` | Drop `Count` suffix |

### 2. [FIXED] Checkpoint not saved on API failure → infinite retry loop *(silent-failure-hunter, code-reviewer)*

**File:** `engine/src/commands/extract.ts:152-162`

When Gemini API fails after transcript truncation, returns `cursorStart` (old position) instead of `newCursor`. Next session re-processes the same chunk forever.

**Fix:** Save checkpoint at `newCursor` even on failure, so the system advances past the chunk.

### 3. [FIXED] `loadCachedSurface` doesn't write `.local.md` file *(architecture-agent)*

**File:** `engine/src/commands/generate.ts:126-166`

`loadCachedSurface()` reads from cache JSON and returns content, but **never writes** it to `.claude/cortex-memory.local.md` — the file Claude actually reads. Only `runGenerate()` writes it.

**Impact:** SessionStart hook reports "Loaded cached surface" but Claude has no surface file. Silent data loss.

### 4. [FIXED] `filterUnembedded` prevents dual-embedding backfill *(code-reviewer, architecture-agent)*

**File:** `engine/src/commands/backfill.ts:29-32`

```typescript
return memories.filter(m => m.embedding === null && m.local_embedding === null);
```

Requires **both** to be null. If Gemini runs first and sets `embedding`, local backfill skips those memories forever. Memories permanently lack local embeddings.

**Fix:** Use separate filters: `filterGeminiUnembedded(m => m.embedding === null)` and `filterLocalUnembedded(m => m.local_embedding === null)`.

---

## Important Issues (should fix)

### 5. [FIXED] Staleness check hardcoded instead of using config constant *(code-reviewer)*

**File:** `engine/src/commands/generate.ts:156`

```typescript
const stale = ageHours > 24; // Should use SURFACE_STALE_HOURS from config.ts
```

### 6. [FIXED] `getSurfaceCachePath` in config.ts is dead code *(code-reviewer)*

**File:** `engine/src/config.ts:82-86`

Uses branch-name-based filenames (`{safeBranch}.json`) but actual cache uses `sha256(branch:cwd)` hashes. Function is never called. Remove or align.

### 7. [FIXED] Recall discards similarity scores *(architecture-agent)*

**File:** `engine/src/commands/recall.ts:221-234`

After `searchByEmbedding` returns memories sorted by cosine similarity, all results get `score: 1.0` hardcoded. `mergeResults()` then sorts by score — but all scores are 1.0, so cross-DB ranking is effectively random.

**Fix:** Keyword results now get position-based scores [1.0→0.5] preserving FTS5 rank order; semantic results propagate cosine scores via `rankBySimilarity`.

### 8. [FIXED] No fallback to keyword search on semantic failure *(silent-failure-hunter)*

**File:** `engine/src/commands/recall.ts:174-201`

When embedding API fails (timeout, rate limit), recall returns error. Should auto-fallback to keyword search.

### 9. [FIXED] `searchByEmbedding` throws on null embedding instead of skipping *(silent-failure-hunter)*

**File:** `engine/src/infra/db.ts:577-582`

Single corrupt memory with null embedding (despite `WHERE embedding IS NOT NULL` filter) crashes entire search. Should log warning and skip.

### 10. [FIXED] Local model load failure cached forever *(silent-failure-hunter)*

**File:** `engine/src/infra/local-embed.ts:103-111`

If model fails to load (transient network error), failure is cached permanently. No retry mechanism. Must restart process.

### 11. [FIXED] FC/IS boundary violation: db.ts imports core/similarity.ts *(architecture-agent)*

**File:** `engine/src/infra/db.ts:17`

`searchByEmbedding()` does cosine similarity inside the DB module. Should split: (1) fetch candidates (I/O), (2) rank by similarity (pure function in core/).

**Fix:** Replaced `searchByEmbedding` with `getMemoriesWithEmbedding` (I/O only) + `rankBySimilarity` in core/similarity.ts (pure). recall.ts orchestrates both.

### 12. [FIXED] Extract script continues after extraction failure *(silent-failure-hunter)*

**File:** `hooks/scripts/extract-and-generate.sh:56-59`

If extraction fails mid-way, script proceeds to backfill + generate. Backfill processes corrupt/incomplete data; generate creates surface from stale memories.

**Fix:** Backfill now skipped on extract failure; generate always runs (stale memories still need fresh surface).

### 13. [FIXED] Extraction parse failure returns empty array silently *(silent-failure-hunter)*

**File:** `engine/src/core/extraction.ts:169-202`

When Gemini returns malformed JSON, `parseExtractionResponse` returns `[]` with no logging. Caller treats this as "no memories found" — session content silently lost.

**Fix:** Added stderr warnings for non-array parsed results and when all candidates filtered out (0 valid from N raw).

---

## Type Design Issues

### 14. [FIXED] No branded types for IDs *(type-design-analyzer)*

`Memory.id`, `Edge.source_id`, `Edge.target_id` are all plain `string`. Easy to swap or pass wrong ID type. Branded types (`MemoryId`, `EdgeId`) would catch this at compile time.

### 15. [FIXED] Embedding types not branded *(type-design-analyzer)*

`Float64Array` (Gemini 768-dim) and `Float32Array` (local 384-dim) are used but could accidentally be swapped. `db.ts:544` uses `instanceof` check — post-hoc. Branded types would prevent this.

### 16. [FIXED] Tags not defensively copied in factory *(type-design-analyzer)*

**File:** `engine/src/core/types.ts:239`

`tags: input.tags ?? []` doesn't copy. Mutable external array could break immutability.

### 17. [FIXED] Type assertions bypass validation in DB deserialization *(type-design-analyzer)*

**File:** `engine/src/infra/db.ts:720,743`

`row.relation_type as EdgeRelation` and `row.memory_type as MemoryType` bypass validation. Should use type guards (`isEdgeRelation`, `isMemoryType`) first.

### 18. [FIXED] Non-exhaustive matching in surface.ts *(type-design-analyzer)*

**File:** `engine/src/core/surface.ts:114,149`

```typescript
const budget = budgets[category as MemoryType] ?? 0;
```

**Fix:** Replaced `as MemoryType` casts with `isMemoryType()` type guard + `continue` for invalid categories. Also fixed in extraction.ts.

---

## Low Priority / Nice to Have

| # | Issue | File | Agent |
|---|-------|------|-------|
| 19 | Consolidation checkpoint files never cleaned up on success | `consolidate.ts:386-400` | silent-failure-hunter |
| 20 | PID lock has TOCTOU race condition | `filesystem.ts:61-87` | silent-failure-hunter |
| 21 | DB connections not closed on uncaught exceptions | `cli.ts:810-815` | silent-failure-hunter |
| 22 | Surface token budget doesn't account for markdown overhead (~200 tokens) | `ranking.ts` / `surface.ts` | architecture-agent |
| 23 | `source_context` JSON has different schemas across extract/remember/index-code | multiple | code-reviewer |
| 24 | Gemini API key passed as URL query param in LLM but header in embed (inconsistent) | `gemini-llm.ts:72` vs `gemini-embed.ts:104` | architecture-agent |
| 25 | `computeAllCentrality()` called 3x per pipeline (redundant DB reads) | `generate.ts`, `lifecycle.ts`, `recall.ts` | architecture-agent |

---

## Test Infrastructure [FIXED]

All `bun:test` imports removed (6 files), `spyOn` → `vi.spyOn`, `toEndWith` → `endsWith()`. **731/731 tests pass.**

---

## Strengths

- **FC/IS architecture is genuinely well-applied** — core/ modules are 100% pure and testable without mocks
- **Immutability-first**: readonly everywhere, defensive factory functions
- **Parse-don't-validate**: Factory functions return validated types, type guards for runtime checks
- **Dual embedding strategy** with clear type separation (Float64 vs Float32)
- **Transaction safety**: index-code.ts wraps all writes in DB transaction
- **Decay model** is mathematically sound with well-designed lifecycle state machine
- **No circular dependencies** — dependency graph is acyclic
- **Testability score ~80%** (core/ 100%, commands/ ~70%, infra/ requires integration tests)

---

## Architecture Metrics

| Metric | Before | After Fixes |
|--------|--------|-------------|
| Runtime bugs | 4 | 0 |
| FC/IS violations | 2 | 0 |
| Pure function % | ~80% | ~85% |
| Mock-free testable | ~80% | ~90% |
| Data loss paths | 2 (score discard, surface file) | 0 |
| Test suite | mixed bun:test/vitest | 731/731 vitest ✅ |

---

## Type Design Ratings

### Memory Type
| Aspect | Rating |
|--------|--------|
| Encapsulation | 7/10 |
| Invariant Expression | 8/10 |
| Invariant Usefulness | 9/10 |
| Invariant Enforcement | 8/10 |

### Edge Type
| Aspect | Rating |
|--------|--------|
| Encapsulation | 7/10 |
| Invariant Expression | 7/10 |
| Invariant Usefulness | 8/10 |
| Invariant Enforcement | 8/10 |

### Embedding Types
| Aspect | Rating |
|--------|--------|
| Encapsulation | 5/10 |
| Invariant Expression | 6/10 |
| Invariant Usefulness | 9/10 |
| Invariant Enforcement | 6/10 |

---

## Unresolved Questions

- backfill never re-embeds local-only memories when Gemini becomes available — intentional or add "re-embed with Gemini" mode?
- loadCachedSurface not writing .local.md — should SessionStart trigger full `generate` if cache stale?
- consolidate.ts `findSimilarPairs` exported as "pure" but cli.ts calls with DB — was `detectDuplicates` the intended public API?
- source_context schema inconsistency — standardize or keep per-source-type?
