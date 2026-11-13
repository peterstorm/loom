# Pi adapter

Loom runs on Claude Code and on Pi from one repository. This document is for contributors: how the Pi adapter maps onto the shared engine, which module owns what, and what to do when adding shared behaviour. To install and operate Loom on Pi, read [Using Loom with Pi](pi-usage.md).

## Design goal

Harness adapters differ only where the harnesses differ. Domain policy, persisted types, parsers, reducers, model profiles, lint, proof, panel logic and orchestration programs are shared.

```text
Claude Code hooks ─┐
                   ├─ handlers/parsers ─ deterministic core ─ persistence/effects
Pi extension ──────┘
```

Two prose implementations that look alike are not shared behaviour. Shared behaviour calls the same core function or is pinned by a parity test.

## Concept mapping

| Claude Code | Pi | Shared Loom seam |
|---|---|---|
| Plugin manifest | Pi package `package.json` | Package root derived by each adapter |
| Slash command markdown | Rendered prompt/Skill resources | Shared `commands/`/`skills/` source |
| Agent markdown | Generated user Agent definition | `core/model-profiles.ts`, `utils/render-pi-agent.ts` |
| PreToolUse | `tool_call` | Core guards/validators |
| PostToolUse | `tool_result` | Linter/evidence/capture adapters |
| SubagentStart/Stop | subagent tool call/result lifecycle | State transitions and capture core |
| SessionStart | extension session hooks | cleanup/resume helpers |
| `${CLAUDE_PLUGIN_ROOT}` | rendered absolute package root | `pi/resources.ts` |
| in-process child | separate Pi process | Pi write grants and native correlators |
| `AskUserQuestion` in child | `loom_interactive_subagent` RPC relay | Interactive Phase Transport + exact UI request ids |
| `.claude/state/` | `.pi/state/` | `StateManager`, harness-aware config |
| `.claude/linter/rules/` | the same `.claude/linter/rules/` (`.pi/linter/rules/` only in a project without it) | one harness-independent rules directory (`projectRulesLayout`) |

A project has one rules directory, read by both harnesses: the first present of `.claude/linter/rules/`, then `.pi/linter/rules/`. `lint-project` refuses a project that carries both. `PI_CODING_AGENT` or an explicit `PI_CODING_AGENT_DIR` identifies Pi operation and selects the state path.

## Package layout and identity

The root package is both the Claude Code plugin source and a Pi package:

```text
.claude-plugin/plugin.json    Claude Code metadata
hooks/hooks.json              Claude Code lifecycle registration
hooks/scripts/                thin Bun CLI shims
package.json                  Pi extension registration
pi/                           the Pi adapter
engine/src/                   shared engine
commands/ skills/ agents/     shared semantic resources
```

`package.json` statically registers only `pi/extension.ts`. Commands and Skills are contributed at `resources_discover`, after rendering, so Pi never loads Markdown that still holds an unexpanded Claude Code token.

Claude Code expands `${CLAUDE_PLUGIN_ROOT}` in plugin resources. Pi has no equivalent token, so `pi/extension.ts` derives the active package root from its own `import.meta.url`, and `pi/resources.ts` replaces every root token with that exact path. Never infer package identity from:

- the current working directory;
- a Git root;
- a Claude Code plugin cache while running Pi;
- another installed copy of Loom.

A root containing characters that cannot be interpolated safely into the shared shell snippets is rejected, never partially escaped.

## Adapter modules

`pi/extension.ts` is the registration shell. It maps Pi's `tool_call`, `tool_result`, Agent lifecycle and resource discovery events to the same core decisions the Claude Code hooks reach, owns the per-process session state those handlers share, and captures the content-addressed Runtime Revision that child CLI processes are checked against. The rest of the adapter lives in modules beside it:

| Concern | Modules |
|---|---|
| Prepare a spawn batch: observe its TaskGraph, expand implementation brief markers, run spawn admission | `spawn-preparation.ts`, `implementation-brief-expansion.ts`, `spawn-graph.ts` |
| Read and rewrite Pi tool-call payloads; derive per-slot roster identities | `tool-input.ts` |
| Reserve what an admitted batch needs before Pi dispatches it (roster rows, pointer lease, request correlators, review and spec-check authorities, write grants, task execution) | `spawn-lifecycle.ts` |
| Roll a reservation back | `spawn-claims.ts` (pure), `spawn-claim-shell.ts` |
| Hold each parent session's reservations and cleanup debt | `spawn-reservation.ts` |
| Render shared resources | `resources.ts`; the agent directory rule is `engine/src/core/pi-agent-directory.ts` |
| Lower Pi messages for the shared parsers | `transcript-adapter.ts` |
| Settle finished subagent results | `subagent-result-batch.ts` (parse the harness batch), `reserved-slot.ts` (parse a slot's role claims at the spawn), `subagent-settlement.ts` (pure reducers), `subagent-result.ts` (shell, under the TaskGraph lock), `subagent-result-route.ts`, `subagent-stop.ts`, `reserved-results.ts` |
| Mint, activate and revoke write grants | `write-grant.ts`, `child-write-grant.ts` |
| Record a child's tool calls in the parent's evidence ledger | `evidence-recorder.ts` |
| Bind Pi batch items to engine request identities; authenticate issued review requests | `review-run-authority.ts`, `trusted-review-witness.ts` |
| Capture exact result bytes into reserved Run Directory slots | `review-capture.ts` |
| Emission launch and readiness | `emission-launch-bridge.ts`, `emission-readiness-sequence.ts`, `emission-readiness-gate.ts` (pure), `emission-readiness-protocol.ts`, `emission-readiness.ts`, `emission-tool.ts` |
| Keep the routing environment equal to the session's live model | `session-model-env.ts` |
| Release everything a session still holds at shutdown | `session-shutdown.ts` |
| Interactive phase Agents | `interactive-subagent.ts`, `interactive-rpc.ts`, `ask-user-question.ts` |

Before Pi dispatches a batch, `pi/spawn-lifecycle.ts` reserves everything it needs and records each reservation in a claims ledger. `pi/spawn-claims.ts` decides how to roll that ledger back (pure); `pi/spawn-claim-shell.ts` performs the releases. Settlement and session shutdown release through the same ledger, so a refused spawn, a finished batch and a closed session cannot leave a capability behind in different ways.

The evidence recorder registers before every other `tool_result` handler, so a later handler cannot change what it records. `piEvidenceTarget` (pure) decides from the grant state alone whether the child may record. The ledger itself is described in [Guarded Skill Machines](../machines/README.md#the-evidence-ledger).

## Resource rendering

What the renderer does, step by step, is in [Using Loom with Pi](pi-usage.md#shared-resource-rendering). The rule for contributors: a new resource category must be added to the renderer's inventory and to the parity tests. Do not solve it with a cwd-relative path in one command.

## Agent definitions

Source Agents carry `model-profile`, the Claude Code `model`, tools and declared Skills. `bash scripts/sync-pi-agents.sh` generates the Pi definitions; what it emits and when to re-run it is in [Model profiles and calibration](model-profiles-and-calibration.md#pi-agent-generation).

Source `tools` fields always use Claude Code tool names: Claude Code refuses to spawn an Agent with a name it does not recognise, so a Pi name in a source breaks the Claude Code harness. The Pi renderer (`engine/src/core/agent-tools.ts`) accepts block, flow or comma-string forms and rewrites the field as one comma-string line, the only form every Pi consumer reads:

| Claude Code source | Pi rendering |
|---|---|
| `Read` | `read` |
| `Write` | `write` |
| `Edit`, `MultiEdit` | `edit` |
| `Bash` | `bash` |
| `Grep` | `grep` |
| `Glob` | `find`, `ls` |

Output is deduplicated in declaration order. Any other name (a Pi name written in the source included), an empty field, a duplicate `tools` key or an unterminated flow list refuses rendering with a reason that names the offending entries.

## Tool-call guards

Shared core functions decide phase order; Wave, dependency and review order; unresolved prompt-template variables; the expected model and Skill; direct-edit policy; and state-path Bash policy. Claude Code handlers adapt hook JSON to those inputs, and Pi `tool_call` handlers adapt Pi input. Both use the same protected-state read seam, so "no active orchestration" and malformed-state behaviour cannot drift.

A guard shared by both harnesses needs:

1. a harness-neutral input/result function;
2. Claude Code adapter wiring;
3. Pi adapter wiring;
4. fail-closed top-level behaviour where the call is enforcing;
5. parity tests with equivalent payloads and malformed authority.

## Subagent identity and writes

Claude Code subagents run inside the harness lifecycle and are recognised by active-subagent tracking. Pi subagents are separate processes, so the parent issues each one a one-time write grant instead. Grant shapes, role roots and lifetimes are in [Pi write grants](pi-usage.md#pi-write-grants).

When adding a writer role, update the role-driven artifact-scope policy (`engine/src/core/artifact-write-scope.ts`) and its tests. Never infer permission from "the prompt contains a path."

## Completion and transcript capture

Claude Code's SubagentStop has transcript-path conventions. Pi produces structured messages and tool results, which `pi/transcript-adapter.ts` lowers into the evidence and review representations the shared parsers expect.

For registered orchestration programs, both harnesses follow the same path:

1. the engine reserves an `AgentRequestAuthority` and a fixed transcript slot;
2. the adapter records the harness-native id against the request at spawn;
3. on completion, the adapter selects the exact final payload under harness-specific rules;
4. `harness-capture-runtime.ts` publishes the exact bytes into the reserved slot;
5. the program resumes and parses semantics from that immutable capture.

The parent model never copies output. Missing, duplicate, mismatched, surplus or malformed capture fails closed.

Both adapters reuse phase transition resolution, artifact parsing, task-id extraction, modified-path reconciliation, test-evidence interpretation, Finding parsing and spec-check parsing. Pi's structured test evidence is not relabelled as Claude Code ledger trust: provenance is part of the persisted result. A Pi Agent's artifact change is checked against its baseline and grant scope before proof is updated.

## Emission

On the qualified Pi route, a reviewer request (schema 2 or 3) and each issued judge or refutation verdict are **emission-enabled**. The request carries the engine-issued `LOOM_EMISSION_DESCRIPTOR`, and the child registers one emission tool whose parameters are byte-identical to the frozen payload schema for that kind and version:

| Producer | Tool |
|---|---|
| Reviewer payload (the issued binding selects schema version 2 or 3) | `loom_emit_reviewer_payload` |
| Architecture judge verdict | `loom_emit_judge_verdict` |
| Refutation verdict | `loom_emit_refutation_verdict` |

The rendered instructions name the tool as the primary final action and final-message extraction as the fallback. The agent calls the tool once. A successful call returns a minimal terminating acknowledgment, so no further assistant message or model turn is needed.

The engine parser stays authoritative on every route. On the qualified route the provider accepts the schema but does not enforce it, so tool arguments pass the same engine admission a final message would. Which source becomes the payload is decided by one rule:

| Observed | Result |
|---|---|
| No emission call | Final-message extraction, unchanged |
| One complete, correctly bound call with engine-valid arguments | That call, whatever the final text says |
| Exactly one call the engine refused, and a usable final message | Extraction; the refusal is retained and no retry is consumed |
| A refused call and no usable final message | One rejection through the shared attempt budget |
| Two distinct calls | Rejected as ambiguous, even when a final message is valid |
| A call for the wrong request, kind or version, or an incomplete or unusable observation | A typed rejection; it is never treated as "no call" |
| An exact transport replay of one call | Idempotent; not a second call |

Everything else is **extraction-only**, which is a mode and not a failure: Claude Code, archived schema-1 reviewer requests, non-Pi parents, and any route other than the qualified one advertise no emission tool and keep the final-message contract. Task text cannot upgrade an extraction-only request, and archived issued contracts are not rewritten. Loom ships the frozen schemas as its own contract; it never rewrites a schema for a provider and never configures a provider.

Route classes and qualification: [Model profiles and calibration](model-profiles-and-calibration.md#emission-routes-and-qualification). Activation conditions, refusal codes and the retry budget: [Using Loom with Pi](pi-usage.md#emission-activation-readiness-errors-and-retry-budget).

### Emission-enabled child startup

Only an issued, explicitly qualified route can select the frozen emission-tool schema. The parent's admission checks that issuance and its exact descriptor independently, then probes the installed `subagent` launch port. A missing port blocks an emission-enabled spawn before dispatch; it never turns the request into an ordinary JSON-mode child. Extraction-only and other non-emission requests keep the normal launcher path.

For each admitted emission item, the parent passes a one-use launch capability to the shared launcher, keyed by session, tool call and item slot. The v2 synchronous event port returns a closed, one-shot reply through a callback; neither the capability probe nor the launch request is a mutable reply envelope, and an older v1 listener cannot claim v2 readiness. The launcher then:

1. sets `LOOM_EMISSION_BINDING` only in that child's environment;
2. starts Pi in RPC mode without a Task prompt;
3. discovers and invokes `/loom-emission-readiness`;
4. checks the child's request, context, schema, tool, revision and actual active tool set;
5. binds and checks the issued provider and model, after readiness;
6. delivers the Task only when every check passed.

Missing or malformed readiness, a route mismatch, a timeout or a cancellation ends that child without delivering its Task, and without any model request being sent to it. When the launcher attests an exact startup refusal before the Task prompt, the parent verifies its session, tool call, slot, issued request and empty child transcript, and then keeps the same issued request for another launch. An absent, malformed or post-prompt result does not earn that exemption. Parallel items never share a binding, and a retry spawn passes the same barrier.

The pure readiness decision is `pi/emission-readiness-gate.ts`, the verifier's step order is `pi/emission-readiness-sequence.ts`, the child's readiness report is built in `pi/emission-tool.ts`, and the command, entry type and report shape both sides import are in `pi/emission-readiness-protocol.ts`. The transport adapter lives in the separately installed Pi `subagent` extension ([the `subagent` launcher](pi-usage.md#the-subagent-launcher)). The decisions behind this design are [ADR-0013](adr/ADR-0013-model-initiated-emission-terminating-success.md), [ADR-0014](adr/ADR-0014-child-readiness-is-a-launcher-barrier-not-a-notification.md) and [ADR-0018](adr/ADR-0018-one-observation-selection-decision-with-per-path-payload-construction.md).

## Interactive phase transport

Four roles question the user before they publish an artifact: `specify-agent`, `clarify-agent`, `architecture-agent` and `arch-interviewer-agent`. Pi's generic `subagent` extension launches print/JSON children in which `ctx.hasUI` is false, so the child that understands the codebase and the parent TUI that holds the user are different processes. For `/loom --panel` this matters most: the interview digest determines the design lenses and the judge criteria, and a headless child must never invent the answers.

Loom therefore registers `loom_interactive_subagent` in the parent Pi extension. It:

1. spawns one validated generated Loom Agent with `pi --mode rpc --no-session`;
2. loads `pi/ask-user-question.ts` in that child, exposing an `AskUserQuestion`-compatible tool;
3. parses child stdout as strict LF-delimited JSONL (U+2028 and U+2029 stay ordinary JSON string content; a malformed, oversized or unterminated frame fails closed);
4. translates each child `extension_ui_request` frame into the parent's `ctx.ui.select`, `confirm`, `input` or `editor` dialog;
5. sends one `extension_ui_response` with the exact request id to child stdin;
6. keeps the same child process and Agent turn alive through follow-up questions and artifact publication;
7. returns the normal `details.results` shape, so the existing reservation, write-grant, phase-advancement, request-capture and result-reconciliation path stays authoritative.

The normal `subagent` transport refuses the four interactive roles and names `loom_interactive_subagent` as the remedy; every headless role stays on `subagent`. The transport runs against the Pi release pinned in `bun.lock`.

**Authority and safety**

- Spawn admission receives the selected transport as data, admits an interactive role only on `interactive-rpc`, and refuses a headless role there.
- The interactive transport accepts exactly one Agent, so concurrent TUI interviews cannot be expressed.
- The generated user Agent is byte-compared with the active Loom package again immediately before the process is spawned.
- The child uses the rendered Agent's exact model, system prompt, preloaded Skills and tool allowlist, plus `AskUserQuestion`.
- `subagent` and `loom_interactive_subagent` are excluded from the child's tool allowlist, which prevents recursive delegation.
- Scoped write grants are injected before the tool executes and consumed by the child's Loom extension before its first Agent turn.
- A cancelled dialog is returned as a cancellation, never converted into a selected value.
- Parent abort, timeout, protocol failure, child crash and session shutdown terminate the child process; a five-second grace period is followed by `SIGKILL`.
- RPC frames are capped at 4 MiB, the complete stdout stream at 64 MiB and stderr at 1 MiB.
- Completion requires `agent_settled`; process exit alone cannot mint a successful result.

**`AskUserQuestion` in the child** supports one to four questions per call: single-select options with descriptions and previews, a custom free-text answer, multi-select through deterministic option toggles with an explicit Done action, and sequential batches that keep the Agent's context. The tool returns semantic option labels to the Agent, not the rendered label, description and preview string. It supports Pi's standard dialogs; `ctx.ui.custom()` components do not work inside an RPC child.

Tests cover the strict RPC parser over arbitrary UTF-8 chunk boundaries, the request-id-preserving relay, same-child-turn completion through a real fake RPC subprocess, refusal of a stale generated Agent, single, multiple, custom and cancelled answers, and refusal of each role on the wrong transport.

## Adding shared functionality

Use this checklist:

1. **Place policy in the core.** No harness imports, filesystem, env, clock, or process access unless the module is explicitly shell code.
2. **Parse untrusted boundaries.** Do not cast hook/Pi JSON or persisted data.
3. **Define adapter inputs.** Keep harness-specific extraction small.
4. **Wire Claude and Pi.** Preserve each harness’s blocking/error polarity.
5. **Handle identity.** If subagents/results are involved, use request authority and native correlators.
6. **Handle interactivity.** Route only live-question phase roles through the Interactive Phase Transport; never add UI to the headless transport.
7. **Handle writes.** Decide whether the role needs Task-bound, scoped, or no write grant.
8. **Render resources.** Include any new shared files in Pi materialization.
9. **Test parity and faults.** Include stale/malformed/missing/symlink/duplicate cases.
10. **Document the real limitation.** Do not describe unsupported UI or transport as available.

## Validation

```bash
bash scripts/sync-pi-agents.sh
cd engine
bun run typecheck
bun run test:unit
bun run test:smoke
```

Focused Pi suites, run from `engine/`:

```bash
bunx vitest run tests/pi-imports.test.ts
bunx vitest run tests/pi-resources.test.ts
bunx vitest run tests/pi-extension-review-events.test.ts
bunx vitest run tests/pi-write-grant.test.ts
bunx vitest run tests/runtime-resource-portability.test.ts
```

Then run `/reload` in Pi and exercise the changed command from a project with the intended package scope. These are for iteration; the gate before a merge is `npm run verify` ([Operations](development.md#development-validation)).
