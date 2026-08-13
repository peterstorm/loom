# Pi phase-Agent interviews

**Status:** interactive relay not implemented. The architecture-panel interviewer has an explicit fail-fast guard.

**Verified against:** Pi 0.83.0
**Affected flows:** specify questionnaire, standard architecture questionnaire/approach gate, architecture-panel interview/finalization.

## Problem

Loom’s interactive phase templates ask a child Agent to question the user before writing an artifact. Claude Code can surface child `AskUserQuestion` calls to the parent UI. Loom’s Pi subagents run as separate headless print/JSON processes, where `ctx.hasUI` is false.

The child that needs answers and the TUI containing the user are different processes. A prompt instruction cannot bridge that boundary.

This is especially load-bearing for `/loom --panel`: the interview digest determines design-lens and judge-criterion authority. Allowing a headless `arch-interviewer-agent` to invent answers would produce a structurally valid but false foundation for the panel.

`pi/extension.ts` therefore refuses that Agent spawn with an explicit diagnostic. This is a correctness guard, not a missing write grant.

## Pi UI surfaces

| Surface | TUI | RPC mode | print/JSON child |
|---|---:|---:|---:|
| `ctx.ui.select/confirm/input/editor` | Yes | Yes, via UI request/response messages | No |
| `ctx.ui.custom()` | Yes | No | No |
| status/widget notifications | Yes | fire-and-forget support | No |

Pi RPC mode runs a full Agent loop over JSONL stdio. Standard dialog calls emit an `extension_ui_request` and wait for the controlling client to send the matching `extension_ui_response`. This provides a viable relay boundary.

## Options

### Parent interviews before child spawn

The parent asks every question, persists a digest, and starts a headless child afterward.

This is mechanically simple and works well for the panel digest, but it changes ownership: the phase child no longer conducts its own adaptive interview. It is an acceptable non-interactive fallback only when the runbook explicitly defines parent-owned questioning.

### Question files between child runs

A child writes questions and exits; the parent answers; another child consumes the answers.

Rejected. The Agent that understood the codebase cannot adapt in the same turn, artifact publication becomes multi-process/racy, and the user answers after the original child is gone.

### Parent-relayed RPC child

Recommended design:

1. Register an interactive phase tool in the parent extension.
2. Spawn `pi --mode rpc --no-session` with strict JSONL stdio.
3. Stream child progress to the parent tool update.
4. When the child emits `extension_ui_request`, render the standard dialog in the parent TUI.
5. Send an exact matching `extension_ui_response` to child stdin.
6. Continue the same child Agent turn until artifact publication.

This preserves per-phase Agent definitions, model profiles, write grants, context, and in-flow adaptive questioning.

### Run interactive phases in the parent Agent

Rejected as the primary design. It discards per-phase model/Skill policy, child evidence separation, and scoped artifact capability—the boundaries Loom is designed to preserve.

## Recommended implementation boundary

An eventual relay should:

- apply only to interactive phases; headless reviewers/designers/judges/verifiers stay on the normal subagent transport;
- support `select`, `confirm`, `input`, and `editor` requests;
- match request ids exactly and honor timeout/cancel behavior;
- parse strict LF-delimited JSONL and fail closed on malformed frames;
- prevent recursive subagent delegation in the RPC child;
- mint the same Task/scoped write grant the normal Pi path would issue;
- bind child completion to normal request authority and capture;
- have parity tests for success, cancellation, timeout, malformed frames, child crash, and parent shutdown.

## Current operating guidance

- Use Claude Code when a live phase questionnaire or architecture-panel choice is required.
- On Pi, use non-interactive registered workflows such as standalone review, Wave Gate, and remediation normally.
- Do not claim full `/loom` questionnaire parity merely because phase Agents can spawn and write artifacts.
- Do not remove the panel fail-fast guard until a real answer transport is tested end to end.

See [Using Loom with Pi](pi-usage.md) and [the integration guide](migration-claude-code-to-pi.md).
