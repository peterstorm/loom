# Clarification Log — Cortex Spec

## 2026-02-08: Marker Resolution Session

All 6 `[NEEDS CLARIFICATION]` markers resolved using unified brief context and reasonable defaults.

### 1. FR-004: Cursor Persistence Mechanism

**Original Marker:** "track cursor position in transcript to resume extraction if interrupted [NEEDS CLARIFICATION: cursor persistence mechanism across sessions]"

**Resolution:** Extractions table tracks (session_id, cursor_position, extracted_at). Cursor persists in SQLite between sessions.

**Source:** Unified brief data model explicitly documents extractions table with these fields.

**Rationale:** SQLite persistence natural choice given existing DB infrastructure. Tracks progress per session_id to support resumable extraction.

---

### 2. FR-012: Transcript Size Threshold

**Original Marker:** "support resumable extraction if session transcript exceeds [NEEDS CLARIFICATION: transcript size threshold for resumable extraction]"

**Resolution:** 100KB threshold

**Source:** Not specified in brief. Reasonable default based on:
- Average session transcript ~5k tokens (~20KB UTF-8)
- 100KB = ~25k tokens = ~5x average
- LLM context windows handle 20k+ tokens easily
- Checkpoint overhead only justified for unusually large sessions

**Rationale:** Balance between avoiding premature chunking and preventing timeout on massive sessions.

---

### 3. FR-016: Per-Category Line Budgets

**Original Marker:** "apply per-category line budgets [NEEDS CLARIFICATION: exact per-category line budget allocations]"

**Resolution:** architecture 25, decision 25, pattern 25, gotcha 20, progress 30, context 15, code_description 10

**Source:** Unified brief gap #5 references memory-mcp "keep" pattern with exact allocations.

**Rationale:** Soft caps with redistribution. Prevents single category dominating push surface. Total targets 300-500 tokens (150 lines avg = 3 tokens/line).

---

### 4. FR-040: Graph Traversal Depth

**Original Marker:** "graph traversal from memory by ID with [NEEDS CLARIFICATION: maximum graph traversal depth]"

**Resolution:** Depth limit of 2 (maximum 2 hops from source node)

**Source:** Unified brief open question #6 states "2-3 for v1", brief scope says "depth 2-3"

**Rationale:**
- Depth 1 = only directly connected memories (too shallow for discovery)
- Depth 2 = "friends of friends" (good balance)
- Depth 3+ = exponential growth, performance risk
- Conservative choice (2) for v1, can increase if needed

---

### 5. FR-054: Batch Directory Indexing

**Original Marker:** "support batch indexing of directories [NEEDS CLARIFICATION: batch directory indexing deferred to v2?]"

**Resolution:** Explicitly deferred to v2 (marked DEFERRED in spec)

**Source:** Unified brief v2 section lists "Batch code indexing — recursive `/index-code src/` on entire directories"

**Rationale:** Manual single-file indexing sufficient for v1. Batch processing adds complexity (file filtering, progress reporting, error handling per-file).

---

### 6. FR-055: Auto-Triggered Re-Indexing

**Original Marker:** "auto-trigger re-indexing when files modified [NEEDS CLARIFICATION: auto-triggered re-indexing deferred to v2?]"

**Resolution:** Explicitly deferred to v2 (marked DEFERRED in spec)

**Source:**
- Unified brief decision #18: "Manual-only v1, auto on Write/Edit deferred to v2"
- Unified brief v2 section: "Auto /index-code on Write/Edit — FR-046 defers to v2"

**Rationale:** Requires integration with Write/Edit tool hooks. Manual `/index-code` sufficient for v1 adoption. Auto-triggering risks noisy re-indexing on every file save.

---

## Coverage Summary

| Category | Status |
|----------|--------|
| Data model | Resolved (FR-004: extractions table) |
| Performance | Resolved (FR-012: 100KB threshold) |
| UX/Push surface | Resolved (FR-016: per-category budgets) |
| Graph operations | Resolved (FR-040: depth 2) |
| Code indexing | Resolved (FR-054, FR-055: deferred to v2) |

**Remaining markers:** 0

**Categories:**
- Resolved: 6
- Deferred: 2 (FR-054, FR-055 explicitly marked)
- Outstanding: 0

**Ready for architecture:** Yes

---

## Decisions by Source

- **From unified brief (explicit):** FR-016, FR-040, FR-054, FR-055
- **From unified brief (inferred):** FR-004
- **Reasonable default (not in brief):** FR-012

All markers resolved with documented rationale. No blocking ambiguities remain.
