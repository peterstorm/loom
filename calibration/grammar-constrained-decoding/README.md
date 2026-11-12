# Grammar-constrained decoding: AD-11 calibration pilot

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md` (AS-004, AS-015, AS-016, AS-017; NFR-001; SC-001–SC-003)
**Plan:** `.claude/plans/2026-09-16-grammar-constrained-decoding.md`, Phase 6 / AD-11
**Runner:** `scripts/run-model-calibration.ts --pilot` / `--decide`
**Modules:** each one's role, pure core or shell, is in [Files](#files), the one place it is described.

## Release decision: RELEASED BY OPERATOR DECISION, unmeasured (ADR-0023 decision 5)

On 2026-10-09 the operator, as spec owner, released every cell on the local route as **unconstrained emission, engine-authoritative** without a completed window (ADR-0023, decision 5). AS-015 and AS-016 are **waived and unmeasured**; they are never reported as passed. Five windows ran, two under pilot-1 and three under pilot-2. Each keeps its own recorded window decision, `incomplete-missing-measurement`: none is re-decided, edited or presented as a release. What each window recorded, and why it ended, is in the append-only [window log](WINDOWS.md). No further window is planned; the machinery below stays in force for one that is.

A violated guardrail in any future window reopens the operator release (ADR-0023, decision 5) and triggers design reconsideration. A window is never re-run to obtain a more favourable result.

### Release policy (fixed by each preregistration, before its windows)

On 2026-10-08 the operator decided that Pi runs local models only and that release is decided **per route**. Before that, the only ways to `done-allowed` were (a) a route qualifying as constrained emission, or (b) the spec owner accepting unconstrained emission as the measured mode. The operator's decision is (b), and it is recorded as a preregistered policy, not a re-reading of pilot-1:

| Policy | Preregistration | Rule |
|---|---|---|
| `capable-route-required` | `preregistration.json` (gcd-ad11-pilot-1, `schemaVersion` 1, no `releasePolicy` field; a v1 record parses to this and may not carry the field) | Done only when every measured cell is on a qualified constrained route. Any unconstrained cell leaves the claim `incomplete` (`no-qualified-capable-route`). |
| `per-route-engine-authoritative` | `preregistration-gcd-ad11-pilot-2.json` (gcd-ad11-pilot-2, `schemaVersion` 2; a v2 record must state `releasePolicy`, with no default) | Each cell is released on its own complete window when every guardrail holds. A constrained cell is released as **`constrained`** and AS-004 applies (provider-structural retries = 0). An unconstrained cell is released as **`unconstrained-engine-authoritative`**. On such a cell AS-004 is `not-applicable`, because the route enforces nothing and the engine validates every payload. AS-015 (latency p95, terminal-failure non-increase) and AS-016 (escaped-defect severity, at least 2 blinded assessors) still apply. |

Under either policy a violation gives `blocked-guardrail-violated`, and a missing, not-measured or inconclusive result gives `incomplete-missing-measurement`. A `done-allowed` decision names each released cell's `releaseClass`. The types make a released cell carrying a non-passing guardrail unrepresentable, and an engine-authoritative release carrying an AS-004 `pass` unrepresentable too. The types also tie a measured cell's AS-004 verdict to its qualification: a constrained cell can only read `pass` or `violated`, and an unconstrained cell only `not-applicable`. So a cell whose every guardrail passes has exactly one release class, and no cell can be resolved and unviolated yet unreleasable. The parsed preregistration types `schemaVersion` 1 with `capable-route-required` only, so a v1 value carrying another policy cannot be written. The decision core reads the policy in one place (`releaseUnderPolicy` in `pilot-core.ts`), which returns the cells the policy releases and the policy's own gaps. Under the per-route policy a preregistration with no emission cell at all releases nothing (`no-released-cell`). Each preregistration's SHA-256 is pinned in [`retained-preregistrations.json`](retained-preregistrations.json) (see [Preregistration](#preregistration-recorded-before-any-window)).

### Requirement status

| Requirement | Guardrail (per cell) | Status |
|---|---|---|
| AS-004 provider-structural retries = 0 on a capable route | `provider-structural-retries` | **Not applicable on the released unconstrained route** (ADR-0023, decision 5). AS-004 applies only to constrained cells, and no cell is qualified constrained: the local route enforces no schema, so its schema violations are reported as `unenforced-schema-violation`, never as a provider guarantee. Under pilot-2's per-route policy `not-applicable` is the guardrail's passing verdict for an `unconstrained-engine-authoritative` release, and the types tie it to the qualification (a constrained cell reads only `pass` or `violated`). |
| AS-015 p95 ≤ +25% vs extraction-only; terminal failures not increased | `latency-p95`, `terminal-failure-non-increase` | **Waived by the operator; not measured** (ADR-0023, decision 5). The pilot-1 windows were blocked; the 2026-10-08 pilot-2 window was a route outage and measures nothing about the arms; the two 2026-10-09 pilot-2 windows were aborted by the route fail-fast after 13 and 30 of 408 pairs, too few to judge either guardrail. |
| AS-016 escaped-defect severity not worse than the PR #52-only baseline | `escaped-defect-severity` | **Waived by the operator; not measured** (ADR-0023, decision 5). The pilot-1 windows dispatched nothing; the 2026-10-08 pilot-2 window holds only 4 accepted payloads before its outage; the two 2026-10-09 pilot-2 windows hold 20 and 47 accepted payloads before they were aborted, too few to judge the guardrail, and no independent blinded assessor scored either. |
| AS-017 retention; a missing measurement blocks done | `measurement-complete` and the decision union | **Mechanism in force.** Preregistrations, matrix, workload and every window are retained as recorded: the two blocked pilot-1 windows, the 2026-10-08 pilot-2 outage window and the two 2026-10-09 pilot-2 windows the fail-fast aborted. Every window's decision is `incomplete`; the release is the operator's, recorded in ADR-0023, not a window decision. |

## Preregistration (recorded before any window)

| Preregistration | Id | Recorded | Release policy | `scheduleSeed` | Windows |
|---|---|---|---|---|---|
| `preregistration.json` | `gcd-ad11-pilot-1` (`schemaVersion` 1) | `2026-10-03T09:17:26Z`, before the first window at 09:23:39Z | `capable-route-required` (implicit) | 20261003 | the two retained, both blocked ([window log](WINDOWS.md)) |
| `preregistration-gcd-ad11-pilot-2.json` | `gcd-ad11-pilot-2` (`schemaVersion` 2) | `2026-10-08T21:27:58Z` | `per-route-engine-authoritative` (explicit) | 20261008 | the three retained: 2026-10-08 (route outage) and two on 2026-10-09 (aborted by the fail-fast after 13 and after 30 pairs), see the [window log](WINDOWS.md) |

Each preregistration's SHA-256 is pinned once, machine-readably, in [`retained-preregistrations.json`](retained-preregistrations.json): its checkout-relative path, id and digest, in the shape a window records it. The test suite reads that manifest and checks that every pin matches its file's bytes and id, that every `preregistration*.json` here is pinned, and that every retained window records exactly its preregistration's pin.

Pilot-2 carries pilot-1's route, cells, schema digests, qualifications, workload, minimum pairs, timeout and guardrails unchanged. Of what decides a window, only the release policy and the schedule seed differ; as records, the two files also differ in their `id`, `schemaVersion` (2, which must state the policy) and `recordedAt`. The workload is unchanged; only the decision rule changed, and it changed before any pilot-2 window. Pilot-1 stays byte-identical, and so do its windows and their decisions.

Every window records the digest of its preregistration. `--decide` refuses to re-evaluate a window if the preregistration has changed since. The workload fixtures, `workload-fixtures.json`, are pinned by `workloadFixturesDigest` = `b60755891d4b26081f64d978e0fd688cd1359157d25d9e0be544cddd3851d201` in both preregistrations. The preflight blocks if they change. Any change needs a new preregistration `id`. Earlier windows stay retained.

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
- **Order:** a seeded global shuffle (`scheduleSeed` 20261003 for pilot-1, 20261008 for pilot-2) with ABBA counterbalancing of arm order within each cell.

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
- **Terminal failures** are `semantic-exhausted`, `startup-refused`, `infrastructure` and `timeout`, with a 900 s per-attempt timeout. **Provider-error rule:** a settled attempt is classified first, through the engine's own selection and the frozen parser. An accepted payload stands, whatever happens after it: an emission-tool call the engine accepted keeps its payload even if the turn after it ends in a provider error, because the production engine ingests an emission at the tool call. Only an attempt left WITHOUT an accepted payload is then read for a provider error ending its LAST model turn (`stopReason: "error"`: refused connection, 5xx, dropped stream); that attempt is an `infrastructure` failure on either arm, never a semantic rejection, so it never spends the attempt-2 retry. A final message is the last model turn's, as in production extraction, so an answer an errored turn came after is not a usable final message. A provider error Pi recovered from (a later turn answered) is not a failure. The `e8d688d8` revision applied the rule before classifying; see the first 2026-10-09 window in the [window log](WINDOWS.md). Terminal failures are retained per arm and rank **+∞** in the latency distribution, so they cannot be dropped. Infrastructure failures are terminal in the pilot for both arms; there is no re-dispatch. On the emission arm, a launcher that cannot be loaded or that rejects mid-run is an infrastructure failure of that attempt, not a window abort, and so is a launch the launcher reports successful although the readiness barrier never verified the child.
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
- At least **2 blinded assessors**: `rubric-v1`, which is deterministic and blind by construction, plus one independent assessor scoring `blinded-assessment-packet.json`. Disagreements are retained, and adjudication takes the maximum severity, identically for both arms. `rubric-v1` reads every accepted payload through its cell's frozen parser (the reviewer v2 and standalone-successor v3 payload parsers, the judge and refutation verdict schemas), so it reads typed fields only; a v3 payload's findings are read through their drafts. It fails closed. If a blinded entry's case is not preregistered, its input is unresolved, its payload is refused by its cell's parser, or an escaped defect id is not declared by its case, the whole assessment is an error that names every such entry, and the `--pilot` run stops after retaining the key and packet without writing `rubric-v1.json`. `window.json` is closed (`endedAt`, `observations`, and a dispatched window's `ending`) before the packet is derived, so such a window still records how it ended; `recordWindow` returns that closed record beside the refused decision. A later decision then counts one assessor fewer, so escaped-defect severity reads as not measured. An unresolvable entry never counts as zero escapes.
- Release precedence: any violation gives `blocked-guardrail-violated` (with design reconsideration). Otherwise any missing, not-measured or inconclusive result gives `incomplete-missing-measurement`. Only a complete, all-pass record whose every measured cell the preregistered release policy releases gives `done-allowed`:
  - Under `capable-route-required`, every measured cell must be on a capable route. One capable cell never carries an unconstrained cell to done.
  - Under `per-route-engine-authoritative`, each cell is released on its own as `constrained` or `unconstrained-engine-authoritative`.
  - The types make a "done" decision carrying a non-passing guardrail unrepresentable.

This is a minimum operational pilot, not a statistical proof of universal non-regression.

## Operator activation / reload steps

1. **Stage the delivered revision.** Merge or check it out. The runner records its Runtime Revision in every window under `preflightFacts.stagedRuntimeRevision`.
2. **Activate it through the normal path.** In Pi, run `/reload`, or fully restart Pi while preserving the session, so the loaded extension publishes the new content-addressed Runtime Revision handshake. Do not bypass the handshake: the mutating CLI refuses on skew, as described in `docs/operations.md` § "Pi reports runtime version skew".
3. **Confirm loaded = staged.** Run the pilot from a shell inside that Pi session, where `LOOM_PI_EXTENSION_RUNTIME_REVISION` is published. The preflight then records `loadedRuntime: matches-staged`, and a mismatch blocks the window.
4. **Confirm the launcher barrier.** The separately installed `subagent` launcher must export `runRpcAgent`. The runner loads `extensions/subagent/rpc-launcher.ts` under `~/.pi/agent`; name another module with `--launcher <module>`.
5. **Bring the route up.** The preflight probes it with the engine's own route probe, an unauthenticated `GET {baseUrl}/models`. `engine/src/core/route-reachability.ts` is the one owner of what each answer means, and the window's route fact records that decision:
   - A 2xx model listing is recorded as `reachable` with `servedModels`. A listing without `glm-5.3-flash-spark-tp2-v14` blocks the window as `served-model-absent`.
   - An authentication refusal (HTTP 401/403) is recorded as the explicit fact `{ "kind": "served-model-unverified", "reason": … }`. The server answers, but its model list cannot be observed without credentials, so the retained evidence states that the model identity was never confirmed. Loom never resolves, sends or records a credential; Pi authenticates the inference itself. The fact records no `served-model-absent` block. A window retained before this fact existed (`gcd-ad11-pilot-2--2026-10-08T21-43-49-395Z`) recorded the same observation as `reachable` with `servedModels: null`; the parser reads that shape as `served-model-unverified`, so the retained window re-decides unchanged.
   - Anything else is recorded as `unreachable` and blocks the window: a refused connection, a timeout, any other status, or a 2xx without a readable list (unlike the Pi spawn gate, which admits that last case as unverified: nothing says it is the OpenAI-compatible server this window measures).

   The live vLLM currently answers `GET /models` with **HTTP 401**, so an unauthenticated `curl http://192.168.0.80:8000/v1/models` printing a 401 means the route is up. Confirm the served model with your own credentials outside Loom if needed.
6. **Run a pilot-2 window** (hours; 816 child dispatches minimum). None is planned since the operator release (ADR-0023, decision 5); a window run later measures the route and can reopen that release if a guardrail is violated:
   `LOOM_RUN_MODEL_CALIBRATION=1 bun scripts/run-model-calibration.ts --pilot calibration/grammar-constrained-decoding/preregistration-gcd-ad11-pilot-2.json`
   - Its windows land in `windows/gcd-ad11-pilot-2--<start>/` and are decided under `per-route-engine-authoritative`.
   - Do not start a new window against `preregistration.json`. Pilot-1 is retained for its two windows under its original policy.
   - Observations are appended per sample to `observations.jsonl`, so an interrupted window keeps everything observed.
   - **Route fail-fast.** After any pair with an infrastructure failure or a timeout, the window re-probes the preregistered route with the preflight's own probe. It stops at once when the route is unreachable; a probe that rejects or throws counts as unreachable, so the window fails closed and is always recorded. It also stops on the third consecutive pair whose every sample was an infrastructure failure or a timeout, even while the route still answers its listing (reason `consecutive-outage-pairs`), which stops a server that answers its listing but hangs inference. It stops only between pairs, so every landed pair keeps both arms. A semantic rejection never probes or stops anything, so model behaviour is never cut short. The last scheduled pair is never judged: a schedule dispatched in full always ends `completed`, and an outage on its last pair is recorded in its samples, not as an abort. The rule is one pure step in `pilot-window-ending.ts`.
   - **The recorded ending.** `window.json` (`schemaVersion` 2) records how the window ended: `completed` with the scheduled pair count, or `aborted` after a number of pairs with its reason (`route-unreachable` with the probe's reason, or `consecutive-outage-pairs`). A closed record holds two samples per dispatched pair, and none for a window that never dispatched. Each ending is read under the rules of the `schemaVersion` that wrote it, so a `schemaVersion` 1 window stays readable exactly as recorded, including its `consecutive-infrastructure-failures` reason, and only such a window may lack the field. `--decide` refuses a window whose ending does not end its preregistration's schedule. An aborted window is decided like any other: its unmeasured pairs leave it `incomplete`. The one codec is `pilot-window-record.ts`.
   - `--preflight-only` records identity and reachability without dispatching.
7. **Blinded assessment.** An independent assessor scores `blinded-assessment-packet.json`, which shows blind ids only, and produces an assessment (`schemaVersion: 1`, `blinded: true`, a path-safe `assessorId`). Then run `bun scripts/run-model-calibration.ts --decide <window-dir> [--assessment <file>]`, which is offline and needs no opt-in.
   - Every assessment a decision reads is retained in the window. An `--assessment` file is copied to `assessments/<assessorId>.json` first. Re-submitting identical bytes does nothing, and a different assessment for an assessor already retained is refused, never overwritten.
   - `release-decision.json` is the current decision. Every decision, including the first, is also appended to `decision-log.jsonl`, so a re-decision can never erase an earlier verdict.
8. **Never chase a favourable window.** A violated guardrail means design reconsideration. A changed workload or route means a new preregistration `id`, recorded before its window. Retained windows are never overwritten.

## Files

| File | Role |
|---|---|
| `preregistration.json` | pilot-1 preregistration, release policy `capable-route-required`; binds the two pilot-1 windows |
| `preregistration-gcd-ad11-pilot-2.json` | pilot-2 preregistration: pilot-1's workload under release policy `per-route-engine-authoritative`; binds every new window |
| `retained-preregistrations.json` | the one machine-readable SHA-256 pin of each retained preregistration, read by the test suite |
| `workload-fixtures.json` | judge and refutation fixtures, v3 context, corpus pointer |
| `pilot-vocabulary.ts` | pure: the required cells (read from the frozen emission-tool registry), arms, severities, spec-fixed bounds, guardrails |
| `pilot-statistics.ts` | pure: seeded PRNG, nearest-rank quantiles over +∞ samples, percentile bootstrap |
| `pilot-preregistration.ts` | pure: the preregistration codec, including the release policy, and the seeded ABBA paired schedule |
| `pilot-observation.ts` | pure: per-arm attempt and sample parsing, sample terminals, retry attribution |
| `pilot-preflight.ts` | pure: preflight facts, the engine route probe mapped into the route fact, the preflight decision |
| `pilot-quality.ts` | pure: blinding key and assessment parsing, the paired escaped-defect comparison (AS-016) |
| `pilot-core.ts` | pure: `evaluatePilot`, which derives cell measurements, guardrails and the release decision under the preregistered policy |
| `pilot-qualification.ts` | pure: what a cell's emission qualification fixes: its structural series, AS-004 verdicts and release class |
| `pilot-workload.ts` | pure: fixtures, case-input resolution (refused before a window opens), matched prompt rendering |
| `pilot-binding.ts` | pure: per-attempt request identity and the issued binding, minted through the engine's one mint |
| `pilot-corpus-loader.ts` | shell: the filesystem adapter of the window's lazy corpus port |
| `pilot-rubric.ts` | pure: the deterministic `rubric-v1` assessor over typed payloads |
| `pilot-dispatch.ts` | pure transcript classification, plus the live Pi dispatch adapter |
| `pilot-window-ending.ts` | pure: the route fail-fast rule and the `WindowEnding` codec, keyed on `schemaVersion` |
| `pilot-window-record.ts` | pure: the one `window.json` codec |
| `pilot-window.ts` | shell: matched-arm window dispatch, the attempt-2 retry, the route fail-fast, blinding key, arm-free packet |
| `pilot-retention.ts` | `recordWindow` and the retained-file rules (never overwrite, preregistration-drift refusal); the `--pilot` and `--decide` sequences that `scripts/run-model-calibration.ts` wires to live adapters |
| `pilot-test-fixtures.ts` | shared test fixtures: the retained workload and preregistrations, sample builders, a fake route |
| `../kernel.ts`, `../pi-json-stream.ts` | the Result kernel and Pi's JSON event stream, shared with the corpus core |
| `../corpus-calibration.ts` | pure core of the script's default (historical corpus) mode |
| `package.json` | private test entry point: runs these tests on the engine's pinned Vitest and config. It is not a Runtime Revision input. |
| `windows/<window-id>/` | one retained window: `window.json`, `observations.jsonl`, `accepted-payloads.jsonl`, `blinding-key.json`, `blinded-assessment-packet.json`, `assessments/`, `release-decision.json`, `decision-log.jsonl` (windows from the second one on) |

Each module has one `*.test.ts` suite at its interface. `pilot.test.ts` is the release decision through `evaluatePilot`, `pilot-retention.test.ts` re-decides every retained window to its retained bytes, and `runner.test.ts` runs the CLI as a subprocess.

Tests: `npm test --prefix calibration/grammar-constrained-decoding` from the repo root. Its `test` script, run from this directory, is `env -u PI_CODING_AGENT ../../engine/node_modules/.bin/vitest run --root ../../engine --dir .`. The `env -u PI_CODING_AGENT` is deliberate (like the engine's own test scripts, it keeps a surrounding Pi session from leaking into the tests), so invoke the script instead of copying the Vitest command without it. The engine's Vitest config also includes `calibration/**/*.test.ts` and its typecheck includes `calibration/`, so `npm run verify` runs and typechecks them too.
