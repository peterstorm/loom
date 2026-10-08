# Context routing for emission (2026-10-08)

- **Branch:** `feat/context-routing`, cut from `main` at `bb708931` (the PR #68 merge).
- **Operator intent:** the route a child runs on depends on the context. A local parent can route to local or cloud, and a cloud
  parent to cloud or local. Emission (grammar-constrained tool output) follows the route the child actually runs on.
- **Operator decisions (2026-10-08):**
  1. An unreachable chosen route **fails closed**. Issuance refuses with a named error. There is no silent fallback.
  2. The AD-11 release decision is **per route**. Each route × schema cell is released on its own qualification and
     measurement.
  3. Qualify the `openai-codex` cloud route now.

## Problem today

Routing happens twice, and the two decisions can disagree.

| Decision | Where | Input | Effect |
|---|---|---|---|
| Spawn-time routing | `core/model-routing.ts` + dotfiles launcher `resolveSubagentRoute` | `~/.pi/agent/model-routing.json`, the parent model | The child's actual `--model` |
| Issue-time binding | `core/model-profiles.ts` `lowerModelProfile` → `harnessBinding.pi` | Catalog profile, plus the one exact-parent special case `reviewerIssueRouteForParent` | Frozen request authority, which decides emission |
| Emission qualification | `core/issued-emission-capability.ts:282` `QUALIFIED_EMISSION_ROUTE = DESKTOP_VLLM_ROUTE` | The frozen `harnessBinding.pi` | Emission on or off |

A cloud parent that is routed to local keeps a cloud binding, so emission stays off. A local parent that a rule sends to
cloud carries a frozen binding that does not match the model it runs on. Only exact `desktop-vllm/glm…/high` parents
reach the qualified local reviewer profile.

## Design

### R1. One effective route, decided at issuance (functional core)

- `resolveEffectivePiBindingFromParent` (pure, already in `core/model-routing.ts`) becomes the single route decision. Issuance
  calls it with the observed parent binding, the routing config and the workload (program, profile, agent).
- The request's frozen `harnessBinding.pi` is the **effective** binding, not the catalog's declared one.
- The launcher and the interactive transport launch exactly the frozen binding. Emission children already confirm it through `set_model` and
  the readiness gate. Non-emission children get the same exact `--model` from the frozen request, so spawn-time
  re-routing is gone.
- `reviewerIssueRouteForParent`, `ReviewerIssueRoute` and the `qualified-local-review` profile election are replaced. A
  routing rule expresses the local reviewer case (for example `local-workloads-use-parent`). The profile catalog keeps the
  declared bindings only.
- Pi-agent render checks (`render-pi-agent.ts`, `validate-agent-model.ts`) validate against the frozen effective binding.

### R2. Fail-closed reachability (imperative shell)

- At issuance, the shell observes reachability for routes whose provider declares a reachable `baseUrl` in
  `~/.pi/agent/models.json`, using `GET {baseUrl}/models` with a short timeout. This is the same probe the calibration
  preflight uses, extracted into one adapter.
- The pure decision returns a closed ADT, `RouteSelection = selected | unreachable | unconfigured`. `unreachable` refuses
  issuance and names the route, the URL and the routing rule that chose it. There is no fallback.
- Cloud providers with no `baseUrl` override are treated as reachable. Their auth and transport failures surface at
  spawn as today.

### R3. Qualified-route registry (functional core)

- `QUALIFIED_EMISSION_ROUTE` becomes `QUALIFIED_EMISSION_ROUTES`, a frozen in-repo registry. It is not operator config:
  qualification is evidence-bound, as AD-2 and FR-002 require.
- **Key:** harness `pi`, provider, model, API, Pi version and schema digest. The base URL is part of the identity for providers
  that declare one.
- **Value:** the AD-2 class (`constrained`, `unconstrained` or `extraction-only`) plus an evidence reference (probe README and
  recording directory).
- `emissionCapabilityForIssuedRoute` looks up the frozen effective binding and the cell digest:
  - a missing entry or `extraction-only` → `not-provided` / `extraction`;
  - `constrained` or `unconstrained` → `provided` (both emit, and the engine stays authoritative). The class is carried on the
    decision, so events and calibration can report it.
- **Seed entries:**
  - desktop-vllm/glm-5.3-flash-spark-tp2-v14: `unconstrained` for all four cells (`probes/emission-qualification/`).
  - openai-codex/gpt-5.6-sol: the codex probe's verdict per cell (`probes/emission-qualification-codex/`), added only once
    a run produces a real verdict.

### R4. Per-route release decision (AD-11 amendment)

- Spec AD-11 / AS-017 and plan Phase 6: the release decision is a per-route × schema matrix. A cell may be released
  when its route is qualified, its window is complete and every guardrail holds:
  - **constrained** cells must satisfy AS-004 (zero provider-structural retries);
  - **unconstrained** cells release as "unconstrained emission, engine-authoritative", where AS-004 is `not-applicable` and
    AS-015 and AS-016 still apply.
- Emission is enabled at issuance only for registry entries whose cell is released. An unreleased qualified cell stays
  `extraction-only`, with the reason "route qualified, release window pending".
- The calibration pilot (`pilot-core.ts` `evaluatePilot`) decides per route. A new preregistration `gcd-ad11-pilot-2`
  covers both routes. Earlier windows are retained.

## Workstreams

| WS | Scope | Notes |
|---|---|---|
| C0 | Codex qualification probe | Done (`ec7a74ba`); run 1 was auth-refused (expired token, 0 inferences). Re-run after the operator logs in again. |
| C1 | R1 effective route at issuance | `model-routing.ts`, `model-profiles.ts`, standalone/wave/refutation request preparation, launcher bridge, render checks, tests |
| C2 | R2 reachability ADT and adapter | Pure decision plus shell adapter; extract the calibration preflight probe |
| C3 | R3 registry | `issued-emission-capability.ts` plus capture runtime / parent admission users; property tests over the registry lookup |
| C4 | R4 spec, plan and ADR | Amend the spec and plan; new ADR "Per-route emission release"; docs (`model-profiles-and-calibration.md`, `pi-usage.md`) |
| C5 | Calibration per route | `pilot-core.ts` per-route decision, `gcd-ad11-pilot-2` preregistration, windows when the routes are reachable |

## Validation

- `npm run verify` from the repository root.
- Live: one standalone review from a local parent and one from a cloud parent. The `loom-emission-route` events must name
  the effective route and its registry class.
