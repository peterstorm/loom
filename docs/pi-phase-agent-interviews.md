# Pi phase-agent interviews: AskUserQuestion for headless subagents

**Status:** design decision — fail-fast gate IMPLEMENTED for the panel
interviewer (2026-08-13); the question relay / headless interview path remains
open.
**Date:** 2026-08-13 · pi 0.83.0
**Relates to:** loom issue #20 (template contract mismatches under pi), panel-mode
`arch-interviewer-agent` flow, phase templates §3 "Interview the User".

---

## 1. Problem

Phase templates (`phase-specify.md` §3, `phase-architecture.md` §3, `phase-arch-interview.md`)
instruct subagents to interview the user via `AskUserQuestion` before writing their
artifact. This works in Claude Code (subagents raise questions to the parent TUI
in-process). It is structurally impossible in pi as currently wired:

- Loom phase agents run as headless children: `pi --mode json -p` (see the
  `subagent` extension, `~/.pi/agent/extensions/subagent/index.ts`).
- `ctx.hasUI` is `false` in print (`-p`) and JSON modes → all `ctx.ui` dialogs fail.
- The child that needs the answer is a separate process; the user lives in the
  parent TUI session.

Same template-contract-mismatch class as the Write grant fix in #20 — the templates
promise a capability the harness does not deliver.

Also affected: `arch-interviewer-agent` in `--panel` mode — it must produce
`interview.md` (the digest is validated by `panel-contract interview` and drives
lens/judge selection), but under pi it cannot actually interview anyone.

## 2. pi's UI surfaces (verified against pi 0.83.0 docs)

| Surface | tui | rpc | print/json (subagent children) |
|---|---|---|---|
| `ctx.ui.select/confirm/input/editor` | yes | yes (via `extension_ui_request`/`extension_ui_response`) | **no** (`ctx.hasUI` false) |
| `ctx.ui.custom()` (full TUI components) | yes | **`undefined`** | no |
| `ctx.ui.notify/setStatus/setWidget` | yes | yes (fire-and-forget) | no |

Key mechanics (docs/rpc.md → "Extension UI Protocol"):

- `pi --mode rpc` runs the **full agent loop** headless over JSONL stdio; the pi
  process executes tools itself; the client sends prompts (`{"type":"prompt",...}`)
  and receives events.
- Dialog methods block the child until the client writes
  `{"type":"extension_ui_response","id":<matching id>, ...}` on stdin.
- Strict JSONL framing: LF only, no `readline`.
- In rpc children, `ctx.ui.custom()` returns `undefined` — the child's question
  tool must use the standard dialogs (`select`/`input`/`editor`); the *parent*
  renders with `ctx.ui.custom()` (it is real TUI mode) for the fancy picker.

## 3. Options evaluated

### A. Parent-side interviewing, answers persisted to files ("the docs approach")

Parent (main session) asks the phase questionnaire at the phase boundary and
writes answers to an interview file the child consumes
(`.claude/specs/{slug}/interview.md`; panel mode already has `interview.md` +
`panel-contract interview`).

- **Pros:** trivial machinery; single spawn per phase; uses the existing panel
  digest contract.
- **Cons:** answers never reach the child that would use them mid-turn. The phase
  agent must write its artifact *before* the user answers (or after a re-spawn),
  inverting the promised "interview FIRST, then write" flow. Not in-flow UX.

### B. Child→parent relay via question files, asked at phase-advance boundaries

Child writes question JSONs; parent extension asks at `tool_result`/advance-phase;
answers read by *later* spawns.

- **Rejected:** structurally broken feedback loop — the child that drafted the
  questions has exited before the user answers; questions are answered after the
  artifact draft exists; adds cross-process file races for the worst of both worlds.

### C. RPC-driven interactive children with parent-relayed dialogs (RECOMMENDED)

Loom registers a `loom-phase` custom tool whose `execute` drives the whole
interactive phase:

1. Spawn the phase agent as `pi --mode rpc --no-session <flags>` with piped
   stdio owned by the loom extension (add `--exclude-tools subagent` to prevent
   self-delegation loops; the child loads the same packages/settings, so the
   loom extension, guards, write grants, and evidence machinery all run inside it
   unchanged — RPC mode is the same agent runtime).
2. Pump the child's JSONL event stream; forward progress to the parent TUI via
   tool `onUpdate`.
3. On `extension_ui_request` (the child's question tool is blocked waiting):
   render the picker **in the parent TUI** (`ctx.ui.custom` — the shipped
   `question.ts`/`questionnaire.ts` examples from the pi package are the template;
   options list, ↑↓/Enter/Esc, "type something" editor), then write
   `extension_ui_response` back to the child's stdin.
4. The child's tool call resolves, the model continues **in the same turn**, and
   writes the artifact once, informed by the answers.

Result: the Claude Code AskUserQuestion UX with zero intermediate docs, and the
panel interviewer becomes genuinely able to interview (`interview.md` digest
contract unchanged).

- **Cons / risks:**
  - A second child-execution path: rpc children for interactive phases
    (brainstorm, specify, architecture, panel interviewer), plain subagent
    children everywhere else.
  - The extension becomes an RPC driver: strict-LF framing, event pump, dialog
    relay, and fail-closed handling of malformed/non-JSONL frames (very loom).
  - `ctx.ui.custom()` is unavailable *inside* the child (rpc), so the child tool
    uses `select`/`input`/`editor` and the parent does the rich rendering.
  - RPC-protocol stability across pi upgrades — the protocol is documented;
    pin the minimum pi version.

### D. In-session phase agents (no subagent for interactive phases)

The parent model runs the interview phase directly with a question tool.

- **Rejected for loom:** discards the per-phase agent definitions, model profiles,
  scoped write grants, artifact dirs, and evidence separation that loom is built
  around; context pollution in the parent session.

## 4. Recommendation

Build **C** — the RPC relay — scoped to the interactive phases only
(brainstorm, specify, architecture; panel-mode interviewer). Keep headless
subagent children for everything non-interactive. The docs approach (A) is a
fallback for non-interactive pi invocation modes (`-p`, JSON clients), not the
primary UX.

Implementation notes for when we return:

- `loom-phase` tool registered in `pi/extension.ts` (`executionMode: "sequential"`).
- Child spawn: `pi --mode rpc --no-session -p`-less; wire stdio; strict JSONL
  parser (split on `\n` only; strip trailing `\r`; never `readline`).
- Dialog relay: match `extension_ui_request.id` exactly; support `select`,
  `confirm`, `input`, `editor`; honour `timeout` (agent auto-resolves).
- The child's `question` tool: port `examples/extensions/question.ts` but replace
  `ctx.ui.custom` with standard dialogs (rpc constraint); the parent renders the
  full custom component.
- Grants: the loom extension spawns the child itself, so it can mint the scoped
  write grant directly (no marker-in-prompt dance) once the child session id is
  known.
- Templates: swap "Use `AskUserQuestion`" → "use the `question` tool" (kept true
  under both harnesses once the tool exists; Claude Code's native tool still
  works for the other harness).
- Validation spike (cheap first step): a `loom-phase` tool that drives one rpc
  child and relays a single `select` dialog end-to-end.
