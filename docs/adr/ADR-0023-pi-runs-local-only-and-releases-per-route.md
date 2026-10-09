# ADR-0023: Pi runs local models only, fails closed on an unreachable route, and releases emission per route

## Status

Accepted (2026-10-08). Amends AD-11 of the grammar-constrained decoding plan; supersedes the reviewer
issue-route election (`qualified-local-review`).

Amended (2026-10-09): decision 3 gains the operator opt-in `LOOM_ROUTE_GATE=strict` and states that every
gate input that cannot be read refuses the batch. The default admission of an unverified route is unchanged.

## Context

Grammar-constrained emission is Pi-only: Claude Code has no Loom extension seam for the frozen emission
tools, so a Claude Code parent always runs reviewers extraction-only. The operator uses Pi with local models
only and Claude Code with Claude models only; the cloud Pi providers (`openai-codex`, `github-copilot`) will
not be used again.

Three things followed from the earlier cloud-default catalog:

1. Most Pi profiles lowered to cloud targets, so a Pi parent's reviewers were extraction-only unless the
   parent was exactly `desktop-vllm/glm-5.3-flash-spark-tp2-v14:high`, in which case issuance elected a
   separate `qualified-local-review` profile from the parent's environment.
2. A down local vLLM was discovered child by child: each spawned child hung or failed on its own.
3. AD-11 required a qualified **capable** (constraint-enforcing) route before the feature could be declared
   done. The only route the deployment uses, desktop-vllm, is qualified **unconstrained emission**: vLLM
   accepts the frozen schemas but does not enforce them, and pi-ai does not send vLLM's
   `structured_outputs`. Done was therefore unreachable by construction.

## Decision

1. **One Pi route.** Every catalog profile lowers its Pi binding to the local route
   (`DESKTOP_VLLM_ROUTE`, thinking `high`); profiles differ only in their Claude model. The reviewer
   issue-route election is deleted: issuance no longer reads the parent's model. A reviewer issued under a Pi
   parent is on the emission-qualified route; under a Claude Code parent it is extraction-only.
2. **History stays readable.** A stored request authority is history. `qualified-local-review` is kept as a
   retired profile id, and the cloud targets as `RetiredPiTarget`s, only so that stored authorities parse.
   Each recorded profile admits exactly the bindings it has issued (`recordedProfileBindings`,
   reconstructed from the catalog's Git history). A request is checked against today's catalog once, where it
   is minted (`parseAgentRequestAuthority`); every roster re-read parses its attempts as recorded.
3. **Fail closed on reachability.** Before a Pi parent's CLI emits a spawn batch, each distinct route its
   children will launch on must answer `GET {baseUrl}/models`, with `baseUrl` from Pi's `models.json`
   (`core/route-reachability.ts`, `utils/route-endpoint.ts`). The launch route is the one the generated
   agent render carries — the Agent's catalog binding after `model-routing.json` rules
   (`resolveAgentLaunchBinding`, shared by the renderer, `render-pi` and the gate) — so the gate never probes
   a route the child will not run on. A refused connection, timeout, non-auth error status or a listing
   without the model refuses the spawn, naming the route, URL and reason; a provider with no endpoint is
   `unconfigured`. Nothing is published, so `resume` re-emits the same batch once the route answers. An
   authentication refusal (401/403), or a 2xx whose body is not a model list, proves the server is up but
   not which model it serves: the batch is admitted and the unverified route is reported on stderr as a
   `loom-route-unverified` event. Loom never resolves or sends credentials; Pi authenticates the inference.
   *(Amended 2026-10-09.)* That admission is the default, not the only mode: an authenticating gateway can
   answer 401 while the model server behind it is down, so an operator may set `LOOM_ROUTE_GATE=strict`,
   parsed once at the CLI boundary into the closed `RouteGateMode` union, under which an unverified route
   refuses the batch with its own remedy (make the route list its models, or unset the variable). Any other
   value of the variable refuses rather than falling back to the default. The gate never fails open on an
   input it cannot read: a stored request authority that does not parse (its route is unknown), a malformed
   `model-routing.json` (the child may launch elsewhere than the declared binding) and a malformed
   `models.json` each refuse the batch.
   A stored request recorded on a retired cloud route is refused as `retired` without a probe: that run
   predates local-only routing, `resume` can never recover it, and the operator starts a fresh run. The
   calibration preflight maps the same pure decision (`decideProbedRoute`) rather than reading HTTP statuses
   itself, and records an unobservable list as an explicit `served-model-unverified` fact.
4. **Per-route release (AD-11 amended).** The release decision is per route × schema cell, fixed by the
   preregistration's `releasePolicy`. Under `per-route-engine-authoritative` a measured cell on an
   unconstrained-emission route is released as **unconstrained emission, engine-authoritative** when its
   window is complete and every applicable guardrail passes: AS-004 (provider-structural retries) is
   `not-applicable`, while AS-015 (p95 latency within +25%, no increase in terminal failures) and AS-016
   (escaped-defect severity, two blinded assessors) still apply. Constrained cells still need AS-004 = 0. The
   retained pilot-1 windows keep `capable-route-required` and re-decide to their recorded bytes; pilot-2
   (`gcd-ad11-pilot-2`) is the first preregistration under the new policy.

## Consequences

- The spawn-time routing config (`~/.pi/agent/model-routing.json`) no longer needs cloud rules; a local
  parent may still route children to its own local model.
- A schema violation on the unconstrained route is reported as `unenforced-schema-violation` and handled by
  the engine's validation and the shared retry budget; it is never presented as a provider guarantee.
- Re-introducing a cloud Pi provider would need a catalog change, a qualification probe and its own release
  cell; the retired-target history shows exactly what was issued before.
