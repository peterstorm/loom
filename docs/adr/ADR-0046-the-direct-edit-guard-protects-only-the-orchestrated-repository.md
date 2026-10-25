# ADR-0046: The direct-edit guard protects only the Orchestrated Repository

## Status
Accepted (2026-10-25). Fixes the guard-scope defect on branch `fix/direct-edit-guard-scope`. Amended
(2026-10-25, PR 137 remediation): Loom's protected directories stay guarded wherever they lie.

## Context
`block-direct-edits` refuses the parent session's Edit/Write/MultiEdit while a TaskGraph is live, so
implementation goes through phase-sequenced, reviewed subagents. Until now the guard decided only *whether*
a graph was live, never *what* a write targets. Every path was refused. In practice, with an orchestration
live in the main checkout, the parent was blocked from editing an independent fix branch in a sibling
worktree, and from writing to its own session scratchpad under `/tmp`. Neither write can reach the
orchestrated repository. `docs/operations.md` even documented the over-reach ("Write and Edit are refused,
even to a session scratchpad"). The only route left for such writes was Bash, which this guard never sees.

Two inputs were already available. The handler canonicalises the write target, resolving symlinks through
the nearest existing ancestor (`canonicalWritePath`). The engine also has one rule for the project boundary
that owns a State File (`observeTaskGraphProjectBoundary`): the Git working tree holding it, or outside Git
its documented `.claude/state/` / `.pi/state/` layout. Other cases fail.

## Options Considered

1. **Keep guarding every path.**
   - Pros: No change and no new failure modes.
   - Cons: It blocks work that cannot affect the orchestration and pushes operators toward Bash writes,
     which the guard does not see at all.

2. **Scope by `CLAUDE_PROJECT_DIR` / the caller's cwd.**
   - Pros: Cheap, with no Git probe.
   - Cons: It names the session's directory, not the repository that owns the graph. A session in a linked
     worktree, a `LOOM_STATE_PATH` override, or Pi's per-session TaskGraph pointer would each scope the
     guard to the wrong tree. Pi has no `CLAUDE_PROJECT_DIR`.

3. **Scope by the repository that owns the live graph, derived from the resolved graph path (chosen).**
   - Pros: One rule shared with the Wave Gate and implementation briefs. It follows the graph wherever the
     graph was resolved from, including overrides and Pi pointers. It applies identically on both harnesses.
   - Cons: One Git probe per guarded write. It is lazy: the probe runs only for an armed file tool with a
     parseable session id.

## Decision
**The guard applies only when a write's canonical target lies inside the canonical root of the Orchestrated
Repository or inside one of Loom's protected directories. A write whose every target lies outside all of
them is allowed before any admission runs.**

- **Protected directories are always guarded.** `protectedDirs()` in `engine/src/config.ts` names the
  subagent directory (`LOOM_SUBAGENT_DIR`, default `/tmp/claude-subagents`) and the machine-definitions
  directory (`LOOM_MACHINES_DIR`). By default both lie outside the Orchestrated Repository, yet both belong
  to the orchestration. The subagent directory holds the evidence ledger (`.evidence.jsonl`), the `.active`
  roster, the `.machine` bindings and the `.task_graph` pointers. The machine directory holds the gate's
  rules. A parent write there forges trusted evidence, fakes attribution, re-points the session's graph or
  rewrites the gate. The state-file guard covers these directories for Bash only, on both harnesses, so for
  file tools the "outside" allow would have been an open door. The first version of this decision reasoned
  that a write outside the repository cannot reach the orchestration. These directories are exactly such
  writes that can. So a target inside one is never placed `outside`: it is judged like an in-repository
  target, by the same admissions.

- **Pure core** (`engine/src/core/block-direct-edits.ts`). `OrchestratedRepository` (`resolved` with a
  non-empty list of roots and a non-empty list of canonical protected roots, or `unresolved`) and
  `EditTargets` (`resolved` with a non-empty list of paths, or `unresolved`) are values the shell parses.
  `editPlacement` returns `outside` only when both are resolved and no root, repository or protected, guards
  any target. The protected roots are required on the `resolved` variant, so no caller can place a write
  `outside` without them. `guardedByRoot` decides containment on path-segment boundaries:
  `/repo-foo` is not inside `/repo`, and the root itself is inside. A non-absolute input counts as guarded.
  `shouldBlockDirectEdit` takes the placement as a lazy port (`placeEdit` in its options object of
  harness-specific ports), consulted after arming, the file-tool filter and the session-id parse. An
  omitted port means `inside`.
- **Shell** (`engine/src/handlers/pre-tool-use/block-direct-edits.ts`). `orchestratedRepositoryOf` maps each
  armed graph path through `observeTaskGraphProjectBoundary`, then realpaths the root. It also takes
  `protectedDirs()` from the caller and canonicalises each directory the way it canonicalises a target,
  through the nearest existing ancestor, so a symlinked or not-yet-created directory is compared by its real
  location. `canonicalEditTargets` canonicalises each target against the call's cwd. Every resolver failure
  that has a cause answers `unresolved` and is announced on stderr: a Git probe that cannot answer, a State
  File at no documented layout outside Git, or an uncanonicalisable repository root or protected directory
  (for example a dangling symlink). A missing, malformed or uncanonicalisable target answers `unresolved`
  too. No armed graph also answers `unresolved`, silently, because nothing failed. Either way every target
  stays guarded. On Claude Code the graph path is `taskGraphPath()`, the same path the arming probe
  checked.
- **`LOOM_STATE_PATH`**. The override is judged by the same boundary rule as a discovered graph, probed from
  the State File's own directory, never from the caller's cwd. Inside a Git working tree, that working tree
  is the Orchestrated Repository. Outside Git, the documented layout names it: `<root>/.claude/state/`,
  `<root>/.pi/state/`, or the directory directly holding the file. A file under some other `state/`
  directory has no derivable boundary and leaves the repository `unresolved`, so every write stays guarded.
- **Pi** (`pi/extension.ts`). Pointer-based arming is unchanged. The repository is the union of roots of the
  cwd-resolved graph (when present) and the graph the session's `<session>.task_graph` pointer names. A
  pointer that cannot be read or parsed leaves the repository `unresolved`. The protected directories come
  from the same `protectedDirs()`. Targets are every path
  `piWriteTargetPaths` reads, resolved against `ctx.cwd`. Malformed input stays `unresolved`. A
  rejected-grant session is still refused unconditionally, before placement. For parity with Claude Code's
  artifact-writer roots, a scoped write grant's scope is checked only for writes placed inside. A write into a
  protected directory is placed inside, so the grant's scope confines it too.
- **Unchanged inside the repository**: roster admission, the implementation binding, artifact-writer roots,
  the invalid-session-id block and malformed-input fail-closed behavior. The State File always lies inside
  its own Orchestrated Repository, and Bash writes to it remain the separate state-file guard's concern.
- **Nested worktrees** (for example `<root>/.claude/worktrees/agent-*`) lie inside the root by path and stay
  guarded. Exempting them would take a per-target Git probe, and the conservative answer costs only a
  refusal.

## Consequences

**Positive:**
- The parent can work in other worktrees and in its scratchpad while an orchestration is live, with no Bash
  workaround.
- Scope follows the graph itself, so overrides, linked worktrees and Pi pointers scope correctly.
- Both harnesses decide placement through one pure function and one pair of resolvers.
- Loom's own evidence, roster, pointers and machine definitions keep file-tool protection wherever
  `LOOM_SUBAGENT_DIR` and `LOOM_MACHINES_DIR` point.

**Negative:**
- A Git subprocess runs per guarded file write (lazily). A Git probe that fails keeps the guard on
  everywhere for that call, which matches the old behavior.
- Writer roles may now write outside the repository as well (scratch files). Their artifact roots and grant
  scopes no longer confine writes the orchestration cannot see.
- Inside a protected directory the ordinary admissions still apply. This guard does not refuse an admitted
  implementation agent or write-grant holder there, just as it does not inside the repository.
- A nested worktree under the orchestrated root stays guarded even when it is an independent branch. Place
  independent worktrees outside the root (for example as siblings) to edit them during orchestration.
