# PR Remediation — Round 3 (run.s4UrYPhQYQ)

- **Branch:** `feat/architecture-panel-mode-plan`
- **Head at review:** `13f0e0c`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.s4UrYPhQYQ`
- **Canonical result:** `result.json` (digest `ac648ea759e83dfb911fcfedad34389b8b99050c518cea1503bc97def32c7534`)
- **Adjudication:** 4 criticals found → 2 survived the Refutation Panel (reproduction / intent / security lenses, 3/3), 1 refuted (3/3). 17 advisories.

## Mandatory surviving criticals

### C1 — `silent-failure-hunter-1` — unguarded `StateManager.fromSession` can crash the whole subagent `tool_result` dispatch

- **Location:** `pi/extension.ts:1399` (inside `finalizeReservedImplementations`) and `pi/extension.ts:1526` (missing review/spec-check persistence), both inside the `pi.on("tool_result")` subagent handler registered at `pi/extension.ts:1287`.
- **Claim:** The handler's documented invariant is per-result isolation ("a throw while processing result #1 must not abort results #2..N"), and the sibling `manager.update` calls are guarded for exactly this reason — but the two `StateManager.fromSession(reservation.sessionId)` calls sit OUTSIDE every try block. `StateManager.fromSession` → `resolveTaskGraph` (`engine/src/state-manager.ts:61-90`) throws on any non-ENOENT read of `<subagentDir>/<sessionId>.task_graph` (EACCES, EIO, ELOOP, ENOTDIR — "refusing local task-graph fallback"). One unreadable pointer file therefore aborts the entire batch: no implementation finalization, no `evidence_capture_failed` marking for missing reviews, no capture terminalization, no pointer cleanup, zero loom diagnostics, tasks stuck `executing`.
- **Panel:** upheld 3/3 (reproduction, intent, security).
- **Fix:**
  1. Site 1 (`finalizeReservedImplementations`): wrap `StateManager.fromSession` in try/catch; on throw write `loom(pi): cannot finalize reserved implementation attempts for session <id> — task graph pointer unreadable: <cause>` to stderr and `return [diagnostic]` (same shape as the existing `manager.update` catch directly below it).
  2. Site 2 (missing reviews/spec-checks): wrap `StateManager.fromSession` in try/catch; on throw record `cannot persist N missing reserved review result(s) and M missing reserved spec-check result(s) for session <id> — task graph pointer unreadable: <cause>` in `processingErrors` + stderr, keep `manager = null`, and skip the ad-hoc / `task graph unavailable` null-manager branches (a `pointerReadFailed` flag distinguishes "unreadable" from "genuinely absent") so the batch continues into the per-result evidence loop.
  3. Update the surrounding comments: the handler guards BOTH the pointer resolution and the `update` — an unguarded throw at either escapes the whole handler.
- **Regression tests** (`engine/tests/pi-extension-review-events.test.ts`, next to the existing graphless-spawn tests at ~678/720): with the session pointer file replaced by a symlink loop (ELOOP, the fail-closed test class already used at :3664), drive (a) a failed reserved implementation result and (b) a mismatched reserved review result; assert the named pointer-unreadable diagnostic is written, `processingErrors` is populated, no `isError` response is produced by the handler aborting, and the graphless ad-hoc assertions (`no task graph to finalize` / `no task graph to record them against`) do NOT fire (the pointer is present-but-unreadable, not absent).

### C2 — `comment-analyzer-1` — `WRAPPER_FLAG_ARGS` misclassifies boolean flags → fail-open heredoc bypass

- **Location:** `engine/src/core/guard-state-file.ts:721` (doc comment), 723-741 (table), 871-874 (the `-S` special case inside `unwrapWrapper`).
- **Claim:** The comment asserts every listed wrapper option "CONSUME[s] the next token", but `sudo -S` (`--stdin`), `env -0` (`--null`), `env -v` (`--debug`), and `watch -d` (`--differences`) are BOOLEAN flags (verified against sudo 1.9.17, GNU coreutils env, procps-ng 4.0.6). Because `unwrapWrapper` does `i += 2` for each listed flag, `env -0 bash << 'EOF'`, `env -v bash << 'EOF'`, `watch -d bash << 'EOF'` swallow the wrapped interpreter, `resolvedInterpreter` lands on the wrapper (null), the quoted heredoc body is treated as opaque data, and `guardStateFileDecision` returns ALLOW while the controls (`env bash`, `sudo bash`, `nice 5 bash`, `nohup bash`, `env -u FOO bash`, `timeout 5 bash`, `sudo -u root bash`) all BLOCK. `sudo -S bash` is blocked only incidentally: the unscoped `-S`/`--split-string` special case (documented as "the option VALUE is the whole command line" — true for `env -S`, false for `sudo -S`) re-splits the next token as the command; `sudo -S -u root bash << 'EOF'` is ALLOWED today for the same reason. Reproduced against the frozen source.
- **Panel:** upheld 3/3.
- **Fix:**
  1. Remove the boolean flags from `WRAPPER_FLAG_ARGS`: `sudo: -S`, `env: -0, -v`, `watch: -d`. They then fall through to the plain flag-skip branch and the wrapped command resolves correctly.
  2. Scope the `-S`/`--split-string` special case in `unwrapWrapper` to `head === "env"` — split-string semantics belong to `env`; for every other wrapper `-S` is a plain flag. (This also closes the `sudo -S -u root bash` allow that the finding's reproduction implies.)
  3. Correct the line-721 comment: the table lists argument-CONSUMING options only; boolean flags are deliberately excluded and take the flag-skip path.
  4. Correct the special-case comment: it describes `env -S '…'` / `env --split-string '…'` only, and notes `sudo -S` (read password from stdin) is boolean and therefore NOT split.
- **Regression tests** (`engine/tests/handlers/pre-tool-use/guard-state-file.test.ts`, extending "wrapped interpreters are unwrapped" at ~1089): add deny cases `env -0 bash`, `env -v bash`, `watch -d bash`, `sudo -S bash`, `sudo -S -u root bash` — each with a quoted heredoc containing the guarded write — all must be `block`.

## Advisory dispositions (17)

14 accepted (all fixed) + 3 deferred + 0 dismissed. (The 17th advisory,
`code-simplifier-6`, was dispositioned at implementation time after the table
was written — see its row above; its single-caller sub-claim became stale
because the accepted `pr-test-analyzer-3` fix added the second consumer.)

### Accepted (14)

| id | file:line | fix |
|----|-----------|-----|
| `code-reviewer-1` | `engine/src/core/test-evidence.ts:50` | A non-zero `N failed` tally on the SAME LINE as the pass tally now vetoes the pass verdict (the pytest summary line is one verdict unit: `2 failed, 6 passed in 0.42s`); the cross-line ordering exemption (a pass line after an earlier failure line) is unchanged. Fix the "rejects pytest with failures" test in `engine/tests/handlers/update-task-status.test.ts` that is green for the wrong reason (its fixture `===== 6 passed, 2 failed =====` never matches the pytest pass regex) by pinning the REAL shape `===== 2 failed, 6 passed in 0.42s =====`. Rationale: latent fail-open in a trust-relevant classifier; every call site is backstopped today, but the classification contract says the opposite of the code. |
| `code-reviewer-2` | `.claude/plans/2026-08-21-pr-remediation-round2.md:90` (+ 4 older plan references) | Fix the stale VALIDATION COMMAND in round2 (`tests/handlers/store-reviewer-findings.test.ts` → `tests/handlers/subagent-stop/store-reviewer-findings.test.ts`): vitest treats unmatched CLI file args as filters, so the command as written exits 0 without running the named suite. The four older references (08-04 “Exact Review Scope”, round28 “Frozen scope”, round30 “Exact frozen review scope”, round40’s scope-artifact observation) are verbatim records of each round’s frozen `result.json.scope` / contemporaneous observations — the 0-byte stale file genuinely was in scope then. Rewriting them would falsify the review record, so they are deliberately untouched (documented deviation from this plan’s original “fix all five” wording). |
| `silent-failure-hunter-2` | `pi/extension.ts:1086` | Wrap `sweepStaleSessions` and `sweepExpiredPiWriteGrants` each in their own try/catch in the `session_start` handler; write `loom(pi): session_start sweep failed: <name>: <cause>` on throw. Hygiene, not authority — `consumePiWriteGrant` independently rejects expired/MAC-invalid grants. |
| `silent-failure-hunter-3` | `pi/extension.ts:739` | Wrap `materializePiResources(PACKAGE_ROOT, PI_RESOURCE_CACHE)` in the `resources_discover` handler: write `loom(pi): resource materialization failed — skills/agents unavailable: <cause>` then RE-THROW so Pi still fails discovery loudly. |
| `pr-test-analyzer-1` | `engine/src/utils/hook-diagnostic.ts:19` | New `engine/tests/utils/hook-diagnostic.test.ts` pinning the dual-channel contract: stderr gets exactly one trailing newline (input with/without trailing newline, multiple trailing newlines), `systemMessage` strips ALL trailing newlines, empty message edge. 9 call sites depend on "discarded findings cannot look like clean reviews". |
| `pr-test-analyzer-3` | `engine/src/core/shell-command.ts:23` | New `engine/tests/core/shell-command.test.ts` pinning the extracted parser directly: `splitCommandSegmentsWithOps` (quoted separators, `&&`/`\|\|`/`;`/`\|`/`&` boundaries, `|&` opBefore, `&>` vs `&`, backslash escapes, empty input), `stripComment` (unquoted only), `stripEnvPrefix`, `classifyFdDupWord` (`>&word` semantics), `hasUnbalancedQuotes`. The module is now imported directly by `pi/transcript-adapter.ts` and is pinned only indirectly today. |
| `type-design-analyzer-2` | `engine/src/core/shell-command.ts:3` | `shell-command.ts` drops its local `QUOTE_CHARS`/`QuoteChar`/`isQuoteChar` and imports `SHELL_QUOTE_CHARS`/`ShellQuoteChar`/`isShellQuoteChar` from `shell-quoting.ts` (which it already imports `scanUnquoted` from); the same dedup applies to the third copy at `engine/src/machine/extract-evidence.ts:42-46` (the finding named `shell-normalize.ts`; the actual third copy is in extract-evidence). The "one quote alphabet" claim in `shell-quoting.ts:13` becomes true. |
| `type-design-analyzer-3` | `engine/src/core/shell-normalize.ts:31` | Re-point the header's "via the colonlessDefaultsEmpty base in referencesPattern" (line 31) and "via the alternateFormsReveal base in referencesPattern" (line 39) at the mechanism that actually exists: `referencesPattern` tests the guard's set-state views through the `collapseVariants` cross-product over the unset/blanked/completed forms, and no production caller passes the removed flags. |
| `comment-analyzer-3` | `engine/src/config.ts:503` | Split the `rg` exclusion qualifier: `--pre <cmd>` executes an arbitrary program per input file; `--hostname-bin <cmd>` executes one program once to resolve the hostname. The exclusion itself is unchanged (arbitrary program execution under any use). |
| `code-simplifier-2` | `engine/src/machine/extract-evidence.ts:31` | Delete the 8-symbol `core/shell-command` re-export block (no importer exists) and the `CommandSegment`/`SegmentOp` re-export hop in `engine/src/machine/index.ts:37-38` (no importer exists). Real consumers import `core/shell-command` directly. |
| `code-simplifier-3` | `pi/extension.ts:186` | Convert the five nested ternaries flagged by the project's own `engine/src/linter/programmatic/no-nested-ternary.ts` rule to `if`/early-return (or `match`) shapes: `pi/extension.ts:186` (`piSpawnItem`), `:204` (`piSpawnCwd`), `:1463` (failure message), `pi/transcript-adapter.ts:104` (`contentBlocks`), `:350` (`verdict` chain). Behavior byte-identical. |
| `code-simplifier-4` | `engine/src/core/shell-normalize.ts:6` | Replace the two stale references to the guard's matching view `collapseQuotes` (header line 6, `NormalizeOptions` doc ~line 202) with the actual entry point `collapseVariants` (`guard-state-file.ts:179`). |
| `code-simplifier-5` | `pi/extension.ts:144` | Unify the fail-closed task-graph probe. `config.ts` gains one shared core `probePathFailClosed(path, diagnostic)` carrying the ENOENT-only-absent semantics; the existing `config.ts` `pathExistsFailClosed` becomes a thin wrapper keeping its exact `loom: … assuming present (fail closed)` text; the Pi-side copy at `pi/extension.ts:144` delegates to the shared core and keeps its pinned `loom(pi): pathExistsFailClosed … assuming active (fail closed)` text (regex-pinned at `engine/tests/pi-extension-review-events.test.ts:3664`). `config.ts` exports ONE `defaultTaskGraphExists` that both `block-direct-edits.ts:71` and `guard-state-file.ts:1793` import instead of byte-identical twins. |
| `code-simplifier-6` | `engine/src/core/guard-state-file.ts:1385` | Two sub-claims, dispositioned separately. **(a) `groupExecutesStdin`** — ACCEPTED and applied: verified single forward to `commandsExecuteStdin(group, 0)` with a doc block whose unique content (group fate-sharing, compound-internal `;`, inline-program recursion) is already carried by the caller `heredocBodyIsScript`'s doc and the callee's doc. Folded into the sole caller (`heredocBodyIsScript`) with a depth-0 comment; function and doc deleted; header walker-map reference updated. Behavior byte-identical (same callee, same args). **(b) `splitCommandSegments` "exactly one caller"** — STALE ON ARRIVAL, NOT applied: the accepted `pr-test-analyzer-3` fix added a second real consumer (`tests/core/shell-command.test.ts` pins it directly), and the deletion test now cuts the other way — deleting it would scatter the texts-only projection into `extractShellWriteTargets` and force the pin test to re-derive it. Kept. |

### Deferred (3) — with concrete reasons

| id | reason |
|----|--------|
| `pr-test-analyzer-2` (no-follow-fs.ts:620, Darwin `removeRunFileNoFollow` branch) | The branch is fail-closed by construction and is exercised only by `it.runIf(process.platform === "darwin")`. This host is Linux and the repository carries no CI configuration in scope; a Darwin runner is a process/infrastructure change, not a code fix. Re-raise when a Darwin leg exists. |
| `comment-analyzer-2` (shell-normalize.ts:45, frozen scope omits imported modules) | This is a review-ENGINE scope-policy observation, not a defect in a reviewed file: the frozen scope is deliberately the changed-path union (497 files), and switching to import closure would grow every run's frozen source several-fold. Defer to a dedicated scope-policy change that weighs packet size against comment verifiability. |
| `code-simplifier-1` (533 dead exports, repo-wide) | A mechanical bulk change across 15+ modules (worst: `remediation-machine.ts` 39/78 exports dead) where every deleted export must be re-proven against consumers OUTSIDE the frozen scope (hooks, scripts, plugin wiring). The project's own `rules/typescript-patterns.md` prescribes a dedicated `knip`/`ts-prune` pass for exactly this pool. Defer to a dedicated dead-export pass with a fresh review run. |

### Refuted-finding audit (reported, NEVER fixed)

| id | claim | panel outcome |
|----|-------|---------------|
| `type-design-analyzer-1` | "The frozen scope declares `engine/tests/handlers/store-review-findings.test.ts` yet the frozen source records it `kind: 'absent'`, so no reviewer could inspect it." | **Refuted 3/3 (reproduction, intent, security).** The run's own immutable artifacts contradict the claim: `program.json` records that path's `scopeSafety` status as `safe` (no `absent` entry for it), the decoded frozen source contains a `kind: "text"` record with a real digest, and the full 329-line file materializes in `contexts/decoded/frozen/`. The finding conflated it with the DIFFERENTLY-NAMED `engine/tests/handlers/store-reviewer-findings.test.ts` (no "er"), which was deleted upstream and IS honestly recorded `absent` — the pr-test-analyzer independently identified that file as the single deleted in-scope path. No remediation; no code action. |

## Support paths (not in frozen review scope — registered at remediation start)

- `.claude/plans/2026-08-21-pr-remediation-round3.md` (this plan)
- `engine/tests/utils/hook-diagnostic.test.ts` (new regression pin)
- `engine/tests/core/shell-command.test.ts` (new regression pin)

Every other touched path is inside the frozen 497-path scope.

## Validation

```bash
cd /home/peterstorm/dev/claude-plugins/loom
# type gates
bun run typecheck          # strict + unused (engine scope)
# full unit suite (188 files / ~4890 tests at review)
bunx vitest run
# the two directly-affected suites, named explicitly
bunx vitest run engine/tests/core/guard-state-file-coverage.test.ts engine/tests/handlers/pre-tool-use/guard-state-file.test.ts engine/tests/pi-extension-review-events.test.ts engine/tests/handlers/update-task-status.test.ts engine/tests/core/shell-command.test.ts engine/tests/utils/hook-diagnostic.test.ts
# wire contract (stamped reviewer fragments)
bun scripts/stamp-wire-contract.ts --check
```

Pass criteria: all green; the new deny cases (`env -0`/`env -v`/`watch -d`/`sudo -S`/`sudo -S -u root` heredoc shapes) block; the pytest failure shape classifies `passed: false`; the ELOOP-pointer regression tests show the named diagnostic and a batch that continues.

## Phase 4 status — blocked on Pi runtime skew (environmental, evidence below)

### Validation results (all remediation code complete and verified)

| gate | result |
|------|--------|
| `bun run typecheck` (strict + unused) | clean |
| full unit suite (`vitest run`) | 4925 passed / 1 skipped / 3 failed — see skew proof |
| `bun scripts/stamp-wire-contract.ts --check` | "wire contract regions match the fragment" |

**The 3 failures are environmental Pi runtime skew, not regressions.** All three are in
`engine/tests/handlers/helpers/orchestration.test.ts` (Pi-spawn-batch publishing under
`PI_CODING_AGENT=true`). This session's live Pi process loaded the Loom runtime at
session start (revision `sha256:c91c1234…`), and this remediation changed
`engine/src/**` + `pi/**` (the content-hashed revision roots), so the on-disk checkout is
now `sha256:755e2022…`. The CLI handshake correctly fails closed. Proof: with all
remediation edits stashed (pristine session-start revision),
`orchestration.test.ts` passes **93/93**; with the edits restored it is the only failing
file, and the failure text is the skew diagnostic verbatim. A fresh Pi process (post-
`/reload` or CI) loads the current checkout and passes.

### Blocked remediation start

Run id named: `run.2iemjjaf1u`. `helper orchestration start remediation` exited 1 at the
runtime handshake **before any side effect** — no run directory was created, nothing is
registered, nothing to abandon.

```text
Loom runtime version skew detected; no CLI mutation was performed. Pi loaded runtime
revision sha256:c91c1234be4be7e96d2197c01666e9999ee39b2c8b1e125e3321e81da402d7ac, but
the checkout is sha256:755e20222c99696ddc2f0aecafa6e52f82cb9e609528b9f6211c63e8c0b61218.
Run /reload in Pi (or fully exit and restart Pi), then retry the exact command.
```

### Recovery (operator action required, then the exact commands)

1. In Pi: run `/reload` (or fully exit and restart Pi) so the in-memory Loom runtime
   matches the checkout on disk.
2. Retry the exact start (same run id — the handshake exit registered nothing, so this
   is a first registration of `run.2iemjjaf1u`):

```bash
cd /home/peterstorm/dev/claude-plugins/loom
bun engine/src/cli.ts helper orchestration start remediation \
  --runs-root ".claude/reviews/review-and-fix-runs" \
  --run "run.2iemjjaf1u" <<'JSON'
{
  "sourceRunsRoot":".claude/reviews/review-and-fix-runs",
  "sourceRun":"run.s4UrYPhQYQ",
  "supportPaths":[".claude/plans/2026-08-21-pr-remediation-round3.md","engine/tests/core/shell-command.test.ts","engine/tests/utils/hook-diagnostic.test.ts"]
}
JSON
```

3. `helper orchestration resume` (same run id) until `done` — the engine verifies and
   installs the index.
4. Commit the installed index and push (no force-push).
