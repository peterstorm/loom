# ADR-0014: Child readiness is a launcher barrier, not a notification

## Status
Accepted

## Context
Grammar-constrained decoding gives each structured producer (reviewer, panel judge, verdict writer, and so on) a per-kind emission tool whose frozen schema is identified by a kind, version and schema digest. The parent issues an emission binding and runs pure spawn admission (`engine/src/core/spawn-admission.ts`) over the batch. That admission proves only which Loom code the **parent** loaded. It says nothing about what the **child** Pi process registered and activated. A child can come up with a stale extension, without the tool, with the tool registered but missing from its `--tools` allowlist, or with a different schema version or digest. If the model prompt is delivered anyway, the model answers through an incompatible tool or none at all. The cost is a real, billed model request whose output is attributed to the wrong contract, plus a retry consumed for what was a provisioning fault.

The obvious in-process hooks do not stop anything. Pi catches exceptions thrown from `before_agent_start` handlers and continues the prompt. Loom's existing startup sweep logs reported failures and keeps going. A notification or thrown error therefore leaves model execution running. The original installed launcher (`~/.pi/agent/extensions/subagent/index.ts`) also started `pi --mode json -p --no-session` with the prompt already on the command line, so there was no point at which a launcher could look at the child before the model ran.

Any fix must meet several requirements. Readiness has to be bound to the specific request so that one child cannot vouch for another. The absence of the extension that performs the check must not count as success. Timeout, cancellation and cleanup must keep their existing infrastructure-failure meaning and must not mint new semantic retries. Error text must name the real remediation: stale resources may need `/reload`, but an unsupported provider schema does not. The integration also crosses a repository boundary, because the launcher lives in the dotfiles subagent extension and not in Loom.

## Options Considered

1. **Throw or notify from `before_agent_start` in the child**
   - Pros: No launcher change is needed. Everything stays inside the Loom extension.
   - Cons: Pi catches the throw and continues, so it is not a stop. A notification is advisory. If the extension is absent or stale, the handler never runs at all, so the missing check reads as success.

2. **Declare readiness from the parent's runtime revision or hash**
   - Pros: Cheap and synchronous. It reuses the parent-side loaded-revision containment that already exists.
   - Cons: It proves what the parent loaded, not what the child activated. It cannot detect an inactive tool, a wrong schema digest in the child, or a child provisioned for a different request.

3. **Treat a missing readiness signal as success, or time it out into success**
   - Pros: Old or non-emission children keep working without any change.
   - Cons: This is fail-open. A stale or absent extension, which is the main failure this decision guards against, becomes indistinguishable from a healthy child.

4. **Build a second, Loom-owned child runtime that controls prompt delivery**
   - Pros: Loom fully controls the lifecycle.
   - Cons: It duplicates the launcher and its cancellation and cleanup contract. It forks child execution semantics. The plan explicitly forbids this as an incidental workaround.

5. **Launcher-side, request-bound, pre-model readiness barrier over `pi --mode rpc` (chosen)**
   - Pros: It is a hard stop, because the prompt is not delivered until the gate opens. It observes the actual child. It binds to the request. An absent extension fails closed because the readiness command is missing. It was proven with zero model requests on every negative control.
   - Cons: It needs a launcher change in another repository. It adds two RPC round trips on top of child startup (the measured startup cost is under Consequences). It depends on Pi RPC primitives whose true upstream minimum version is unverified.

## Decision
**The launcher holds model prompt delivery behind a bounded, request-bound readiness barrier that inspects the actual child. Parent spawn admission remains the pure batch decision.**

The decision applies at four layers.

- **Parent admission is unchanged in kind.** `spawn-admission.ts` decides the batch purely, and its expected-capability gate (`issued-emission-capability.ts`) mints the admitted expectation from `issueEmissionBinding` over `EMISSION_TOOL_SPECS`. The schema digest is derived from the frozen bytes and is never trusted from the child. For an emission child, the Pi extension answers the launcher with a `PiSubagentLaunchReply` of kind `emission-rpc` (`pi/emission-launch-bridge.ts`). That reply carries the binding env (`LOOM_EMISSION_BINDING`), the expected provider, model and tool name, and a `verifyReadiness` callback. Non-emission children answer `not-admitted` and launch as before.
- **Launcher seam (separately owned).** `~/.dotfiles/pi/extensions/subagent/rpc-launcher.ts` and `index.ts` own this layer. The launcher spawns `pi --mode rpc --no-session` headless with **no prompt**. It then runs these steps in order:
  1. `get_state` as a channel check, which separates "child never came up" from "child up, readiness missing".
  2. `get_commands` discovery, which must list `/loom-emission-readiness` with source `extension` before the command is invoked. An unknown slash command would fall through to a real model request.
  3. A call to the readiness command through the RPC `prompt` command. Extension commands run without a model request.
  4. A wait for the bound payload on `entry_appended` under custom type `loom-emission-readiness`.
  5. A pure gate decision.
  6. A fail-closed `set_model` route binding whose response identity is compared.
  7. Delivery of the real task prompt, but only if every earlier step matched.

  Failures are phased as `before-task-prompt` or `task-prompt-sent` (`RpcLaunchFailurePhase`).
- **Child readiness command (Loom).** The command is `EMISSION_READINESS_COMMAND = "loom-emission-readiness"` in `pi/emission-tool.ts`, wired in `pi/emission-readiness.ts`. Inside a command handler, never at factory top level, it registers the tool, reads `pi.getActiveTools()`, and reports `emissionReadinessReport(...)` through `pi.appendEntry`. The report contains exactly ten contract fields: request ID, context digest, kind, version, tool name, schema digest, revision, active flag, child PID and registered tools. Readiness is invoked by command at gate time because `session_start` is emitted before the RPC stdout subscription attaches. That makes each report fresh and bound to its request. Registration is idempotent only for the exact same request, kind, version and digest. A contradictory re-registration is refused.
- **Pure gate.** `parseReadinessReport`, `parseReadinessStageObservation`, `decideReadinessGate` and `decideStartupRoute` in `pi/emission-readiness-gate.ts` form a closed ADT, separate from the child surface in `pi/emission-tool.ts`; the readiness report is the one contract the two modules share. The decision has two stages: `decideReadinessGate` canonicalises the probe facts and compares every binding field, and `decideStartupRoute` binds a route only to a `ready` readiness decision, so refused readiness can never be paired with a route observation. The parent bridge's verifier (`pi/emission-launch-bridge.ts`) parses each RPC response into these observations and refuses every child state through the gate. It has fourteen refusal codes (`EmissionStartupRefusalCode`): `child-unreachable`, `readiness-command-absent`, `readiness-timeout`, `startup-unavailable`, `malformed-readiness`, `wrong-request`, `unexpected-kind`, `unexpected-version`, `schema-digest-mismatch`, `tool-name-mismatch`, `tool-inactive`, `revision-mismatch`, `route-bind-refused` and `cancelled`. Each code maps to a named remediation in `EMISSION_STARTUP_REMEDIATIONS`. `/reload` appears only where stale resources are the cause. The ADT has **no semantic arm**. A startup refusal is evidence or infrastructure class and is never a consumed semantic attempt.
- **Defense in depth (in-child).** An awaited `before_agent_start` hold, bracketed by `loom-emission-hold` entries, blocks the first model request until the readiness exchange releases it. A pending promise works as a gate where a throw does not. The hold's transitions are the pure `decideEmissionHoldTransition` in `pi/emission-tool.ts`: only an armed hold moves, released by a readiness report whose tool is in the actual active set or by session shutdown. This layer backs up the launcher barrier. It does not replace it.

**Invariants:**
- Missing, malformed, contradictory, inactive or wrong-request readiness refuses before any model request. An absent or stale extension fails because the command is absent, never because a timeout is read as success.
- Timeout and cancellation keep existing infrastructure-failure semantics. Cleanup kills only that child and releases only the matching reservation.
- No new semantic retry or second persisted lifecycle is introduced. The barrier uses the launcher's existing startup and cancellation contract.
- Concurrency stays per child. Independent producer spawns are not serialized globally to implement readiness.

**Evidence.** `probes/emission-readiness/` passed 4/4 twice (matching, contradictory, missing, held) on installed pi 0.83.0 against a counting provider substitute. `engine/tests/pi/emission-startup-protocol.test.ts` and `engine/tests/pi/emission-startup-production.test.ts` re-prove the seam on every run against a real headless `pi --mode rpc` child (a probe-adapted fixture extension and the production extension respectively), using production identity parsers and the AS-020 negative-control matrix; the pure gate contract is pinned in `engine/tests/pi/emission-readiness-gate.test.ts`. The seam primitives are owned by `@earendil-works/pi-coding-agent`.

## Consequences

**Positive:**
- A provisioning fault (stale extension, inactive tool, schema drift, cross-request child) costs zero model requests and zero semantic retries. The operator gets a specific remediation instead of a confusing payload failure.
- Readiness describes what the child actually activated, not what the parent believes it loaded. This closes the gap between parent revision and child state.
- The fail-closed `set_model` step stops a prompt from falling through to the child's default real provider. Without it, the run could silently use a provider that cannot honor the constraint.
- The gate is a pure, closed decision. Each refusal code is pinned by tests, and new failure modes must be added to the ADT explicitly.
- Non-emission and Claude Code paths are untouched (`not-admitted` and extraction-only).

**Negative:**
- Each emission child adds two RPC round trips on top of child startup. Startup measured about 1.7 to 2.0 s with the minimal probe extension; a production child loading the full Loom graph can take about 20 s to reach `get_state`, and the launcher bounds the gate at 45 s (`DEFAULT_READINESS_TIMEOUT_MS`). Calibration must measure production children and include that cost in the p95 budget.
- Correctness depends on a launcher change in `~/.dotfiles/pi/extensions/subagent/`, outside this repository. The change is owned and versioned separately, and Loom cannot enforce that the deployed launcher is current. An old print-mode launcher does not run emission children through the barrier. That is a known gap in the fail-closed guarantee, which holds only for the current RPC launcher; Loom cannot detect it from this repository. Engine-side parsing still validates every payload, so the gap weakens readiness assurance, not payload admission.
- The design relies on observed Pi RPC behavior: extension commands execute without a model request, `entry_appended` reaches stdout, `session_start` precedes the stdout attach, and unknown commands fall through to the model. These were proven on pi 0.83.0. The true upstream minimum is unverified, and a Pi change could invalidate the seam. The re-run in the `emission-startup-*.test.ts` suites is the tripwire.
- The child extension must register only inside event or command handlers, never at factory top level. This constraint is easy to violate during later refactors.
