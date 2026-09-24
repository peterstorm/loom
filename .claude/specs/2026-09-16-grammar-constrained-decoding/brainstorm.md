# Brainstorm Summary

**Building:** Grammar-constrained decoding for loom's structured agent payloads — reviewer/judge/verifier payload generation routed through provider structured outputs so payloads parse by construction, killing the syntax-level churn class at generation (roadmap churn row 1) instead of admitting it after the fact, with PR #52's fail-closed extraction retained as the deterministic fallback.

**Approach:** Payload emission tool with pi-ai constrained sampling — loom's extension registers a per-kind emission tool in payload-agent child sessions whose parameters schema is the exact frozen payload schema bytes, carrying `constrainedSampling: { type: "json_schema", strict: "require" }`; the engine's ingestion seam gains an additive, deterministic preference for valid emission-tool args over final-message extraction.

**Key Constraints:**
- **Determinism thesis (closed, must not reopen):** the engine never chooses between interpretations. The ingestion preference must be additive and deterministic — prefer emission-tool args when present and valid, else PR #52's fail-closed extraction (prose/fence admission, zero-candidate and ambiguity rejection, bounded retry) — and the fallback path stays fail-closed for every provider.
- **One schema, no second contract:** payload schema bytes are frozen and content-addressed (`schemaDigest` in `CURRENT_REVIEWER_PROTOCOL`; wire contract stamped via `renderReviewerWireContract()` + `scripts/stamp-wire-contract.ts`). The emission tool must emit those exact bytes, never a parallel schema.
- **Provider-agnostic via pi-ai, not bespoke serialization:** pi-ai already owns the constrained-sampling protocol (`Tool.constrainedSampling`, `resolveJsonSchemaStrictSampling`, `supportsOpenAIGrammarTools` Lark/regex variants) and emits `strict: true` on function tools for capable providers (openai-completions `convertTools`). Loom must not build a second provider payload builder outside pi-ai — the two-contracts smell `wire-contract.ts` explicitly warns against.
- **Payload producers are loom package agents, scoped by kind:** reviewer/judge/verifier kinds are cataloged in `engine/src/core/model-profiles.ts`; child-session agent identity is stamped (`LOOM_PI_AGENT_ID` marker via `engine/src/utils/render-pi-agent.ts`, parsed in `pi/extension.ts`). Scoping uses kind/identity, never prompt text.
- **Extension-in-child precedent exists:** loom's extension loads in spawned child pi sessions (global package) and already registers custom tools (`ask_user_question`, `interactive-subagent`) — the emission tool follows the same seam.
- **Honest churn accounting:** grammar constraints eliminate only syntax-level classes at generation (invalid JSON, schema non-conformance, duplicate keys, depth violations — each currently burns a bounded-retry round). Issuance-join constraints (frozen scope, packet/generation binding, prior-assessment ordering) are not expressible in a standalone schema and stay at ingress; semantic truth is never eliminable by either mechanism. Success metric is cost/time to independently accepted behavior without worse escaped-defect severity — measured against that boundary, not against plausibility.
- **Engine revision guard:** mutations bind through the content-addressed SHA-256 revision handshake (`PI_EXTENSION_RUNTIME_*` env vars, `runtime-compatibility` check before spawns).

**In Scope:**
- Emission tool(s) registered by loom's extension in payload-agent child sessions (reviewer, judge/verifier kinds per roadmap row 1: "reviewer and panel spawns are the payload producers"), parameters = exact frozen payload schema bytes, `constrainedSampling` set to require JSON-schema strict sampling.
- Additive ingestion preference in the subagent-stop/orchestration-result seam: prefer valid emission-tool args over final-message extraction; PR #52 extraction retained verbatim as the deterministic fallback.
- Capability-aware degradation: when the provider ignores the constraint (no strict mode, no grammar tools), behavior regresses to exactly today's pipeline — no new failure modes.
- Wire contract and docs updates where they live: single-source fragment (`renderReviewerWireContract()`), stamp script, agent README/model-profile docs.

**Out of Scope:**
- The other churn-informed additions (rows 2–9): mutation testing, family-repair checklist, tool-schema knob minimization, per-call tool deadlines, one-owner-per-fact, retry transactions, convergence diagnosis, delta debugging, Historical RED — each is its own row.
- Issuance-join constraint elimination (scope, binding, prior-assessment ordering) — ingress keeps those checks regardless.
- Task-graph/decompose payloads (`decompose-agent` output piped via CLI stdin to `populate-task-graph`) — different transport, planning-phase, smaller churn class; explicitly deferred (see Open Questions).
- Fugue-repo changes, LoopRegions, Best-of-N sampling, more reviewer lenses, higher reasoning budgets everywhere, any general Loom-to-Fugue rewrite.

**Open Questions:**
- Task-graph/decompose payloads: does the CLI stdin transport get the same emission-tool treatment later, or stay permanently out? (Defer to a separate row; the per-wave reviewer class is the retry-burning one.)
- Model-catalog compat flags (`supportsStrictMode`, `supportsOpenAIGrammarTools`) for the operator's `desktop-vllm` routing: configured user-side (`~/.pi/agent/models.json`), or does loom need calibration rows/docs? (Likely user-side + docs; confirm in specify.)
- Forced tool selection: pi-ai supports `options.toolChoice` (openai-completions emits `params.tool_choice`), which would make the tool call itself deterministic — not just its args — fully closing the grammar class. Whether the per-request plumbing is reachable from loom's extension seam is an architecture-phase question; constrainedSampling alone still leaves the model free to emit prose (covered by the fallback).
- Exact wire-contract text: whether the emission tool replaces "Emit exactly one JSON object … No other final output." or coexists as primary-with-fallback wording — specify phase decides.
- Schema size vs guided-decoding quality: `REVIEWER_PAYLOAD_SCHEMA_V2` is large; constrained decoding on large schemas can affect output quality/latency on some backends — worth one calibration observation, not a design driver.
- Live seam gap hit during this brainstorm: this brainstorm-agent spawn received no scoped Pi write grant (empty `/tmp/claude-subagents/pi-write-grants/`, no `LOOM_PI_WRITE_GRANT` marker in the child prompt), so its first artifact write was blocked by `block-direct-edits` — the exact "under-planned batch spawns a writer with no capability and fails confusingly at its first edit" confusion `pi-write-grant-plan.ts` names. Worth a defect row or triage in specify; not part of this feature's scope.

---

## Approaches Considered (for the specify phase)

### A. Payload emission tool with pi-ai constrained sampling — RECOMMENDED

Register a per-kind emission tool (via `pi.registerTool`, like `ask_user_question`) in payload-agent child sessions. Its parameters schema is the exact frozen payload JSON schema (already generated from zod via `z.toJSONSchema` — the same bytes the wire contract stamps), with `constrainedSampling: { type: "json_schema", strict: "require" }`. pi-ai resolves it against provider capability and emits `strict: true` (OpenAI strict mode → constrained decoding of tool arguments) or OpenAI custom-tool grammar formats (Lark/regex); vLLM's xgrammar/outlines/guidance backends honor structured outputs provider-side. The payload agent calls the tool; on capable providers the args are grammar-constrained — payload by construction.

The ingestion seam moves additively: the engine prefers the emission tool's args (when present and valid) over final-message extraction. PR #52's fail-closed extraction stays for providers without the guarantee and for models that emit prose instead of calling the tool — no regression anywhere.

Trade-offs: moderate new surface (one seam, one tool per payload kind, transcript-side tool-arg capture, wire-contract text update); targets the large churn class (multi-turn reviewer agents with bounded retries — the churn analysis's largest consumed rounds: the reviewer-protocol payload grammar, prose-wrapped payloads). All machinery it needs already exists in pi-ai/loom; nothing is built twice.

### B. Child-session provider payload rewrite (`before_provider_request`) — smallest alternative that works, but only for the small class

Rewrite the provider payload in the child session to add `response_format: { type: "json_schema", … }`. Deterministic only for single-turn, no-tool payload producers (e.g. `arch-judge-agent`, "read-only, pure JSON output") — with no tools, the assistant's first response is the payload, so the constraint applies to exactly one request. For multi-turn reviewers, which request is the payload request is not determinizable: constraining every turn breaks tool use, and turn-awareness heuristics reintroduce interpretation choice — reopening the determinism thesis. Also builds a second payload serializer outside pi-ai (the two-contracts smell). Panel judges are single-turn, so their extraction churn is already trivial — B buys little where it works and cannot work where the churn is.

### C. Honest no-op (keep PR #52 only) — the baseline A must beat

The governing simplicity bar says every addition must pay for itself. PR #52's extraction already admits prose/fence-wrapped payloads deterministically; the remaining syntax classes (zero-candidate invalid JSON, schema non-conformance, duplicate keys) each fail closed to the bounded retry. C costs nothing but leaves the grammar class alive at generation on every provider — the churn analysis names it the largest single lever, so C likely does not pay, but it is the honest fallback-shaped baseline against which A's churn-class reduction must be measured.
