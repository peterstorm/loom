# PR #167 docs remediation — 2026-11-15

- **Branch:** `review/post-merge-167-170`, based on `main` at `ce407816`.
- **Why:** PR #167 (merge `87fd11bc`) was reviewed code-only by `run.pr167-src-review-20261113` and `run.pr167-tests-review-20261113`; its 155 added or modified markdown files were left unreviewed. This change reviews them and applies the accepted findings.
- **Reviewed scope:** the 156 markdown files PR #167 added or modified (one more than the earlier count; the list was re-derived from the merge), split into 12 `comments`-kind runs by read budget (`run.pm167-docs01-review-20261115` … `docs12`).
- **Not reviewed:** the 256 files PR #167 deleted: 233 are archived plans, and the doc references the rest left behind are checked mechanically by the `no-dangling-doc-reference` lint rule (PR #173). They were excluded, not covered.
- **Runs root:** `.claude/reviews/review-and-fix-runs/`

## Superseded run

`run.pm167-docs02-review-20261115` became terminal-blocked: its comment-analyzer's final admitted attempt left the last page of `docs/verification.md` (bytes 72000–73713) unread. The same scope was re-run as `run.pm167-docs02b-review-20261115` (3/3 reviewers captured), and docs02 was abandoned with `--superseded-by run.pm167-docs02b-review-20261115`.

## Critical findings

None. Every run reports 0 surviving and 0 refuted criticals (engine inspection), so no Refutation Panel ran and no Declared Repair Group exists. Defect-family accounting: `not-required`. `run.pm167-docs06-review-20261115` reported no findings at all.

## Advisory dispositions (DECLARED)

55 advisories: 53 accepted, 2 deferred, 0 dismissed. Each run's decisions are published as its policy run, named below with the disposition digest.

### docs01 — `run.pm167-docs01-review-20261115` → `run.pm167-docs01-policy-20261115` (`834af119…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `docs/reference/helpers.md:6` | accepted | helpers.md Shared behaviour bullet now names mutation-check as the one helper that writes a runtime record. |
| comment-analyzer-1 | `docs/reference/helpers.md:7` | accepted | Same defect as code-reviewer-1; one fix covers both. |
| comment-analyzer-2 | `docs/operations.md:281` | accepted | The 'migration' canary is wave-gate-start's own full-tier lint (runFullTierWaveLint); the sentence now says lint runs at gate start and again as the suite check. |
| comment-analyzer-3 | `docs/operations.md:54` | accepted | Rewritten: status reports project-verification coverage from the moment the TaskGraph is populated. |

### docs02b — `run.pm167-docs02b-review-20261115` → `run.pm167-docs02b-policy-20261115` (`b5358dfa…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `skills/security-expert/references/xss-prevention.md:34` | accepted | xss-prevention.md now says escape < as \u003c. |
| comment-analyzer-1 | `skills/security-expert/references/xss-prevention.md:34` | accepted | Same defect as code-reviewer-1; one fix covers both. |
| comment-analyzer-2 | `docs/verification.md:19` | accepted | The example's testFileSuffixes now lists the four engine defaults (DEFAULT_TEST_FILE_SUFFIXES), matching 'explicit values for the settings it leaves out'. |
| comment-analyzer-3 | `CONTEXT.md` | accepted | CONTEXT.md regains an Architecture section: Functional Core, Imperative Shell, Shell Orchestrator, Port, Bounded Context, Ubiquitous Language, Aggregate, Value Object, Either, Domain Event, plus their relationships. Tier and LLM Profile already live in owner-verification and harness context files. |
| architecture-tech-lead-1 | `CONTEXT.md` | accepted | Same gap as comment-analyzer-3; one fix covers both. |
| architecture-tech-lead-2 | `docs/verification.md:1` | deferred | Splitting verification.md into per-context pages moves anchors that docs, commands, skills and the no-dangling-doc-reference baseline all reference; a structural doc move for its own change, not a correctness fix. |

### docs03 — `run.pm167-docs03-review-20261115` → `run.pm167-docs03-policy-20261115` (`8200409c…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| comment-analyzer-1 | `docs/architecture.md:366` | accepted | All 28 links in the repo labelled 'operations' that target another document are relabelled after their target (verification, standalone review, development, recovery). |
| comment-analyzer-2 | `references/adr-template.md:8` | accepted | adr-template.md Status norm allows the vocabulary's multi-word status and stated relations; 'Changing a decision' adds the relation to the old Status and forbids rewriting the decision, not Status upkeep. |

### docs04 — `run.pm167-docs04-review-20261115` → `run.pm167-docs04-policy-20261115` (`8256d6e1…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `calibration/grammar-constrained-decoding/WINDOWS.md:29` | accepted | WINDOWS.md 'the operator release, above' now links README.md's Release decision section. |
| code-reviewer-2 | `calibration/grammar-constrained-decoding/WINDOWS.md:23` | accepted | WINDOWS.md 'pilot-window.ts, below' now points at README.md's Route fail-fast step under Operator activation / reload steps. |
| comment-analyzer-1 | `calibration/grammar-constrained-decoding/WINDOWS.md:23` | accepted | Same defect as code-reviewer-2; one fix covers both. |
| comment-analyzer-2 | `calibration/grammar-constrained-decoding/WINDOWS.md:29` | accepted | Same defect as code-reviewer-1; one fix covers both. |
| comment-analyzer-3 | `docs/workflows.md:243` | accepted | workflows.md now says the thresholds select architecture for any other aspect, matching commands/review-pr.md. |

### docs05 — `run.pm167-docs05-review-20261115` → `run.pm167-docs05-policy-20261115` (`2365e592…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `docs/loom-prompt-decomposition.md:26` | accepted | loom-prompt-decomposition.md names the two architecture.md sections that hold the hook table and the State File. |
| comment-analyzer-1 | `docs/loom-prompt-decomposition.md` | accepted | Same defect as code-reviewer-1; one fix covers both. |
| architecture-tech-lead-1 | `docs/standalone-review.md:341` | deferred | Splitting standalone-review.md into reviewer protocol, plan-design review and remediation documents is a structural doc move across many inbound anchors; separate change. |

### docs07 — `run.pm167-docs07-review-20261115` → `run.pm167-docs07-policy-20261115` (`dcfa88de…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `rules/architecture.md` | accepted | rules/architecture.md names java-patterns.md and typescript-patterns.md as holding the charging-a-card example, and Rust's 'Module Layout' beside 'Package Structure'. |
| code-reviewer-2 | `README.md` | accepted | README.md links relabelled after their targets (part of the repo-wide 'operations' label sweep). |
| comment-analyzer-1 | `docs/executable-models-enforcement.md` | accepted | executable-models-enforcement.md links the Acceptance Stop Check section of verification.md. |
| comment-analyzer-2 | `docs/executable-models-enforcement.md` | accepted | 'G5b' replaced by what it names: owner obligations (ADR-0032) and owner verification's mutation runs (ADR-0036). |
| comment-analyzer-3 | `README.md:126` | accepted | README.md and skills/review-and-fix/SKILL.md labels relabelled in the same sweep. |
| comment-analyzer-4 | `rules/java-patterns.md` | accepted | java-patterns.md Either list drops fold from the samples and says a controller folds the result. |
| comment-analyzer-5 | `docs/executable-models-enforcement.md` | accepted | The second-copy lens section now states both roster triggers: an owned family (ADR-0047) and a contract types file (ADR-0069). |
| architecture-tech-lead-1 | `rules/java-patterns.md:262` | accepted | Reconcile shares Charge's call only because the sample PSP deduplicates the key; the arm now says so, and the Idempotency bullet already says a non-deduplicating PSP queries first. The Reconcile comment is widened to 'pending' in the Java, TypeScript and security samples. |

### docs08 — `run.pm167-docs08-review-20261115` → `run.pm167-docs08-policy-20261115` (`b4d3120c…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| comment-analyzer-1 | `docs/pi-adapter.md:256` | accepted | pi-adapter.md closing link relabelled Development. |
| comment-analyzer-2 | `docs/roadmap.md:43` | accepted | roadmap.md Shipped-table labels relabelled after their targets. |
| comment-analyzer-3 | `docs/development.md:80` | accepted | development.md lists lint-rules/ among the governed roots, matching GOVERNED_ROOTS. |
| comment-analyzer-4 | `skills/nextjs-frontend-design/references/nextjs-patterns.md:215` | accepted | Verified against nextjs.org error.js docs (updated 2026-10-15): error is unknown; unstable_retry added in v16.2.0, retry stable in v16.3.0. nextjs-patterns.md is right; nextjs-testing.md's sample now takes error: unknown and retry, shows its own copy and asserts the thrown message is not rendered. |
| architecture-tech-lead-1 | `skills/ts-test-engineer/references/nextjs-testing.md:198` | accepted | Same conflict as comment-analyzer-4, fixed in nextjs-testing.md. |

### docs09 — `run.pm167-docs09-review-20261115` → `run.pm167-docs09-policy-20261115` (`427a79d0…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `docs/adr/README.md:79` | accepted | ADR-0062's Status applies ADR-0042 and ADR-0043 and amends nothing; its relation cell is now '—'. |
| code-reviewer-2 | `docs/adr/README.md:46` | accepted | ADR-0029 row now reads 'amends ADR-0004, ADR-0005'. |
| comment-analyzer-1 | `commands/wave-gate.md:163` | accepted | wave-gate.md and review-pr.md labels relabelled in the repo-wide sweep. |
| comment-analyzer-2 | `docs/adr/README.md:14` | accepted | The column definition now includes the 'amended by' relations a Status states; a sweep of every Status section also added the missing 'amended by' rows for ADR-0034, ADR-0035 (ADR-0063) and ADR-0042 (ADR-0053). |
| comment-analyzer-3 | `rules/rust-patterns.md:30` | accepted | rust-patterns.md comment scoped to 'outside this module' with the reason. |
| architecture-tech-lead-1 | `commands/wave-gate.md:157` | accepted | Same defect as comment-analyzer-1; one fix covers both. |

### docs10 — `run.pm167-docs10-review-20261115` → `run.pm167-docs10-policy-20261115` (`6cf453c3…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| comment-analyzer-1 | `commands/specify.md:22` | accepted | specify.md's /loom list now includes Package resources, which defines {LOOM_DIR}. |
| comment-analyzer-2 | `agents/security-hunter-agent.md:19` | accepted | security-hunter-agent.md: the brief, this file and the lens files its Lenses section names are what the hunter needs. |
| architecture-tech-lead-1 | `commands/specify.md:17` | accepted | Same defect as comment-analyzer-1; one fix covers both. |
| architecture-tech-lead-2 | `skills/lint-project/references/typescript.md:120` | accepted | lint-project typescript.md regains a Function Length section (engine default 50, test suffixes excluded), symmetric with java.md. |
| architecture-tech-lead-3 | `commands/spec-check.md:67` | accepted | The Decided-by bullet no longer restates the settled-row rule; it points at the one rule below. Step 4's emission table and the Constraints list do not restate it. |

### docs11 — `run.pm167-docs11-review-20261115` → `run.pm167-docs11-policy-20261115` (`58e1239a…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `skills/security-expert/references/command-injection.md:100` | accepted | SafeCommand polls while the process runs and kills it once the output file passes MAX_OUTPUT_BYTES; the remaining slack (one poll interval) and the exact-bound alternative are stated. |
| comment-analyzer-1 | `.claude/plans/2026-11-13-pr-remediation.md:61` | accepted | The two superseded statements in the 2026-11-13 plan now say so and link the Follow-up section. |
| comment-analyzer-2 | `skills/ts-test-engineer/references/vitest-patterns.md:14` | accepted | vitest-patterns.md comment says jsdom applies to every file and how a pure test opts out. |
| comment-analyzer-3 | `skills/security-expert/references/path-traversal.md` | accepted | downloadRejectsTraversal is parameterized over plain, percent-encoded and double-encoded traversal sent as a raw query string, so the HTTP layer decodes them. |

### docs12 — `run.pm167-docs12-review-20261115` → `run.pm167-docs12-policy-20261115` (`d76972c3…`)

| Finding | Where | Decision | Reason |
|---|---|---|---|
| code-reviewer-1 | `skills/security-expert/references/idempotency.md:73` | accepted | idempotency.md Act step: Reconcile shares Charge's call only for a provider that deduplicates; otherwise it asks the provider first (requirement 6). |
| comment-analyzer-1 | `docs/adr/ADR-0070-the-plan-design-review-gates-decompose.md:58` | accepted | ADR-0070 sentence reworded: the files were frozen and not edited, and have since been removed. The path stays unformatted: the #173 resolver (no-dangling-doc-reference) refuses a backticked path that no longer exists. |
| comment-analyzer-2 | `commands/templates/phase-arch-design.md:21` | accepted | phase-arch-design.md: write only the candidate path; the harness grant over .claude/specs/ is named as wider than the task. |
| comment-analyzer-3 | `skills/security-expert/references/idempotency.md:62` | accepted | Reconcile comment widened to 'pending: an earlier run stopped, or one is still running' (also in the Java and TypeScript rules). |
| architecture-tech-lead-1 | `docs/adr/ADR-0010-standalone-finding-lineage.md:5` | accepted | PR #51 merged 2026-09-16 00:08 +0200 (3fb60e1a); ADR-0010 Status and its index row now say 2026-09-16. |
| architecture-tech-lead-2 | `agents/adr-writer-agent.md:27` | accepted | adr-writer-agent.md and adr-template.md forbid rewriting a decision in place, not Status relations, moved links or corrected facts. |
| architecture-tech-lead-3 | `commands/templates/phase-arch-finalize.md:65` | accepted | panel-templates.test.ts now checks every numbered step phase-arch-finalize.md names against phase-architecture.md's '### N. Title' headings; renaming step 7 fails it (verified). Pinned in loom-prompt-decomposition.md's test table. |

## Accepted fixes beyond the named lines

- **Link labels.** The 28 links in the repository labelled `operations` that open another document were relabelled after their target (`verification`, `standalone review`, `development`, `recovery`), not only the ones the reviewers named. None remains.
- **ADR index relations.** A sweep of every ADR's Status section against the index found three more rows missing the "amended by" relation their Status states: ADR-0034 and ADR-0035 (ADR-0063), ADR-0042 (ADR-0053).
- **Reconcile wording.** The same too-narrow comment ("an earlier run stopped mid-flight") was widened in `rules/java-patterns.md`, `rules/typescript-patterns.md` and `skills/security-expert/references/idempotency.md`.

## Not accepted as raised

- docs12 comment-analyzer-1 asked for the ADR-0070 path to keep its code formatting. The path no longer exists, and the `no-dangling-doc-reference` rule refuses a backticked reference to a removed path, so it stays prose.

## Validation (my runs, not remediation evidence)

Run from `engine/` after `bun install --frozen-lockfile` at the repository root and in `engine/`:

- `npm run typecheck`: pass
- `npm run lint` (whole project, full tier, includes `no-dangling-doc-reference`): no violations
- `bun ../scripts/stamp-wire-contract.ts --check`: pass
- `vitest run`: 19269 passed, 4 failed, 2 skipped. The 4 failures (`tests/handlers/helpers/orchestration.test.ts`, `tests/pi-extension-review-events.test.ts` ×2, `tests/pi/interactive-subagent.test.ts`) read the machine's `~/.pi/agent/model-routing.json`, whose `served` target holds no exact model ref. They fail identically on untouched `main` (`ce407816`) and are unrelated to this change.
- `tests/panel-templates.test.ts`: the new finalize-step check passes, and fails when `phase-architecture.md`'s "### 7. Write the plan" is renamed.

## Remediation

One registered remediation per source run with findings (11 runs), each with `defectFamily: not-required`; every changed path outside that run's frozen scope, this plan included, is a support path.
