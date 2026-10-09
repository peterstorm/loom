# Using Loom with Pi

Loom ships as a first-class native Pi package: its `package.json` exposes one native extension (`pi/extension.ts`), Loom skills, and top-level command templates. It uses the same deterministic engine as Claude Code, with the extension providing tool guards, lifecycle capture, resource rendering, and child write capabilities.

## Support summary

Supported through the shared engine:

- commands and Skills rendered from the active package;
- phase/Wave/task guards and protected `.pi/state`;
- implementation proof and test-result adaptation;
- immediate/full lint;
- registered standalone review, Refutation Panel, Wave Gate, and remediation programs;
- exact model/Skill request policy;
- immutable Run Directories and exact-byte Agent-result capture;
- scoped phase/panel artifact writes and Task-bound implementation writes;
- emission-enabled producer payloads on the qualified route: exact frozen-schema tool registration, the launcher's request-bound readiness barrier, and deterministic emission/extraction source selection (see [Emission-enabled child startup](#emission-enabled-child-startup)).

Interactive phase parity:

- `specify-agent`, `clarify-agent`, `architecture-agent`, and `arch-interviewer-agent` run through Loom's parent-relayed RPC transport. Their `AskUserQuestion` calls appear in the parent Pi TUI while the same child Agent turn remains alive. See [Pi Interactive Phase Transport](pi-phase-agent-interviews.md).

## Interactive phase agents in Pi

Use `loom_interactive_subagent` for the four interactive roles above. The normal `subagent` tool is intentionally headless and refuses them; every reviewer, implementation Agent, designer, judge, verifier, and other non-interactive role remains on normal `subagent`.

## This workstation: dotfiles-managed local package

Home Manager installs the Pi binary and links these directories from the dotfiles repository:

```text
~/.pi/agent/agents      -> ~/.dotfiles/pi/agents
~/.pi/agent/extensions  -> ~/.dotfiles/pi/extensions
~/.pi/agent/prompts     -> ~/.dotfiles/pi/prompts
```

`~/.pi/agent/settings.json` is a mutable copy of `~/.dotfiles/pi/settings.json`. It declares Loom as a live local package:

```json
{
  "packages": [
    "../../dev/claude-plugins/loom",
    "../../dev/claude-plugins/cortex",
    "../../dev/claude-plugins/obsidian",
    "../../dev/claude-plugins/loom-pi-goal/packages/pi-goal"
  ]
}
```

The Loom path resolves relative to `~/.pi/agent/` as `~/dev/claude-plugins/loom`. Pi therefore loads the currently checked-out Loom worktree; no `pi install` or `pi update` is required for normal development.

After changing or pulling Loom:

```bash
cd ~/dev/claude-plugins/loom
git pull
```

Restart Pi or run `/reload`. Run `home-manager switch` only after changing the Home Manager module or dotfiles' default Pi settings.

The dotfiles package supplies a generic `subagent` extension and a small set of generic agents (planner, reviewer, scout, worker). Loom's agent definitions live in the same Pi agent directory as rendered, integrity-stamped files produced by `scripts/sync-pi-agents.sh` (see [Agent sync and model policy](#agent-sync-and-model-policy)); do not hand-edit them or byte-copy raw source agents there. Emission-enabled Pi requests additionally require the shared `subagent` launcher with the `loom:subagent-launch:v2` port installed under the *same* `PI_CODING_AGENT_DIR` as the parent. Installing Loom alone does not install or upgrade that separately owned launcher.

## Installation

### Local checkout

```bash
pi install /absolute/path/to/loom
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
```

A local package is referenced in place. After source changes, run `/reload`; after generated-Agent inputs change, run `scripts/sync-pi-agents.sh` and then `/reload`.

Loom binds the in-memory extension and fresh CLI processes with a content-addressed Runtime Revision. A mutating CLI command launched by a Pi process whose extension predates or differs from the checkout is refused before any TaskGraph or Run Directory write. Read-only orchestration status remains available.

### Git or npm

```bash
pi install git:github.com/peterstorm/loom@<tag-or-commit>
# or
pi install npm:@peterstorm/loom@<version>
```

A Git ref is intentionally pinned. To adopt a newer Loom version, change the ref or reinstall with the desired ref, then `/reload`. Use an unpinned Git source only when you explicitly want `pi update` to follow the repository's default branch.

Run `scripts/sync-pi-agents.sh` from the installed package root, then `/reload`.

Generated Agents are written to:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents
```

## Verify the active package

Pi derives identity from the extension module’s `import.meta.url`, never cwd or a Claude installation. The extension exports that root as both `CLAUDE_PLUGIN_ROOT` and `LOOM_PLUGIN_ROOT`; Loom commands, skills, and subagents use these variables for package-relative files.

```bash
printf 'LOOM_PLUGIN_ROOT=%s\n' "$LOOM_PLUGIN_ROOT"
test -f "$LOOM_PLUGIN_ROOT/engine/src/cli.ts"
pi list
```

`PI_CODING_AGENT_DIR`, when set to a non-empty value, selects the Pi Agent/resource base directory (a leading `~/` expands to the home directory, as in Pi). Otherwise Loom uses `~/.pi/agent`, where `~` is the account home `os.homedir()` reports — the same rule Pi applies, owned once by `engine/src/core/pi-agent-directory.ts` for the Pi extension, the routing-config loader and the model guard. `PI_CODING_AGENT` is Pi’s process identity marker; Loom also treats explicit `PI_CODING_AGENT_DIR` as Pi context for state/rule path selection.

## Shared-resource rendering

Shared Markdown contains Claude Code’s `${CLAUDE_PLUGIN_ROOT}` token. Pi does not expand it.

At `resources_discover`:

1. `pi/extension.ts` derives the package root.
2. `pi/resources.ts` inventories commands, Skills, references, and rules.
3. Root tokens are replaced with the active absolute package path.
4. Rendered bytes and inventory are published into a content-addressed cache.
5. Reuse verifies every expected file and its bytes.
6. Corrupt cache entries are quarantined and rebuilt atomically.

Source resource trees must contain regular readable files, not symbolic links. Package roots with unsafe interpolation characters are rejected rather than partially escaped.

`package.json` statically registers only `pi/extension.ts`; rendered resources are contributed dynamically so Pi never loads unrendered Claude-facing Markdown first.

## Agent sync and model policy

Source Agents map to semantic profiles in `engine/src/core/model-profiles.ts`. The sync script:

- emits exact Pi provider/model/thinking frontmatter;
- expands package paths;
- inlines declared Skill content;
- stamps source/package/full-definition integrity metadata.

Every Pi spawn byte-compares the selected user-global definition with a fresh render from the loaded package. Project-local Agent shadowing, stale definitions, unresolved root tokens, and missing required Skills are rejected.

Pi runs local models only: every catalog profile's Pi binding is `desktop-vllm/glm-5.3-flash-spark-tp2-v14:high`, and launcher routing may explicitly inherit a local parent model for children. The immutable request freezes both harness bindings. Before a spawn batch is emitted, the facade checks that the route each child will launch on (the generated render's binding, routing rules included) answers `GET {baseUrl}/models` (from `models.json`) and refuses the batch, naming the route, if it does not; resume once the server is up. A route that answers without a readable model list (an HTTP 401/403, or a 2xx that is not a model list) is admitted and reported on stderr as a `loom-route-unverified` event and in the emitted action's `unverifiedRoutes` — unless the operator sets `LOOM_ROUTE_GATE=strict`, under which such a route is refused as `unverified` (see [A spawn batch is refused by the route gate](#a-spawn-batch-is-refused-by-the-route-gate)). The gate never guesses past an input it cannot read: a stored request authority that does not parse, a malformed `model-routing.json`, a malformed `models.json` or a `LOOM_ROUTE_GATE` naming no mode each refuse the batch. A run whose stored requests carry a binding their profile no longer issues (today, a retired cloud binding from before local-only routing) is refused as `retired`, naming the recorded and the current binding: start a fresh run instead of resuming. A reviewer request issued under a Pi parent advertises the frozen reviewer emission tool, and the child still must pass the installed launcher's request-bound readiness barrier. Without that launcher, the parent refuses the spawn; it does not silently degrade the issued request.

## Pi write grants

Pi children are separate processes, so Claude’s active-subagent write exemption cannot be reused.

Before spawn, the parent mints a one-time cryptographic grant and injects its token into only that child’s task. The token is stored on disk only as a SHA-256 digest.

Two grant shapes exist:

- **Task-bound implementation grant** — bound to Agent, Task id, repository cwd, TaskGraph, and session; valid for the implementation session.
- **Scoped artifact grant** — for writer roles only. Each writer role has fixed role roots (below); prompt authority may only narrow `.claude/specs`/`.claude/plans` roots to the spec, plan, or panel-run directories it names. A prompt path outside the role's roots (plan-alignment reading the plan) is dropped, never granted. Roots a prompt path cannot name (the lint-rule dirs) are granted whole.

Read-only roles—reviewers, verifier, judge, decompose, and spec-check—receive no grant even if their prompts mention writable-looking paths.

Claude Code applies the same writer-role policy without a grant. `block-direct-edits` admits an Edit/Write/MultiEdit from a writer role only when the **calling** subagent (PreToolUse `agent_id`) is on the session's active roster with that role and the symlink-resolved target lies strictly inside the role's root under the project directory (`CLAUDE_PROJECT_DIR`): brainstorm, specify, clarify, and plan-alignment → `.claude/specs/`; architecture → `.claude/plans/`, `.claude/specs/`, `.claude/linter/rules/`, `.pi/linter/rules/` (plan, spec tree and panel-run dirs, checkable-invariant lint rules); arch-interviewer and arch-designer → `.claude/specs/`. These are the role roots both harnesses share; Claude applies them whole (no prompt refinement). The main agent and read-only roles stay blocked even while a writer is active. `artifactWriterRole` in `engine/src/core/artifact-write-scope.ts` classifies writer roles once for both harnesses.

Outside orchestration—no active TaskGraph for the session—no role receives a grant, including implementation agents. Direct edits are ungated when no TaskGraph exists, so a capability there would authorize nothing already forbidden, while its Task id binding would refuse a spawn that has no Task id to give. This is what makes a Loom agent usable ad hoc on Pi, matching Claude Code, whose hook shims already exit before any gate when no TaskGraph is present. `engine/src/core/pi-write-grant-plan.ts` owns the decision.

The child consumes the token before its first model turn. Replay, wrong Agent/Task/cwd, expiration, rejected spawn, or shutdown fails closed. Parent tool completion and rollback revoke outstanding grants. A fixed 24-hour ceiling only bounds a capability abandoned by a parent crash; it is not the normal lifetime.

## Registered orchestration capture

Registered `spawn-batch` requests contain `LOOM_REQUEST_ID`, Context Packet digest/path, and complete request authority. Before dispatch, the extension binds Pi’s native tool-call/item identity to that request. On result, it publishes the exact final bytes into the reserved immutable transcript slot and resumes program semantics from those bytes.

Pi’s subagent tool accepts at most eight items per call. Large engine-issued batches may be partitioned into ordered chunks of at most eight, but requests must not be changed, dropped, or duplicated; resume only after every chunk completes.

### Emission-enabled child startup

Only an issued, explicitly qualified Pi provider/model route can select the frozen emission-tool schema. Loom's parent admission independently checks that issuance and its exact descriptor, then probes the installed `subagent` launch port. A missing port **blocks an emission-enabled spawn before dispatch**; it never turns a tool-primary request into an ordinary JSON-mode child. Genuinely extraction-only and other non-emission requests retain the normal launcher path.

For each admitted emission item, the parent passes a one-use launch capability to the shared launcher keyed by session, tool call and item slot. The v2 synchronous event port returns a closed, one-shot reply through a callback; neither the capability probe nor the launch request is a mutable reply envelope. An older v1 listener cannot silently claim v2 readiness; ordinary JSON subagents keep their existing launch path. The launcher sets `LOOM_EMISSION_BINDING` only in that child's environment, starts Pi in RPC mode **without a Task prompt**, discovers and invokes `/loom-emission-readiness`, checks the child's request/context/schema/tool/revision and actual active set, binds and checks the issued provider/model *after* readiness, and delivers the Task only on the open decision. Missing or malformed readiness, route mismatch, timeout, and cancellation terminate that child without delivering its Task — and without any model request ever being sent to that child. When the launcher attests an exact pre-Task-prompt startup refusal, the parent verifies its session, tool-call, slot, issued request, and empty child transcript before preserving the **same** issued request for another launch; absent, malformed, or post-prompt results do not earn that retry exemption. Parallel items never share an ambient binding; retry spawns traverse the same barrier. The pure readiness parser/decision lives in `pi/emission-readiness-gate.ts`, and the verifier's step order in `pi/emission-readiness-sequence.ts` (the child's readiness report builder stays in `pi/emission-tool.ts`; the command, entry type and report shape both import are owned by `pi/emission-readiness-protocol.ts`), and the transport adapter lives in the separately installed Pi `subagent` extension.

On this workstation the managed source is `~/.dotfiles/pi/extensions/subagent/`; `~/.pi/agent/extensions/subagent/` is the installed link. Restart Pi or reload its extensions after updating that launcher, and confirm the active `PI_CODING_AGENT_DIR` contains it. Do not provision `LOOM_EMISSION_BINDING` in the parent shell or add a descriptor to task text by hand: neither is issued request authority.

### Emission activation, readiness errors and retry budget

Emission activates only when all of the following hold: the issued request names a producer kind the Agent Catalog authorizes for that Agent, the request's Pi binding is the exact qualified route (`desktop-vllm/glm-5.3-flash-spark-tp2-v14`), the shared `subagent` launcher exposes the `loom:subagent-launch:v2` port under the same `PI_CODING_AGENT_DIR` as the parent, and the child passes its readiness barrier. Provider capability flags are operator configuration on the provider side; Loom contributes documentation only and never configures a provider.

A readiness refusal names its actual cause, and the remediation follows the cause:

| Refusal | Actual cause | Remediation |
|---|---|---|
| `readiness-command-absent` | the child did not register the readiness command | `/reload` the loom extension |
| `malformed-readiness` | the readiness payload does not match the bound readiness contract | `/reload` the extension |
| `unexpected-version` | the child carries a schema version other than the issued one | `/reload` so the child carries the issued frozen schema version |
| `schema-digest-mismatch` | the child registered schema bytes other than the issued frozen bytes | `/reload` so the child registers the issued frozen schema bytes |
| `revision-mismatch` | the child loads a different Loom revision | `/reload` so the child loads the issued revision |
| `unexpected-kind` | the child is provisioned for another producer kind | verify the issued producer kind against the child's spawn configuration |
| `tool-name-mismatch` | the child registered a tool name other than the issued emission tool | verify the child extension registers the exact issued tool name |
| `tool-inactive` | the emission tool is missing from the child spawn's `--tools` allowlist | include the tool in the spawn allowlist |
| `wrong-request` | the observed child holds another request's readiness | spawn a fresh child provisioned for this request |
| `child-unreachable` | the pi runtime or extension wiring cannot reach the child | verify the pi runtime and extension wiring, then respawn |
| `startup-unavailable` | child provisioning or extension startup refused | correct the provisioning or startup refusal, then respawn |
| `readiness-timeout` | the child did not report readiness within the bounded window | inspect the child extension startup, then respawn within the bounded readiness window |
| `route-bind-refused` | the provider/model the gate must bind before prompting is misconfigured | verify the provider/model configuration |
| `cancelled` | startup was cancelled | none — the child was released without prompting |

`/reload` is the remediation for **stale Loom resources** — an outdated extension, revision or schema registration. It is not a universal cure: a provider that rejects or ignores the frozen tool schema, a missing or un-upgraded launcher port, or an unqualified route are configuration problems that only requalification or launcher installation fix. No amount of reloading turns an extraction-only route into an emission route.

Emission and extraction rejection share the engine's one existing request-slot attempt budget: a semantic rejection at attempt 1 permits one fresh attempt-2 spawn, and attempt-2 failure is terminal. There is no same-spawn correction protocol — agents are instructed to call the emission tool once and, after one argument refusal, to finish with the documented final-message fallback instead of re-emitting. Pi's own in-child validation-retry loop (it re-prompts the model after a tool-argument validation failure, ~2 extra requests) sits outside that accounting; calibration counts it in the emission arm's latency budget. One observability limit is recorded honestly: the harness exposes parsed tool arguments, not the original generated JSON bytes, so duplicate-key behavior is never reported as measured.

## Harness behavior

| Capability | Pi implementation |
|---|---|
| Resource/package identity | `pi/resources.ts`, extension `import.meta.url` |
| Tool guards | `pi/extension.ts` `tool_call` handlers + shared core |
| Phase/task state | shared `StateManager` under `.pi/state/` |
| Lint | shared linter from Pi tool results |
| Task completion | shared proof/review/spec core with Pi transcript adaptation |
| Agent writes | one-time Task or scoped grants |
| Agent models/Skills | generated, integrity-checked user definitions |
| Registered result capture | native correlator + shared capture runtime |
| Interactive phase questions | parent-relayed RPC child + standard Pi UI request/response protocol |
| Run persistence | shared anchored Run Directory and orchestration runtime |

The legacy `pi/loom-bridge.ts` bridge was removed; `pi/extension.ts` is the only Pi state adapter, and the package manifest pins the bridge's absence.

## Development workflow

```bash
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
cd engine
bun run typecheck
bun run test:unit
bun run test:smoke
```

Then `/reload` Pi and exercise the affected command from a project that has the intended Loom package scope.

## Troubleshooting

### `CLAUDE_PLUGIN_ROOT` is unset where a command needs it

The native extension sets `CLAUDE_PLUGIN_ROOT` (and `LOOM_PLUGIN_ROOT`) for Pi subprocesses; if it is missing, the loom extension is not loaded for this process. Use `LOOM_PLUGIN_ROOT` for diagnostics where the command accepts it. An unresolved Claude token in a rendered Pi prompt is a packaging bug.

### Command uses the wrong checkout

```bash
printf '%s\n' "$LOOM_PLUGIN_ROOT"
pi list
```

Project package scope wins over a global entry for the same package identity. Remove/disable the unintended package and `/reload`.

### Agent definitions are stale

```bash
"$LOOM_PLUGIN_ROOT/scripts/sync-pi-agents.sh"
```

Then `/reload`. Ensure you are writing to the `PI_CODING_AGENT_DIR` used by the active Pi process.

### Resource materialization fails

Check that `commands/`, `skills/`, `references/`, and `rules/` contain only regular readable files and that the Pi Agent directory is writable. Loom rejects symlinked source files and corrupt cache reuse.

### A writer is blocked

Read the diagnostic:

- no grant for a reviewer/judge/verifier is expected;
- no grant for anyone outside orchestration is expected;
- a scoped writer can write only derived artifact roots;
- an implementation grant must match its Task and repository;
- state/evidence paths remain guarded regardless of grant.

Never broaden the grant manually.

### An emission-enabled spawn is refused before dispatch

The shared `subagent` launcher under the active `PI_CODING_AGENT_DIR` is missing its `loom:subagent-launch:v2` port, or the installed copy predates it. Install or update the separately owned launcher (`~/.dotfiles/pi/extensions/subagent/` on this workstation), restart Pi or reload its extensions, and confirm `~/.pi/agent/extensions/subagent/` carries it. Loom never silently degrades an emission-enabled request to an ordinary JSON-mode child, and provisioning `LOOM_EMISSION_BINDING` by hand or adding a descriptor to task text is not a fix — neither is issued request authority.

### A spawn batch is refused by the route gate

A diagnostic beginning `refusing to spawn:` names every route that cannot run, and ends with one remedy per cause. Nothing was published, so after the fix `resume` re-emits the same batch.

| Route is | Means | Do |
| --- | --- | --- |
| `unreachable` | `GET {baseUrl}/models` was refused, timed out, answered a non-auth error status, or listed models without this one | bring the model server up (or load the model), then resume |
| `unverified` (only under `LOOM_ROUTE_GATE=strict`) | the route answered 401/403 or a 2xx without an OpenAI-style model list, so the served model is unconfirmed | make the route list its models without credentials, or unset `LOOM_ROUTE_GATE`, then resume |
| `unconfigured` | Pi's `models.json` declares no `baseUrl` for the provider — often a `model-routing.json` rule naming an undeclared provider | declare the provider or route the child elsewhere, then resume |
| `retired` | a stored request records a Pi binding its profile no longer issues (today: a cloud route issued before local-only routing, ADR-0023); the diagnostic names the recorded and the current binding | start a fresh run; resume can never recover it |

`LOOM_ROUTE_GATE` is read once per spawn batch from the Pi parent's environment. Unset (or `admit-unverified`) admits an unverified route and reports it on stderr as a `loom-route-unverified` event and in the emitted action's `unverifiedRoutes`; `strict` refuses it — choose it when an authenticating gateway can answer while the model server behind it is down. Any other value refuses the batch rather than falling back to the default.

A diagnostic beginning `cannot check Pi route reachability:` means the gate could not read its inputs: fix the named `model-routing.json`, `models.json` or `LOOM_ROUTE_GATE` value, then resume. A diagnostic beginning `Pi orchestration spawn request N:` means a stored request authority no longer parses, so its route cannot be known.

### A child fails the emission readiness barrier

Read the refusal code in the spawn diagnostic and follow the remediation table in [Emission activation, readiness errors and retry budget](#emission-activation-readiness-errors-and-retry-budget). Stale-Loom causes (`readiness-command-absent`, `malformed-readiness`, `unexpected-version`, `schema-digest-mismatch`, `revision-mismatch`) resolve with `/reload`; everything else is a spawn-configuration, launcher or provider problem that reloading will not fix. A provider schema rejection is a route-qualification problem, never a stale-resource problem.

### Interactive phase Agent is refused by `subagent`

This is intentional transport routing, not missing UI support. Re-run `specify-agent`, `clarify-agent`, `architecture-agent`, or `arch-interviewer-agent` with `loom_interactive_subagent`. If that tool is absent, reload the active Loom package.

### `Unknown agent: "code-implementer-agent"`

Confirm the dotfiles generic `subagent` extension is enabled, that `~/.pi/agent/agents/` holds the rendered Loom definitions (run `scripts/sync-pi-agents.sh`), and run `/reload`.

### `FATAL: active Loom package is incomplete`

Loom's native Pi extension is not loaded (or the package root it resolved is incomplete). Confirm `pi list` includes the Loom package and restart/reload Pi.

### Tasks update twice or state transitions behave unexpectedly

Remove any legacy `loom-bridge` extension from the loaded package set (it no longer ships in the package; an old cached copy is the only source). The native Loom extension is the only state adapter that should process `subagent` results.

### Runtime version skew / restart required

A diagnostic beginning `Loom runtime version skew detected` means the checkout changed after Pi loaded the extension. The TaskGraph is not corrupt, and the refused CLI command performed no mutation.

Run:

```text
/reload
```

If reload is unavailable or fails, fully exit and restart Pi, preserving the session. Then retry the exact idempotent orchestration command. Do not remove newly valid fields, edit the TaskGraph, or recreate a Run Directory.

### State or Wave operation is blocked

Use canonical status and resume the registered program:

```bash
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper orchestration status
```

Do not edit `.pi/state/active_task_graph.json` or Run Directory evidence.

## Further reading

- [Architecture](architecture.md)
- [Workflows](workflows.md)
- [Operations](operations.md)
- [Claude Code and Pi integration guide](migration-claude-code-to-pi.md)
- [Model profiles and calibration](model-profiles-and-calibration.md)
