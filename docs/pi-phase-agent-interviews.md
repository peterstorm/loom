# Pi Interactive Phase Transport

**Status:** implemented for Pi 0.83.0.

**Interactive roles:** `specify-agent`, `clarify-agent`, `architecture-agent`, `arch-interviewer-agent`.

## Problem

Loom's interactive phase templates require a child Agent to question the user before publishing an authoritative artifact. Pi's generic `subagent` extension launches print/JSON children where `ctx.hasUI` is false, so the child that understands the codebase and the parent TUI containing the user are different processes.

This is load-bearing for `/loom --panel`: the interview digest determines design lenses and judge criteria. A headless child must never fabricate answers.

## Shipped design

Loom registers a dedicated `loom_interactive_subagent` tool in the parent Pi extension:

1. Spawn one validated generated Loom Agent with `pi --mode rpc --no-session`.
2. Load `pi/ask-user-question.ts` in that child and expose an `AskUserQuestion`-compatible tool.
3. Parse child stdout as strict LF-delimited JSONL. U+2028/U+2029 remain ordinary JSON string content; malformed, oversized, or unterminated frames fail closed.
4. Translate child `extension_ui_request` frames into the parent `ctx.ui.select`, `confirm`, `input`, or `editor` dialog.
5. Send one method-correct `extension_ui_response` with the exact request id to child stdin.
6. Keep the same child process and Agent turn alive through follow-up questions and artifact publication.
7. Return the normal `details.results` shape so Loom's existing reservation, write-grant, phase-advancement, request-capture, and result-reconciliation path remains authoritative.

The normal `subagent` transport now refuses all four interactive roles and names `loom_interactive_subagent` as the remedy. Headless reviewers, implementation Agents, designers, judges, and verifiers continue through the generic subagent transport.

## Authority and safety

- Spawn Admission receives the selected transport as data and admits an interactive role only on `interactive-rpc`.
- The interactive transport accepts exactly one Agent; concurrent TUI interviews are unrepresentable.
- The generated user Agent is byte-compared with the active Loom package again immediately before process spawn.
- The child uses the rendered Agent's exact model, system prompt, preloaded Skills, and tool allowlist plus `AskUserQuestion`.
- `subagent` and `loom_interactive_subagent` are excluded from the child tool allowlist, preventing recursive delegation.
- Existing scoped Pi write grants are injected before the custom tool executes and consumed by the child Loom extension before its first Agent turn.
- Dialog cancellation is returned as cancellation, never converted into a selected value.
- Parent abort, timeout, protocol failure, child crash, and session shutdown terminate the child process; a five-second grace period is followed by `SIGKILL`.
- RPC frames are capped at 4 MiB and the complete stdout stream at 64 MiB. Stderr is capped at 1 MiB.
- Child completion requires `agent_settled`; process exit alone cannot mint a successful result.

## AskUserQuestion behavior

The RPC child tool supports one to four questions per call:

- single-select options with descriptions and previews;
- a custom free-text answer;
- multi-select through deterministic option toggles and an explicit Done action;
- sequential batches while preserving the Agent's context.

The tool returns semantic option labels to the Agent rather than the rendered label/description/preview string.

## Usage

The `/loom` runbook routes the interactive roles automatically by instruction:

- Pi: `loom_interactive_subagent`
- Claude Code: native Agent/Task tool

A direct normal Pi `subagent` call for an interactive role is deliberately blocked.

## Validation

Focused coverage includes:

- strict RPC parser and arbitrary UTF-8 chunk boundaries;
- U+2028/U+2029 and unterminated-frame behavior;
- request-id-preserving parent relay;
- same-child-turn completion through a real fake RPC subprocess;
- stale generated-Agent refusal;
- single, multiple, custom, and cancelled answers;
- normal-headless refusal and interactive admission;
- existing Pi extension lifecycle/write-grant integration.

See [Using Loom with Pi](pi-usage.md) and [the integration guide](migration-claude-code-to-pi.md).
