# ADR-0023: Pi runs local models only, fails closed on an unreachable route, and releases emission per route

## Status

Accepted (2026-10-08). Amends AD-11 of the grammar-constrained decoding plan; supersedes the reviewer
issue-route election (`qualified-local-review`).

Amended (2026-10-09): decision 3 gains the operator opt-in `LOOM_ROUTE_GATE=strict` and states that every
gate input that cannot be read refuses the batch. The default admission of an unverified route is unchanged,
and the admitted batch's emitted action also names each unverified route (`unverifiedRoutes`) beside the
stderr event. A `retired` refusal is derived from the request's recorded binding and its profile's current
one, so a later retargeting is reported in its own terms.

Amended (2026-10-09, evening): decision 5. The operator releases tool-call emission on the local route by
decision, without a completed calibration window. AS-015 and AS-016 are recorded as waived and unmeasured,
never as passed. No further pilot window is planned.

Amended (2026-11-15, #178): decision 6. A `model-routing.json` target may name a provider (`served`) instead
of a model; Loom resolves it to the one model that provider serves, and to do so sends the provider's key
on that listing request only. Decision 3's "Loom never resolves or sends credentials" now holds for every
other request, including the reachability probe. Revised the same day after the PR #179 review: the key is
the one Pi sends (a credential stored in `auth.json` before the `models.json` apiKey), it is refused
unsent when no header can carry it and never follows a redirect, observations are reused for 30 seconds,
capture reads the emission decision spawn admission recorded instead of re-resolving the route, and a
served target without a thinking level is documented as the launcher's parent level, not always the
parent session's.

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
   is minted (`mintAgentRequestAuthority`); every roster re-read parses its attempts as recorded.
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
   `loom-route-unverified` event. The reachability probe never resolves or sends credentials; Pi
   authenticates the inference. *(Amended 2026-11-15: the one credentialed request is decision 6's served
   listing.)*
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
5. **Operator release without a measured window (AD-11 amended again, 2026-10-09).** Three pilot-2 windows
   ran, and none measured a complete schedule because the local vLLM stopped serving in each: the 2026-10-08
   window walked all 408 pairs but measured an outage from about pair 6 on, and on 2026-10-09 the route
   fail-fast aborted the other two after 13 and after 30 of 408 pairs. A complete window needs roughly
   two days of uninterrupted serving, and the route has not sustained that. The operator, as spec owner,
   therefore releases every cell on the local route as **unconstrained emission, engine-authoritative** by
   decision. This is option (b) of AD-11's original text — the spec owner accepting unconstrained emission —
   taken without the measurement decision 4 attached to it.
   - **What is released.** Tool-call emission stays the issued mode for reviewers, judges and refutation
     verifiers under a Pi parent, as decision 1 already makes it at runtime; nothing in the engine reads a
     calibration decision, so no code changes. The engine stays authoritative: every emitted payload is
     parsed by the frozen registry parser, and a violation is an `unenforced-schema-violation` handled by
     the shared retry budget.
   - **What is not claimed.** AS-015 (p95 latency within +25%, no increase in terminal failures) and AS-016
     (escaped-defect severity, two blinded assessors) are **waived by the operator, not measured**. No
     document may report them as passed. Every retained window keeps its own recorded decision,
     `incomplete-missing-measurement`; none is re-decided, edited or presented as a release.
   - **The basis is DECLARED.** It is the operator's judgement that tool calling is the better mode,
     consistent with, but not established by, the descriptive figures of the third window
     (`gcd-ad11-pilot-2--2026-10-09T14-43-58-835Z`, 30 pairs, below every cell's preregistered count):
     the emission arm accepted 26 of 30 samples at attempt 1 with no semantic rejection, and its 4 failures
     were outages or timeouts; the extraction arm accepted 21 of 30, needed attempt 2 for 2 of them and
     ended 7 in semantic rejection after both attempts (5 judge, 2 refutation: final messages the frozen
     verdict parser could not read as JSON). Among accepted samples, emission's p50 / p95
     dispatch-to-ingestion was 205 s / 310 s against extraction's 270 s / 543 s. These are point figures from
     one partial window with no bootstrap interval and no blinded quality assessment; they are not a
     guardrail result.
   - **The calibration machinery is retained**, unchanged and tested, so a later window can still measure the
     route. A violated guardrail in such a window would reopen this decision; a missing one would not.
6. **Served routing targets, resolved before launch (2026-11-15, #178).** A `model-routing.json` target is
   either exact (`{"model": "provider/id", "thinkingLevel": …}`) or served (`{"served": "provider"}`, with an
   optional `thinkingLevel`). Without one, the child runs at the parent thinking level its resolver is given:
   the parent session's live level for the interactive launcher (`resolveEffectivePiBindingFromParent`),
   the Agent's declared level for every headless launch (`resolveEffectivePiBinding`, whose parent is a
   model ref only). The operator's local server swaps models, and a served target follows it without editing
   the routing policy. Loom records the exact binding every child launches on, so a served target is
   resolved to one exact provider/model before anything launches. The generated-agent render and its
   validator, `render-pi`, the spawn route gate, the interactive launcher and spawn admission each build the
   routing context (`PiRoutingContext.served`) by the same observation and resolve the target through the
   same `resolveAgentLaunchBinding`.
   - **The observation.** For each provider a rule that can match the observed parent serves
     (`servedProvidersFor`), the shell (`utils/served-model-probe.ts`) reads `baseUrl` and the declared
     model ids from Pi's `models.json` in the active agent directory, picks the key Pi 1.5.2 sends a custom
     provider (`core/provider-key.ts`: an `api_key` credential stored in `auth.json` wins, its template
     reading the entry's `env` before the environment; a stored credential without a key — `oauth`, or
     `api_key` without `key` — means no key, never a fallback; otherwise the `models.json` `apiKey`),
     resolves it in Pi's grammar (`core/pi-config-value.ts`: a leading `!` runs a command,
     `$NAME`/`${NAME}` interpolate, `$` and `$!` escape, anything else is literal), and requests
     `GET {baseUrl}/models` with it as `Authorization: Bearer`. The pure decision (`core/served-model.ts`)
     admits the model only when the listing names exactly one model and Pi's catalog declares it for that
     provider; every other outcome is a typed cause (`core/served-model-cause.ts`), rendered to prose once.
   - **Credentials.** That listing is the only request on which Loom sends a credential. The key lives in
     the shell's locals and the bounded probe child's environment; it is never put on a command line, in a
     log line, a refusal, an event or a record. A key no HTTP header value can carry (a line break, a control
     character, a character above U+00FF) is refused before the request, because `fetch` quotes an invalid
     header value in its error; the request follows no redirect (`redirect: "error"`), so the key reaches
     only the configured `baseUrl`; every refusal text the probe child returns is scrubbed of the key in
     every form it could take (`scrubSecret`, a tested property); and a malformed `models.json` or
     `auth.json` is reported by file name only, because V8's `JSON.parse` error quotes the text around the
     fault.
   - **No fallback.** A missing or unresolvable key, a 401/403, an unreachable server, a listing of zero or
     several models, or a model the catalog does not declare leaves the provider's model unknown, and any
     rule that selects the target refuses the launch with the reason and its remedy. The resolved route is
     then probed by decision 3's gate like any other.
   - **Reuse.** The live ports reuse a listing per URL and key fingerprint, and a key command's successful
     output per command, for 30 seconds (`SERVED_OBSERVATION_TTL_MS`, on an injectable clock): the readers of
     one launch agree without each probing, and a long-lived Pi process sees a model switch within the
     window. A failing key command is never reused. Pi itself caches a stored credential's command output
     for its whole process and re-runs a `models.json` command each time.
   - **Capture does not re-resolve.** Spawn admission records its emission decision with the child's
     correlator (`AdmittedEmission`: `enabled` with the admitted route, or `not-enabled`), and capture
     judges the child by it. Resolving the route again when the result arrives would read the parent model,
     the routing config and the served provider as they are then: a model switch or a provider outage would
     turn an emission-enabled child into extraction-only authority and refuse its call. A correlator with no
     recorded decision (Claude, the `correlate` CLI, one written before the field) is stored without the
     field, byte-identical to before, and qualifies on its frozen route.
   - **What stays the same.** An exact target still requires `thinkingLevel` (stricter than the dotfiles
     launcher, which defaults it). The reachability probe stays unauthenticated. The generated Agent
     definitions carry the routed binding, so they must be re-synced (`scripts/sync-pi-agents.sh`) after the
     server switches models, and a stale one is refused as stale.

## Consequences

- The spawn-time routing config (`~/.pi/agent/model-routing.json`) no longer needs cloud rules; a local
  parent may still route children to its own local model.
- A schema violation on the unconstrained route is reported as `unenforced-schema-violation` and handled by
  the engine's validation and the shared retry budget; it is never presented as a provider guarantee.
- Re-introducing a cloud Pi provider would need a catalog change, a qualification probe and its own release
  cell; the retired-target history shows exactly what was issued before.
- The grammar-constrained decoding feature may be declared done on the operator release (decision 5). The
  done claim names the waiver: AS-004 not applicable on the unconstrained route, AS-015 and AS-016 waived and
  unmeasured, AS-017 retention in force.
