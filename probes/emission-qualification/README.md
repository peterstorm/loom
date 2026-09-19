# FR-002 qualification probe — exact-route schema qualification (emission)

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md` (FR-002, AS-023, SC-007, AD-2)
**Qualified route:** `desktop-vllm` (vLLM) · model `glm-5.3-flash-spark-tp2-v14` (the served spark-preset profile) · each schema's digest below
**Run:** `node probes/emission-qualification/probe.mjs` (fixtures first: `npx tsx probes/emission-qualification/gen-fixtures.mts`)
**Date:** 2026-09-19 · **Raw evidence:** `recordings/` (every wire request + response, verbatim)

## Method

A recording proxy sits between the probe child and the real vLLM server; the
child registers the four REAL emission tools — the frozen registry's exact
bytes, the production registration shape, and `constrainedSampling:
{ type: "json_schema", strict: "prefer" }` — so every captured request is what
production will send. Per schema: an acceptance call (canonical fixture minted
by `schema.parse`, never hand-authored) and a violation-temptation call, plus
a **direct-enforcement stage** that reuses the exact wire tool def, forces
`tool_choice`, and demands the violating arguments — model cooperation is
irrelevant there; the sampler alone decides whether schema-invalid arguments
are representable.

## Recorded verdicts

| Schema | Digest | Accepted (HTTP) | `strict` on wire | Wire parameters = frozen bytes | Raw violation through forced call |
|---|---|---|---|---|---|
| reviewer v2 (10.0 KB) | `sha256-3ac33953…` | **yes** (200) | **true** | **yes** | no (model-complied; inconclusive — see below) |
| reviewer v3 (14.6 KB) | `sha256-515ed14d…` | **yes** (200) | **true** | **yes** | no (model-complied; inconclusive — see below) |
| judge v1 (1.8 KB) | `sha256-3f590e9f…` | **yes** (200) | **true** | **yes** | **yes** (`score: 12` at HTTP 200) |
| refutation v1 (1.4 KB) | `sha256-766a0dee…` | **yes** (200) | **true** | **yes** | **yes** (`verdict: "partially_upheld"` at HTTP 200) |

## Classification (AD-2 vocabulary)

**Route = UNCONSTRAINED EMISSION for tool arguments.** Pi requests
`strict: true` and forwards the frozen bytes unchanged (the strictifier is a
no-op — the zod-derived bytes are already strict-compatible:
`additionalProperties: false` + complete `required` everywhere, even across
v2's root `oneOf`). vLLM **ignores the OpenAI tool-level `strict` flag** — its
structured-outputs enforcement lives in `extra_body` (`guided_json` /
`structured_outputs`), which pi-ai does not send for tools. The two decisive
forced-call violations (judge, refutation) on the same server, same flag,
settle the mechanism; the v2/v3 direct calls conforming is model compliance,
not enforcement, and is recorded as inconclusive rather than claimed.

Per the plan this is a legitimate, fully-supported mode: **the engine stays
authoritative** (FR-003/FR-006/FR-010/FR-018 — engine parsing, issuance joins,
and the request-slot budget unchanged). No route is extraction-only: nothing
was rejected.

## Pi-side gates observed working (AS-018 adjacent evidence)

- Pi's client-side `validateToolArguments` **accurately validates the
  forwarded frozen schemas** — all four canonical fixtures PASS against the
  exact wire parameters (offline reproduction:
  `pi-ai` `utils/validation.validateToolArguments`).
- A malformed model emission (`schemaVersion: "2"` as string, `findings` as a
  JSON-encoded string) was **rejected with precise per-branch errors**
  (`recordings/002-*`: "schemaVersion: must be equal to constant", "findings:
  must be array", …) — the oneOf/$defs shape parses correctly, and the refusal
  is the designed engine-authoritative behavior for an unconstrained route.
- Execute round-trip achieved (canonical emission → execute → terminating
  ack) for judge v1 and refutation v1; v2/v3 failed only because the model
  re-typed the fixture with string-typed fields — refused by the validator,
  not by any defect. The identical execute shell + validator pass for all
  four closes the loop.

## Discoveries recorded for the plan (not modeled there today)

1. **Pi runs an in-child validation-retry loop:** on tool-argument validation
   failure, pi feeds the error back as a tool-role message and re-prompts the
   model (up to ~2 extra model requests; `recordings/002/003/005/008/010/014`),
   ending in `finish: stop` when the model cannot produce valid args. This is
   harness-level retry behavior — calibration must count it in the
   emission-mode latency budget, and FR-006's "no separate emission retry
   budget" boundary should note that pi itself retries at the validation seam
   (loom's request-slot accounting sits outside this loop).
2. **vLLM-native enforcement is a harness-resolver capability**, not a loom
   one: if pi-ai's resolver grows vLLM `structured_outputs`/`guided_json`
   support for tools, this route could re-qualify as constrained. FR-030
   forbids loom building that serialization itself.
3. The child's system prompt embeds the emission tools' schema-bearing
   descriptions (promptSnippet + guidelines) — the model cited the enum from
   context when refusing to violate, which is prompt-level compliance and
   distinct from grammar enforcement; the direct stage exists precisely to
   separate the two.

## Requalification triggers (per AD-2)

- Any served-model switch (the routing policy inherits the parent, so the
  route identity is `(desktop-vllm, <served model id>, <schema digest>)`).
- Any frozen-schema change (digest moves).
- Any pi upgrade that changes tool serialization or the resolver's
  strict-sampling behavior.
- Optional cloud comparison route (openai-codex) remains unqualified — not
  spent; local evidence was the priority and the subscription quota was not
  touched.
