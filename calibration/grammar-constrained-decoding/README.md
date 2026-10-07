# Grammar-constrained decoding: AD-11 calibration pilot

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md` (AS-004, AS-015, AS-016, AS-017; NFR-001; SC-001–SC-003)
**Plan:** `.claude/plans/2026-09-16-grammar-constrained-decoding.md`, Phase 6 / AD-11
**Runner:** `scripts/run-model-calibration.ts --pilot` / `--decide`
**Pure core:** `pilot-core.ts` (the release decision: `evaluatePilot`, cell measurements, guardrails), over its parsed inputs `pilot-preregistration.ts` (preregistration, schedule), `pilot-observation.ts` (observations, per-sample terminals and retries), `pilot-preflight.ts` (staged registry facts, preflight decision), `pilot-quality.ts` (blinding key, assessments, escaped-defect comparison), and the shared `pilot-vocabulary.ts` (cells read from the frozen registry, arms, guardrails) and `pilot-statistics.ts`; `pilot-workload.ts` (fixtures, case-input resolution, matched prompts), `pilot-rubric.ts` (the `rubric-v1` assessor), `pilot-dispatch.ts` (transcript classification through the engine's own selection; the live Pi adapter)
**Window dispatch shell:** `pilot-window.ts` (matched-arm dispatch with the attempt-2 retry behind the `ArmDispatch` port, blinding key and packet)
**Window retention:** `pilot-retention.ts` (`recordWindow` runs a whole window behind its ports — input resolution, matched dispatch, retention, decision — and the window's files and decision rules behind the `WindowStore` port: never-overwrite, preregistration-drift refusal, assessment retention, decision record and append-only log)
**Shared with the historical corpus core:** `../kernel.ts` (Result, NonEmpty) and `../pi-json-stream.ts` (Pi's JSON event stream and message text)

## Release decision: INCOMPLETE. Done cannot be claimed

| Window | Recorded | Preflight | Samples | Decision |
|---|---|---|---|---|
| `windows/gcd-ad11-pilot-1--2026-10-03T09-23-39-047Z/` | 2026-10-03 09:23:39Z (baseline `71827878`) | **blocked: `route-unreachable`** (`GET http://192.168.0.80:8000/v1/models` refused) | 0 dispatched, 0 fabricated | `incomplete-missing-measurement` |
| `windows/gcd-ad11-pilot-1--2026-10-03T17-12-24-293Z/` | 2026-10-03 17:12:24Z (baseline `5cfda5a1`; runtime identity superseded by later `engine/src` commits, see below) | **blocked: `route-unreachable`** (same refusal; registry digests, fixtures and Pi version still match the preregistration) | 0 dispatched, 0 fabricated | `incomplete-missing-measurement` |

Two independent reasons block a done claim:

1. **The pilot could not run.** The live route `desktop-vllm` refused connections in both windows and on every manual check in between (`curl` exit 7). No sample was dispatched or invented. Every cell is retained as `not-measured`, with its preregistered pair count. The second window is not a re-run looking for a better result. It re-checks the route and records the delivered runtime identity, and it is blocked for the same reason as the first.
2. **The intended deployment has no qualified *capable* route.** In the spec glossary, a capable route accepts **and enforces** the declared constraints. The only qualified route, `(desktop-vllm, glm-5.3-flash-spark-tp2-v14, <digest>)`, is classified **unconstrained emission** (`probes/emission-qualification/`). AD-11 says: *"If the intended deployment has no qualified capable route, the constrained feature cannot be declared measured/done."* The decision core encodes this as the missing measurement `no-qualified-capable-route`. So even a complete, all-passing window on this route stays `incomplete`.

To reach `done-allowed`, one of these must happen:

- (a) a route qualifies as **constrained emission**, for example pi-ai's resolver gaining vLLM `structured_outputs`/`guided_json` for tools, or a cloud route passing qualification. That requires requalification, a new preregistration with a new `id`, and a new window.
- (b) the spec owner explicitly amends AS-004/AD-11 to accept unconstrained emission as the measured mode. That is a user decision. This record does not make it.

A violated guardrail in any future window blocks done and triggers design reconsideration. A window is never re-run to obtain a more favourable result.

### Requirement status

| Requirement | Guardrail (per cell) | Status |
|---|---|---|
| AS-004 provider-structural retries = 0 on a capable route | `provider-structural-retries` | **Not measured.** No capable route. On the unconstrained route the guardrail is `not-applicable`, and schema violations are reported as `unenforced-schema-violation`, never as a provider guarantee. |
| AS-015 p95 ≤ +25% vs extraction-only; terminal failures not increased | `latency-p95`, `terminal-failure-non-increase` | **Not measured** (window blocked). |
| AS-016 escaped-defect severity not worse than the PR #52-only baseline | `escaped-defect-severity` | **Not measured** (no payloads; independent blinded assessor still required). |
| AS-017 retention; a missing measurement blocks done | `measurement-complete` and the decision union | **Mechanism in force.** Preregistration, matrix, workload and blocked window are retained. The decision is `incomplete`. |

## Preregistration (recorded before any window)

The **binding** preregistration is `preregistration.json`, recorded `2026-10-03T09:17:26Z`, before the first window at 09:23:39Z. Its SHA-256 is `4f00b74ff732f779da9e4421a034ce1f8fc4045aee51dd8c249293447458f7b9`, and every window records that digest. `--decide` refuses to re-evaluate a window if the preregistration has changed since. The workload fixtures, `workload-fixtures.json`, are pinned by `workloadFixturesDigest` = `b60755891d4b26081f64d978e0fd688cd1359157d25d9e0be544cddd3851d201`. The preflight blocks if they change. Any change needs a new preregistration `id`. Earlier windows stay retained.

### Route / schema matrix (intended deployment)

Route: harness `pi` 0.83.0 · provider `desktop-vllm` · API `openai-completions` · `http://192.168.0.80:8000/v1` · model `glm-5.3-flash-spark-tp2-v14` · thinking `high`.

| Cell | Tool | Frozen schema digest (registry, bare hex) | Qualification | Pairs |
|---|---|---|---|---|
| reviewer-payload v2 | `loom_emit_reviewer_payload` | `3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37` | unconstrained emission | 8 cases × 13 = **104** |
| reviewer-payload v3 | `loom_emit_reviewer_payload` | `515ed14d0435d47da4f8299ed4f7ba9908f33c9f567051db93de84ec0017b4a2` | unconstrained emission | 8 cases × 13 = **104** |
| judge-verdict v1 | `loom_emit_judge_verdict` | `3f590e9f4a9e4ef586220f4d0fa07bb061fb4ebaa32c9a24eeed07fbb044c569` | unconstrained emission | 4 fixtures × 25 = **100** |
| refutation-verdict v1 | `loom_emit_refutation_verdict` | `766a0dee252ca3fb135253d51b6ddea5bac1ce941e367eebf2da10f81ce8b2fd` | unconstrained emission | 4 fixtures × 25 = **100** |

The preflight recomputes each digest from the staged frozen registry, and a mismatch blocks the window, since it is a requalification trigger. Qualification evidence is `probes/emission-qualification/README.md` plus `recordings/`. No cell is extraction-only, because every schema was accepted. Had a cell been extraction-only, its outcome would have been an explicit `qualification-only` record with no samples.

### Fixed workload

- **Reviewer v2/v3** use the eight `calibration/corpus.json` snapshots, read through `git show <revision>:<path>` over the changed-path scope derived from each revision.
  - **hard** = `vulnerable` snapshot: a held-out known-defect case whose known defect is the corpus expectation, severity `critical`.
  - **easy** = `fixed` snapshot: no known defect present.
  - v3 additionally carries the fixed issued successor context: `lineageDigest`/`snapshotDigest` from `workload-fixtures.json`, no prior findings.
- **Judge v1** uses four architecture-panel fixtures (2 easy, 2 hard). Each has one candidate with a planted fatal flaw, which is the known defect.
- **Refutation v1** uses four findings (2 easy, 2 hard): two real defects (the held-out known-defect cases) and two false positives.
- **Held-out:** the corpus snapshots and fixtures were never used to develop or tune the emission feature. The corpus *was* used earlier for model-profile calibration, so it is held out from this feature, not from model selection.

### Matching, input and seed policy

- Both arms run on **one frozen runtime**: children load the staged checkout's extension (`-ne -e <checkout>/pi/extension.ts`), whose content-addressed Runtime Revision is recorded per window. They share the same model, provider, thinking level, tool set (`read,grep,find,ls,bash`) and source snapshot.
- **Task bodies are byte-identical** across arms. Only the wire section differs. The emission arm gets the frozen tool-primary wording naming the issued tool. The extraction arm gets the retained final-message contract. Each child is launched exactly as production launches it: the emission arm goes through the installed launcher's `runRpcAgent` readiness barrier with `LOOM_EMISSION_BINDING`, and the extraction arm runs in print-mode JSON.
- **Seeds:** Pi exposes no sampling-seed or max-token flag for this route. Both arms therefore inherit the same catalog defaults, and repeats are independent samples, not seeded replays. Inputs, not sampling, are fixed.
- **Order:** a seeded global shuffle (`scheduleSeed` 20261003) with ABBA counterbalancing of arm order within each cell.

### Measurement definitions

- **Dispatch-to-ingestion wall clock** runs from the first child spawn to accepted ingestion. It includes startup, the readiness barrier, tool acknowledgments, follow-up model turns, Pi's in-child validation re-prompts and the semantic attempt 2.
- **Accepted ingestion** means the engine's own selection (`piEmissionCallFrames` → `observeEmissionCalls` → `selectCanonicalPayload` / `selectVerdictSource`) followed by the frozen registry parser for the issued kind and version. The extraction-only arm is offered no emission tool, so it is classified by final-message extraction alone (the PR #52-only baseline): it records no emission calls, tool errors or readiness time, and a call to the tool it was never offered is not an emission call. The parser's contract value is the canonical accepted payload for both arms: its digest and its blinded-packet form never depend on the model's own JSON key order.
  - *Typed observations:* a sample is discriminated by arm. An extraction-only attempt with emission counters or a readiness time, an extraction-arm acceptance from the emission tool, or a `fallbackOverRefusal` on an emission-tool acceptance is refused when the sample is parsed.
  - *Limitation:* the run-directory issuance joins (roster, scope, prior-origin, criterion/lens bindings) are not exercised by this child-level harness.
- **Retry:**
  - a *semantic retry* is the one fresh engine-issued attempt 2 after a rejection (AD-9's shared budget);
  - an *in-child re-prompt* is each errored emission tool result, part of Pi's validation-retry loop.
- **Retry causes:** `provider-structural`, `unenforced-schema-violation`, `engine-only-refusal`, `unclassified-tool-error`, `extraction-failure`, `duplicate-call`, `observation-refused`, `payload-refused`. Errored results are classified by producer: "Validation failed for tool …" is a harness JSON Schema error, and `<code>: …` is an engine refusal.
- **Rates on the emission arm:**
  - tool use: at least one call in any attempt;
  - non-emission: zero calls in every attempt;
  - fallback: accepted via extraction, including "over exactly one refused call";
  - duplicate-call rejection.
- **Terminal failures** are `semantic-exhausted`, `startup-refused`, `infrastructure` and `timeout`, with a 900 s per-attempt timeout. They are retained per arm and rank **+∞** in the latency distribution, so they cannot be dropped. Infrastructure failures are terminal in the pilot for both arms; there is no re-dispatch. On the emission arm, a launcher that cannot be loaded or that rejects mid-run is an infrastructure failure of that attempt, not a window abort, and so is a launch the launcher reports successful although the readiness barrier never verified the child.
- **Raw-observation limit:** Pi exposes parsed arguments only. Every emission call is counted as `rawArgumentObservation: unavailable`, and the duplicate-key measurement is reported as `not-claimed`, never as zero.

### Guardrails and decision rules

| Guardrail | Pass | Violated (blocks done) | Otherwise |
|---|---|---|---|
| measurement-complete | every scheduled pair observed in both arms | — | cell `not-measured` |
| latency-p95 | bootstrap 95% upper bound of p95 ratio ≤ 1.25 | point p95 ratio > 1.25 | inconclusive (**not a pass**) |
| terminal-failure-non-increase | emission failures ≤ extraction-only failures | any increase | — |
| provider-structural-retries | 0 on a constrained cell | > 0 on a constrained cell | `not-applicable` on an unconstrained cell |
| escaped-defect-severity | mean paired difference ≤ 0 and upper bound ≤ 0.3 | lower bound > 0 or mean > 0.3 | inconclusive / not-measured |

Supporting parameters:

- Effect sizes and uncertainty: p95 ratio with interval, median paired latency difference with interval, terminal-rate difference with interval, and mean paired severity difference with interval. All use a percentile bootstrap with 2000 resamples (`bootstrapResamples`) and base seed 52 (`bootstrapSeed`) plus a per-statistic offset, so each interval draws its own resample stream: p95 ratio seed 52 (+0), median paired latency difference seed 53 (+1), terminal-rate difference seed 54 (+2), mean paired severity difference seed 55 (+3).
- Severity rubric: minor = 1, major = 2, critical = 3. The score is the sum over escaped known defects, and a request with no accepted payload lets every known defect escape.
- At least **2 blinded assessors**: `rubric-v1`, which is deterministic and blind by construction, plus one independent assessor scoring `blinded-assessment-packet.json`. Disagreements are retained, and adjudication takes the maximum severity, identically for both arms. `rubric-v1` reads every accepted payload through its cell's frozen parser (the reviewer v2 and standalone-successor v3 payload parsers, the judge and refutation verdict schemas), so it reads typed fields only; a v3 payload's findings are read through their drafts. It fails closed. If a blinded entry's case is not preregistered, its input is unresolved, its payload is refused by its cell's parser, or an escaped defect id is not declared by its case, the whole assessment is an error that names every such entry, and the `--pilot` run stops after retaining the key and packet without writing `rubric-v1.json`. `window.json` is closed (`endedAt`, `observations`) before the packet is derived, so such a window still records how it ended. A later decision then counts one assessor fewer, so escaped-defect severity reads as not measured. An unresolvable entry never counts as zero escapes.
- Release precedence: any violation gives `blocked-guardrail-violated` (with design reconsideration). Otherwise any missing, not-measured or inconclusive result gives `incomplete-missing-measurement`. Only a complete, all-pass record with every measured cell on a capable route gives `done-allowed`; one capable cell never carries an unconstrained cell to done. The types make a "done" decision carrying a non-passing guardrail unrepresentable.

This is a minimum operational pilot, not a statistical proof of universal non-regression.

## Final qualification / config / runtime identity

| Item | Value |
|---|---|
| Baseline commit | `5cfda5a1` (feat/grammar-constrained-decoding), the second window. The first window ran at `71827878`. The branch has since advanced past it (see the next row). |
| Staged Runtime Revision (content-addressed: `engine/src`, `pi`, `package.json`, `engine/package.json`, `engine/bun.lock`) | `sha256:04a99e92939f10290de13f0f7bb3db76a2607b1472fbe3c5d462722f131eb0e1` (second window). The first window recorded `sha256:d92429639cbce93e37791539080f6f2eb80f3035fc0aa4c57e3510884ed212ab`. **Superseded since:** later commits changed `engine/src` after the second window, starting with `ceb07a6a` (SubagentStop transcript settling) and `17e04c6e` (new-test evidence collection). Neither is on the emission path. The branch head therefore no longer computes the recorded digest. This record deliberately pins no current head digest, because any further `engine/src` change would make it stale. No window ran on any later revision. The next window's preflight records the delivered identity; neither retained window vouches for it. |
| Loaded runtime (Pi handshake) | **unobserved**: the window ran outside a Pi session. Staging/merge and the loaded runtime are kept distinct, and `unobserved` is never treated as a match. |
| Pi | 0.83.0 (`pi --version`), the version qualified on 2026-09-19 |
| Registry digests | equal to the preregistered digests (preflight recomputed them) |
| Route qualification | unconstrained emission, `probes/emission-qualification/` (2026-09-19) |

## Operator activation / reload steps

1. **Stage the delivered revision.** Merge or check it out. The runner records its Runtime Revision in every window under `preflightFacts.stagedRuntimeRevision`.
2. **Activate it through the normal path.** In Pi, run `/reload`, or fully restart Pi while preserving the session, so the loaded extension publishes the new content-addressed Runtime Revision handshake. Do not bypass the handshake: the mutating CLI refuses on skew, as described in `docs/operations.md` § "Pi reports runtime version skew".
3. **Confirm loaded = staged.** Run the pilot from a shell inside that Pi session, where `LOOM_PI_EXTENSION_RUNTIME_REVISION` is published. The preflight then records `loadedRuntime: matches-staged`, and a mismatch blocks the window.
4. **Confirm the launcher barrier.** `~/.pi/agent/extensions/subagent/rpc-launcher.ts` must export `runRpcAgent`. It is the dotfiles-owned launcher; override it with `--launcher <module>`.
5. **Bring the route up** and check that `curl http://192.168.0.80:8000/v1/models` lists `glm-5.3-flash-spark-tp2-v14`.
6. **Run the window** (hours; 816 child dispatches minimum):
   `LOOM_RUN_MODEL_CALIBRATION=1 bun scripts/run-model-calibration.ts --pilot calibration/grammar-constrained-decoding/preregistration.json`
   Observations are appended per sample to `observations.jsonl`, so an interrupted window keeps everything observed. `--preflight-only` records identity and reachability without dispatching.
7. **Blinded assessment.** An independent assessor scores `blinded-assessment-packet.json`, which shows blind ids only, and produces an assessment (`schemaVersion: 1`, `blinded: true`, a path-safe `assessorId`). Then run `bun scripts/run-model-calibration.ts --decide <window-dir> [--assessment <file>]`, which is offline and needs no opt-in.
   - Every assessment a decision reads is retained in the window. An `--assessment` file is copied to `assessments/<assessorId>.json` first. Re-submitting identical bytes does nothing, and a different assessment for an assessor already retained is refused, never overwritten.
   - `release-decision.json` is the current decision. Every decision, including the first, is also appended to `decision-log.jsonl`, so a re-decision can never erase an earlier verdict.
8. **Never chase a favourable window.** A violated guardrail means design reconsideration. A changed workload or route means a new preregistration `id`, recorded before its window. Retained windows are never overwritten.

## Files

| File | Role |
|---|---|
| `preregistration.json` | binding preregistration (content-addressed) |
| `workload-fixtures.json` | judge/refutation fixtures, v3 context, corpus pointer (content-addressed) |
| `pilot-vocabulary.ts` | pure: the required cells, each read from the frozen emission-tool registry (key, kind, version and registry membership compile-checked), arms, severities, spec-fixed bounds, guardrails, schema primitives |
| `pilot-statistics.ts` | pure: seeded PRNG, nearest-rank quantiles over +∞ samples, percentile bootstrap, JSON-safe quantile and interval records |
| `pilot-preregistration.ts` | pure: preregistration parsing and the seeded ABBA paired schedule |
| `pilot-observation.ts` | pure: per-arm attempt and sample parsing, sample terminals, retry attribution |
| `pilot-preflight.ts` | pure: preflight facts parsing, the staged registry facts, the preflight decision |
| `pilot-quality.ts` | pure: blinding key and assessment parsing, the paired escaped-defect comparison (AS-016) |
| `pilot-core.ts` | pure: `evaluatePilot` — cell measurements, guardrails and the release decision |
| `pilot-workload.ts` | pure: fixtures, case-input resolution (cell-indexed, refused before a window opens), request identity, matched prompt rendering |
| `pilot-rubric.ts` | pure: the deterministic `rubric-v1` assessor over typed payloads |
| `pilot-dispatch.ts` | pure transcript classification + the live Pi dispatch adapter |
| `pilot-window.ts` | shell: matched-arm window dispatch over the `ArmDispatch` port and an injected clock, the attempt-2 retry, blinding key, arm-free packet |
| `pilot-retention.ts` | the window's retained files over the `WindowStore` port: pure derivations (preregistration and assessment parsing, drift check, observation log, assessment retention, decision record) and the `--pilot` (`recordWindow`, which runs the whole window behind its ports) / `--decide` sequences; `scripts/run-model-calibration.ts` wires the live adapters |
| `pilot*.test.ts` | one suite per module at its interface; `pilot.test.ts` is the release decision through `evaluatePilot` |
| `pilot-retention.test.ts` | retention rules and `recordWindow`'s wiring at the `WindowStore` and `ArmDispatch` ports, and re-decision of every retained window to its retained bytes |
| `pilot-dispatch.test.ts` | transcript classification, and the live Pi adapter against a fake launcher, readiness client and `pi` executable |
| `runner.test.ts`, `pilot-test-fixtures.ts` | CLI subprocess runs against an unreachable route, and the dispatch path against a fake route |
| `../kernel.ts`, `../pi-json-stream.ts` | the Result/NonEmpty kernel and Pi's JSON event stream, shared with the corpus core |
| `../corpus-calibration.ts` | pure core of the script's default (historical corpus) mode, tested in `../corpus-calibration.test.ts` |
| `package.json` | private test entry point: runs these tests on the engine's pinned Vitest and config. It is not a Runtime Revision input. |
| `windows/<window-id>/` | `window.json` (identity, preflight facts, dispatch plan), `observations.jsonl`, `accepted-payloads.jsonl`, `blinding-key.json`, `blinded-assessment-packet.json`, `assessments/`, `release-decision.json`, `decision-log.jsonl` (windows from the second one on) |

Tests: `npm test --prefix calibration/grammar-constrained-decoding` from the repo root. Its `test` script, run from this directory, is `env -u PI_CODING_AGENT ../../engine/node_modules/.bin/vitest run --root ../../engine --dir .` — the `env -u PI_CODING_AGENT` is deliberate (like the engine's own test scripts, it keeps a surrounding Pi session from leaking into the tests), so invoke the script rather than copying the Vitest command without it. The engine's Vitest config also includes `calibration/**/*.test.ts` and its typecheck includes `calibration/`, so `npm run verify` runs and typechecks them too.
