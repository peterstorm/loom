# Feature: Cortex — Persistent Memory Plugin

**Spec ID:** 2026-02-08-cortex
**Created:** 2026-02-08
**Status:** Draft
**Owner:** peterstorm

## Summary

Cortex automatically captures knowledge from Claude Code sessions and surfaces relevant context at the start of new sessions. Unlike existing memory solutions, Cortex is code-aware: it pairs prose summaries with raw code blocks, enabling semantic search that understands both what the code does (prose) and what it contains (source). The system operates silently in the background, extracting memories after each session and presenting a curated context push surface when the next session begins.

---

## User Scenarios

### US1: [P1] Automatic Knowledge Capture

**As a** developer working across multiple sessions
**I want** the system to automatically remember decisions, patterns, and code explanations
**So that** I don't need to manually document or re-explain context

**Why P1:** Core value proposition. Without automatic extraction, system provides no value.

**Acceptance Scenarios:**
- Given I complete a session where architectural decisions are discussed, When the session ends, Then those decisions are extracted and stored without manual input
- Given I complete a session with no significant new information, When the session ends, Then extraction completes silently without creating noise memories
- Given an extraction error occurs at session end, When I close Claude Code, Then the session ends normally and the error is logged for inspection
- Given I work on a feature branch, When the session ends, Then branch context is captured with the memories

### US2: [P1] Relevant Context at Session Start

**As a** developer starting a new session
**I want** to immediately see the most relevant context from prior sessions
**So that** I don't waste time reconstructing mental models or re-reading notes

**Why P1:** Primary user-facing workflow. Push surface must work reliably for adoption.

**Acceptance Scenarios:**
- Given I start a session on the same branch I ended on, When Claude Code loads, Then I see a context push surface with 300-500 tokens of relevant memories
- Given I start a session on a different branch than last time, When Claude Code loads, Then the push surface emphasizes cross-branch architecture over branch-specific progress
- Given the push surface cache is stale, When Claude Code loads, Then I see a staleness warning with timestamp
- Given I start a session in a project with no prior memories, When Claude Code loads, Then no push surface appears or an empty surface with helpful guidance

### US3: [P1] Code-Aware Memory Search

**As a** developer mid-session needing specific information
**I want** to search for both what code does (prose summaries) and what code contains (source)
**So that** I can find relevant examples even when I don't remember exact terms

**Why P1:** Differentiator from pure prose memory systems. Code blocks must be first-class.

**Acceptance Scenarios:**
- Given I indexed a function with summary "validates email format", When I search "email validation", Then the prose summary is returned with the linked source code
- Given I indexed code containing "jwt.verify(token)", When I search "jwt", Then the code block is found even if the prose summary doesn't mention JWT
- Given I search for a concept, When results are returned, Then related memories are discovered through graph edges (related_to, exemplifies, refines)
- Given I'm offline, When I search, Then results are returned via keyword search without requiring external API calls

### US4: [P1] Explicit Memory Creation

**As a** developer discovering a pattern or making a decision
**I want** to explicitly store a memory with type and priority
**So that** important information doesn't depend on automatic extraction quality

**Why P1:** Backup for extraction failures and user control. Required for trust.

**Acceptance Scenarios:**
- Given I recognize a gotcha during debugging, When I create a memory with type "gotcha" and high priority, Then it appears in future push surfaces
- Given I document a project-specific pattern, When I create a memory without global flag, Then it's stored in the project database only
- Given I document a reusable architectural decision, When I create a memory with global flag, Then it's accessible from all projects
- Given I pin a critical memory, When time passes, Then the memory's confidence does not decay

### US5: [P2] Memory Consolidation

**As a** developer with growing memory stores
**I want** duplicate or redundant memories to be identified and merged
**So that** my push surface doesn't contain repetitive information

**Why P2:** Quality of life. System degrades without this, but not immediately broken.

**Acceptance Scenarios:**
- Given two memories with >0.7 similarity are created, When I trigger consolidation, Then I'm prompted to merge them with a combined summary
- Given I approve a merge, When consolidation completes, Then one memory supersedes the other and the old memory is marked superseded
- Given consolidation is triggered, When errors occur, Then I can rollback to the pre-consolidation state
- Given consolidation runs automatically after threshold, When it completes, Then I'm notified of merge suggestions for review

### US6: [P2] Semantic Recall Mid-Session

**As a** developer working on a task
**I want** to search memories semantically by concept
**So that** I find relevant context even with different phrasing

**Why P2:** Important for deep sessions, but push surface covers 80% of needs.

**Acceptance Scenarios:**
- Given memories exist about "authentication flow", When I search "user login process", Then semantically similar memories are returned
- Given I search for a concept, When multiple memories match, Then results are ranked by relevance (similarity), importance (priority), and freshness (access recency)
- Given I search with branch filter, When results are returned, Then only memories from specified branch context are included
- Given I access a memory via search, When I view it, Then access count increments and last accessed time updates

### US7: [P2] Code Block Indexing

**As a** developer wanting to preserve explanations with code
**I want** to index a code block with a prose summary
**So that** the code is searchable by what it does, not just what it contains

**Why P2:** Enables code-aware search. Required for US3 but can be manually triggered initially.

**Acceptance Scenarios:**
- Given I provide a file path and summary, When I index the code, Then a prose memory is created (embedded) and linked to a code memory (raw source) via source_of edge
- Given I search for the prose summary, When results are returned, Then the linked code block is included in output
- Given a file is re-indexed, When indexing completes, Then the old code memory is marked superseded by the new version
- Given I index code on a feature branch, When I switch branches, Then the code memory is associated with the branch context

### US8: [P3] Memory Forgetting

**As a** developer with outdated memories
**I want** to archive or delete specific memories
**So that** incorrect or obsolete information doesn't pollute future surfaces

**Why P3:** Edge case cleanup. Lifecycle decay handles most cases automatically.

**Acceptance Scenarios:**
- Given I identify an incorrect memory, When I forget it by ID, Then it's immediately archived and excluded from push surfaces
- Given I don't know the memory ID, When I forget by fuzzy query, Then matching memories are shown for selection before archival
- Given a memory is archived, When it's accessed via search, Then it's restored to active status
- Given a memory remains archived for 30 days, When lifecycle runs, Then it's permanently deleted (pruned)

### US9: [P3] Memory Lifecycle Management

**As a** developer with long-term memory stores
**I want** old, unused memories to automatically decay and archive
**So that** push surfaces prioritize recent, relevant information

**Why P3:** Automated cleanup. Important for long-term quality but not critical for v1 adoption.

**Acceptance Scenarios:**
- Given a progress memory ages without access, When 7 days pass, Then its confidence decays by half
- Given a memory reaches confidence <0.3 for 14 days, When lifecycle runs, Then it's archived
- Given an architecture memory ages, When time passes, Then its confidence remains stable (no decay)
- Given a memory has high centrality (many graph connections), When lifecycle runs, Then it's exempt from archival despite low confidence

---

## Functional Requirements

### Core Extraction Requirements

- FR-001: System MUST extract memories automatically at session end without user action
- FR-002: System MUST parse conversation transcripts to identify decisions, patterns, gotchas, code descriptions, and progress updates
- FR-003: System MUST extract session context including branch name, recent commits, and changed files
- FR-004: System MUST track cursor position in transcript via extractions table (session_id, cursor_position, extracted_at) to resume extraction if interrupted. Cursor persists in SQLite extractions table between sessions.
- FR-005: System MUST classify extracted memories into types: architecture, decision, pattern, gotcha, context, progress, code_description, code
- FR-006: System MUST classify memories as project-scoped or global-scoped based on content analysis
- FR-007: System MUST assign confidence score (0-1) to each extracted memory based on clarity and relevance
- FR-008: System MUST assign priority (1-10) to each extracted memory based on importance
- FR-009: System MUST complete extraction within 30 seconds (p95) to avoid session end delays
- FR-010: System MUST handle extraction errors without blocking session closure
- FR-011: System MUST log extraction errors to inspect later without surfacing to user
- FR-012: System MUST support resumable extraction if session transcript exceeds 100KB threshold by checkpointing cursor position to extractions table

### Push Surface Requirements

- FR-013: System MUST generate a context push surface immediately after extraction
- FR-014: System MUST target 300-500 tokens for push surface content
- FR-015: System MUST rank memories by composite score: confidence × priority × centrality × access frequency
- FR-016: System MUST apply per-category line budgets to prevent single category dominance (architecture 25, decision 25, pattern 25, gotcha 20, progress 30, context 15, code_description 10)
- FR-017: System MUST allow category budget overflow if high-value memories exceed soft caps
- FR-018: System MUST redistribute unused category budget to other categories
- FR-019: System MUST cache push surface keyed by (branch, cwd) for instant session startup
- FR-020: System MUST boost memories tagged with current branch when generating surface
- FR-021: System MUST serve cached push surface at session start if available
- FR-022: System MUST invalidate push surface cache when new memories are extracted
- FR-023: System MUST indicate cache staleness if surface is >24 hours old
- FR-024: System MUST write push surface to `.claude/cortex-memory.local.md` for auto-loading
- FR-025: System MUST write push surface between CORTEX_MEMORY markers for stable integration
- FR-026: System MUST ensure `.claude/cortex-memory.local.md` is gitignored
- FR-027: System MUST complete push surface generation within 5 seconds (p95)
- FR-028: System MUST use PID-based file locking to prevent concurrent surface writes
- FR-029: System MUST detect stale locks (PID no longer running) and override

### Search Requirements

- FR-030: System MUST support semantic search by embedding query text and computing cosine similarity
- FR-031: System MUST search both project and global memory databases
- FR-032: System MUST return top 10 results by default
- FR-033: System MUST support filtering search results by branch context
- FR-034: System MUST fall back to keyword search (FTS5) when embeddings unavailable
- FR-035: System MUST follow graph edges to include related memories in search results (depth 2)
- FR-036: System MUST follow source_of edges to include linked code blocks when prose summaries match
- FR-037: System MUST update access count and last accessed timestamp when memories are retrieved
- FR-038: System MUST complete semantic search within 2 seconds (p95)
- FR-039: System MUST prefix query embeddings with metadata `[memory_type] [project:name]` for aligned search
- FR-040: System MUST support graph traversal from a memory by ID to discover connected memories with depth limit of 2 (maximum 2 hops from source node)

### Memory Creation Requirements

- FR-041: System MUST support explicit memory creation with content, type, and priority
- FR-042: System MUST allow users to specify global vs project scope for memories
- FR-043: System MUST allow users to pin memories to prevent confidence decay
- FR-044: System MUST support tagging memories with arbitrary labels
- FR-045: System MUST queue embeddings for asynchronously created memories
- FR-046: System MUST backfill missing embeddings in background at next session start

### Code Indexing Requirements

- FR-047: System MUST support indexing code files with prose summaries
- FR-048: System MUST store prose summaries as embedded memories (memory_type: code_description)
- FR-049: System MUST store raw code content as unembedded memories (memory_type: code)
- FR-050: System MUST link prose and code memories via source_of edges
- FR-051: System MUST track file path and line ranges for code memories
- FR-052: System MUST support re-indexing files to supersede old versions
- FR-053: System MUST NOT send raw code content to embedding API
- FR-054: System SHOULD support batch indexing of directories [DEFERRED: v2 feature - recursive directory indexing]
- FR-055: System MAY auto-trigger re-indexing when files are modified [DEFERRED: v2 feature - auto-trigger on Write/Edit tools]

### Graph Requirements

- FR-056: System MUST support typed edges between memories: relates_to, derived_from, contradicts, exemplifies, refines, supersedes, source_of
- FR-057: System MUST compute similarity between new memories and existing memories
- FR-058: System MUST create relates_to edges for similarity 0.1-0.5
- FR-059: System MUST create suggested edges for similarity 0.4-0.5 requiring user review
- FR-060: System MUST flag memory pairs with similarity >0.5 for consolidation
- FR-061: System MUST apply Jaccard pre-filter before embedding similarity to reduce API calls
- FR-062: System MUST normalize edge type aliases before storage (e.g., "derives" → "derived_from")
- FR-063: System MUST prevent duplicate edges (same source, target, relation_type)
- FR-064: System MUST support bidirectional edges
- FR-065: System MUST assign strength (0-1) to edges
- FR-066: System MUST compute in-degree centrality for memories based on incoming edges
- FR-067: System MUST support graph traversal (BFS) from memory ID with depth limit
- FR-068: System MUST support filtering traversal by edge type, direction, and minimum strength
- FR-069: System MUST group traversal results by depth
- FR-070: System MUST prevent infinite loops during traversal via visited set

### Consolidation Requirements

- FR-071: System MUST detect duplicate memories via semantic similarity
- FR-072: System MUST trigger consolidation automatically after 10 extractions
- FR-073: System MUST trigger consolidation automatically when active memory count exceeds 80
- FR-074: System MUST present memory pairs with similarity >0.5 for user review
- FR-075: System MUST allow users to merge memory pairs with combined summary
- FR-076: System MUST mark merged memory as superseding old memories via edge
- FR-077: System MUST mark superseded memories with status=superseded
- FR-078: System MUST preserve superseded memories (not delete) for auditability
- FR-079: System MUST create database checkpoint before consolidation
- FR-080: System MUST support rollback to checkpoint if consolidation fails or is rejected
- FR-081: System MUST prevent infinite consolidation loops (max 3 passes per trigger)
- FR-082: System MUST NOT allow automatic creation of supersedes edges (human-only)

### Lifecycle Requirements

- FR-083: System MUST apply confidence decay based on memory type and age
- FR-084: System MUST apply half-life decay: architecture/decision/code_description/code=stable, pattern=60d, gotcha=45d, context=30d, progress=7d
- FR-085: System MUST NOT decay pinned memories
- FR-086: System MUST double half-life for memories with access_count >10
- FR-087: System MUST double half-life for memories with centrality >0.5
- FR-088: System MUST archive memories with confidence <0.3 for 14 consecutive days
- FR-089: System MUST exempt high-centrality memories (>0.5) from archival regardless of confidence
- FR-090: System MUST restore archived memories to active status when accessed
- FR-091: System MUST prune (delete) archived memories untouched for 30 days
- FR-092: System MUST run lifecycle operations (decay, archive, prune) at session end after extraction

### Memory Forgetting Requirements

- FR-093: System MUST support archiving memories by ID
- FR-094: System MUST support archiving memories by fuzzy query
- FR-095: System MUST prompt for confirmation before archiving via fuzzy query
- FR-096: System MUST immediately exclude archived memories from push surfaces and search results (unless explicitly requested)

### Storage Requirements

- FR-097: System MUST maintain separate databases for project and global memories
- FR-098: System MUST store project database at `.memory/cortex.db` relative to project root
- FR-099: System MUST store global database at `~/.claude/memory/cortex-global.db`
- FR-100: System MUST enable SQLite WAL mode for concurrent access safety
- FR-101: System MUST enable SQLite FTS5 for keyword search
- FR-102: System MUST store embeddings as BLOB columns (voyage_embedding, local_embedding)
- FR-103: System MUST store memory fields: id, content, summary, memory_type, category, confidence, priority, pinned, source_type, source_session, source_context, tags (JSON), access_count, last_accessed_at, created_at, updated_at, status
- FR-104: System MUST store edge fields: id, source_id, target_id, relation_type, strength, bidirectional, status, created_at
- FR-105: System MUST store extraction checkpoint fields: id, session_id, cursor_position, extracted_at
- FR-106: System MUST enforce unique constraint on (source_id, target_id, relation_type) for edges

### Embedding Requirements

- FR-107: System MUST embed prose summaries using external embedding service
- FR-108: System MUST prefix embedding text with metadata: `[memory_type] [project:name] summary`
- FR-109: System MUST store embedding vectors as BLOBs in database
- FR-110: System MUST support fallback to local embedding model when external service unavailable
- FR-111: System MUST queue embeddings for offline processing
- FR-112: System MUST support both 1024d (Voyage) and 384d (local) embedding dimensions
- FR-113: System MUST compute cosine similarity for semantic search
- FR-114: System MUST normalize vectors before similarity computation

### Integration Requirements

- FR-115: System MUST integrate as native Claude Code plugin (not MCP server)
- FR-116: System MUST provide Stop hook for session-end extraction
- FR-117: System MUST provide Start hook for push surface loading
- FR-118: System MUST provide skills: /recall, /remember, /index-code, /forget, /consolidate, /inspect
- FR-119: System MUST receive Stop hook input as JSON stdin: session_id, transcript_path, cwd
- FR-120: System MUST parse transcript as JSONL format
- FR-121: System MUST write structured telemetry to `.memory/cortex-status.json`
- FR-122: System MUST include in telemetry: last extraction success/failure, memory counts, embedding queue size, cache staleness

---

## Non-Functional Requirements

### Performance

- NFR-001: Extraction MUST complete in <30 seconds (p95)
- NFR-002: Push surface generation MUST complete in <5 seconds (p95)
- NFR-003: Semantic search MUST complete in <2 seconds (p95)
- NFR-004: Keyword search (offline fallback) MUST complete in <500ms (p95)
- NFR-005: System MUST handle 10,000+ memories without performance degradation
- NFR-006: System MUST handle 50,000+ edges without performance degradation

### Cost

- NFR-007: Daily LLM usage MUST cost <$0.15 for 10 sessions
- NFR-008: Embedding API usage MUST stay within free tier limits (200M tokens/month)

### Reliability

- NFR-009: Extraction errors MUST NOT block session closure
- NFR-010: Push surface errors MUST NOT prevent session startup
- NFR-011: Search errors MUST return empty results, not crash
- NFR-012: Database corruption MUST be recoverable via WAL replay
- NFR-013: System MUST create database checkpoints before destructive operations (consolidation, pruning)

### Offline Support

- NFR-014: System MUST support keyword search when embedding API unavailable
- NFR-015: System MUST queue extraction when LLM API unavailable
- NFR-016: System MUST queue embeddings when embedding API unavailable
- NFR-017: System MUST process queued operations at next session when API available

### Security

- NFR-018: System MUST NOT send raw code content to embedding API
- NFR-019: System MUST read API keys from environment variables only (never files)
- NFR-020: System MUST log structured telemetry without sensitive content (no raw transcripts, code, or memory content)

### Testability

- NFR-021: Core domain logic MUST be 90%+ unit testable without mocks
- NFR-022: Pure functions MUST be separated from I/O operations
- NFR-023: Ranking, decay, similarity, centrality functions MUST be pure
- NFR-024: Database, API, filesystem operations MUST be in separate modules

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: 90% of sessions extract memories within 30 seconds
- SC-002: 95% of sessions generate push surfaces within 5 seconds
- SC-003: Push surfaces average 300-500 tokens without overflow >10% of time
- SC-004: Semantic search returns results in <2 seconds for 95% of queries
- SC-005: Zero session closures blocked by extraction errors
- SC-006: Keyword search fallback works for 100% of queries when offline
- SC-007: Code blocks are retrievable via prose summaries in 90% of index attempts
- SC-008: Graph traversal discovers related memories for >80% of searches with depth 2
- SC-009: Daily LLM costs average <$0.10 for 10 sessions over 30 days
- SC-010: Memory stores scale to 10,000+ memories without >5% performance degradation

**Measurement approach:** Instrumentation logs timing, counts, errors to `.memory/cortex-status.json`. /inspect command surfaces telemetry. Integration tests verify offline fallback. Property tests verify ranking invariants (non-negative, bounded, monotonic decay).

---

## Out of Scope

Explicitly NOT part of this feature:

- MCP server architecture (plugin-native only)
- Symbol-level code parsing (only file/line tracking)
- Manual promotion of project memories to global database (/promote skill)
- Graph visualization UI
- Real-time mid-session extraction (only at session end)
- Automated consolidation triggers during session (manual /consolidate only)
- Multi-user or team features
- Memory export/import in v1
- Batch code indexing (recursive directory indexing)
- Auto-triggered code re-indexing on file edits
- Cross-instance memory handoff (Desktop ↔ Code ↔ Web)
- Configurable ranking weights via config file
- Edge strength decay over time
- Hot/cold explicit memory tiers

---

## Dependencies

External factors this feature depends on:

- Claude Code plugin system (hooks: Stop, Start; skills API; agent framework)
- Voyage AI API for embedding generation (voyage-3.5-lite, 1024d)
- Anthropic API for extraction and edge classification (Haiku)
- SQLite with FTS5 extension
- Git repository context (branch, commits, file changes)
- Filesystem access for `.claude/` and `.memory/` directories
- Environment variables for API keys (ANTHROPIC_API_KEY, VOYAGE_API_KEY)

---

## Risks

Known risks and mitigation thoughts (not solutions):

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Extraction too slow for large transcripts | High | Truncate transcript to last N tokens, resume via cursor |
| Embedding API rate limits exceeded | Medium | Queue embeddings, batch process, fallback to local model |
| Memory store grows unbounded | Medium | Lifecycle decay, archival, pruning with tunable thresholds |
| Push surface becomes stale between sessions | Low | Cache invalidation on new extraction, staleness warnings |
| Consolidation creates incorrect merges | Medium | Human review required, checkpoint/rollback safety net |
| Graph traversal hits cycles | Low | Visited set tracking during BFS |
| Concurrent writes corrupt push surface file | Medium | PID-based locking with stale lock detection |
| LLM misclassifies memory scope (global vs project) | Low | Confidence threshold >0.8 for global, manual override via flag |
| Code indexing re-indexes unchanged files | Low | Manual-only in v1, defer auto-triggering to v2 |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Memory | Atomic unit of stored knowledge (prose or code) |
| Push surface | Auto-generated context file loaded at session start |
| Extraction | Process of parsing transcripts to create memories |
| Edge | Typed relationship between two memories in graph |
| Prose-code pairing | Pattern where prose summary is embedded, code stored raw, linked via source_of edge |
| Centrality | In-degree count of memory (number of incoming edges) |
| Consolidation | Process of merging duplicate or redundant memories |
| Supersession | Relation where one memory replaces another via supersedes edge |
| Lifecycle | Automated decay, archival, pruning process |
| Confidence | Score 0-1 indicating memory quality/relevance, subject to decay |
| Priority | Score 1-10 indicating user-assigned importance, stable |
| Category | Classification as project-scoped or global-scoped |
| Memory type | Classification into architecture, decision, pattern, gotcha, context, progress, code_description, code |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-02-08 | Initial draft from brainstorm and unified brief | Claude (specify-agent) |
