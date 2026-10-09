# Model profiles and calibration

Loom assigns models by Agent role, not by whatever model happens to run the parent session. `engine/src/core/model-profiles.ts` is the executable policy catalog.

## Why semantic profiles exist

An Agent needs different concrete settings in each harness:

- Claude Code selects `haiku`, `sonnet`, or `opus`.
- Pi selects an exact provider, model, and thinking level.

A semantic profile binds both targets as one policy value. This lets orchestration request “focused review” rather than reimplement model equivalence in Markdown.

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

Pi runs local models only: every profile lowers its Pi binding to the one local route (`DESKTOP_VLLM_ROUTE`, `desktop-vllm/glm-5.3-flash-spark-tp2-v14:high`), so profiles differ only in their Claude Code model. The retired profile `qualified-local-review` and the retired cloud Pi targets (`openai-codex`, `github-copilot`) survive only as history: a stored request authority issued under them still parses, against exactly the bindings each profile has issued (`recordedProfileBindings`). Only that history is hand-written: a catalog profile's current binding is its catalog lowering (`currentProfileBindings`), never a second copy, so retargeting a profile changes one place and moves the outgoing target onto the front of the profile's retired history. A stored binding its profile never issued is refused once, against the whole recorded set; at issuance each differing field is named. See [ADR-0023](adr/ADR-0023-pi-runs-local-only-and-releases-per-route.md).

Concrete targets are intentionally source-controlled in `LLM_PROFILES`; consult that catalog rather than copying a table into long-lived docs.

## Agent policy

`AGENT_POLICIES` maps every Loom-owned Agent definition (excluding `agents/README.md`) to exactly one profile. Validation proves:

- every source Agent has a policy;
- no policy points at a missing Agent;
- profile ids exist;
- Claude frontmatter matches its profile;
- rendered Pi frontmatter contains the exact expected pattern;
- required Skills resolve and are included in generated definitions.

There is no implicit profile fallback. Missing Agent, profile, harness, or frontmatter data is a typed failure.

### Pi launcher routing

The catalog defines the requested Pi binding, and every role is issued under its catalog profile; the parent's model never changes issuance. A request is checked against today's catalog once, where it is minted. `mintAgentRequestAuthority` is the catalog's one issuance entry: the issuer passes only the request's identity (run, request, slot, program, role, attempt, Context Packet digest, transcript slot) and the catalog fills the role's profile, that profile's current bindings and the role's required Skill, then runs the strict issue-mode parse (`parseAgentRequestAuthority`). A `MintedAgentRequestAuthority` is narrower than a recorded one — its profile is an `LlmProfileId` and its Pi binding a `LocalPiBinding` — so a retired profile or cloud target cannot be issued even through a cast-free path; only recorded history is as wide as `PiBinding`. Rosters re-read from checkpoints and registrations parse their attempts as recorded history. The seams that issue requests take the minted type — a roster slot is issued with `issueAgentRosterSlot`, a refutation panel with `issueRefutationPanelAuthority` (whose result keeps an `ExactRoster<MintedAgentRosterSlot>`), and the Wave review batch and materialized panel requests carry minted authorities — so a builder that skipped the catalog check does not compile at any of them. Coverage stops where an aggregate is persisted as issued and only ever read back: the standalone review authority's roster (parsed by the same code that re-reads the persisted authority), the architecture panel authority (it has no issuing seam; its requests are minted one at a time by panel materialization), and a refutation panel resumed from its record. The brand is phantom: serialized authorities are unchanged. Refutation verifier requests are minted for `review-verifier-agent` only when the panel has no record; a panel already checkpointed or published is resumed and replayed from its recorded requests (and a slot's attempt 2 carries its recorded attempt 1's profile, binding and Skill), so a panel issued before a catalog change is never re-minted and compared with today's catalog. Each recorded Pi history row is checked when the catalog loads: no row repeats a target or lists its profile's current one. A machine’s Pi launcher routing policy may explicitly choose local-parent inheritance or a named exact target for child Agents, but cannot reinterpret an issued request's frozen profile or binding. Both Pi launchers—the normal headless subagent transport and the Interactive Phase Transport—apply parent-model, workload, profile, and Agent specificity and record the same exact provider/model/thinking binding. The Pi spawn guard proves the generated definition, user-global Agent scope, and request authority while allowing the launcher’s explicit routing decision to determine the effective model.

### Emission routes and qualification

The frozen emission tools are issued only on an explicitly qualified route. The engine freezes the qualified route as module-local policy data (`QUALIFIED_EMISSION_ROUTE` in `engine/src/core/issued-emission-capability.ts`, naming the catalog's single route owner `DESKTOP_VLLM_ROUTE`): provider `desktop-vllm`, served model `glm-5.3-flash-spark-tp2-v14`. Since every catalog profile lowers to that route, a request issued under a Pi parent, for a producer kind/version the frozen registry carries, is emission-enabled; a Claude Code parent, a stored request on a retired route, or a launcher-routed different local model is extraction-only, with the reason recorded on the issued capability. Neither callers nor ambient parent state can choose an enabled route. Once a request is issued emission-enabled, a launcher or child that cannot honor it is refused before any model request, never silently degraded to an ordinary child (see [Pi usage](pi-usage.md#emission-activation-readiness-errors-and-retry-budget)).

Activation is conjunctive and each condition is checked in its own layer: the issued request must name a producer kind the Agent Catalog authorizes for that Agent, its Pi binding must be the exact qualified route, the installed launcher must expose the `loom:subagent-launch:v2` port, and the child must pass its readiness barrier. Qualification alone enables nothing — it only makes issuance on that route possible.

### Route reachability (fail closed)

Before a Pi parent's facade CLI emits a spawn batch, each distinct route the batch's children will launch on must answer `GET {baseUrl}/models`, where `baseUrl` comes from Pi's `models.json` in the active agent directory. The launch route is the generated agent render's binding: the Agent's catalog binding after the `model-routing.json` rules for the observed parent (`resolveAgentLaunchBinding` in `engine/src/core/model-routing.ts`, the one rule the renderer, `render-pi` and the gate share). A refused connection, timeout, error status or a listing without the model refuses the spawn with the route, URL and reason; a provider without an endpoint is `unconfigured` — typically a routing rule naming a provider `models.json` does not declare — and the refusal says to declare its `baseUrl` or route the child elsewhere. There is no fallback route. Nothing is published to the session, so `helper orchestration resume` re-emits the same batch once the route answers.

An authentication refusal (HTTP 401/403), or a 2xx whose body is not a model list, counts as reachable but leaves the served model unverified: Loom reads only `baseUrl` and never resolves or sends credentials; Pi authenticates the inference itself. By default the batch is admitted and each such route is reported on stderr as one JSON line, `{"event":"loom-route-unverified","route":…,"url":…,"cause":"auth-refused"|"unreadable-listing","status":…}`. Setting `LOOM_ROUTE_GATE=strict` refuses such a route instead; any other value of the variable, a request authority that does not parse, or a malformed `model-routing.json` or `models.json` refuses the batch (ADR-0023, amended).

A stored request recorded on a retired cloud route (a `RetiredPiTarget`) is refused as **retired**, without a probe: the run was issued before ADR-0023 moved Pi to the local route, no route change can make its recorded binding runnable, and `resume` re-emits the same refusal. Start a fresh run.

### Release decision (AD-11, per route)

The local route is qualified *unconstrained emission*: vLLM accepts the frozen schemas but does not enforce them, so the engine validates every payload. Under the `per-route-engine-authoritative` release policy (preregistration `gcd-ad11-pilot-2`), a cell on that route is released as *unconstrained emission, engine-authoritative* once its calibration window is complete and the latency (AS-015) and escaped-defect (AS-016) guardrails pass; AS-004 does not apply. See `calibration/grammar-constrained-decoding/README.md`.

Route classes (exact vocabulary):

- **Constrained emission** — the route accepts the tool schema and enforces the advertised JSON-schema constraints at sampling time.
- **Unconstrained emission** — the route accepts the exact frozen schema bytes but does not enforce preferred strict sampling; the engine parser stays authoritative. This is the recorded class of the currently qualified route (`probes/emission-qualification/`, consolidated in `.claude/specs/2026-09-16-grammar-constrained-decoding/feasibility.md` §2): all four schemas were accepted at HTTP 200 with the production `strict: "prefer"` registration, and the wire parameters were byte-identical to the frozen bytes, but schema-invalid arguments were demonstrably representable.
- **Extraction-only** — the harness or route cannot support the exact tool schema; no unsupported tool is advertised and no schema is rewritten or provider-specific payload construction introduced.

Qualification is bound to the route identity — provider, served model, and frozen schema digest. **Requalification triggers:** a served-model switch, a frozen-schema digest change, or a pi upgrade that changes tool serialization or resolver strict-sampling behavior.

Operator configuration: provider capability flags (strict/constrained sampling, tool-call parser, served model) remain **user-side configuration**. Loom's contribution to that configuration is documentation only — it ships the frozen schemas as its own contract but never configures a provider or rewrites a schema for one, and it never treats a capability flag, a provider name, or a successful local schema round-trip as live qualification. Missing access blocks the corresponding evidence; it is never a pass.

Two budget/observability facts matter for calibration: emission and extraction rejection share one existing request-slot attempt budget (a semantic rejection at attempt 1 may advance to one fresh attempt-2 spawn; attempt-2 failure is terminal; there is no same-spawn correction protocol), and pi's own in-child validation-retry loop (~2 extra model requests on refused tool arguments) sits outside that accounting and must be counted in the emission arm's latency budget. Raw tool-argument bytes are not exposed at the harness seam, so duplicate-key behavior is never reported as measured.

## Engine-issued requests

Registered programs place model policy inside `AgentRequestAuthority` before publication. Each spawn request includes:

- semantic profile id;
- exact Pi and Claude bindings;
- Agent role;
- required Skill;
- Context Packet digest;
- fixed output slot.

This removes repeated parent-side model lookups from Wave Gate and standalone review execution. Spawn hooks still validate the binding at the harness seam.

## Pi Agent generation

Source Agent definitions use Loom/Claude-oriented frontmatter and package-root tokens. Run:

```bash
bash scripts/sync-pi-agents.sh
```

The script calls the model-profile renderer, lowers package paths, inlines declared Skills, and writes integrity-stamped definitions to:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents
```

At spawn time, Loom freshly renders the active source and byte-compares it with the installed Pi definition. A stale or modified generated definition is rejected.

Run sync after changing:

- an Agent body or frontmatter;
- an Agent’s declared Skills;
- the model profile catalog or Agent policy;
- shared path lowering behavior;
- the package installation root.

Then run `/reload` in Pi.

## Inspecting and validating policy

```bash
bun engine/src/cli.ts helper model-profiles agent --agent comment-analyzer
bun engine/src/cli.ts helper model-profiles validate
```

The first command resolves one Agent. The second checks the full source catalog and definitions. Run the model-profile and Pi resource tests after policy changes.

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

Live execution is deliberately opt-in and is not a normal CI step:

```bash
LOOM_RUN_MODEL_CALIBRATION=1 bun scripts/run-model-calibration.ts \
  --profile focused-review \
  --corpus calibration/corpus.json \
  --output calibration/results/focused-review.json
```

The runner:

1. parses the corpus;
2. resolves the selected semantic profile;
3. lowers it to the exact Pi target;
4. builds one engine-authored prompt per case;
5. invokes Pi in JSON mode against the case revision/context;
6. extracts the final assistant JSON array;
7. records executed and not-executed outcomes.

Generated result files belong under `calibration/results/` and are ignored by Git unless intentionally promoted as evidence elsewhere.

## Changing a profile

A responsible profile change should include:

1. a stated quality/cost/latency hypothesis;
2. calibration evidence on vulnerable and fixed cases;
3. updates to `LLM_PROFILES` or `AGENT_POLICIES`;
4. regenerated Pi Agent definitions;
5. model-profile, Pi resource, and spawn-gate tests;
6. documentation only when semantics—not merely concrete version strings—changed.

Do not weaken a model because one run was lucky, promote one because it emitted more Findings, or call every novel fixed-code prediction a false positive.
