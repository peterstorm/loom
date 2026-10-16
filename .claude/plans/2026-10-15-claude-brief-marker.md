# Claude Code implementation brief marker (G4 pilot F5)

- **Branch:** `feat/claude-implementation-brief-marker`
- **Source:** G4 stop-check pilot finding F5. Under Claude Code the parent re-emitted each roughly 51 KB engine-rendered brief verbatim in its Agent call, because the `LOOM_IMPLEMENTATION_BRIEF` marker was Pi-only.

## Probe (2026-10-15, Claude Code 2.1.286)

I ran a scratch project with only project settings loaded, a PreToolUse hook on `Agent` and an echo subagent.

- A hook returning `hookSpecificOutput.updatedInput` with a new `prompt` replaces what the subagent receives. No permission decision is needed, so Loom auto-approves nothing.
- The parent transcript keeps the original marker. The subagent transcript's first message is the expansion.
- Sibling hooks on the same matcher run in parallel on the **original** input, so they see only the marker.

## Design

- `engine/src/handlers/pre-tool-use/implementation-brief-marker.ts`:
  - `expandBriefMarker(input, render)` is pure over a render port. It returns `no-marker | expanded(toolInput, stdin) | refused(message)`. A marker refuses when its brief cannot render or when the spawn names an agent other than the Task's.
  - `withBriefMarkerExpanded(gate, handler)` makes a sibling gate judge the expanded payload, and blocks with the gate's name when the marker cannot expand.
- `validate-task-execution` is the one rewriting hook. It expands the marker, runs every spawn veto and the reservation on the expanded bytes, and returns the new `HookResult` arm `pre-tool-use-rewrite`. `hookSuccessStdout` renders that arm as `hookSpecificOutput.updatedInput`.
- Every `SPAWN_VETOES` entry is wrapped: phase order, template substitution, agent model and agent skill. A test drives every entry, so a new veto that forgets the wrap fails the suite.
- `briefInvocation` now gives Claude Code `claude.prompt`, the same marker Pi gets. `--prompt` remains for reading the brief.

## Fail-closed layers for a marker that never expands

1. The handler: any refusal blocks, and the route is in `FAIL_CLOSED_ROUTES`, so a crash exits 2.
2. The shim: with no active TaskGraph, `validate-task-execution.sh` keeps its fast exit 0 unless the payload mentions `LOOM_IMPLEMENTATION_BRIEF`. Such a payload goes to the engine route, so the core `parseImplementationBriefMarker` remains the one marker grammar, including JSON-escaped whitespace, and an unexpandable marker blocks there.
3. The agent: each of the 7 implementation agent definitions says that a bare marker means the expansion failed, so make no change and stop. This covers the residual case where bun is missing, which makes the hook non-blocking.

## Tests

- `engine/tests/handlers/pre-tool-use/implementation-brief-marker.test.ts`, 24 tests:
  - the pure expansion, plus a property test that a non-marker prompt never renders;
  - the sibling wrapper;
  - the rewrite stdout shape;
  - the reservation hook with fakes;
  - an end-to-end run of the real default hook, which expands the marker against a fixture graph, passes every real veto, reserves T2 and rewrites the call;
  - every `SPAWN_VETOES` default export refusing an unexpandable marker by name (mutation-checked: unwrapping one veto fails it);
  - real hook processes: `validate-task-execution` exits 0 printing the rewrite, and `validate-agent-skill` admits a marker because its brief names the skill, while it still refuses a non-marker one-liner;
  - the shim with no graph: it blocks a marker in compact, JSON-escaped and pretty-printed input, passes a prompt that only mentions the marker, and never starts the engine for one that does not.
- The brief projection tests are updated for `claude.prompt`.
- The real CLI emits exactly the probed shape: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...,"prompt":"# Implementation Agent Context..."}}}`.

## Docs

- `commands/loom.md`: the Implementation briefs section.
- `docs/architecture.md`: the PreToolUse coverage list.

## Not verified

No live Claude Code session spawned a real Loom implementation agent through the installed hook. The probe proved the harness mechanics, and the engine now emits the probed output shape. The first live run is the next Loom feature's Wave.

## Operational note

Editing agent definitions changes the Pi agent renders. After merge, run `scripts/sync-pi-agents.sh`, or Pi's model guard refuses the stale renders.
