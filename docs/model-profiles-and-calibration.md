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

The catalog defines the requested Pi binding. A machine’s Pi launcher routing policy may explicitly choose local-parent inheritance or a named exact target for child Agents. Loom does not infer that choice inside the pure catalog. Both Pi launchers—the normal headless subagent transport and the Interactive Phase Transport—apply parent-model, workload, profile, and Agent specificity and record the same exact provider/model/thinking binding. The Pi spawn guard proves the generated definition, user-global Agent scope, and request authority while allowing the launcher’s explicit routing decision to determine the effective model.

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
