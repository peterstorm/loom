# Phase-2 Feasibility Record — Grammar-Constrained Decoding

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md`
**Plan:** `.claude/plans/2026-09-16-grammar-constrained-decoding.md`
**Date:** 2026-09-19
**Status:** Both Phase-2 feasibility prerequisites are RESOLVED with committed evidence — route qualification (§2) and launcher readiness seam (§3). The FR-032 real reviewer request-to-ingestion vertical slice is **not** covered by this record; it remains the Phase-3 gate. This record consolidates committed probe evidence with exact commands, runtime/schema identity and evidence limits; it is not a Wave Gate pass and completes no requirement by itself.

---

## 1. Scope and authority

**What this record is.** The Phase-2 artifact the plan requires: "publish feasibility observations with exact commands, runtime/schema identity and evidence limits" (plan Phase 2; AD-2/AD-4/AD-5 prerequisite resolution). It consolidates the two committed probe programs and their artifacts:

- `probes/emission-qualification/` — exact-route schema qualification (commit `91192d5`, includes all recordings).
- `probes/emission-readiness/` — launcher readiness barrier mechanism (commit `b4cf963`).

The committed probe READMEs are the interpretations of record. Where the raw machine report disagrees with them, the discrepancy is named here (§2.6) rather than silently normalized.

**What this record is not.** It is not runtime integration, not a claim that the model reliably calls the tool, not a latency/quality measurement (AD-11 calibration is Phase 6), not production readiness proof (the full AS-020 negative-control matrix through the production path is allocated to Phase 3), and not a second schema or payload contract (FR-021).

**Provider access status.** Access to the live local vLLM server existed at qualification time. Per FR-032, missing provider access or missing launcher capability is an explicit implementation prerequisite — never a claimed pass. Had either been missing, the corresponding section below would state BLOCKED and Phase 3 would not start (plan Phase 2: "If provider access or the launcher seam is missing, remain blocked here; tests asserting a fabricated port succeeds are not readiness proof").

---

## 2. Route qualification — FR-002 / AS-023 (FR-032 prerequisite 1)

### 2.1 Runtime and schema identity (exact)

| Component | Identity |
|---|---|
| Pi runtime | installed `pi` **0.83.0** — `/nix/store/w594wdq06kgr892xbz9rlm18irkq98fc-pi-coding-agent-0.83.0` (`/home/peterstorm/.nix-profile/bin/pi`); the same runtime later proven by the readiness probe (§3) |
| Provider | `desktop-vllm` — **vLLM** OpenAI-compatible server (identification confirmed by the server's own fingerprint `vllm-0.1.dev21530+gbd7681400-tp2-78dbda3f` in every streamed response) at `http://192.168.0.80:8000/v1` |
| Served model | `glm-5.3-flash-spark-tp2-v14` (the served spark-preset profile; the routing policy inherits the parent's model, so the served model id is part of the route identity) |
| Sampling request | production shape `constrainedSampling: { type: "json_schema", strict: "prefer" }` through pi's existing resolver; on the wire pi serialized `strict: true` on every tool, for all four schemas |
| Route identity (AD-2) | `(desktop-vllm, glm-5.3-flash-spark-tp2-v14, <schema digest>)` |

Frozen schema identity — digests minted from the real zod schemas and embedded, with the full schema bytes, in `probes/emission-qualification/fixtures/manifest.json` (also stamped into every wire tool def and reported in `recordings/probe-report.json`):

| Kind/version | Registered tool name | Schema digest | Size |
|---|---|---|---|
| reviewer-payload v2 | `loom_emit_reviewer_payload_v2` | `sha256-3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37` | 10.0 KB |
| reviewer-payload v3 | `loom_emit_reviewer_payload_v3` | `sha256-515ed14d0435d47da4f8299ed4f7ba9908f33c9f567051db93de84ec0017b4a2` | 14.6 KB |
| judge-verdict v1 | `loom_emit_judge_verdict` | `sha256-3f590e9f4a9e4ef586220f4d0fa07bb061fb4ebaa32c9a24eeed07fbb044c569` | 1.8 KB |
| refutation-verdict v1 | `loom_emit_refutation_verdict` | `sha256-766a0dee252ca3fb135253d51b6ddea5bac1ce941e367eebf2da10f81ce8b2fd` | 1.4 KB |

The qualification is bound to exactly these bytes. Any byte change moves the digest and triggers requalification (§2.8).

### 2.2 Exact commands

```sh
# 1. Mint canonical fixtures once (committed output; rerun only to re-derive)
npx tsx probes/emission-qualification/gen-fixtures.mts

# 2. Run the qualification probe against the live local route
node probes/emission-qualification/probe.mjs              # all four schemas
node probes/emission-qualification/probe.mjs --model glm-5.3-flash-spark-tp2-v14
node probes/emission-qualification/probe.mjs --only v2    # single schema
```

- **Fixture provenance (parse, don't validate at the evidence layer):** `gen-fixtures.mts` imports `EMISSION_TOOL_SPECS` from `engine/src/core/emission-tool` and the real zod schemas (`reviewer-contract`, `standalone-lineage-contract`, `panel-contract`, `review-panel`), and writes a fixture only after `schema.parse(...)` succeeds. The probe asks the model to emit canonical parsed payloads by construction — never hand-authored JSON that could drift from the frozen contracts.
- **Probe child invocation (from `probe.mjs`):** `pi --mode rpc --no-session -ne -e probes/emission-qualification/qual-extension.ts --provider desktop-vllm --model <model>`, with `QUAL_PROXY_BASE_URL` pointing at the probe's recording proxy. `-ne` disables extension discovery so only the probe extension loads.
- **Probe method:** a recording proxy sits between the probe child and the real server, capturing the exact wire request and the raw streamed response for every model request. The child registers the four REAL emission tools — frozen registry bytes, production tool names (version-suffixed only where v2/v3 share the reviewer spec), and the production `strict: "prefer"` shape — so every captured request is what production will send. Per schema: an acceptance call (canonical fixture), a violation-temptation call, and a **direct-enforcement stage** that reuses the exact wire tool def, forces `tool_choice`, and demands the violating arguments — model cooperation is irrelevant there; the sampler alone decides whether schema-invalid arguments are representable.
- **Run identity:** started `2026-09-19T11:58:05.237Z`; all calls hit the local server (no subscription spend; the optional cloud comparison route was not touched). The committed recordings are the artifacts of this run.
- **Credentials:** the driver reads the upstream key from the operator's `~/.config` candidate paths at runtime; captured request recordings contain the wire body only (no headers, no credentials).

### 2.3 Committed evidence

- `probes/emission-qualification/README.md` — the committed verdict table and route classification (interpretation of record).
- `probes/emission-qualification/fixtures/manifest.json` — per-kind registered tool name, full frozen schema bytes, digest, canonical fixture, violation instruction and violation detector.
- `probes/emission-qualification/recordings/` — 39 committed files, verbatim wire traffic: `NNN-request.json` (every model request body) and `NNN-response.sse` (every raw streamed response) for 17 request/response pairs, plus `001-wire-params.json` / `003-wire-params.json` (actual serialized v2 wire tool parameters) and the machine stage report `probe-report.json` (`errors: []`).
- Recording map: `001`–`005` reviewer v2 (acceptance `001`, in-child validation-retry feedback `002`/`003`, violation temptation `004`, retry `005`), `006` v2 direct-enforcement; `007`–`010` reviewer v3, `011` v3 direct; `012`–`014` judge (acceptance, temptation, retry), `015` judge direct; `016` refutation acceptance, `017` refutation direct.

### 2.4 Verdicts (all four schemas)

| Schema | Accepted | `strict` on wire | Wire parameters = frozen bytes | Violation through (stage) |
|---|---|---|---|---|
| reviewer v2 | **yes** (HTTP 200, `recordings/001-*`) | true | **yes** | no — model complied under temptation; direct call also conformed → recorded **inconclusive** |
| reviewer v3 | **yes** (HTTP 200, `recordings/007-*`) | true | **yes** | no — model complied under temptation; direct call also conformed → recorded **inconclusive** |
| judge v1 | **yes** (HTTP 200, `recordings/012-*`) | true | **yes** | **yes** — `score: 12` at HTTP 200, emitted even in the unforced temptation stage (`recordings/013-*`) and repeated decisively by the forced direct call (`recordings/015-*`) |
| refutation v1 | **yes** (HTTP 200, `recordings/016-*`) | true | **yes** | **yes** — `verdict: "partially_upheld"` at HTTP 200 through the forced direct call (`recordings/017-*`) |

Supporting observations verified against the raw artifacts:

- **Wire-parameter identity:** the machine report records `wireParamsEqualFrozen: true` (deep structural equality of the parsed wire parameters against the frozen bytes) for every acceptance/violation stage. The retained v2 artifacts go further: `recordings/001-wire-params.json` is **byte-identical** to the frozen schema bytes in `fixtures/manifest.json`. The strictifier is a no-op on this route — the zod-derived frozen bytes are already strict-compatible (`additionalProperties: false` + complete `required` everywhere, including across v2's root `oneOf`); pi forwarded the frozen bytes unchanged with `strict: true`.
- **Acceptance calls emitted the canonical fixture:** assembling the streamed argument deltas of `recordings/012-response.sse` (judge) and `recordings/016-response.sse` (refutation) yields argument objects parsed-equal to the minted fixtures in `fixtures/manifest.json` (key-for-key, value-for-value; formatting differs from the pretty-printed fixture text).

### 2.5 Route classification: unconstrained emission (AD-2 vocabulary)

- **vLLM ignores the OpenAI tool-level `strict` flag.** Its structured-outputs enforcement lives in `extra_body` (`guided_json` / `structured_outputs`), which pi-ai does not send for tools.
- **Decisive evidence:** on the same server and the same flag, schema-invalid arguments were representable and went through at HTTP 200 — judge `score: 12` (emitted even without forcing) and refutation `verdict: "partially_upheld"` (forced direct call). The direct stage exists precisely to separate model compliance from grammar enforcement; these two results settle the mechanism for the route.
- The v2/v3 direct calls conforming is **model compliance** (the schema-bearing tool descriptions and prompt context primed conformity), recorded **inconclusive** — never claimed as enforcement.
- **Consequence:** this route is **unconstrained emission** for tool arguments — a legitimate, fully-supported mode per the plan. The engine stays authoritative (FR-003/FR-006/FR-010/FR-018: engine parsing, issuance joins, and the request-slot budget are unchanged). **No route is extraction-only:** nothing was rejected, so no schema rewriting or provider-specific payload construction occurred or was needed; AS-023's extraction-only clause has no instance on this route.
- vLLM-native enforcement (`guided_json`/`structured_outputs`) is a pi-ai **resolver** capability, not a loom one — FR-030 keeps loom out of provider serialization. If pi-ai's resolver grows that support, this route could re-qualify as constrained.

### 2.6 Evidence limits (honest)

- **Raw-argument observation is unavailable at the harness seam.** Pi exposes parsed tool arguments to tools and the engine; it does not expose the original generated JSON bytes. Parsed arguments cannot establish what duplicate keys existed in the original generated JSON. This record therefore records raw-argument observation as **unavailable** and makes **no zero-duplicate-key measurement or claim** from this probe. The committed raw SSE streams retain the streamed argument deltas verbatim, so the concatenated argument text is in principle re-derivable by hand, but no such analysis was performed and none is claimed.
- **The machine stage report contains known bookkeeping artifacts; the committed README verdicts supersede them.**
  - The refutation acceptance stage shows `accepted: false` with no captured `httpStatus` in `probe-report.json`, while the raw recording of that stage (`recordings/016-request.json` + `016-response.sse`) shows the complete wire exchange — tool call emitted, streamed to `[DONE]` with usage, at the same server. The committed README verdict ("accepted, HTTP 200", verified against the recordings) supersedes the stage flag.
  - The refutation violation-temptation stage recorded zero wire requests (its stage counters are zero); the adversarial evidence for refutation comes from the forced direct stage, `recordings/017-*`.
  - The report's per-stage `executeObserved` flag for the refutation acceptance stage is part of the same attribution artifact class; the refutation acceptance arguments were parsed-equal to the canonical fixture (§2.4), and the committed README records the execute round-trip as achieved for judge v1 and refutation v1.
  - The report's auto-generated per-stage `classification` strings are pre-analysis heuristics (they label v2/v3 "CONSTRAINED" on model compliance) and are superseded by the committed route-level classification in §2.5.
- **Model compliance is not enforcement.** v2/v3 arguments conforming under temptation is inconclusive about grammar enforcement; only the judge/refutation results settle the mechanism — and only for this server build (`vllm-0.1.dev21530+gbd7681400-tp2-78dbda3f`) and flag behavior.
- **Constraint-support observations are shape-level.** Demonstrated: the route accepts the exact frozen schema bytes and does not enforce the JSON Schema at sampling time. Not demonstrated: any deeper provider behavior (duplicate keys, raw-byte unicode edge handling, reasoning/thinking interactions beyond the observed `reasoning_effort`), or that the served model reliably calls the tool — compliance varied: judge/refutation acceptance emitted the canonical fixture in one request; v2/v3 re-typed fixture fields and were refused by pi's validator (§2.7), a model-compliance fact, not a defect.
- **Run count.** The committed qualification recordings are the artifacts of **one** full run (17 request/response pairs; `probe-report.json` reports no errors). The readiness probe ran twice (§3); the qualification probe has not been re-run for reproducibility. A rerun is only comparable at the same route identity (§2.8).
- **Scope of qualification.** Exactly one route is qualified: the local vLLM route above. No cloud route (e.g. openai-codex) was qualified — unspent, not claimed. Any additional configured route requires its own qualification with its own recordings before any capability claim.

### 2.7 Pi-side gates observed live (adjacent AS-018 evidence)

- Pi's client-side `validateToolArguments` **accurately validates the forwarded frozen schemas** — all four canonical fixtures pass against the exact wire parameters (offline reproduction via pi-ai `utils/validation.validateToolArguments`).
- A malformed model emission was **refused with precise per-branch errors** (`recordings/002-*`: "schemaVersion: must be equal to constant", "findings: must be array", …) — the oneOf/$defs shape parses correctly, and the refusal is the designed engine-authoritative behavior for an unconstrained route.
- Execute round-trip achieved (canonical emission → execute → terminating ack) for judge v1 and refutation v1; v2/v3 execute was not observed because the model re-typed the fixture with string-typed fields and the validator refused — not a defect; the identical execute shell and validator pass for all four closes the loop.
- **Discovery — pi's in-child validation-retry loop:** on tool-argument validation failure, pi feeds the error back as a tool-role message and re-prompts the model (observed ~2 extra model requests; `recordings/002/003/005/008/010/014`), ending in `finish: stop` when the model cannot produce valid arguments. Calibration (AD-11) must count this loop in the emission-mode latency budget; FR-006's budget boundary notes that loom's request-slot accounting sits **outside** this harness-level loop.

### 2.8 Requalification triggers (per AD-2)

- Any served-model switch (the route identity includes the served model id).
- Any frozen-schema change (the digest moves).
- Any pi upgrade that changes tool serialization or the resolver's strict-sampling behavior.

---

## 3. Launcher readiness seam — FR-008 / AS-020 (FR-032 prerequisite 2)

### 3.1 Runtime identity

- Installed `pi` **0.83.0** — same nix store path as §2.1.
- A **counting provider substitute**: a local HTTP server that counts and rejects `/v1/chat/completions` POSTs — no real model involved. The substitute proves request counts and ordering; it proves nothing about payload contents.
- Date 2026-09-19; **two consecutive full runs with identical verdicts**. The probe prints its verdicts (no recordings directory); the committed README documents the results.
- Probe budget constants (from `probe.mjs`): readiness timeout 15 s, state timeout 10 s, first-request timeout 30 s, hold 2 s, ordering slack 250 ms.

### 3.2 Exact command

```sh
node probes/emission-readiness/probe.mjs                  # all four variants (~25s)
node probes/emission-readiness/probe.mjs --variant matching   # single variant
```

No model or provider access is needed (the substitute server is local); the installed `pi` must be on `PATH`.

### 3.3 The proven seam

The plan-alignment checkpoint had marked FR-008 BLOCKED: the installed normal subagent launcher starts print-mode Pi with its prompt already supplied — no pre-prompt readiness exchange. This probe demonstrates the supported seam:

1. **Spawn** the child headless with NO prompt: `pi --mode rpc --no-session -ne -e <probe-extension.mjs> --tools <tool>` (run in a temp dir; `-ne` isolates the probe extension).
2. **Channel check:** `get_state` answers — distinguishing "child up, readiness missing" (readiness refusal) from "child never came up" (infrastructure failure).
3. **Discovery:** `get_commands` must list the expected readiness command (source `extension`) BEFORE it is invoked. An unknown `/command` falls through to a normal user prompt and triggers a real model request — so the launcher must never invoke an unverified command. A stale/absent extension therefore fails by command absence.
4. **Readiness:** the launcher invokes `/loom-emission-readiness` via the RPC `prompt` command. Extension commands execute immediately (preflight succeeds, **no model request**), and the handler performs the authoritative in-process check — `pi.registerTool` + `pi.getActiveTools()` — then reports via `pi.appendEntry(customType, payload)`, which emits `entry_appended` on the RPC stdout. The payload binds: exact tool name, schema digest, revision, child PID, active flag, full tool list.
5. **Gate decision (pure):** the launcher compares the payload against the issued expectation (tool, digest, revision, active). Any mismatch refuses.
6. **Route binding (fail-closed):** `set_model` selects the issued provider/model and its response identity is compared. A prompt that slips past a failed selection would fall through to the child's default real provider — the under-capability class the gate exists to prevent. No `set_model` success, no prompt.
7. **Deliver:** only on a matching readiness plus verified route does the launcher send the real prompt. Refusal and timeout never prompt; cleanup kills only that child.
8. **In-child defense-in-depth (proven separately):** a `before_agent_start` handler returning a pending promise blocks `agent-session.prompt()` between `emitBeforeAgentStart` and `_runAgentPrompt` — the first model request waits for the hold. Throwing is NOT a stop: `emit()` catches handler exceptions and continues. The hold is the gate; the throw is only a log.

### 3.4 Results (2 consecutive full runs, identical verdicts)

| Variant | Readiness | Gate | Prompt sent | Counting-server requests | Verdict |
|---|---|---|---|---|---|
| `matching` | observed; digest+revision+active match | open | yes | **1**, first request after readiness observation | PASS |
| `contradictory` | observed; wrong schema digest | refused (`digest`) | no | **0** | PASS |
| `missing` | command never registered (stale/absent-extension shape) | refused (absent) | no | **0** | PASS |
| `held` | observed + matching | open; child hold delays the first request | yes | **1**, request ≥ hold resolution | PASS |

**PROBE PASS 4/4, twice.** Measured timings: readiness-to-first-request +53 ms (matching); hold resolution → first request +61 ms (assertion slack 250 ms); child startup (spawn → readiness available) ~1.7–2.0 s; the gate adds two RPC roundtrips on top. Calibration (US6/AD-11) must include this startup cost in the p95 budget. These are single-machine timings informing budget design — they are not a p95 result.

### 3.5 Mechanics the production integration must honor (discovered here)

- **Action methods cannot be called during extension loading** — the loom child extension must register its tool/provider/appendEntry inside event handlers (e.g. a command or `session_start`), never at factory top level.
- **Startup events never reach the launcher:** `rebindSession()` emits `session_start` BEFORE the RPC loop attaches its stdout subscription — a readiness signal appended in `session_start` is invisible. Readiness MUST be command-invoked at gate time (this also makes it fresh and request-bound).
- **Unknown commands fall through to real model requests:** discovery (`get_commands`) precedes invocation, always.
- **No CLI route lock for extension-registered providers:** `--provider probe` at startup errors ("Unknown provider") because registration happens in the extension. The gate's `set_model`-before-prompt fail-closed step is what prevents fall-through to the default real provider.
- **Model definitions need `input` and `cost`** — a minimal definition omitting them crashes pi-ai client-side before any request.
- **Tool errors are thrown, never returned** (returning never sets `isError`); `terminate: true` from `execute` skips the follow-up turn when every finalized result in the batch terminates (FR-013 surface, verified in the installed pi's docs).

### 3.6 Evidence limits (honest)

- **The counting substitute proves zero-request gating mechanics, not real-model behavior.** The real reviewer request→child→capture→ingestion path with a real model is the Phase-3 vertical slice (FR-032's second half, AS-022) — this probe does not claim it.
- **AS-020 coverage is mechanism-level for four principal controls:** missing/absent extension, contradictory digest, bounded timeout (refusal path of `missing`), and cleanup that kills only the probe's child. The full AS-020 negative-control matrix re-run through the production path remains allocated (Phase 3).
- **Seam primitives are proven on installed 0.83.0 only** (RPC mode, `get_commands`, extension-command prompt invocation, `entry_appended`, `getActiveTools`/`getAllTools`, awaited `before_agent_start`). The true upstream minimum is unverified (API history not auditable offline). Owning package of the seam primitives: `@earendil-works/pi-coding-agent`.
- **The launcher edit is a separately owned prerequisite, not yet done.** The installed launcher is `~/.pi/agent/extensions/subagent/index.ts`, sourced from `~/.dotfiles/pi/extensions/subagent/index.ts` — outside this repository. The print-mode → RPC gate protocol change is a separately owned dotfiles change; loom's in-repo share is the child-extension readiness command plus the gate protocol specification (the probe + this record). No global extensions were modified for the probe. Until that edit exists, production emission spawns do not yet have the launcher barrier — an explicit, tracked prerequisite (FR-032/FR-008), never a claimed pass.

---

## 4. Prerequisite ledger

| Prerequisite | Status | Evidence | Remaining work |
|---|---|---|---|
| FR-002 / AS-023 exact-route qualification | **RESOLVED** — unconstrained emission on the local vLLM route, all four frozen schemas accepted, wire bytes = frozen bytes | `probes/emission-qualification/` (commit `91192d5`, recordings committed) | Requalify on the §2.8 triggers; qualify any additional configured route before claiming capability for it |
| FR-008 / AS-020 launcher readiness seam | **RESOLVED** — mechanism proven, zero-request negative controls, counting substitute, pi 0.83.0 | `probes/emission-readiness/` (commit `b4cf963`) | Dotfiles launcher gate (separately owned); loom child-extension readiness command; full AS-020 matrix through the production path |
| FR-032 real vertical slice | **NOT YET — Phase 3** | — | One real reviewer request→child→capture→ingestion path with discriminating bypass/always-accept/always-reject controls |

If either §2 or §3 evidence had been unobtainable (no provider access; no launcher seam), the corresponding section would read BLOCKED and Phase 3 would not start. Neither was the case; both prerequisites carry committed evidence.

---

## 5. Requirement traceability (contributions, not completion)

This Wave owns no Requirement Completion Claims. The contributions are partial work:

- **FR-032 (contribution):** the qualification prerequisite is demonstrated (§2); the launcher-readiness prerequisite is mechanism-proven (§3). The real request-to-ingestion vertical slice with discriminating success and failure controls remains Phase 3. Per the plan: "Phase 3 completes AS-022/FR-032 only when both qualification prerequisites and the real vertical slice are demonstrated, not merely when a feasibility document exists."
- **AS-023 (contribution):** actual request acceptance and observed constraint support are recorded for the exact v2/v3 reviewer and v1 judge/refutation schemas on the qualified local route (§2.4/§2.5), without schema rewriting or provider-specific payload construction (wire parameters equal — and for v2 byte-identical to — the frozen bytes; the strictifier was a no-op). No extraction-only instance arose on this route because nothing was rejected; every other declared route remains unqualified and requires its own record before any capability or degradation claim.
