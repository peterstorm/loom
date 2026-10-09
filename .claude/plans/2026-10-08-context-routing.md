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
| L4 | Per-route release: preregistration `releasePolicy` (`capable-route-required` for retained pilot-1, `per-route-engine-authoritative` for new `gcd-ad11-pilot-2`); `evaluatePilot` releases unconstrained cells with class `unconstrained-engine-authoritative`. The calibration runner's probe reuses the engine adapter; a 401/403 is recorded as the explicit fact `served-model-unverified`. | `calibration/grammar-constrained-decoding/`, `scripts/run-model-calibration.ts` |
| L5 | Spec AS-017a, plan AD-11 amendment, ADR-0023, `docs/model-profiles-and-calibration.md`, `docs/pi-usage.md`, `CONTEXT.md`, calibration README. | docs |
| L6 | Measured pilot-2 window on the live route, then the independent blinded assessment and `--decide`. | operator/runtime |
| L7 | Review remediation (registered read-coverage review `raf-ctxr-p01..p04` of `bb708931..7fb670bb`: 0 criticals, 38 advisories, all accepted and published): W1 the spawn gate probes the **launch route** (`resolveAgentLaunchBinding`, shared with the renderers), refuses a retired recorded route with a restart remedy, reports unverified served models on stderr, one owner of HTTP status meaning (`decideProbedRoute`); W2 the current binding derived from the catalog, minted vs stored request authority branded; W3 AS-004 typed by qualification, the release policy read in one place, preregistration digests pinned; W4 test-fixture seams (`facade-parent.ts`, `fixture-pi-agent-directory.ts`, `local-pi-binding.ts`). | engine, calibration, tests |
| L8 | Pilot route fail-fast, after the first pilot-2 window measured a route outage (vLLM went down ~6 pairs in; 812/816 samples recorded as "no final text payload" rejections): a Pi provider error ending the last model turn is an `infrastructure-failure` (`providerFailure`), and the window re-probes the route after an infrastructure failure or timeout and stops on an unreachable route or 3 consecutive all-infrastructure pairs (`judgePair`), recording its `ending` in `window.json`. The outage window is retained as recorded; a fresh pilot-2 window follows. | `calibration/grammar-constrained-decoding/`, `scripts/run-model-calibration.ts` |

Spawn-time routing (`core/model-routing.ts`, `~/.pi/agent/model-routing.json`) is unchanged, but since L7 the spawn gate
probes the route a child actually launches on. A routing rule that still sends children to a cloud provider with no
`baseUrl` in `models.json` (the dotfiles' `sol-subagents-use-high`) is therefore refused as unconfigured; with a
local-only Pi those cloud rules are dead configuration the operator should delete.

## Validation

- `npm run verify` from the repository root.
- `npm test --prefix calibration/grammar-constrained-decoding`.
- Live: a Pi-parented standalone review against the running desktop vLLM; with vLLM stopped, the same start must refuse
  with `refusing to spawn: route desktop-vllm/glm-5.3-flash-spark-tp2-v14 is unreachable`.
