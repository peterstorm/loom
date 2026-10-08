# Pi local-only routing and per-route release (2026-10-08)

- **Branch:** `feat/context-routing`, cut from `main` at `bb708931` (the PR #68 merge).
- **Decision record:** [ADR-0023](../../docs/adr/ADR-0023-pi-runs-local-only-and-releases-per-route.md).
- **Operator decisions (2026-10-08):**
  1. Pi runs local models only (desktop-vllm); Claude Code runs Claude models only. Cloud Pi providers are not used again,
     so the codex qualification probe was dropped.
  2. An unreachable chosen route **fails closed**: a named refusal, no silent fallback.
  3. The AD-11 release decision is **per route**: the unconstrained local route can be released as
     "unconstrained emission, engine-authoritative" after a measured window.

## Scope

Emission (grammar-constrained tool output) is Pi-only: Claude Code has no Loom extension seam, so a Claude Code parent
is always extraction-only. All routing work is therefore Pi-side.

| WS | Change | Where |
|---|---|---|
| L1 | Every catalog profile lowers its Pi binding to `DESKTOP_VLLM_ROUTE` (`LocalPiTarget`); profiles differ only in their Claude model. The reviewer issue-route election (`qualified-local-review`, `ReviewerIssueRoute`, `isIssuableProfile`, `observedReviewerIssueRoute`) is deleted. | `engine/src/core/model-profiles.ts`, Wave/standalone issuance, `spawn-task.ts` |
| L2 | Stored authorities stay readable: retired profile id `qualified-local-review`, `RetiredPiTarget`s, and `recordedProfileBindings` (every binding each profile has issued, from Git history). A request is checked against today's catalog once, at mint (`parseAgentRequestAuthority`); roster re-reads (`parseAgentRosterSlot`) and terminal diagnostics parse as recorded. `prepareFreshStandaloneReview` mints each attempt in issue mode. | `orchestration-contract/roster.ts`, `diagnostics.ts`, `standalone-review-preparation.ts`, `standalone-review-records.ts` |
| L3 | Fail-closed reachability: before a Pi parent's CLI emits a spawn batch, each distinct route must answer `GET {baseUrl}/models` (`baseUrl` from `models.json`; credentials never read). Pure decision `core/route-reachability.ts`, shell adapter `utils/route-endpoint.ts`, gate `spawnRouteRefusal` in `handlers/helpers/orchestration.ts`. Tests: a main-process fake route (`tests/setup/fixture-pi-route.ts`, vitest `globalSetup`) that fixture Pi sessions use via `PI_CODING_AGENT_DIR`. | engine |
| L4 | Per-route release: preregistration `releasePolicy` (`capable-route-required` for retained pilot-1, `per-route-engine-authoritative` for new `gcd-ad11-pilot-2`); `evaluatePilot` releases unconstrained cells with class `unconstrained-engine-authoritative`. The calibration runner's probe reuses the engine adapter and treats 401/403 as reachable with an unobservable served list. | `calibration/grammar-constrained-decoding/`, `scripts/run-model-calibration.ts` |
| L5 | Spec AS-017a, plan AD-11 amendment, ADR-0023, `docs/model-profiles-and-calibration.md`, `docs/pi-usage.md`, `CONTEXT.md`, calibration README. | docs |
| L6 | Measured pilot-2 window on the live route, then the independent blinded assessment and `--decide`. | operator/runtime |

Not changed: spawn-time routing (`core/model-routing.ts`, `~/.pi/agent/model-routing.json`). With a local-only Pi its
cloud rules are dead configuration the operator may delete.

## Validation

- `npm run verify` from the repository root.
- `npm test --prefix calibration/grammar-constrained-decoding`.
- Live: a Pi-parented standalone review against the running desktop vLLM; with vLLM stopped, the same start must refuse
  with `refusing to spawn: route desktop-vllm/glm-5.3-flash-spark-tp2-v14 is unreachable`.
