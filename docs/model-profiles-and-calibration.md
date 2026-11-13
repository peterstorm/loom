# Model profiles and calibration

Loom assigns models by Agent role, not by whatever model happens to run the parent session. `engine/src/core/model-profiles.ts` is the executable policy catalog. This document owns three topics: the profile policy, the classes of emission route and how a route qualifies, and calibration.

## Why semantic profiles exist

An Agent needs different concrete settings in each harness:

- Claude Code selects `haiku`, `sonnet`, or `opus`.
- Pi selects an exact provider, model, and thinking level.

A semantic profile binds both targets as one policy value, so orchestration requests "focused review" and no Markdown file has to restate which models are equivalent.

Current profile ids:

- `implementation`
- `architecture-finalize`
- `general-review`
- `focused-review`
- `panel-design`
- `panel-judge`
- `refutation`
- `mechanical`
- `spec-check-review`

Pi runs local models only ([ADR-0023](adr/ADR-0023-pi-runs-local-only-and-releases-per-route.md)): every profile lowers its Pi binding to the one local route, `DESKTOP_VLLM_ROUTE` in the catalog, so profiles differ only in their Claude Code model. Concrete targets are source-controlled in `LLM_PROFILES`. Read the catalog; do not copy a route or a model table into a document.

## Agent policy

The Agent Catalog maps every Agent definition under `agents/` to exactly one profile. Validation proves:

- every source Agent has a policy;
- no policy points at a missing Agent;
- profile ids exist;
- Claude Code frontmatter matches its profile;
- rendered Pi frontmatter contains the exact expected pattern;
- required Skills resolve and are included in generated definitions.

There is no implicit profile fallback. A missing Agent, profile, harness or frontmatter value is a typed failure. The inventory of Agents is [Loom Agents](agents.md).

## Issuance (minting)

Every role is issued under its catalog profile; the parent's model never changes issuance. A request is checked against today's catalog once, where it is minted (`mintAgentRequestAuthority`, the only constructor of a `MintedAgentRequestAuthority`). What that type guarantees is its doc comment in `engine/src/core/orchestration-contract/roster.ts`.

Each issuing seam takes the minted type or mints what it issues itself, so a builder that skipped the catalog check does not compile there:

- a fresh roster slot (`mintAgentRosterSlot`): the standalone reviewer roster and every refutation verifier slot;
- an exact roster (`issueExactRoster`): it takes its slots' identities and mints each slot itself, so no recorded slot and no cast value can reach it, and a slot the catalog will not mint is refused by its slot id with the catalog's reasons;
- a refutation panel (`issueRefutationPanelAuthority`), which issues its roster through `issueExactRoster`;
- the Wave review batch and materialized panel requests;
- refutation verifier slots, minted only when the panel has no record, under the catalog the plan names.

Coverage stops at an aggregate that is persisted as issued and only ever read back:

- the standalone review authority's roster;
- the architecture panel authority, whose requests are minted one at a time by panel materialization;
- a refutation panel read back from its record, and the prepared panel every program consumes.

### Recorded history

A roster re-read from a checkpoint or a registration parses as recorded history. A stored authority may name a retired profile (`qualified-local-review`) or a retired cloud Pi target, and its Pi binding must be one that profile actually issued. A stored binding its profile never issued is refused. A panel already checkpointed or published is resumed and replayed from its recorded requests, so a panel issued before a catalog change is never re-minted and compared with today's catalog.

Only that history is hand-written. A profile's current binding is its catalog lowering, never a second copy: retargeting a profile changes one place and moves the outgoing target to the front of that profile's retired history. A test pins that no history row repeats a target or lists the current one.

Tests that need a run written before a retargeting pass the engine a catalog as it stood then. The engine refuses to build such a catalog from a binding the profile never issued, and what it mints under one is a plain recorded slot, never a minted one, so the minted type's local-only promise holds.

### Pi launcher routing

A machine's `model-routing.json` may explicitly make child Agents inherit a local parent model or use a named exact target. That is launcher policy at the spawn boundary: it cannot reinterpret an issued request's frozen profile or binding. Both Pi launchers, the headless `subagent` transport and the interactive phase transport, apply the same rules and record the same exact provider, model and thinking binding. Before a batch is emitted, every route its children will launch on is probed, and an unreachable route refuses the batch; the operator view is in [Using Loom with Pi](pi-usage.md#a-spawn-batch-is-refused-by-the-route-gate).

## Emission routes and qualification

An emission tool lets a reviewer, judge or refutation verifier return its payload as tool arguments under the frozen schema ([how it works](pi-adapter.md#emission)). The tools are issued only on an explicitly qualified route. The qualified route is module-local policy in `engine/src/core/issued-emission-capability.ts`, and it names the catalog's one local route. Because every profile lowers to that route, a request issued under a Pi parent, for a producer kind and version the frozen registry carries, is emission-enabled. A Claude Code parent, a stored request on a retired route and a launcher-routed different local model are extraction-only, with the reason recorded on the issued capability. Neither a caller nor ambient parent state can choose an enabled route.

Qualification alone enables nothing; it only makes issuance on that route possible. The other conditions (launcher port, child readiness) and their refusals are in [Using Loom with Pi](pi-usage.md#emission-activation-readiness-errors-and-retry-budget).

Route classes (exact vocabulary):

- **Constrained emission** — the route accepts the tool schema and enforces the advertised JSON-schema constraints at sampling time.
- **Unconstrained emission** — the route accepts the exact frozen schema bytes but does not enforce preferred strict sampling; the engine parser stays authoritative. This is the recorded class of the qualified route ([`probes/emission-qualification/`](../probes/emission-qualification/README.md)): all four schemas were accepted at HTTP 200 with the production `strict: "prefer"` registration, and the wire parameters were byte-identical to the frozen bytes, but schema-invalid arguments were demonstrably representable.
- **Extraction-only** — the harness or route cannot support the exact tool schema; no unsupported tool is advertised and no schema is rewritten or provider-specific payload construction introduced.

Qualification is bound to the route identity: provider, served model and frozen schema digest. **Requalification triggers:** a served-model switch, a frozen-schema digest change, or a Pi upgrade that changes tool serialization or strict-sampling behaviour. A test pins the qualified route to the model the retained probe recordings were captured against, so a catalog model switch cannot land without new evidence.

Provider capability flags (strict or constrained sampling, tool-call parser, served model) are the operator's configuration. Loom never treats a capability flag, a provider name or a successful local schema round-trip as live qualification. Missing access blocks the corresponding evidence; it is never a pass.

### Release decision

The local route is released as unconstrained emission with the engine authoritative: the server accepts the frozen schemas but does not enforce them, so the engine validates every payload. The release is the operator's decision (ADR-0023, decision 5), not a measured result. No calibration window completed, and the latency and escaped-defect guardrails are waived and unmeasured, never reported as passed. Runtime behaviour does not depend on the release: a Pi parent's reviewers, judges and refutation verifiers are issued the emission tools either way. Policy, definitions and the window log: [`calibration/grammar-constrained-decoding/`](../calibration/grammar-constrained-decoding/README.md).

## Pi Agent generation

Source Agent definitions use Claude Code frontmatter and package-root tokens. Run:

```bash
bash scripts/sync-pi-agents.sh
```

The script calls the model-profile renderer, which emits exact Pi provider, model and thinking frontmatter, lowers declared tools and package paths, inlines declared Skills, and writes integrity-stamped definitions to:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents
```

At spawn time, Loom freshly renders the active source and byte-compares it with the installed Pi definition. A stale or modified generated definition is rejected.

Run sync after changing:

- an Agent body or frontmatter;
- an Agent's declared Skills;
- the model profile catalog or Agent policy;
- shared path lowering behaviour;
- the package installation root.

Then run `/reload` in Pi.

## Inspecting and validating policy

```bash
bun engine/src/cli.ts helper model-profiles agent --agent comment-analyzer
bun engine/src/cli.ts helper model-profiles validate
```

The first command resolves one Agent. The second checks the full source catalog and definitions. Run the model-profile and Pi resource tests after policy changes. Every engine-issued spawn request carries its profile and both harness bindings ([Request and evidence authority](architecture.md#request-and-evidence-authority)), and the spawn hooks validate the binding again at the harness seam.

## Calibration model

Policy should be informed by review quality, not only model size. Loom includes a deterministic calibration core in `engine/src/core/model-calibration.ts` and a committed corpus at `calibration/corpus.json`.

Each corpus case binds:

- stable case id;
- `vulnerable` or `fixed` state;
- exact Git revision;
- one or more known critical expectations;
- optional aliases and deterministic text match rules;
- source context.

Cases are paired where possible: a vulnerable revision tests recall; a fixed revision tests avoidance of the known stale Finding.

### Scoring semantics

Prediction matching is maximum-cardinality one-to-one. One prediction cannot satisfy two expectations and one expectation cannot consume two predictions.

For vulnerable cases, Loom reports known-critical recall. For fixed cases, it reports avoidance of known Findings. Unmatched predictions on fixed code are **novel/unclassified**, not automatically false positives; the corpus cannot label a claim it does not know.

A run with any `not-executed` case is `incomplete` and cannot be interpreted as a passed calibration.

## Running live Pi calibration

Live execution is opt-in and is not a CI step:

```bash
LOOM_RUN_MODEL_CALIBRATION=1 bun scripts/run-model-calibration.ts \
  --profile focused-review \
  --corpus calibration/corpus.json \
  --output calibration/results/focused-review.json
```

The runner parses the corpus, resolves the profile to its exact Pi target, builds one engine-authored prompt per case, runs Pi in JSON mode against the case's revision, extracts the final assistant JSON array, and records executed and not-executed outcomes. Write result files under `calibration/results/` and commit one only when it is deliberately kept as evidence.

## Changing a profile

A responsible profile change should include:

1. a stated quality/cost/latency hypothesis;
2. calibration evidence on vulnerable and fixed cases;
3. updates to `LLM_PROFILES` or `AGENT_POLICIES`;
4. regenerated Pi Agent definitions;
5. model-profile, Pi resource, and spawn-gate tests;
6. documentation only when semantics—not merely concrete version strings—changed.

Do not weaken a model because one run was lucky, promote one because it emitted more Findings, or call every novel fixed-code prediction a false positive.
