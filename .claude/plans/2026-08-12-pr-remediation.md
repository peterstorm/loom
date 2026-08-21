# PR Remediation Plan — 2026-08-12

**Branch:** feat/architecture-panel-mode-plan  
**Review Run:** run.p4usmpoZvU  
**Adjudication:** 0 critical surviving, 0 refuted, 16 unique advisories  
**Accepted advisories:** 3 of 16  

## Findings to Fix

### Advisory #2 — Log inaccessible binding diagnostics in `recoverPiSpawnReservation`

**File:** `pi/extension.ts` (~line 455)  
**Problem:** `inaccessibleBindings` array is populated but never used — diagnostics are silently discarded.  
**Fix:** When `recovered.length === 0 && inaccessibleBindings.length > 0`, write a warning to stderr so operators see why orchestration results fell through to the legacy path.

### Advisory #12 — Clarify `createFileProgramJournal` is non-production

**File:** `engine/src/orchestration/fugue-program-runtime.ts` (~line 145)  
**Problem:** Comment describes the TOCTOU race and locking but never says this journal is only for tests/dry-runs. The production path uses `RunDirHandle`'s `journalOperations` with `withAnchoredDirectoryLock`.  
**Fix:** Add a doc comment note clarifying this is the non-production/test journal.

### Advisory #13 — Fix misleading "synchronously" in `promoteArtifactSet` doc

**File:** `engine/src/orchestration/run-directory-handle.ts` (~line 700)  
**Problem:** Doc says failure "cannot be provoked through `publishArtifactSet` synchronously" — implying an async path could reach it. In fact, `publishArtifactSet` holds a lock, so the failure is unreachable in production regardless of sync/async.  
**Fix:** Replace "synchronously" with "through the lock-protected `publishArtifactSet`" or similar.

## Validation

- `bun test` — all existing tests pass
- `bun run typecheck` — no type errors
- No logic changes, only diagnostic logging and comment edits

## Refuted Findings

None — all 0 criticals meant no refutation panel was needed.
