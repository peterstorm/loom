# FR-008 feasibility probe — launcher readiness barrier (emission)

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md` (FR-008, AS-020, SC-005)
**Proven against:** installed `pi` 0.83.0 (`/nix/store/w594wdq06kgr892xbz9rlm18irkq98fc-pi-coding-agent-0.83.0`)
**Run:** `node probes/emission-readiness/probe.mjs` (all four variants; ~25s)

## What this probe resolves

The plan-alignment checkpoint marked FR-008 BLOCKED: "the installed normal
subagent launcher starts print-mode Pi with its prompt already supplied. No
supported pre-prompt readiness exchange has been demonstrated." This probe
demonstrates the supported seam and its negative controls, using the plan's own
proof method — a counting provider substitute — so no real model is involved.

## The seam (proven)

`pi --mode rpc` + extension-command readiness + gate-time prompt delivery:

1. **Spawn** the child headless with NO prompt: `pi --mode rpc --no-session -ne -e <loom-extension>`.
2. **Channel check:** `get_state` answers — distinguishes "child up, readiness
   missing" (readiness refusal) from "child never came up" (infrastructure
   failure).
3. **Discovery:** `get_commands` must list the expected readiness command
   (source `extension`) BEFORE it is invoked. An unknown `/command` falls
   through to a normal user prompt and triggers a real model request — so the
   launcher must never invoke an unverified command. A stale/absent extension
   therefore fails by command absence.
4. **Readiness:** the launcher invokes `/loom-emission-readiness` via the RPC
   `prompt` command. Extension commands execute immediately (preflight
   succeeds, **no model request**), and the handler performs the authoritative
   in-process check — `pi.registerTool` + `pi.getActiveTools()` — then reports
   via `pi.appendEntry(customType, payload)`, which emits `entry_appended` on
   the RPC stdout. The payload binds: exact tool name, schema digest, revision,
   child PID, active flag, full tool list.
5. **Gate decision (pure):** the launcher compares the payload against the
   issued expectation (tool, digest, revision, active). Any mismatch refuses.
6. **Route binding (fail-closed):** `set_model` selects the issued
   provider/model and its response identity is compared. A prompt that slips
   past a failed selection would fall through to the child's default real
   provider — the under-capability class the gate exists to prevent.
7. **Deliver:** only on a matching readiness + verified route does the launcher
   send the real prompt. Refusal and timeout never prompt; cleanup kills only
   that child.
8. **In-child defense-in-depth (proven separately):** a `before_agent_start`
   handler returning a pending promise blocks `agent-session.prompt()` between
   `emitBeforeAgentStart` and `_runAgentPrompt` — the first model request
   waits for the hold. (Throwing is NOT a stop: `emit()` catches handler
   exceptions and continues. The hold is the gate; the throw is only a log.)

## Results (2 consecutive full runs, identical verdicts)

| Variant | Readiness | Gate | Prompt sent | Counting-server requests | Verdict |
|---|---|---|---|---|---|
| `matching` | observed, digest+revision+active match | open | yes | **1**, first request after readiness observation | PASS |
| `contradictory` | observed, wrong schema digest | refused (`digest`) | no | **0** | PASS |
| `missing` | command never registered (stale/absent extension shape) | refused (absent) | no | **0** | PASS |
| `held` | observed + matching | open, then child hold delays the first request | yes | **1**, request ≥ hold resolution | PASS |

`PROBE PASS` (4/4). The held variant's ordering: holdResolvedAt → +61ms → first
request (assertion slack 250ms). Readiness-to-first-request in the matching
variant: +53ms. Child startup (spawn → readiness available) measured ~1.7–2.0s;
the gate adds two RPC roundtrips on top of it — calibration (US6) must include
this startup cost in the p95 budget.

## Mechanics the production integration must honor (discovered here)

- **Action methods cannot be called during extension loading** — the loom
  child extension must register its tool/provider/appendEntry inside event
  handlers (e.g. a command or `session_start`), never at factory top level.
- **Startup events never reach the launcher:** `rebindSession()` emits
  `session_start` BEFORE the RPC loop attaches its stdout subscription — a
  readiness signal appended in `session_start` is invisible. Readiness MUST be
  command-invoked at gate time (this also makes it fresh and request-bound).
- **Unknown commands fall through to real model requests:** discovery
  (`get_commands`) precedes invocation, always.
- **No CLI route lock for extension-registered providers:** `--provider probe`
  at startup errors ("Unknown provider") because registration happens in the
  extension. The gate's `set_model`-before-prompt fail-closed step is what
  prevents fall-through to the default real provider.
- **Model definitions need `input` and `cost`** — a minimal def omitting them
  crashes pi-ai client-side (`reading 'includes'`) before any request.
- **Tool errors are thrown, never returned** (returning never sets `isError`);
  `terminate: true` from `execute` skips the follow-up turn when every
  finalized result in the batch terminates (FR-013 surface, verified in docs).

## Ownership (the separately-owned prerequisite)

- **Seam primitives:** owned by `@earendil-works/pi-coding-agent` — proven on
  the installed **0.83.0** (RPC mode, `get_commands`, extension-command prompt
  invocation, `entry_appended`, `getActiveTools`/`getAllTools`, awaited
  `before_agent_start`). Minimum version claim: 0.83.0 in this environment;
  true minimum upstream is unverified (API history not auditable offline).
- **The launcher change:** the installed launcher is
  `~/.pi/agent/extensions/subagent/index.ts`, sourced from
  `~/.dotfiles/pi/extensions/subagent/index.ts` — **outside this repository**.
  Per the plan: the launcher edit (print-mode → RPC gate protocol) is a
  separately owned change in the dotfiles repo, not a hidden edit to global
  extensions. Loom's in-repo share is the child-extension readiness command +
  the gate protocol specification (this document + the probe).
- **No global extensions were modified** for this probe; everything runs from
  `probes/emission-readiness/` and a temp dir.

## What remains for FR-008 completeness (allocated, not claimed)

1. Launcher gate implementation in the dotfiles subagent launcher (separately
   owned; protocol = this document).
2. Loom child extension: production readiness command emitting the bound
   payload (issued kind/version/schema digest + revision + child identity) and
   the child-side `before_agent_start` hold.
3. AS-020's full negative-control matrix re-run through the production path
   (this probe covers the mechanism and the four principal controls).
