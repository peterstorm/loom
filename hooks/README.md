# Loom hooks (Claude Code)

`hooks/hooks.json` binds Claude Code lifecycle events to the shell shims under `hooks/scripts/`. Every shim delegates to exactly one engine handler — `bun …/engine/src/cli.ts <hook-type> <handler>` — and carries no policy of its own beyond its skip rule and its failure posture. The engine owns every decision; `engine/tests/machine/hooks-sync.test.ts` pins every route a shim invokes into the closed routing table (`KNOWN_HANDLERS` in `engine/src/handler-routes.ts`), so a shim that outlives its handler fails the suite. The Pi adapter binds the same events natively (`pi/extension.ts`); a parity test requires both harnesses to decide identically.

Hooks act only while a run is active: most shims read the run's State File first and drain stdin when no graph exists.

## PreToolUse

| Matcher | Script → handler | What it does | Crash |
|---|---|---|---|
| `Task\|Agent\|subagent` | `validate-phase-order.sh` → `pre-tool-use validate-phase-order` | A spawn must name the active phase's agent and meet the phase's artifact prerequisites | blocks |
| `Task\|Agent\|subagent` | `validate-task-execution.sh` → `pre-tool-use validate-task-execution` | Expands the implementation-brief marker into the rendered brief and runs every spawn veto and the reservation | blocks |
| `Task\|Agent\|subagent` | `validate-template-substitution.sh` → `pre-tool-use validate-template-substitution` | Enforces the template-substitution rules on the spawn's prompt | blocks |
| `Task\|Agent\|subagent` | `validate-agent-model.sh` → `pre-tool-use validate-agent-model` | The spawn's model must match the Task's declared model profile | blocks |
| `Task\|Agent\|subagent` | `validate-agent-skill.sh` → `pre-tool-use validate-agent-skill` | The spawn must carry its required Skill | blocks |
| `Edit`, `Write`, `MultiEdit` (one entry each) | `block-direct-edits.sh` → `pre-tool-use block-direct-edits` | The parent session cannot edit files while a run is active; changes go through attributed Agents | blocks |
| `Edit`, `Write`, `MultiEdit` (one entry each) | `enforce-phase-tools.sh` → `pre-tool-use enforce-phase-tools` | The Guarded Skill Machine's phase gate: an enforced tool outside its phase is denied, deny-by-default | blocks |
| `Bash` | `guard-state-file.sh` → `pre-tool-use guard-state-file` | The Bash guard over protected state: the State File, ledgers, bindings and run directories, judged through the shared shell grammar | blocks |
| `Bash` | `guard-subagent-authority.sh` → `pre-tool-use guard-subagent-authority` | A subagent may write only its audit and orchestration-authority surfaces | blocks |
| `Edit\|Write\|MultiEdit\|Bash` | `rules-gate.sh` → `pre-tool-use rules-gate` | Blocks code mutation until the Loom rules and Skills are in the caller's context and adherence is stated | blocks |

## SubagentStart / SubagentStop

| Event | Matcher | Script → handler | What it does | Crash |
|---|---|---|---|---|
| SubagentStart | `*` | `mark-subagent-active.sh` → `subagent-start mark-subagent-active` | Binds the subagent: roster line, machine epoch, write grant on Pi | blocks |
| SubagentStop | — | `dispatch.sh` → `subagent-stop dispatch` (timeout 300) | The stop dispatcher: routes the stopped agent to its settlement — phase advance, status, findings capture, unbind | non-blocking |

## SessionStart

| Matcher | Script → handler | What it does | Crash |
|---|---|---|---|
| — | `cleanup-stale-subagents.sh` → `session-start cleanup-stale-subagents` | Sweeps subagent state idle past the shared TTL; never deletes the starting session or one whose TaskGraph still exists | non-blocking |
| `clear` | `resume-after-clear.sh` → `session-start resume-after-clear` | Re-injects the active run's context after `/clear` | non-blocking |
| `startup\|clear` | `lint-coverage.sh` → `session-start lint-coverage` | Reports the project's lint coverage state at session start | non-blocking |

## PostToolUse / PostToolUseFailure

| Matcher | Script → handler | What it does | Crash |
|---|---|---|---|
| `Task\|Agent` | `record-orchestration-spawn.sh` → `post-tool-use record-orchestration-spawn` | Records the spawn in the run's orchestration record | non-blocking |
| `Task\|Agent` | `surface-stop-check-notes.sh` → `post-tool-use surface-stop-check-notes` | Surfaces the agent's stop-check notes to the parent session | non-blocking |
| `Edit`, `Write`, `MultiEdit` (one entry each) | `lint-file.sh` → `post-tool-use lint-file` | The immediate lint tier after every edit; a violation blocks (fail-closed) | non-blocking |
| `Edit\|Write\|MultiEdit` (timeout 45) | `type-diagnostics.sh` → `post-tool-use type-diagnostics` | Advisory compiler diagnostics for TypeScript sources | non-blocking |
| `Read\|Edit\|Write\|MultiEdit\|Bash` | `record-evidence.sh` → `post-tool-use record-evidence` | Mints evidence-ledger facts from the tool call (the evidence ledger's minting shell) | non-blocking |
| PostToolUseFailure `Bash` | `record-evidence.sh` → `post-tool-use record-evidence` | The same recorder for a failed Bash call, whose exit and stderr the success event never carries | non-blocking |

## Failure polarity, precisely

Two layers decide what happens when something is broken:

- **A crash outside the handler** (dynamic-import failure, stdin error) exits **2 (blocking)** for the ten PreToolUse gate routes listed in `FAIL_CLOSED_ROUTES` (`engine/src/handler-routes.ts`) and **1 (non-blocking)** for everything else. Exit 1 is non-blocking for a PreToolUse hook, so a gate route must never fail with it: a guard that crashes open is no guard.
- **The shim's own failure posture**: when the runtime itself is unavailable (`CLAUDE_PLUGIN_ROOT` unset, `bun` off PATH) the gates fail closed with a stderr line — a guard that silently disables itself on PATH drift is no guard — while the recorders, the dispatcher and the SessionStart scripts fail open loudly: SubagentStop and SessionStart must never brick a session, but a silent skip says so on stderr.

## Where the depth lives

- The engine-side view of every handler, and what each guards: [Architecture](../docs/architecture.md), especially the system map and the Bash guard.
- The evidence ledger these hooks feed: [Guarded Skill Machines](../machines/README.md).
- Operating the gates (the rules gate, edit-time feedback, advisory diagnostics): [Operations](../docs/operations.md).
- The mechanism-level map of the hook families and their guarantees: [Feature & Guard Map](../docs/feature-guard-map.md).
