# Using Loom with Pi

Loom ships as a native Pi package: its `package.json` exposes one extension (`pi/extension.ts`), the Loom skills and the command templates. It runs the same engine as on Claude Code; the extension supplies tool guards, lifecycle capture, resource rendering and child write grants. This document is for operators. How the adapter is built is in [Pi adapter](pi-adapter.md).

## What works on Pi

Through the shared engine:

- commands and Skills rendered from the active package;
- phase, Wave and Task guards, and protected state under `.pi/state`;
- implementation proof and test-result adaptation;
- immediate and full lint;
- registered standalone review, Refutation Panel, Wave Gate and remediation programs;
- exact model and Skill request policy;
- immutable Run Directories and exact-byte capture of Agent results;
- scoped phase and panel artifact writes, and Task-bound implementation writes;
- emission tools for reviewers, judges and refutation verifiers on the qualified route ([Emission activation](#emission-activation-readiness-errors-and-retry-budget)).

Two limits: Pi children run without the live phase gate of a [Guarded Skill Machine](../machines/README.md#known-residual-limits), and an interactive phase Agent supports Pi's standard dialogs but not custom TUI components.

## Installation

### Local checkout

```bash
pi install /absolute/path/to/loom
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
```

A local package is referenced in place. After source changes, run `/reload`; after generated-Agent inputs change, run `scripts/sync-pi-agents.sh` and then `/reload`.

### Git or npm

```bash
pi install git:github.com/peterstorm/loom@<tag-or-commit>
# or
pi install npm:@peterstorm/loom@<version>
```

A Git ref is pinned on purpose. To adopt a newer Loom version, change the ref or reinstall with the desired ref, then `/reload`. Use an unpinned Git source only when you want `pi update` to follow the repository's default branch.

Run `scripts/sync-pi-agents.sh` from the installed package root, then `/reload`. Generated Agents are written to:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents
```

Do not hand-edit them or copy raw source Agents there.

### The `subagent` launcher

Loom spawns its Agents through Pi's `subagent` tool, which a separately installed Pi extension provides. Loom does not install or upgrade that extension. Two things depend on it:

- **Any Loom spawn** needs a `subagent` extension that reads Agent definitions from the Pi agent directory.
- **An emission-enabled spawn** additionally needs the launcher to expose the `loom:subagent-launch:v2` port. Without it the parent refuses the spawn before dispatch; it does not degrade the request to an ordinary JSON-mode child.

The launcher must be installed under the same `PI_CODING_AGENT_DIR` as the parent session (`extensions/subagent/` below it). Restart Pi or reload its extensions after updating the launcher. Do not set `LOOM_EMISSION_BINDING` in the parent shell or add an emission descriptor to task text by hand: neither is issued request authority.

## Verify the active package

Pi derives the package's identity from the extension module's `import.meta.url`, never from the working directory or a Claude Code installation. The extension exports that root as both `CLAUDE_PLUGIN_ROOT` and `LOOM_PLUGIN_ROOT`; Loom commands, skills and subagents use these variables for package-relative files.

```bash
printf 'LOOM_PLUGIN_ROOT=%s\n' "$LOOM_PLUGIN_ROOT"
test -f "$LOOM_PLUGIN_ROOT/engine/src/cli.ts"
pi list
```

`PI_CODING_AGENT_DIR`, when set to a non-empty value, selects the Pi agent and resource base directory (a leading `~/` expands to the home directory, as in Pi). Otherwise Loom uses `~/.pi/agent`. `PI_CODING_AGENT` is Pi's process identity marker; Loom also treats an explicit `PI_CODING_AGENT_DIR` as Pi context when it selects state and rule paths.

Loom binds the loaded extension and every fresh CLI process to a content-addressed Runtime Revision. A mutating CLI command launched by a Pi process whose extension differs from the checkout is refused before any TaskGraph or Run Directory write; read-only status stays available. The fix is under [Runtime version skew](#runtime-version-skew--restart-required).

## Shared-resource rendering

Shared Markdown contains Claude Code's `${CLAUDE_PLUGIN_ROOT}` token, which Pi does not expand. At `resources_discover`:

1. `pi/extension.ts` derives the package root.
2. `pi/resources.ts` inventories commands, Skills, references and rules.
3. Root tokens are replaced with the active absolute package path.
4. Rendered bytes and inventory are published into a content-addressed cache below the Pi agent directory.
5. Reuse verifies every expected file and its bytes.
6. Corrupt cache entries are quarantined and rebuilt atomically.

Source resource trees must contain regular readable files, not symbolic links. A package root with characters that cannot be interpolated safely is rejected.

## Agent definitions and model routing

`scripts/sync-pi-agents.sh` renders each source Agent into a Pi definition with exact provider, model and thinking frontmatter, expanded package paths, inlined Skill content and an integrity stamp. Every Pi spawn byte-compares the selected user-level definition with a fresh render from the loaded package. Project-local Agent shadowing, a stale definition, an unresolved root token and a missing required Skill are all rejected. The policy behind the bindings is in [Model profiles and calibration](model-profiles-and-calibration.md).

Three routing facts matter to an operator:

- **Pi runs local models only.** Every catalog profile lowers to the one local route the catalog names. A `model-routing.json` rule may explicitly make children inherit a local parent model. Before a spawn batch is emitted, each route its children will launch on is probed; see [the route gate](#a-spawn-batch-is-refused-by-the-route-gate).
- **Routing off the qualified route turns emission off; it is not a mismatch.** The emission tools are qualified on one route. When a routing rule launches a reviewer elsewhere (for example `{"when":{"parentClass":"local"},"use":{"kind":"parent"}}`, inheriting a stronger parent model), the render, the spawn admission and the capture all decide the same thing from the same observation: the task carries no `LOOM_EMISSION_DESCRIPTOR`, the child returns its payload as final-message JSON, and capture expects exactly that. Routing that resolves back onto the qualified route keeps the tool. A rule whose selector includes `workload` never matches a normal `subagent` spawn, because launch resolution supplies no workload; key the rule on `parentClass`, optionally with `agent` or `profile`.
- **The parent model is the session's live model, not the one Pi exported at start.** Loom projects the live model into `PI_PROVIDER` and `PI_MODEL` at `session_start`, before each `tool_call` guard and before subagent-result capture. If a spawn's render and admission ever disagree about the child route, look here first: a hand-edited `PI_MODEL`, a nested Pi process or an adapter that sets the pair itself reintroduces the split.

## Pi write grants

Pi children are separate processes, so Claude Code's active-subagent write exemption cannot be reused.

Before spawn, the parent mints a one-time cryptographic grant and injects its token into only that child's task. The token is stored on disk only as a SHA-256 digest.

Two grant shapes exist:

- **Task-bound implementation grant.** Bound to Agent, Task id, repository cwd, TaskGraph and session; valid for the implementation session.
- **Scoped artifact grant.** For writer roles only. Each writer role has fixed role roots (below); prompt authority may only narrow `.claude/specs`/`.claude/plans` roots to the spec, plan or panel-run directories it names. A prompt path outside the role's roots (plan-alignment reading the plan) is dropped, never granted. Roots a prompt path cannot name (the lint-rule dirs) are granted whole. The direct-edit guard confines a scoped grant holder's Edit/Write/MultiEdit to targets strictly below a granted dir, in the same core decision that places the write. A target it cannot canonicalise (a symlink loop, a dangling symlink) is refused, and so is every guarded write when the grant recorded no authorizing cwd or the tool's cwd is not that cwd.

Read-only roles (reviewers, verifier, judge, decompose and spec-check) receive no grant even if their prompts mention writable-looking paths.

Claude Code applies the same writer-role policy without a grant. `block-direct-edits` admits an Edit/Write/MultiEdit from a writer role only when the calling subagent (PreToolUse `agent_id`) is on the session's active roster with that role and the symlink-resolved target lies strictly inside the role's root under the project directory (`CLAUDE_PROJECT_DIR`):

| Role | Roots |
|---|---|
| brainstorm, specify, clarify, plan-alignment | `.claude/specs/` |
| architecture | `.claude/plans/`, `.claude/specs/`, `.claude/linter/rules/`, `.pi/linter/rules/` (plan, spec tree and panel-run dirs, checkable-invariant lint rules) |
| arch-interviewer, arch-designer | `.claude/specs/` |

These are the role roots both harnesses share; Claude Code applies them whole, with no prompt refinement. The main agent and read-only roles stay blocked even while a writer is active.

On both harnesses, role roots and grant scopes govern only writes into the Orchestrated Repository, the repository that owns the live TaskGraph. A write whose every symlink-resolved target lies outside that repository's root is not the direct-edit guard's concern and passes: a scratch file, another worktree, a sibling directory. Loom's protected directories are the exception. The subagent directory (`LOOM_SUBAGENT_DIR`) and the machine-definitions directory (`LOOM_MACHINES_DIR`) stay guarded wherever they lie, so a parent cannot forge evidence or rewrite the gate there, and a scoped grant's scope still confines writes into them. On Pi the repository comes from the cwd-resolved graph and from the graph named by the session's `.task_graph` pointer; an unreadable pointer keeps every target guarded ([ADR-0046](adr/ADR-0046-the-direct-edit-guard-protects-only-the-orchestrated-repository.md)). `artifactWriterRole` in `engine/src/core/artifact-write-scope.ts` classifies writer roles once for both harnesses.

Outside orchestration (no active TaskGraph for the session) no role receives a grant, implementation agents included. Direct edits are ungated when no TaskGraph exists, so a grant there would authorize nothing that is forbidden, while its Task id binding would refuse a spawn that has no Task id to give. This is what makes a Loom agent usable ad hoc on Pi, matching Claude Code, whose hook shims exit before any gate when no TaskGraph is present.

The child consumes the token before its first model turn. Replay, a wrong Agent, Task or cwd, expiration, a rejected spawn and shutdown all fail closed. Parent tool completion and rollback revoke outstanding grants. A fixed 24-hour ceiling only bounds a grant abandoned by a parent crash; it is not the normal lifetime.

## Registered orchestration capture

A registered `spawn-batch` request contains `LOOM_REQUEST_ID`, the Context Packet digest and path, and the complete request authority. Before dispatch, the extension binds Pi's native tool-call and item identity to that request. On result, it publishes the exact final bytes into the reserved immutable transcript slot and resumes the program from those bytes.

Pi's subagent tool accepts at most eight items per call. A larger engine-issued batch may be split into ordered chunks of at most eight, but requests must not be changed, dropped or duplicated; resume only after every chunk completes.

## Interactive phase Agents

`specify-agent`, `clarify-agent`, `architecture-agent` and `arch-interviewer-agent` ask the user questions. Run them with `loom_interactive_subagent`, which keeps the child Agent alive and shows its `AskUserQuestion` dialogs in the parent Pi TUI. The normal `subagent` tool is headless and refuses these four roles; every other role stays on `subagent`. `/loom` routes them for you. Design: [Interactive phase transport](pi-adapter.md#interactive-phase-transport).

## Emission activation, readiness errors and retry budget

Emission activates only when all of the following hold: the issued request names a producer kind the Agent Catalog authorizes for that Agent, the request's Pi binding is the exact qualified route, [the `subagent` launcher](#the-subagent-launcher) exposes the `loom:subagent-launch:v2` port under the same `PI_CODING_AGENT_DIR` as the parent, and the child passes its readiness barrier. Provider capability flags are operator configuration on the provider side; Loom contributes documentation only and never configures a provider. Which route is qualified, and what requalifies it: [Model profiles and calibration](model-profiles-and-calibration.md#emission-routes-and-qualification).

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

`/reload` is the remediation for **stale Loom resources**: an outdated extension, revision or schema registration. It is not a universal cure. A provider that rejects or ignores the frozen tool schema, a missing or outdated launcher port, and an unqualified route are configuration problems that only requalification or launcher installation fix. No amount of reloading turns an extraction-only route into an emission route.

Emission and extraction rejection share the engine's one request-slot attempt budget: a semantic rejection at attempt 1 permits one fresh attempt-2 spawn, and an attempt-2 failure is terminal. There is no same-spawn correction protocol. Agents are instructed to call the emission tool once and, after one argument refusal, to finish with the final-message fallback. Pi's own in-child validation-retry loop (it re-prompts the model after a tool-argument validation failure, about two extra requests) sits outside that accounting, and calibration counts it in the emission arm's latency budget. One observability limit: the harness exposes parsed tool arguments, not the original generated JSON bytes, so duplicate-key behaviour is never reported as measured.

## Troubleshooting

### `CLAUDE_PLUGIN_ROOT` is unset where a command needs it

The extension sets `CLAUDE_PLUGIN_ROOT` and `LOOM_PLUGIN_ROOT` for Pi subprocesses; if they are missing, the Loom extension is not loaded for this process. Use `LOOM_PLUGIN_ROOT` for diagnostics where the command accepts it. An unresolved Claude Code token in a rendered Pi prompt is a packaging bug.

### Command uses the wrong checkout

```bash
printf '%s\n' "$LOOM_PLUGIN_ROOT"
pi list
```

Project package scope wins over a global entry for the same package identity. Remove or disable the unintended package and `/reload`.

### Agent definitions are stale

```bash
"$LOOM_PLUGIN_ROOT/scripts/sync-pi-agents.sh"
```

Then `/reload`. Make sure you are writing to the `PI_CODING_AGENT_DIR` the active Pi process uses.

### Resource materialization fails

Check that `commands/`, `skills/`, `references/` and `rules/` contain only regular readable files and that the Pi agent directory is writable. Loom rejects symlinked source files and corrupt cache reuse.

### A writer is blocked

Read the diagnostic:

- no grant for a reviewer/judge/verifier is expected;
- no grant for anyone outside orchestration is expected;
- a scoped writer can write only derived artifact roots;
- an implementation grant must match its Task and repository;
- state/evidence paths remain guarded regardless of grant.

Never broaden the grant manually.

### An emission-enabled spawn is refused before dispatch

[The `subagent` launcher](#the-subagent-launcher) under the active `PI_CODING_AGENT_DIR` is missing its `loom:subagent-launch:v2` port, or the installed copy predates it. Install or update the launcher, restart Pi or reload its extensions, and confirm the active agent directory carries it.

### A spawn batch is refused by the route gate

Before a Pi parent emits a spawn batch, each distinct route its children will launch on must answer `GET {baseUrl}/models`, where `baseUrl` comes from Pi's `models.json` in the active agent directory. The launch route is the generated render's binding: the Agent's catalog binding after the `model-routing.json` rules for the observed parent. There is no fallback route. Loom reads only `baseUrl` and never resolves or sends credentials; Pi authenticates the inference itself.

A diagnostic beginning `refusing to spawn:` names every route that cannot run, and ends with one remedy per cause. Nothing was published, so after the fix `resume` re-emits the same batch.

| Route is | Means | Do |
| --- | --- | --- |
| `unreachable` | `GET {baseUrl}/models` was refused, timed out, answered a non-auth error status, or listed models without this one | bring the model server up (or load the model), then resume |
| `unverified` (only under `LOOM_ROUTE_GATE=strict`) | the route answered 401/403 or a 2xx without an OpenAI-style model list, so the served model is unconfirmed | make the route list its models without credentials, or unset `LOOM_ROUTE_GATE`, then resume |
| `unconfigured` | Pi's `models.json` declares no `baseUrl` for the provider — often a `model-routing.json` rule naming an undeclared provider | declare the provider or route the child elsewhere, then resume |
| `retired` | a stored request records a Pi binding its profile no longer issues (today: a cloud route issued before local-only routing, ADR-0023); the diagnostic names the recorded and the current binding | start a fresh run; resume can never recover it |

`LOOM_ROUTE_GATE` is read once per spawn batch from the Pi parent's environment. Unset (or `admit-unverified`) admits an unverified route and reports it on stderr as a `loom-route-unverified` event and in the emitted action's `unverifiedRoutes`; `strict` refuses it — choose it when an authenticating gateway can answer while the model server behind it is down. Any other value refuses the batch rather than falling back to the default.

The stderr event is one JSON line, `{"event":"loom-route-unverified","route":…,"url":…,"cause":"auth-refused"|"unreadable-listing","status":…}`, and the action carries `unverifiedRoutes: [{"route":…,"url":…,"cause":…,"status":…}]`. A batch whose every route listed its model carries no `unverifiedRoutes` field.

A `retired` refusal reads `route <provider/model> (recorded under profile '<profile>') is retired: the request records <recorded binding>, and profile '<profile>' now issues <current binding>`. It is refused without a probe, because a child launches on its profile's current binding and no route change can make the recorded one runnable.

A diagnostic beginning `cannot check Pi route reachability:` means the gate could not read its inputs: fix the named `model-routing.json`, `models.json` or `LOOM_ROUTE_GATE` value, then resume. A diagnostic beginning `Pi orchestration spawn request N:` means a stored request authority no longer parses, so its route cannot be known. The gate applies to every Pi parent (`PI_CODING_AGENT=true`), whether or not the batch announces a session id.

### A child fails the emission readiness barrier

Read the refusal code in the spawn diagnostic and follow the remediation table in [Emission activation, readiness errors and retry budget](#emission-activation-readiness-errors-and-retry-budget). Stale-Loom causes (`readiness-command-absent`, `malformed-readiness`, `unexpected-version`, `schema-digest-mismatch`, `revision-mismatch`) resolve with `/reload`; everything else is a spawn-configuration, launcher or provider problem that reloading will not fix. A provider schema rejection is a route-qualification problem, never a stale-resource problem.

### Interactive phase Agent is refused by `subagent`

This is intentional transport routing, not missing UI support. Re-run `specify-agent`, `clarify-agent`, `architecture-agent` or `arch-interviewer-agent` with `loom_interactive_subagent`. If that tool is absent, reload the active Loom package.

### `Unknown agent: "code-implementer-agent"`

Confirm that a `subagent` extension is enabled ([the `subagent` launcher](#the-subagent-launcher)) and that the Pi agent directory's `agents/` holds the rendered Loom definitions (run `scripts/sync-pi-agents.sh`), then run `/reload`.

### `FATAL: active Loom package is incomplete`

Loom's Pi extension is not loaded, or the package root it resolved is incomplete. Confirm `pi list` includes the Loom package and restart or reload Pi.

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

- [Pi adapter](pi-adapter.md), for contributors
- [Model profiles and calibration](model-profiles-and-calibration.md)
- [Architecture](architecture.md)
- [Workflows](workflows.md)
- [Operations](operations.md)
