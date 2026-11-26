# Loom Feature & Guard Map

A comprehensive, mechanism-level map of Loom: every feature, every guardrail, every
determinism device — why it exists, why it works, and where it honestly does not.

Written from a full source scan of revision **a28b6d6a** (main, 2026-11-15), updated through
**deb8c369** (2026-11-18): the #201–#223 wave (engine-run test evidence, the loom#198/#199
Cause campaign, the #213 reviewer-protocol fixes) was read from its diffs and is folded in —
mechanisms, catalog rows, residuals and appendices. Updated again through **98a9852c**
(2026-11-18): the #224/#225 advisory-disposition and succession-carry changes (ADR-0090,
ADR-0089 as amended by ADR-0091) folded in from their diffs and ADRs. Updated again through
**a585eb27** (2026-11-18): #233/#234 — the reopen scope (ADR-0093) and the narrowed
re-review roster (ADR-0094) — folded in from their diffs and ADRs, with a fresh full-suite
verdict in §10. Every claim was checked
against the code at its revision; claims resting on documentation rather than code are marked
*(docs)*. Vocabulary follows [CONTEXT.md](../CONTEXT.md).

---

## 1. What Loom is, in one page

Loom is a **dual-harness orchestration engine**: a Claude Code plugin and a native Pi
package that deliver complex software through explicit requirements, parallel
implementation Waves, and evidence-backed quality gates.

Its central design rule (docs/architecture.md, and enforced structurally):

> **Language models perform semantic work and users make genuine policy decisions.
> Loom code owns deterministic routing, identity, validation, persistence, retries,
> aggregation, and state transitions.**

Everything in this document is an instance of that rule or of its failure-handling
twin: **fail closed when authority is incomplete or ambiguous.**

The pipeline: `brainstorm → specify → clarify → architecture → plan alignment → plan
design review → decompose → execute (Waves) → Wave Gates → orchestration completion`,
plus standalone programs (`/review-pr`, `/review-and-fix`, `/security-audit`,
`/spec-check`, `/lint-project`) that reuse the same review and panel machinery without
a feature TaskGraph.

Two persistence domains carry all authority:

- the **State File** (`active_task_graph.json`) — the protected TaskGraph, mode 0444,
  written only by the `StateManager` under lock;
- **Run Directories** (`run.<id>/`) — immutable, no-follow-anchored evidence folders for
  every registered program (panels, Wave Gates, reviews, remediation, audits).

---

## 2. Repository map

| Directory | Contents | Size |
|---|---|---|
| `agents/` | 31 Agent definitions (persona + model profile + preloaded Skill) | 31 files |
| `skills/` | 14 Skills (architecture-tech-lead, code-implementer, deepen, distill, grill, java/ts-test-engineer, lint-project, nextjs-frontend-design, review-and-fix, retro, security-audit, security-expert, ts-test-engineer, vercel-react-best-practices) | 104 files |
| `commands/` | 10 slash-command runbooks + 11 phase prompt templates | 21 files |
| `rules/` | architecture.md (language-neutral) + java/rust/typescript-patterns.md + property-testing.md | 947 lines |
| `references/` | spec/plan/ADR templates, design-lens & refutation-lens catalogs, reviewer-wire docs, 13 vendored security lenses, per-command runbooks | 39 files |
| `lint-rules/` | 13 shipped regex rules + schema README | 14 files |
| `machines/` | 3 Guarded Skill Machines (code-implementer, distill, security-hunter) + ledger description | 4 files |
| `hooks/` | hooks.json (Claude Code bindings) + 20 shell shims | 22 files |
| `engine/` | The engine: 621 src files / ~170.8k lines TS; `engine/tests/` holds 962 TS files / ~265.4k lines (fixtures and helpers included), of which 841 test files are executed (817 under `engine/tests/`, 24 under `calibration/` and `probes/`) | — |
| `pi/` | Pi adapter: 40 modules / 13.4k lines | — |
| `probes/` | Frozen feasibility evidence (emission readiness barrier, emission qualification) | 54 files |
| `scripts/` | sync-pi-agents, stamp-wire-contract, smoke suites, security sandbox, calibration runner | 12 files |
| `calibration/` | Model-calibration corpus + grammar-constrained-decoding pilot (preregistrations, windows, blinded assessments) | 85 files |
| `artifacts/tests/` | Shell-level integration suites (hook gaps, task-graph validation, smoke-deterministic-core) | 8 scripts |
| `docs/` | 131 docs incl. **102 ADRs** (index test-enforced) | — |

---

## 3. Product surface

### 3.1 Commands

| Command | What it does | Protected TaskGraph | Run Directory |
|---|---|---:|---:|
| `/loom [desc] [--skip-*] [--panel[=N]] [--status]` | Full feature lifecycle | Yes | panels + wave gates |
| `/wave-gate` | Quality checkpoint between Waves | Yes | Yes |
| `/review-pr [aspect]` | Standalone frozen-scope review over one of the aspects code, errors, tests, types, comments, architecture, simplify, all | No | Yes |
| `/review-and-fix [--no-push]` | Review + adjudicate + remediate + install exact verified index | No | review + remediation |
| `/security-audit` | Coverage-accounted audit with sandboxed verification | No | Yes |
| `/spec-check` | Read-only implementation-vs-requirements audit | reads | No |
| `/brainstorming`, `/specify`, `/clarify` | Requirements-only phases | only under `/loom` | No |
| `/lint-project` | Set up + run the two-tier linter | No | No |

Skip flags are explicit lifecycle bypasses recorded in the State File at `init-state`
(`--skip-specify` implies brainstorm+specify+clarify). `--complete`/`--abort` are
deliberately **not** implemented flags: completion goes through `helper orchestration
complete-orchestration` after the final Wave Gate; abandonment through the guarded
cleanup helper. *(docs — verified against phase-init and the operations doc.)*

### 3.2 Agents

31 definitions. Each carries an explicit model profile (`model-profile:` + pinned
`model:`) — a spawn whose model does not match the profile is refused by
`validate-agent-model`. Where a Skill is required, `validate-agent-skill` refuses a
spawn prompt that does not name it. The Wave review roster is **derived, never
configured**: `waveTaskReviewRoster` answers the base five (`code-reviewer`,
`silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`,
`comment-analyzer`), plus `architecture-tech-lead` sixth when the Task's packets carry
the owner map or the contract surface — each reason also rendered as a digest-bound
packet section, so roster and packet cannot disagree.

### 3.3 Rules & the rules gate

`rules/architecture.md` (functional core/imperative shell, parse-don't-validate, DDD,
idempotency, ports) plus per-language pattern files. The **rules gate**
(`rules-gate.sh` / `pi/rules-gate.ts`, one shared core decision) blocks every code
edit until the rules and applicable skills are provably in the model's context (read
coverage over the rule files) and adherence is stated in the message making the edit.
Fail-closed on crash.

---

## 4. Engine deep map

### 4.1 Entry, routing, and failure polarity

**`engine/src/cli.ts`** — single entry point. Every hook shim delegates to
`bun engine/src/cli.ts <hook-type> <handler>`. Facts:

- **Failure polarity is derived from argv before anything can throw**
  (`failureExitCode(process.argv[2], process.argv[3])`). Routes in
  `FAIL_CLOSED_ROUTES` exit 2 (blocking) on any top-level crash — dynamic-import
  failure, stdin error — because exit 1 is *non-blocking* for PreToolUse hooks and
  would silently fail the gate open. This one decision is why "fail-closed" is real
  rather than aspirational: a crashing guard blocks.
- **Stdin is bounded**: 4 MiB per hook route, 16 MiB for orchestration
  submit/standalone captures, buffered eagerly before async work — an oversized or
  hostile payload fails fast instead of accumulating toward OOM.
- **`handler-routes.ts`** is the closed routing table (`KNOWN_HANDLERS`); a route the
  table does not name is refused. Tests pin that the hooks-sync shims invoke only
  routes the table contains.
- **`runtime-compatibility.ts`** — Pi Runtime Revision: the extension hashes
  `engine/src/`, `pi/`, and package metadata when it loads. Mutating CLI routes
  re-hash the checkout before dynamic import; `StateManager` re-checks immediately
  before any chmod/lock/write. Skew refuses with a `/reload` diagnostic (status stays
  available). *Why:* prevents a fresh CLI writer from emitting state a stale
  in-memory extension cannot parse.
- **TaskGraph engine-revision pin (#205)** — the failure the Runtime Revision could not
  catch: the plugin path points at a checkout, and another session switching that checkout
  mid-orchestration made hooks run older engine code than the CLI, judging one TaskGraph by
  two sets of rules. Population now pins the graph to the running engine's content-addressed
  revision (`engine/src/core/engine-revision-pin.ts`; a project hosting the engine itself is
  recorded self-hosted, since every Wave changes its engine). The StateManager write boundary refuses to persist
  a graph pinned to any other revision, naming both. `helper orchestration
  adopt-engine-revision --reason` is the audited, quiescent, idempotent move that gives a
  pre-pin graph its first pin (append-only adoption chain, parser-checked); re-population
  keeps an existing pin — only adoption moves a graph between engines.

### 4.2 The spawn gates (PreToolUse on `Task|Agent|subagent`)

All five are fail-closed. Active only while a State File exists.

| Gate | Mechanism | Why it exists |
|---|---|---|
| `validate-phase-order` | Phase sequencing: refuses a phase agent whose prerequisite phase is incomplete; refuses decompose until the plan design review is accepted for the **plan's current bytes** (digest via the `ArtifactProbe.sha256` port) or skipped | Order is authority: a phase completed out of order forges every later artifact's premise |
| `validate-task-execution` | Expands the implementation brief marker, checks Wave order + dependency order + path ownership, reclaims only policy-eligible reservations, writes skeletons, captures byte baselines, registers attempt + retry authority **atomically** | One hook owns the entire "may this Task spawn, and what exactly is it" decision |
| `validate-template-substitution` | Refuses a prompt still holding an unsubstituted `{variable}` (underscore-grammar identifiers; a small `FALSE_POSITIVES` set: `{type} {id} {name} {system} {revision} {builtAt} {hot}` + the acceptance files placeholder — owned by the exported `FALSE_POSITIVES` constant in `engine/src/core/validate-template-substitution.ts`) | An unsubstituted variable means the parent skipped protocol assembly — the child would act on a half-specified prompt |
| `validate-agent-model` | Model must match the Agent's LLM Profile | Model choice is policy, not improvisation; also blocks silently inheriting the (expensive) orchestrator model |
| `validate-agent-skill` | Prompt must name the agent's required Skill | Skill preload is part of the agent's contract |

**The implementation brief marker.** The parent sends only
`LOOM_IMPLEMENTATION_BRIEF: T5` (+ optional `LOOM_OPERATOR_NOTE:` lines). The gate
renders the full brief from protected state, runs every veto and the reservation on
it, and returns it as the call's `updatedInput`. Sibling gates expand the marker
themselves, because hooks on one matcher see only the original input. *Why:* the
parent model never authors the Task's prompt — the engine does, from protected state,
so scope and duties cannot drift between what was authorized and what the child reads.

**Phase placement by identity (#223).** The phase gate's `detectPhase` used to fall back
to regexes over the spawn prompt for any agent type it did not know — a general-purpose
agent whose brief happened to say "read rules/architecture.md" was refused mid-execute as
an "invalid phase transition", and the only workaround was rewording the brief to dodge
the gate. The gate now classifies the spawn's **identity** first (`classifyAgent`):
- `loom:<known>` — placed by its catalog phase, then judged by phase order;
- `foreign` (another plugin's namespace, or a bare name outside the catalog) — the phase
  order is not its business: allowed here, bounded by the direct-edit guard;
- `missing` (no agent type at all) — **blocked**;
- `unknown-loom` (a `loom:` name the catalog does not know) — **blocked** with the
  recognized-agent list.
On a bare-name harness (Pi) an unknown name cannot be told from a foreign agent, so a
misspelled Loom agent passes this gate and is still held by the direct-edit guard.

### 4.3 The edit gates (PreToolUse on `Edit|Write|MultiEdit`)

- **`block-direct-edits`** — during a run the orchestrating session cannot edit files
  directly: phase agents write only under their artifact roots; an implementation
  agent writes only once its exact Implementation Attempt is bound (pending ⇒
  retriable block, refused ⇒ hard block). Scoped to the Orchestrated Repository
  (ADR-0046): writes entirely outside the root owning the live graph pass. *Why:*
  unattributed parent edits would make the evidence ledger's attribution — and hence
  every proof — meaningless. Since #218 (ADR-0085, "attestation is enforced, not
  instructed"), the same gate also refuses the Edit/Write of a Task **armed for
  attestation** (`core/attestation-writes.ts`): once a write is admitted, the gate asks
  the calling implementation Agent's Task write mode and blocks the armed Task's edit,
  naming the Task and telling the Agent to report instead of edit; a Task whose mode
  cannot be observed fails closed (Claude Code reads the Task from the caller's bound
  attempt and the session's TaskGraph; Pi uses what the child's write grant was bound
  to). Drift detection remains the backstop. *Why:* an attesting Task's next attempt
  verifies and changes nothing — that used to be a brief instruction, agents edited
  anyway, and each edit surfaced afterwards as terminal drift; now the guard refuses it
  up front.
- **`enforce-phase-tools`** — the Guarded Skill Machine gate: deny-by-default within
  the machine's declared `enforcedTools`, judged against the **caller's own** machine
  (see 4.5 attribution).
- **`rules-gate`** — see 3.3.

### 4.4 The Bash guards and the shared shell grammar

**`core/guard-state-file.ts`** — deny-by-default protection of the State File, the
subagent evidence/binding files, and machine definitions against Bash writers.
Since #219 its question is **"what does this line write?", not "what does it
mention?"** — a line naming guarded state was once judged by whether each segment's
head *looked* read-only, which a segment that rebound a command name could defeat
(`cat(){ rm "$1"; }; cat <state>`, `alias cat=rm`, `PATH=…`, `LD_PRELOAD=…` all rewrote
the State File through the old contract). Design, verified in source:

- A line that writes nothing it could name as guarded state passes untouched, whatever
  it mentions. A line that can is judged as a **pipe-chain**: segments split quote-aware
  on `&& || ; &` newline, with `|`-linked segments in ONE chain (a pipe carries data — a
  guarded path echoed into `xargs` becomes a write argument two segments later, so the
  chain is one trust unit).
- **Rebinding is the gate, not the exception** (`commandNamesRebound` in
  `shell-command-head.ts`, one rule both Bash guards apply): a segment whose command is
  rebound — a function definition, alias, hash, enable, source, trap, mapfile, an eval
  of runtime text (followed into its literal text), or a `PATH`/`BASH_CMDS`/`BASH_ALIASES`
  /`LD_*`/`DYLD_*` assignment — blocks a guarded line outright; the subagent authority
  guard trusts no head on it. Every segment is judged by the command it actually runs,
  as `analyzeCommandHead` resolves it — the review round that found literal-eval,
  backslash-, quote- and case-arm-hidden rebinders missed by a separator-only matcher
  was closed by deriving the judgment from the same resolution the head analyzer uses,
  not from text position.
- Admissions that write nothing (whatever they mention): **read-only git/gh** (#206 —
  `isReadOnlySubcommandInvocation` admits exactly `git`/`gh` with no environment prefix
  per the audited classifiers `read-only-git.ts` and `read-only-gh.ts`: listed verb
  tables that write no local file; no alias, extension, checkout or download),
  **sort/uniq/find and the text-filter/checksum family without their writing options**
  (`read-only-filters.ts`; `option-words.ts` shared so the classifiers cannot drift),
  reserved words around a command (`do cat "$f"`, `if grep …; then`), bindings of names
  the shell does not read itself (`NAME=value`, `for`, `read` — a binding line is judged
  whole, so `$NAME` cannot carry a guarded path into a chain that never names it), and a
  read's redirect to a file whose ONE static, lexically-normalized spelling names no
  guarded state (runtime, glob, brace, `~` targets, `<>`, `>&file` and relative targets
  on a `cd` line stay blocked).
- A **whitelisted helper** (17 helpers, matched token-by-token at the segment head;
  a helper vouches only for its own segment and never for protected-dir writes) passes;
  awk, sed, perl, xxd and base64 stay blocked (their programs or options write).
- Pattern tests run against a **quote-collapsed view** (`.cl'aude'/state/active_'task_graph'.json`
  still names the file) — collapse only errs fail-closed.
- **Substitutions** (`$(…)`, backticks, `<(…)`, `>(…)`) are extracted and recursively
  judged depth-capped, then replaced by placeholders that preserve guarded-token
  status; unbalanced substitution syntax fails closed.
- **Heredocs** are data unless the owning group executes stdin (interpreter reading
  program from stdin, recursing into inline `-c` programs) or the body is unquoted
  with live substitutions. Prose in a quoted heredoc is never judged as a command.
- Everything unparseable or unbounded fails closed — including writers nobody
  enumerated (patch, rsync, shred, `git checkout --`), wrappers (`xargs`,
  `env`, `timeout`), and the indirection seeds of the earlier rounds (bare
  `VAR=<state-path>` where the shell reads the name itself).
- **One owner of engine path classes (#204).** #192/#196 were one bug in two observers
  that each kept their own engine-path list, and a third list had already drifted
  (remediation excluded Claude Code's state/review directories but not Pi's — a Pi
  remediation could stage Loom evidence). `core/engine-owned-paths.ts` now defines every
  path class the engine writes or protects and classifies a path
  (`engineOwnedPathClass`, `isEngineEvidencePath`); task scope, the workspace digest,
  defect accounting, remediation, config, populate and the manifest helpers all read it.
  *Why:* a second site for "which paths are the engine's" was the drift that shipped.

**The shell grammar — one walker per concern, shared by every guard.** This is the
single most important structural decision in the guard layer. Rounds 15–18 suffered
"twin-scanner drift": two copies of the quote scan had already diverged (two counted a
backtick as a quote opener, one didn't), so `` $(`a)b`) `` was read as closing early.
The fix was not another patch but a consolidation into pure modules both the guard and
the evidence ledger build on — the guard *sees* and the ledger *mints* the same spans:

| Module | Owns | Divergence it killed |
|---|---|---|
| `shell-quoting.ts` | THE one quote lexer (`lexShellQuotes`) and its unquoted projection (`scanUnquoted`): the segment splitter, env-prefix strip, fused-redirect split, redirect scans and the evidence word reader all walk it | backtick-as-opener drift (round 15–18 class); six later hand-copied loops |
| `shell-substitution.ts` | THE one substitution traversal (`scanSubstitutions`: quote state `'"/null`, `'` inside `"…"` literal, `$(…)`/backticks live in double quotes) | the round-20 double-quoted-apostrophe regression, round-21's incomplete fix |
| `shell-normalize.ts` | THE one word normalizer: quote stripping, backslash escapes, line continuation, ANSI-C decode (NUL truncates), `$"…"`, parameter expansion — including the **default** forms (`${x:-w}` yields `w`) and the **alternate** forms (`${x:+w}`/`${x+w}`: empty on unset, `w` on set — the round-24 fail-open). Two entry points: `normalizeShellSpan` (the evidence reader's redirect word, every variable unset) and `normalizeShellVariants` (the guard's matching view: every reveal/empty combination of the optional word forms, null past the bound) | guard vs evidence scanner disagreeing about what a word *is* |
| `shell-ansi-c.ts` | shared `$'…'` decode | `\x2e`-spelled paths seen by one scanner and not the other |
| `shell-command.ts` / `shell-command-head.ts` | segment splitting (an `&` or `\|` binds to a redirect only after a `>` the walk read unquoted: `>&`, `>\|`; `readShellOperator` owns that walk for the splitter and the heredoc group walk alike), tokenizer (`( ) { }` standalone so compound syntax never hides a head), wrapper unwrap (`sudo env timeout …`), the read-only head | truncated-body analysis; `echo \>& rm <state>` read as one `echo` |
| `shell-redirects.ts` | THE one output-redirect scan (`redirectsOf`: file-write, fd-dup, stderr-discard, and the targets a guard cannot name — file-dup, read-write, process-substitution, missing-target); `hasOutputRedirect`, `outputRedirectTargets` and the evidence reader's `redirectTargetsOf` are its projections, each by an exhaustive per-kind table | `>\|` named to the guard, minted as nothing |
| `shell-heredoc.ts` | opener-line groups (compound-tracking), body data-vs-executed judgment | the heredoc inline-program gap |
| `shell-match-views.ts` | reveal-monotonic matching views + glob intersection vs a directory | guards missing brace/class/parameter spellings of a path |
| `shell-write-targets.ts` | the ledger-side reader: redirect targets (`redirectTargetsOf`: by kind, valued by the normalizer), `tee`, `mv`/`git mv`/`cp` destinations (device streams never targets) | evidence missing writes the guard would see |

`tests/core/guard-state-file-walkers.test.ts` pins the walker contracts so any future
drift is caught by an independent reference expectation. **Why it works:** the guard's
matching view and the ledger's minting view are derived from the same normalization,
so "the guard taught X" can never again mean "the evidence scanner does not know X".
**Residual:** this is still text-level judgment of command strings, not an execution
graph — see §8.

**`core/subagent-authority.ts`** (ADR-0067 D6) — a subagent may not change audit or
orchestration authority: only read-only helper operations (the split **derived** from
each helper's operation table `subagent` trait, never a hand-copied list), read-only
harness entrypoints, `.git` mutations restricted through `read-only-git.ts`.
Explicitly **defence in depth**: a ballot's authority rests on the capture-attestation
data path, not on this fence (see §8.5).

### 4.5 Guarded Skill Machines and the evidence ledger

A **machine** is a phase diagram for one agent type; the agent's own attributed tool
calls are the events. Three shipped machines (code-implementer, distill,
security-hunter). Key mechanics:

- **Digest pins (ADR-0076).** The engine does not trust the `machines/` directory:
  `machine-pins.ts` compiles in the SHA-256 of every shipped definition; the loader
  admits only exact-byte matches, and the pin set (not the directory listing) says
  who is gated. Tampering can make a gate stricter, never weaker. `npm run
  pin-machines -- --check` and a byte-compare test keep pin and file in lockstep.
  *Honest residual:* the pin is engine source the user's account can write — see §8.4.
- **The evidence ledger** (`<session>.evidence.jsonl`) holds **facts only**, four
  kinds: `FileRead`, `FileWrite` (`via: tool|shell`), `TestRun` (two origins: an
  `agent-command` runner at head position with a parsed structured report, or an
  `engine-run` run minted from a `helper run-tests` receipt, §4.6), `SandboxRun`
  (nonce'd sandbox script). Judgments (trusted, passed, red-then-green) are **computed
  at read time, never stored**. Transcript text is never a fact.
- **One minting rule for both harnesses** (ADR-0027): Claude PostToolUse/Failure and
  Pi child tool_result both reduce to a `HarnessToolCall` → `extractEvidence` (pure)
  → append. A matrix test feeds identical fixtures through both adapters and asserts
  identical records — the harnesses cannot drift.
- **When a TestRun is trusted** — three rules, each closing a forgery class:
  1. *Freshness is call-scoped*: the PreToolUse Bash hook stamps call start
     (`<session>.callstart.json`); an artifact may vouch only within [call-start − 2s
     slack, +15 min cap]; missing stamp ⇒ artifact-backed sources rejected loudly,
     only call-scoped stdout reporter JSON can vouch.
  2. *An agent cannot author its own report*: an explicit `--outputFile` the agent
     wrote in this epoch (file tool or shell, including on the judged command line)
     is vetoed — `printf '{…}' > r.json; npx vitest --outputFile=r.json` does not pass.
  3. *Exit ownership must be provable*: the line's exit is credited only to a sole
     command or the last segment after `&&`/`;`/`&`/`|` (with backgrounded tests and
     `$(…)`/`<(…)` nested runners never owning it). `npm test || true` yields
     `exit: null` ⇒ untrusted.
  A zero-exit run counts as a pass only with a parsed report showing ≥ 1 executed test
  and no failures; zero executed tests (none declared, or all skipped, pending or todo)
  is a trusted **non-pass** (ADR-0100). A later file write demotes an
  earlier pass. Untrusted verdicts carry a label naming how weak they are
  (`low-trust`, `degraded`, `fallback`, `snapshot-read-failed`, `helper-reported`).
- **Attribution** (pure `attributeEvidence`): a call with `agent_id` records only
  under that agent's binding line; reserved/unsafe/duplicated ids record nothing —
  never credited to a sibling. Calls with no `agent_id` fall back to the
  **sole-active rule** (recorded only while exactly one subagent is active and one
  machine is bound; contention stands down). Pi children are exact by construction:
  each is its own process recording under its parent-issued write grant's epoch.
- **Binding liveness**: bindings carry a TTL (shared 60-minute constant with the
  SessionStart sweep); a gated agent dying without its stop hook cannot gate the
  session forever. The sweep deletes a session group only when everything idled past
  TTL, never the starting session, and never a session whose TaskGraph pointer still
  exists — an orchestration paused overnight keeps its ledger. A session whose run
  binding registry names an open run is kept for up to `OPEN_RUN_GRACE_MS` past the
  TTL (ADR-0101), so a standalone run's captures still bind after an idle wait.

### 4.6 Proof, attempts, and settlement

- **Implementation Attempt**: one engine-reserved execution of one Task under one
  semantic attempt ordinal and one **immutable byte baseline**. Only engine-issued
  attempt authority can settle it. A Task id inferred from ambient state is cleanup
  evidence, never completion authority.
- **Attempt lifecycle**: attempt 1 fails ⇒ exactly one attempt-2 retry is issued
  (typed admission, prompt/context authority in `implementation-retry.ts`); attempt 2
  fails ⇒ terminal escalation, published in status. There is no attempt 3.
- **Proof obligations** (`proof-obligations.ts`): completion, required regression pass,
  required new tests, **test-first evidence where owed (I6)**, declared artifacts
  changed (engine-written skeleton bytes subtracted), completion conformance where the
  contract owes it. A Task's `verification_policy` carries independent
  `regression`/`new_tests` arms, each `required` or `waived` **with a typed reason** —
  no policy waives artifact proof or review.
- **I6 red-then-green**: did one attempt epoch show a behavioral red on the Task's own
  test files (frozen test-file classification per ADR-0025) before the first
  implementation write, then green? The judge (`red-then-green.ts`) reads only the
  ledger epoch view. *Honest residual:* it proves the **logged history** shows
  test-first work; an unlogged write (interpreter, generator) is invisible — see §8.2.
- **The Task Mutation Check (ADR-0071)**: while an implementer is still working,
  survivors of a mutation run over the Task's changed owner lines are named at the
  stop — via a record `helper mutation-check` wrote (the stop runs nothing), so the
  expensive run happens inside the attempt, off the stop path.
- **Stop checks** (`handlers/subagent-stop/stop-checks.ts`): one stop shell, one
  planner (`planStopChecks`, ADR-0024/0028) runs the Acceptance Stop Check then the
  Affected-Test Stop Check, with sequence/lock/budget/counter discipline. The
  Acceptance Stop Check enforces what a claimant owes when its agent tries to stop
  with contract obligations open (skeleton conformance included).
- **The Verification Manifest** (`.loom/verification-manifest.json`): the **operator's**
  file; the fixed Wave completion commands and optional settings. Population freezes
  it, so no Agent can ever supply command authority; absent file freezes engine
  defaults (reserved checks only). *Why:* "which commands decide done" is operator
  policy, and an agent-authored test command is a self-graded exam.
- **The completion suite**: the Wave Gate's frozen check bundle (acceptance runner,
  affected runner, owner verification, …) — everything enters one **suite digest**, so
  receipt reuse, workspace binding, and replay are uniform for every check.
- **Population refuses unprovable rosters (#202, Cause 3a).** Graph invariants that used
  to surface only at settlement or a Wave Gate are checked at population: a Task owing
  red-then-green whose file list holds no file the frozen classification calls a test
  file (it could only ever fail no-test-files); a Task owing red-then-green under a
  manifest with no affectedRunner (no engine run could prove it); a completable
  Requirement no Task names in spec_anchors (every Wave Gate's spec-check would report
  it ownerless). Runner presets (`core/runner-presets.ts`) give known runners as
  `affectedRunner` presets at manifest time.
- **`orchestration rescope-task` (#203, Cause 3b).** A pending Task whose file list cannot
  satisfy its policy is repaired in place instead of re-populating every Task: pure
  decision under population's own file-list rules (same-Wave ownership, sealed paths,
  protected paths, frozen contract paths, export bindings, the I6 test file), Proof
  re-derived, attempt baseline cleared, idempotent; a population-baseline Task gains the
  added files as Git held them at its start SHA.
- **Regression attribution (ADR-0080, #210, Cause 1).** A trusted failing run no longer
  fails the settling Task when every failing file belongs to another not-yet-implemented
  Task of the same Wave, the run recorded per-file results, and at least one test outside
  those files ran and passed (`core/regression-attribution.ts`); the evidence label names
  each excused file and owner. A later FileWrite still demotes an attributed pass. *Why:*
  parallel Waves share test files mid-flight; failing a Task for a sibling's in-progress
  file was a false block the panel kept having to refute.
- **Roster liveness (#211/#207).** A Claude Code subagent that dies on an API error never
  fires SubagentStop, so its `.active` roster entry stayed forever and blocked
  adopt-engine-revision, reopen-task, rescope-task and sole-agent attribution until
  removed by hand. `core/roster-liveness.ts` judges a typed TranscriptObservation:
  never-started (no transcript past a grace period — #207) or aborted (last transcript
  record is the API-error record and the transcript has gone quiet), so a dead entry is
  dead by evidence, and a retried agent that writes again is alive. #207 also fixed the
  CLI exiting before pipe output drained (`utils/exit-after-flush.ts`: an immediate exit
  delivered 128 KiB of 1 MiB under a paused reader) — set the code, let the process end.
- **Settlement**: the engine's single decision on one piece of submitted work, in one
  atomic transition. Late or duplicate evidence settles nothing.
- **Engine-run test evidence (loom#198 Cause 1, #201)** — the newest tier, which moves the
  test execution itself into the engine: `helper run-tests --files <path>…` runs the frozen
  Verification Manifest's `affectedRunner` over the test files the **agent names**, with the
  engine choosing the runner, its arguments, working directory, timeout and report path —
  all from the frozen manifest. The run prints a receipt line (`LOOM_TEST_RUN_RECEIPT {…}`)
  as the LAST stdout line after the runner has exited and its process tree is gone; the
  runner's own output goes to stderr before it, so a test printing a forged receipt line
  cannot reach the receipt slot even where a harness merges the streams (Pi). The receipt
  binds the run to the canonical repository root and the frozen manifest digest
  (`EngineRunBinding`, one parser for the receipt and the ledger's TestRun origin);
  settlement admits it only when both are its own TaskGraph's. In a graph that froze
  `test_evidence` engine-run mode, this is the **only** run that proves I6 — the evidence
  recorder mints an engine-run TestRun from the receipt and settlement admits only such
  runs; population freezes which mode the graph uses. A run whose report cannot be read
  back, is not UTF-8, or changed after the run prints no receipt and refuses, instead of
  becoming a runner-crash red; a run that did not finish (timed out, killed, could not
  start) proves nothing. The run holds the per-repository runner lock the stop checks
  hold, so a stop check and this run never write the same report at once. *Why it works:*
  the agent keeps semantic judgment (which files to test) while every mechanical authority
  (what runs, where, how long, what report, which receipt) is the engine's — closing the
  agent-writable-report residual of §8.6 at its root for engine-run graphs.
- **Reopen scope (ADR-0093, #234, loom#213 Cause 3).** `reopen-task --needs
  implementation|tests` (default `implementation`) records what the Finding needs before the
  re-dispatch. Under `tests`, each named Task carries a protected `reopen_scope`
  (`core/reopen-scope.ts`: the `TestsOnlyScope` — the frozen Test-File Classification's test
  and implementation lists plus the reopening's audit position) and its Proof is derived
  once from that scope: `test-files-changed`, `implementation-files-unchanged` and
  regression — no `new-tests`, no I6 order, no declared-artifact proof, so a matrix-row fix
  needs no cosmetic production write. Settlement judges the declared paths whose bytes differ
  from the reopen baseline (`reopenScopeChangedPaths`); an implementation file that changed
  fails by name, a test file that did not change fails, a registered attempt with no captured
  baseline is refused. Typed refusals cover Distill Tasks, contract Tasks, waived regression,
  unclassified lists and no-test-files lists; a repeat reopening is idempotent; conflicting
  `--needs` on the same awaiting Tasks are refused. The scope ends when the lineage settles
  terminally: `implemented` keeps the satisfied Proof as the record, escalation drops it and
  re-derives the default pending Proof, any return to revalidation drops it. A graph that
  never names `--needs` is unchanged byte for byte.

### 4.7 Review authority

- **Finding identity** is `(agent, emission ordinal)` — never model-chosen (an
  agent-chosen id collides across runs, and a k-of-n vote needs an item two verifiers
  can agree they are discussing). A reviewer-emitted item is a *draft finding* until
  attribution gives it identity. Malformed output is a **failed review**, never a
  finding.
- **Review Packet**: immutable snapshot binding Task ↔ base/head revisions ↔ exact
  path scope ↔ diffs ↔ postimages ↔ plan context ↔ proof obligations. Scope covers
  Git-visible leaves at either revision (deleted included, ignored excluded, symlinks
  by target); every scoped path must cover ≥ 1 artifact; **empty scope fails rather
  than broadening to the Wave**. Self-hashes prove integrity; **registration in
  protected state proves issuance** — a caller-authored file with recomputed hashes is
  not authority.
- **Review Generation**: monotonic per-Task implementation revision. Any byte change
  increments it and invalidates in-progress review runs — late evidence for older
  bytes cannot mutate current review state.
- **Review Run**: packet + generation + exact reviewer roster + **ordered active
  Finding ids** frozen at creation. Every expected reviewer must assess every prior
  Finding exactly once (`still_present` keeps it active) before atomic finalization,
  which resolves old findings and activates new ones together or not at all. *Why:*
  the "clean rerun erases the old blocker by omission" failure is structurally
  impossible.
- **Resolved ≠ refuted**: resolved requires every expected reviewer to verify the fix
  against one immutable packet; refuted requires panel adjudication (or audited manual
  override). Both retained forever — a wrong refutation is a shipped bug, and a
  silently dropped critical is indistinguishable from one never found.
- **Wire Contract**: the exact machine-readable output a reviewer must emit, fixed by
  protocol version, generated and **stamped** into reviewer definitions
  (`scripts/stamp-wire-contract.ts`) — never hand-edited. Versioned (ADR-0009); runs
  started under an older protocol finish under it. **Protocol v4 (#214, ADR-0084)**:
  a Wave Gate registered from now on issues a payload of `{schemaVersion: 4, kind:
  "wave-review", prior_findings, findings}` — the engine binds the Review Packet ID
  and Review Generation from the issued subject, so a mistyped hash can no longer
  exhaust a final attempt; a payload still carrying packetId or generation is refused,
  naming the v4 envelope. A Wave Gate registered before v4 keeps v2 until it ends; a
  restart or orphan replacement of it issues v4. Fresh **standalone** reviews still
  admit exact v2 bytes only — v3 is not a fresh protocol but the explicit-successor
  descriptor (ADR-0010), and v4 is Wave-only so it cannot collide with it.
- **Restart carry (ADR-0089, #222, Cause 1b).** After a restart of an exhausted Wave
  Gate, the replacement run issues only spec-check and the exhausted reviewer slots;
  accepted reviewer slots carry by reference (original slot, request and context
  identity plus `carried_from` provenance, never re-minted), and a Task whose whole
  roster was accepted is not reissued. Carry is admissible only under the same reviewer
  protocol, Review Generation, prior Finding IDs, roster and workspace scope/head —
  otherwise the Task resets as before. The carry plan is decided once under the restart
  lock (`core/wave-review-carry.ts`, pure) and recorded in protected state.
- **Advisory dispositions (ADR-0090, #224, Cause 4).** The operator's advisory decisions are
  recorded on the TaskGraph itself: `advisory_dispositions`, an append-only list written by
  `helper orchestration disposition` (`core/advisory-disposition.ts`, `advisory-disposition-record.ts`),
  the latest record per advisory being its standing decision. The record is a union on `decision`:
  `fixed` has neither anchor nor target, `deferred` has an anchor and an optional target Wave/Task,
  `dismissed` has an anchor and no target; every record carries a reason. The anchor is a sha256 over
  the reviewed bytes the advisory anchors to (its own file when that file is one of the Task's reviewed
  artifacts, otherwise the Task's whole reviewed artifact set), computed by the shell from the same
  reviewed-workspace observer the gate uses. Abandoning the gate run no longer loses the decisions —
  the operation is allowed while the gate is paused on its advisories and after the run is abandoned —
  and one prior selector (`waveReviewPriorFindings` → `issuedPriorFindings`) is the only site that
  turns records into a review's prior Findings: a `deferred`/`dismissed` advisory is omitted from a
  fresh review's priors exactly while its anchor equals the anchor of the bytes now reviewed, so an
  edited file puts the advisory back in front of reviewers. Approval is refused, naming each advisory,
  while any advisory the pending decision request issues has no standing disposition.
- **Succession carry (ADR-0091, #225, Cause 5).** A fresh Wave Gate start after an abandon (or a
  completed-Wave reopen) succeeds the Wave's latest retired run and carries every reviewed Task whose
  accepted review still judges its unchanged subject. The subject is bound by a **Subject Digest**
  sealed into the acceptance at finalisation (`core/review-subject.ts`): protocol, roster, description,
  agent, plan context, Requirement anchors and contributions, declared and modified files, Review
  Generation, proof, test result, owner-map obligations, contract surfaces, plan file and the reviewed
  workspace scope and head; the seal binds the Task's active and refuted Finding IDs, which a Refutation
  Panel may move between without breaking it. Retired runs become protected provenance
  (`core/retired-wave-review-runs.ts`): retiring an abandoned run's tombstone no longer drops the
  acceptances it recorded. The succession is planned at start and frozen into the registration
  (`prepareWaveGateFacadeStart` → `planSuccessorCarry`; `core/wave-review-carry-plan.ts` reads it),
  the install re-checks each carried acceptance against the observed bytes and Subject Digest, and
  completion admits a carried acceptance only from the registration's lineage. A legacy acceptance
  without a digest is reviewed in full once. An advisory disposition never breaks a carried acceptance
  (the digest covers what packets present apart from Findings) — the two mechanisms compose.
  `start wave-gate --fresh-review` plans nothing and issues every reviewed Task in full.
- **Standalone read coverage (ADR-0022)**: a standalone reviewer is admitted only
  after the engine observed it read the whole frozen diff. Coverage is **per-attempt**
  and engine-verified; **retries reset coverage to zero** and unread pages are always
  refused.
- **Standalone lineage (ADR-0010)**: advisory publication records the parent's
  complete ordered decisions immediately (policy declared, not observed); a successor
  review joins one exact predecessor result + policy revision, conserves every
  original Finding (id, assertion, severity, evidence, votes), and only new criticals
  or evidence-bound reopenings reach a fresh panel. No automatic predecessor,
  similarity merge, or severity override — a digest or a formally phrased claim is not
  semantic proof.
- **Stop-check notes** surface to the orchestrating session via PostToolUse so agent
  left-notes (#121) cannot vanish.

### 4.8 Panels

- **`panel-kernel.ts`** — the primitives every adversarial panel shares: exact
  candidate/criterion/verifier **slots**, each slot's identity binding its lens or
  criterion (caller prose cannot swap it), **complete-roster parsing** (aggregation
  cannot accept a partial roster), retries, ranking, verdict validation.
- **Refutation panel** (Wave Gate step): N verifiers, each committed to one of five
  **refutation lenses** (`reproduction`, `intent`, `blast-radius`, `security`,
  `test-coverage`; baseline selection always includes reproduction + intent), each
  covering ALL critical Findings, trying to **refute**. Strict majority refutes; ties
  keep the Finding (a false positive costs a cycle; a false negative ships a bug).
  Refuted findings are recorded with lenses and reasoning, never deleted.
- **Architecture panel** (`/loom --panel`): N designers × 5 **design lenses**
  (`simplicity-first`, `type-driven-fp`, `risk-security-first`, `performance-first`,
  `codebase-conventionist`), judges score every candidate per criterion, engine
  aggregates, **the user chooses** — ranking is advice. One normal architecture plan
  comes out.
- **Durability**: the architecture panel's parent replays its `spawn-outcome`/
  `engine-outcome` journal through `helper panel-program architecture` (ADR-0096);
  refutation panels persist as a checkpoint whose event prefix must replay exactly
  and is **re-proved on every read**.

### 4.9 The Wave Gate

`wave-gate-machine.ts` is the LC-1 reducer with **proof-carrying authority**:
readiness snapshots and next-action proofs are cross-checked (completion needs the
readiness proof; readiness binds a lifecycle checkpoint and next-action proof) and can
be minted only inside the module — everything else recognises them by identity. Stages
(docs + code): preparing → review issuance → awaiting-review-results → refutation
panel (when criticals) → advisory decision (user) → completion suite (frozen checks +
full-tier lint) → ready-to-complete → **done** (one protected commit stamping the
Acceptance Freeze from the archived suite receipt).

Supporting machinery, each in its own module: membership (whether a request/capture
belongs to this gate), registration (one decision over fresh vs existing runs),
replacement (two pure protected-state transitions), preparation, status facts
(`loom-status.ts` is the canonical read model), and orphan recovery (`recover-orphan`
— a run whose directory is missing is orphaned, never fresh). A fresh start also
plans its succession (ADR-0091): the carry from the Wave's latest retired run is
decided at registration and frozen into it; `start wave-gate --fresh-review`
plans nothing.

A fresh start also narrows what it re-reviews (ADR-0094, #233, loom#213 Cause 5b): a
changed Task is issued only the reviewers its change needs, judged against its **Review
Basis** — the current-protocol accepted review, or the `review_basis` a reopening kept
(`core/review-narrowing.ts` owns the two spellings and the one conversion). The shell reads
the basis run's frozen packet bytes; the core proves them against the accepted head and
classifies the change (`core/review-change.ts`): `unchanged`, `scope-changed`,
`context-changed`, or per-file `comment`/`doc`/`test`/`code` classes — comment-only verdicts
come from a conservative lexer (`core/comment-lexer.ts`, property-tested against the
TypeScript parser; C-family only, so anything unreadable counts as code). The role table
(`core/wave-review-roles.ts`): comment- or doc-only → `comment-analyzer`; test-only →
`code-reviewer` + `pr-test-analyzer`; any code or context change → the full derived roster;
`architecture-tech-lead` rides the full roster or owns an issued prior Finding. The selection
is frozen into the registration (`narrowedReviews`, absent when nothing narrowed, so such a
registration is byte-identical to before), enforced by the locked install (a narrowed Task
that lost its basis is refused, never silently widened), recorded on the Review Run and its
acceptance, and reported per Task on stderr (`wave-gate-start-roster`). A narrowing that no
longer fits the derived roster widens to the whole roster — loudly, never silently. A carried
Task (above) is never narrowed.

### 4.10 Acceptance Contracts and Skeletons

A plan's `CT-N` declaration becomes **executable before implementation**:

- a declarations-only types file (or none, with a typed reason) and dedicated
  acceptance test files, written by the contract's Task, **frozen once observed
  failing** (red);
- each testcase named after the Requirement it decides; the name prefix is the only
  attribution;
- claimant Tasks must turn the frozen tests green; claimants may not write the frozen
  paths (the freeze is checked, with advisories pre-freeze via `freeze-notice.ts`);
- **Skeletons**: engine-written files at not-yet-existing paths a plan binds to a
  contract — every bound export declared with its frozen type, body throwing
  unimplemented. Completion refuses a bound export that is deleted, renamed, retyped,
  or still unimplemented (**conformance judge**, `engine/src/core/skeleton/conformance.ts` — with a
  restricted pure TS lexer and a Java surface);
- the writer is **no-clobber** (`skeleton-writer.ts`); "contract stubs" are the
  skeletons written at the contract Task's stop;
- **Contract Revision** is the one operator path that changes a frozen contract,
  resetting exactly what a reset must reset.

*Why it works:* "the tests were green" stops being a claim — the tests existed, were
observed red, were frozen, and a specific Task was named to make them green, with the
types file enforced by the compiler.

### 4.11 Owner verification

For a plan-declared invariant **owned** by one function with sibling entry points:

- obligations are **stamped at TaskGraph population** (ADR-0032); the gate re-reads
  the plan under the lock and fails closed on drift (`plan-integrity.ts`) — one
  selection owner (`engine/src/core/owner-verification/obligations.ts`) answers "what does this
  Wave/Task owe", with absent-stamp and empty-list never confused;
- **sibling coverage**: the matrix test's import graph (parsed with the TypeScript
  compiler API, closed under re-exports) must reach the owner module and every
  declared sibling entry point;
- **mutation**: a deterministic plan over the owner's changed head lines (vs the Wave
  base) runs each mutant in a **detached worktree** (isolated, ADR-0038), via the
  frozen affected runner with the matrix test as its only file — no command text ever
  comes from the plan;
- **outcome classification reads only the structured report** and never throws:
  unreadable file, missing report, unparseable owner, missing base, changed real
  workspace — each a named infrastructure result, never a kill and never a pass
  (ADR-0037);
- the check is part of the completion-suite digest, and a Task touching an owned
  family earns the `owner-map` packet section + the sixth reviewer + brief duties.

*Why it works:* "the invariant holds" becomes "a generated matrix test imports the
owner through every sibling, and every mutant of the owner's changed lines was
killed" — both engine-observed.

### 4.12 Standalone programs

- **`/review-pr`** — freezes changed files, runs the applicable reviewer roster,
  refutes criticals, publishes `result.json`. Never touches a feature TaskGraph.
  Roster completion proof, aggregation, and result custody live in
  `standalone-review.ts` (the one owner of source, disposition, and successor
  preparation).
- **Advisory disposition** — a standalone-disposition program records accepted/
  deferred/dismissed decisions **without Agents**; corrections name the exact earlier
  publication.
- **`/review-and-fix`** — the remediation machine: scope authority, **excluded
  evidence paths** (state/review evidence can never enter a commit), an **audited
  temporary Git index**, witness recheck, install of exactly the verified changes;
  push optional, **force-push forbidden**.
- **`/security-audit`** (ADR-0067) — the deepest program:
  - a **coverage-ledger state machine** (`security-coverage.ts`): the one place
    coverage is assigned; hunters are issued **per coverage unit** across 13 vendored
    security lenses; "we looked at everything" is replaced by enumerated cells;
  - hunters run Read/Glob/Grep/Bash only, with **sandboxed** impact proof
    (`scripts/security-sandbox.sh`; the sandbox contract is typed in
    `security-sandbox.ts`): a receipt says the limits held, bound to the artifact by
    nonce — evidence the run happened, not that production is exploitable;
  - **verifier panel** on a different model profile: ballots bound to issued spawns;
    captures attested by the harness into a protected store; a same-profile ballot is
    worthless (INV-S3);
  - **adjudication** (`security-adjudication.ts`): which candidate becomes a
    published finding, on what vote;
  - the report **refuses to publish** over unsettled coverage; publication blockers,
    budget, and calibration are explicit stages; handoff to `/review-and-fix` is a
    typed disposition record.

### 4.13 Persistence

**The State File.** `state-manager.ts` + `state-file-wire.ts` (4.1k lines of pure
`(unknown → LineParseResult)` wire parsers — the whole graph is parsed before use,
"parse, do not cast"):

1. mode `0444` at rest;
2. deny-by-default Bash guard (4.4);
3. `StateManager` lock + **stage-temp-then-rename** writes through an anchored parent
   capability (retained parent descriptor on Linux; `O_NOFOLLOW_ANY`-proven real path
   on darwin);
4. narrow hook/helper ownership of mutations (the 17 whitelisted helpers, each vouching
   only for its own segment); the lock re-checks Runtime Revision immediately before
   any chmod/lock/write.

`core/` never imports `config.ts`: guarded locations arrive as `GuardedLocations`
domain values resolved by the shells — env facts stay out of the pure core.

**Run Directories.** `run-directory-handle.ts` (2.2k lines) anchors every access:
direct-child relation verified, unsafe identity/path shapes rejected, path components
reopened **no-follow**; authority/abandonment/request/context/blob/transcript/event/
receipt slots are immutable and exclusive; duplicate publication or mismatched run
identity fails closed; no arbitrary-path write API exists. Durability is the
**append-only journal of dedup-keyed events** (ADR-0029); checkpoints are projections
re-proved on read; an append is idempotent on its dedup key, so a crash between
publishing an artifact and journalling resumes by republishing the same bytes and
journalling once. Retired runs get `abandoned.json` — written once, deleting nothing,
deliberately not a program event.

**Context Packets.** Content-addressed immutable collections: the packet file lists
section identity (label, length, digest); section bytes live once in `blobs/<digest>`;
every read re-hashes through one resolver. A frozen Wave source shared by a Task's
reviewers and their retries is one blob, not a copy per packet (a 34 MB run stores
1.9 MB). *Why:* children read scope and protocol prose from bytes the engine minted,
not from a parent model's reconstruction.

**Effects.** Reducers emit typed effect intents; `effect-runner.ts` executes and
records receipts; on resume an already-receipted effect is **reconciled, not rerun**.
"The domain authorizes this effect" and "the shell performed it" are separate facts.

### 4.14 Model policy and the Pi adapter

- **Model profiles** (`model-profiles.ts`): every agent's model is explicit and
  pinned; Pi renders agent definitions with explicit provider/model/thinking bindings
  (`scripts/sync-pi-agents.sh`) — a byte-copy would preserve Claude aliases and let
  children silently inherit the orchestrator's expensive model, both forbidden.
  `model-routing.json` can authorize binding children to the parent's (e.g. local)
  model; a malformed config degrades to declared bindings.
- **Pi runs local models only, fails closed on an unreachable route, releases
  emission per route** (ADR-0023): `route-reachability.ts` gates spawning before a
  parent spawns into a dead route; `served-model-probe.ts` observes what each routing
  target actually serves.
- **Emission** (the Pi child-launch system): a model-**initiated** launch request is
  issued a capability; child readiness is a **launcher barrier, not a notification**
  (ADR-0014 — the launcher proves the child's readiness command exists and answers
  before any Task prompt is delivered; the seam was proven by a frozen probe under
  `probes/emission-readiness/`); the batch's capabilities — staged launches, issued
  write grants, rewritten child prompts, bound review runs — live in one **claims
  ledger** (`pi/spawn-claims.ts`) released by two orchestrators; **write grants** are
  one-time, scoped, and enforced per write; a child without a valid grant records no
  evidence and says so on stderr; `reserved-results.ts` treats a short return as
  missing, never as success.
- **Session shutdown** releases every capability a session still holds.
- **Interactive phase agents** run as RPC children with relayed dialogs; no
  `ctx.ui.custom()` inside RPC children (documented limit).

### 4.15 The linter

Two tiers, **both fail closed**: the immediate tier (regex + immediate programmatic
rules) runs after every edit (`lint-file.sh`) and returns a **block** carrying the
violations (or the engine error) — the edit has landed, but the model is told at once
and the run cannot treat it as clean; the full tier runs at the Wave Gate
(`lint-wave-gate`), with **lint runtime skew** detection (whether the lint that judged
a branch ran over the same bytes now current).

Scoping model — "everything is linted; exclusions are explicit and reasoned":

- every lintable extension, tests and declaration files included, plus `docReferences`-
  governed Markdown; exclusions are a parsed, validated list (`exclude-pattern.ts`:
  suffix vs directory entries; an entry that would not mean what its author wrote is
  **refused by name** — empty, bare `/`, `.`/`..` segments, byte-for-byte globs);
- every subtracting list is **decay-checked**: an exclusion, root, shell, boundary,
  capability grant, external name, or baseline entry that names nothing fails the run
  (ADR-0079: a word that lives outside the source is listed as an external name);
- every opt-in rule family (`boundaries`, `pureModules`, `requireGovernance`,
  `docReferences`) is configured or declined-with-reason; neither is a coverage gap
  that fails the full tier (ADR-0075), and each session in an undecided project starts
  with a reminder until decided or silenced per-repository.

Rules: 13 shipped regex rules (hygiene: `lint-rules/no-any-type.json`, `lint-rules/no-console-log.json`,
`no-star-import`, `no-non-null-assertion`, …), plus programmatic rules including the
engine's own governance: `no-cross-boundary-imports` (every `engine/src` directory must
be named by a boundary — an ungoverned file is a violation), `no-io-in-pure-modules`
(with `machine-purity.test.ts` walking the whole declared core's import closure),
`switch-totality`, `exhaustive-discriminant-branching`, `no-duplicate-block`,
`no-wire-cast`, `no-dangling-doc-reference` (every reference in a governed doc/code
resolves), `fugue-generated-integrity`, `max-function-lines`, `prefer-array-methods`,
`no-nested-ternary`. Grandfathered violations live in **baselines** that decay-check
on every full run.

**ReDoS safety (ADR-0002)**: static regex analysis plus a runtime timeout wrapper —
a project-supplied regex rule cannot hang the edit loop.

*Honest residual:* the programmatic rules are pattern/AST-hybrid; `no-io-in-pure-modules`
matches known I/O spellings, so exotic indirection can evade the regex list — but the
machine core's import closure is provably walked by a test, which is the stronger
guarantee where it matters most.

### 4.16 Parsers and transcript anti-corruption

`parsers/` + `core/claude-transcript-*.ts`: JSONL transcripts are read only once
settled (`read-settled-jsonl`: the final record is fully written), with retries; the
Claude transcript projection is an explicit anti-corruption boundary; test output is
extracted only from real Bash tool_use/tool_result pairs; phase artifacts are derived
from completed agent output; the decompose payload, plans (`parse-plan-models.ts`:
lifecycles, pipelines, invariants **with ownership**, contracts), and specs
(`parse-spec.ts`, branded `SpecEntryId<"FR">`-style ids) all enter through exact
parsers. `plain-record.ts` is the shared exact-parse kernel for untrusted JSON wire
input. Proven non-empty lists (`nonEmptyOf`) replace every `as NonEmpty` cast.

### 4.17 Active-run mutation surfaces (the #212–#222 campaign)

A live TaskGraph used to be frozen against repair: a wrong file list, a missing dependency,
a drifting spec or plan could only be suffered until the Wave ended. The campaign gave the
operator **audited mutation operations** instead — each one a pure decision core, an audit
record, and a helper:

- **Audited active-Wave plan edits (ADR-0081, #212).** Same-Wave dependencies are now
  satisfiable: a `dependency` dispatch hold withholds a Task until its same-Wave
  dependencies settle (`core/task-dependency-edit.ts` shares the hold rule with status,
  registration and the brief). `helper orchestration add-dependency --task --on --reason`
  records a `dependency-added` WavePlanEdit; a cycle is refused with the cycle named; the
  State File admits a same-Wave edge only when an audit records it. All plan edits
  accumulate in the graph's `wave_plan_edits` audit (`core/wave-plan-edit.ts`).
- **Coupled file sets (ADR-0082, #212).** A package manifest and the lockfiles beside it
  belong to one Task (`core/coupled-file-sets.ts`); population, rescope-task and add-task
  refuse a split — a Task that edits a manifest without its lockfile can
  never produce coherent evidence.
- **Task addition/withdrawal through plan edits (ADR-0086, #217/#212).** Forward Fix is
  retired: `helper orchestration add-task` appends a Task to the active Wave as a
  `task-added` plan edit (`core/task-addition.ts` — sealed paths named with
  `--sealed-file`, `--depends-on` edges, `--before` makes pending Wave Tasks wait for
  it; `withdraw-task` removes a never-dispatched added Task with every edge). No held
  Task has to fail first, and a Task the plan missed needs no sealed path; a cycle is
  refused at write time. The forward-fix dispatch hold is gone — an older State File's
  forward-fix audit reads as its held Tasks depending on the fix Task, so a paused run
  resumes on this engine without a migration; one mechanism instead of two.
- **Spec amendment (ADR-0087, #220).** `helper amend-spec --from <proposed> --reason`
  changes the specification's text while the run is live: it records a spec-amended audit
  (both Spec Index observations, rewritten/added/withdrawn ids, the completed claims owed
  a re-judgement), re-anchors open claims to the new text, retires the Wave's review
  authority and spec-check, then writes the new bytes. Withdrawing an id an open Task
  still claims is refused; a rewritten completed claim is re-judged by the next Wave
  Gate's spec-check (`core/spec-rejudgement.ts`); a crash after the commit is finished by
  re-running the command.
- **Runtime seams (ADR-0088, #221, Cause 5).** A contract may declare **Runtime seams:** —
  the production symbols a request passes through (a host's checkpoint encoder, a response
  serializer). The contract persists them; the Acceptance Freeze is refused while any
  acceptance file does not reference a declared seam; plan alignment reports SEAM-N gaps
  for a route whose contract declares no seams or whose harness bypasses them, and
  spec-check reports a bypassing harness as HIGH. *Why:* an acceptance test that green-lights
  a path the production harness never takes is a tested lie.
- **Retrospectives (ADR-0083, #215, #200).** Every Wave's friction is recorded as facts,
  not narrative: `core/retro-facts.ts` digests attempt receipts, escalations and
  remediations, reopenings, plan edits, Wave Gate runs (abandoned runs as their audits
  name them), Finding counts, and the Tasks with friction and their failure kinds.
  `retro-triggers` names when a digest is worth a retro (terminal escalation, a second
  Wave Gate run, a plan change, repeated reopenings, the engine moved under the run). The
  status document carries a never-blocking `retro` report; `helper record-retro` audits
  that the retrospective happened, and the `retro` skill reads the facts first.

---

## 5. The determinism catalog

Every row is a prompt-only failure mode Loom observed, and the mechanism that replaced
it. Expanded from docs/architecture.md "Guarantees and honest limits" with the
per-mechanism *why it works* and *what remains*.

| # | Prompt-only failure | Mechanism | Why it works | Residual |
|---|---|---|---|---|
| 1 | Agent says "done" | Engine-derived proof obligations (§4.6) | Completion is a pure derivation from evidence the engine minted, not a claim | Semantic correctness of the work is still the model's |
| 2 | Transcript *looks* green | Ledger TestRun facts + structured reports + trust rules (§4.5) | Ground truth (report bytes + call-scoped freshness + exit ownership) outranks prose | Ledger covers logged facts only (§8.2) |
| 3 | `npm test \|\| true` grades itself | Exit-ownership rule at real head position | Runner inside `$(…)`, after `\|\| true`, or backgrounded never owns the exit | Unclassified spellings (e.g. `npm --prefix <dir> run verify`) fall to untrusted, the safe side — §8.1 |
| 4 | Test-first skipped | I6 red-then-green over the attempt epoch | The red run must precede the first logged implementation write | Unlogged writes invisible (§8.2) |
| 5 | Agent authors its own test report | Self-author veto + artifact freshness window | A report the agent wrote this epoch cannot vouch for itself | Same-call forgery residuals documented; sandbox receipts bind artifact, don't authenticate author (§8.6) |
| 6 | Review rerun omits the old blocker | Review Generation + packet + mandatory prior-id assessments | Omission is structurally impossible: every reviewer must assess every prior id | — |
| 7 | Caller swaps/skips panel verdicts | Exact slots + complete-roster parser | A partial or foreign roster has no representation | — |
| 8 | Parent improvises retries | Typed attempt-1/attempt-2 lifecycle, terminal escalation | The reducer owns transitions; no attempt 3 exists | — |
| 9 | Markdown "sequence" drifts | Reducer state/event algebras (LC-1, LC-2, remediation, disposition) | Illegal transitions unrepresentable; terminal states explicit | — |
| 10 | Parent copies output into "transcripts" | Harness captures exact bytes into fixed slots | Capture is the harness's, request-bound, attested | Parent session is trusted (§8.5) |
| 11 | Agent edits the state JSON | 0444 + Bash guard + StateManager lock/rename + narrow writer ownership | Four independent layers; guard fails closed on unparseable input | Text-level judgment (§8.3); coordinated machine+pin rewrite (§8.4) |
| 12 | Prompt chooses output paths | Anchored fixed-layout RunDirHandle, no-follow | No arbitrary-path write API exists to misuse | — |
| 13 | Broad `git add` | Audited temporary index + witness recheck, force-push forbidden | What enters the commit is exactly what was verified | — |
| 14 | "We looked at everything" | Security coverage ledger, enumerated cells, publication refusal | Publishing with unsettled coverage is not a representable state | Coverage only as good as seeded cells (§8.7) |
| 15 | Reviewer "remembers" the invariant | Owner verification: matrix test + mutation kill (§4.11) | Engine-observed import closure + mutant kills | Report-artifact residuals (§8.6) |
| 16 | Invariant enforced "in prose" | Executable-models policy: lint rule or honest advisory | A model in a plan either executes or does not exist | — |
| 17 | Generated pipeline drifts | Fugue stamp + `fugue-generated-integrity` lint | Regeneration without the stamp fails the full tier | — |
| 18 | Gated agent rewrites its own gate | Machine digest pins (ADR-0076) | Loader admits only exact bytes; tampering only tightens | OS-level rewrite of engine source (§8.4) |
| 19 | Unsubstituted template ships | Substitution gate + FALSE_POSITIVES set | Prompt cannot reach a child half-specified | Hand-maintained set is checkout-drift-prone (§8.9) |
| 20 | Stale CLI writes state a live extension can't parse | Runtime Revision hash + pre-write re-check | Skew refuses at the write boundary | — |
| 21 | Crash fails a gate open | FAIL_CLOSED_ROUTES exit-2 polarity from argv | Polarity decided before anything can throw | — |
| 22 | Harness adapters drift apart | One minting rule + dual-harness matrix tests; one rules-gate core; one lint-coverage shell | Shared core, thin adapters | — |
| 23 | "Roster complete" asserted | `parseCompleteRoster` et al: complete rosters are parser-produced | Aggregation cannot accept a partial roster | — |
| 24 | Duplicate/late evidence mutates state | Settlement: exactly one outcome, one atomic transition; dedup-keyed journal | Late evidence settles nothing; replays dedup | — |
| 25 | Checkpoint lies about history | Append-only journal is the record; checkpoint re-proved on read | Projection cannot outrun its event prefix | — |
| 26 | Agent runs its own tests, names its own runner | Engine-run test evidence: `helper run-tests` receipt (engine picks runner/report/timeout from the frozen manifest; receipt is the last stdout line, root+manifest-digest bound) (§4.6) | The agent names files; the engine owns execution and the receipt's slot | Legacy `agent-command` graphs keep the §8.6 residuals; engine-run graphs close them |
| 27 | Roster unprovable at birth surfaces at settlement | Population refuses unprovable rosters (#202) | no-test-files, no-runner and ownerless-requirement graphs are rejected when authored | — |
| 28 | Guard trusts a rebound head (`cat(){ rm; }; cat <state>`) | Write-based guard; `commandNamesRebound` one rule both Bash guards apply (#219) | Each segment judged by the command the head analyzer resolves; literal eval text followed | — |
| 29 | "Don't edit while attesting" as brief prose | Attestation enforced by the edit guard (#218, ADR-0085) | Armed Task's writes refused up front; unobservable mode fails closed | — |
| 30 | Sibling's in-flight test file fails my Task | Regression attribution (ADR-0080, #210) | Per-file results + in-flight owner check; the label names each excusal | Pi verdicts stay untrusted by design |
| 31 | Reviewer payload asserts its own packet identity | Protocol v4: engine binds packet id + generation (#214, ADR-0084) | A mistyped hash can no longer exhaust a final attempt | — |
| 32 | Restart re-runs reviewers who already passed | Carry plan decided once under the restart lock (ADR-0089, #222) | Accepted slots carry by reference; admissibility pre-checked | — |
| 33 | Dead roster entry blocks operators forever | Roster liveness judged from transcript evidence (#211, #207) | never-started / aborted are typed observations, not guesses | — |
| 34 | Two observers keep two engine-path lists (#192/#196) | `engine-owned-paths.ts` is the one owner (#204) | Every consumer reads one classifier; a second site is the bug | — |
| 35 | Engine switches under a live run | TaskGraph engine-revision pin + audited adoption (#205) | Write boundary refuses a foreign pin; adoption chain is append-only and parser-checked | Self-hosted graphs exempt by design |
| 36 | A live TaskGraph cannot be repaired, only suffered | Audited mutation operations: add-dependency, rescope-task, add-task/withdraw-task, amend-spec (#212/#203/#217/#220) | Each is a pure decision core + an audit record; cycles and illegal edits refused at write time | — |
| 37 | Acceptance green on a path production never takes | Runtime seams declared, enforced at the freeze (ADR-0088, #221) | Freeze refuses acceptance files that reference no declared seam | — |
| 38 | Retro = vibes | Friction facts + triggers + audited record (ADR-0083, #215) | Facts digested from protected state; the retro report never blocks | — |
| 39 | Advisory decisions die with the gate run | Advisory dispositions recorded on the TaskGraph, anchored to reviewed bytes (ADR-0090, #224) | Abandon loses nothing; a decided advisory is reissued only when its bytes change | — |
| 40 | A fresh start re-reviews every accepted Task | Succession carry by a Subject Digest sealed into the acceptance (ADR-0091, #225) | Carries only when the whole review subject is unchanged; `--fresh-review` opts out | Pre-digest acceptances reviewed in full once |
| 41 | A test-row fix pays for a full re-implementation | Reopen scope: `reopen-task --needs tests` derives a tests-only Proof (ADR-0093, #234) | Implementation files unchanged is proven, not instructed; no cosmetic write can satisfy it | A graph that never names `--needs` is byte-identical |
| 42 | A one-line comment fix re-issues five reviewers | Roster narrowing against the Review Basis (ADR-0094, #233) | Comment/doc/test classes issued only the roles they need; selection frozen into the registration | Unreadable or missing basis ⇒ full roster; JSX/TSX and non-C-family comments count as code |

---

## 6. Guardrail inventory (every guard, one line)

| Guard | Layer | Fail-closed? | Protects |
|---|---|---|---|
| `validate-phase-order` | spawn | crash ⇒ block (exit 2) | phase sequence; decompose vs plan-design gate |
| `validate-task-execution` | spawn | crash ⇒ block | wave/dependency order, path ownership, reservations, attempt authority |
| `validate-template-substitution` | spawn | crash ⇒ block | prompt completeness |
| `validate-agent-model` | spawn | crash ⇒ block | model policy |
| `validate-agent-skill` | spawn | crash ⇒ block | skill preload contract |
| `block-direct-edits` | edit | crash ⇒ block | orchestrator/agent write scope, attempt binding |
| `enforce-phase-tools` | edit | crash ⇒ block | machine tool availability per phase |
| `rules-gate` | edit+bash | crash ⇒ block | rules/skills in context before code |
| `guard-state-file` | bash | crash ⇒ block | State File, evidence/bindings, machine defs |
| `guard-subagent-authority` | bash (subagents) | crash ⇒ block | audit/orchestration authority |
| `record-evidence` | post | never blocks | ledger facts |
| `lint-file` | post | blocks on a violation or an engine error (immediate tier) | edit-time rule enforcement; the full tier runs at the Wave Gate |
| `type-diagnostics` | post | advisory | type-check feedback in-loop |
| `mark-subagent-active` | start | records | machine binding, attempt binding |
| `record-orchestration-spawn` | post | records | correlator ↔ request authority |
| `surface-stop-check-notes` | post | records | agent notes reach the orchestrator |
| `dispatch` (stop) | stop | routes | settlement of every agent kind |
| `cleanup-*` / sweep | lifecycle | best-effort | stale binding/TTL hygiene |
| `resume-after-clear` | session | injective | context restoration after `/clear` |
| `lint-coverage` | session | never blocks | family on-or-declined reminder (ADR-0075) |

Plus the **non-hook guards**: StateManager (mode/lock/rename/no-follow/Runtime
Revision), RunDirHandle (anchoring/exclusivity), effect receipts, capture
attestations, sandbox contract, coverage-ledger publication refusal, remediation
exclusions, digest pins, route-reachability gate, emission readiness barrier, write
grants, claims ledger, reserved-slot authority, stdin caps, ReDoS wrapper, decay
checks — plus, since the #201–#223 wave: the TaskGraph engine-revision pin, the
per-repository runner lock, the restart carry plan, and the population-time
roster-provability checks.

---

## 7. How Loom tests its own determinism

- **841 executed test files / ~265.4k lines** — 817 under `engine/tests/` (962 TS files there
  including fixtures and helpers; core 315 test files, handlers 188, pi 50,
  linter 47, orchestration 39, utils 35, machine 31, acceptance 20, security 20, …)
  and 24 under `calibration/` and `probes/`, which the Vitest include set adds
  (`*.test.ts` plus the probes' `*.test.mjs`).
- **Matrix tests** lock "every caller is a row": owner-obligations callers, walker
  contracts, dual-harness evidence fixtures.
- **Property tests** (fast-check) over the shell grammar and parsers — the class of
  bug that killed rounds 15–24 is now mechanically explored, not just exemplified.
- **Byte-compare pins**: machine pins, generated modules, wire-contract stamps.
- **Doc tests**: the ADR index table (102 ADRs) is derived and verified; wire examples in docs
  are validated against the real schemas (`doc-wire-examples.test.ts`).
- **Smoke suites**: panel mode, orchestration facades, Pi resources, task-graph
  validation — real CLI processes, not mocks.
- **Probes** are frozen evidence: the emission-readiness barrier's feasibility proof
  (counting provider substitute, negative controls) is retained and re-runnable.
- **Calibration**: a corpus + preregistration/window/blinded-assessment discipline for
  measuring model-route behavior; release decisions are recorded per route with
  guardrails, and **a window is never re-run to obtain a more favourable result**.
- **The verify chain**: `npm run verify` runs the Verify Slice (`LOOM_VERIFY_SLICE`)
  through `scripts/verify.ts` — pure step plan, spawning shell; tests run with
  `env -u PI_CODING_AGENT` so an ambient Pi session's environment can't skew results.
- **Engine-run evidence test**: `helper run-tests` (`#201`) — the engine executes the
  frozen manifest's runner over agent-named files and prints a root-and-digest-bound
  receipt the ledger mints into an engine-run TestRun; in engine-run graphs it is the
  only run settlement counts (§4.6).

---

## 8. What doesn't work — verified residuals and weak spots

Everything in this section was checked against the code at a28b6d6a and, for the wave
that followed it, at deb8c369. The engine's own "Honest limits" documentation is
unusually candid; this section adds what the scans found beyond it.

### 8.1 Test-command classification gap (still open, narrower)

`PACKAGE_RUN_HEADS` matches **bare heads** (`npm run <script>`, `yarn run`, `pnpm run`,
`bun run`; plus `npm test` / `npm run test` / `npm run verify` in
`TEST_COMMAND_PATTERNS`). The `npx --prefix <dir> vitest` form **is** classified now
(`NPX_PREFIX_OPTION` in `machine/extract-evidence.ts` strips the option so the runner
after it classifies; a quoted or substituted directory never matches). But
`npm --prefix <dir> run verify` — the exact invocation loom's own root `package.json`
prints — is **still not classified**: the head starts with `npm --prefix`, which
matches neither a bare `npm run` head nor a test pattern. Under Claude Code its pass is
therefore untrusted (`untrusted-regression-pass`); under Pi it proves no test result at
all (`test-result-missing` — the Pi path has no regex fallback). Safe-side by design
(unclassified ⇒ untrusted or absent), and engine-run graphs sidestep it entirely
(§4.6); the agent-command path
still cannot mint trusted evidence from that spelling.

### 8.2 The evidence ledger sees only what command text names

A file written through `dd of=`, a `$VAR` destination, an interpreter
(`python -c 'open(…).write(…)'`), a generator, or a build step leaves **no** FileWrite.
Every judgment over the ledger inherits this: the self-author veto, pass demotion,
changed-files derivation, and I6. Red-then-green proves the logged history shows
test-first work — not that no code was written before the red run. Deliberate
trade-off (text-level observability, no FS watcher), honestly documented; the effect
is that the honest path is the cheap one, and cheating is a *deliberate unlogged
write* — visible in shell-write ledger records but not prevented.

### 8.3 The shell guard judges text, not an execution graph

Guards are reveal-monotonic and fail closed on the unparseable, but "parseable yet
wrong" remained the bug class of rounds 13–24 (indirection via `VAR=`; twin-scanner
divergence; double-quoted apostrophe; heredoc inline programs; alternate-form
parameter expansion). #219 extended the class with **command rebinding** —
`cat(){ rm "$1"; }; cat <state>`, `alias cat=rm`, `PATH=…`, `LD_PRELOAD=…` all rewrote
the State File through a guard that trusted the head's *name* — and its own review
round then found rebinders hidden in literal eval strings, behind backslashes, quotes,
assignment prefixes and case arms. The fix pattern held both times: the judgment moved
into the one module that already resolves what a command IS (`commandNamesRebound`
judging each segment as `analyzeCommandHead` does), the semantics moved from
"what the line mentions" to "what the line writes", and the old contract's tests were
restated for the new one. The epistemic status is unchanged and honest: the guard is as
good as its grammar, bash's grammar is bottomless, and new spellings will occasionally
require new rules — but the walker tests and the shared resolution are what keep the
fix count converging.

Two residuals added by #219 this section must carry verbatim, both
added by #219: the guard **cannot see a symlink** (a read redirected to an unguarded
name is allowed even if an earlier command made that name a link into guarded state —
making the link needs a command that names the state path, which the guard blocks, or
one no text guard can see), and a **working-directory walk** (`cd .claude; cd state; rm
*.json`) never names a guarded path, though the single-hop form is blocked and a read's
relative redirect target on a `cd` line is never trusted.

### 8.4 The pin boundary is the user account

Machine digest pins, Runtime Revision hashes, and Fugue integrity stamps are engine
**source files**. Code an agent gets executed indirectly (a Git hook, a package
script) could rewrite a machine and its pin **together**. Pinning converts silent
drift into a coordinated, auditable change of shipped code — a real improvement — but
only OS isolation (a read-only install root) closes it. Documented in
docs/architecture.md; no mechanism beyond documentation exists.

### 8.5 The parent session is trusted (security audit)

Every write and capture hook runs in the parent session, so an operator (or a fully
compromised parent) is outside the threat model. Against **subagents**, the authority
guard is a fence with known bypass classes: a subagent that evades the shell-string
guards can still write *files* (a transcript into a verification run, a ballot into
`verdicts.json`) — but it cannot produce an **attested capture**, so neither is ever
counted. The residual is exactly: "a subagent that evades every Bash guard and writes
a canonical attestation into the protected store by hand would be believed." The
guards are what stand between a subagent and that write; their strength is the
strength of §8.3's text-level grammar.

### 8.6 Report artifacts live in an agent-writable environment

Report files (JUnit/JSON) are written by the runner into the shared filesystem, with
documented same-call forgery residuals (a "test" script that prints runner-shaped
JSON, or one that stages a report during the judged call, can still vouch for itself).
The freshness window (call-start − 2s), the self-author veto, and exit-ownership narrow
the surface, and the sandbox receipt's nonce binds it to its artifact path but does not
authenticate the artifact against a hunter that writes the artifact itself. A security
ballot is bound to its issued verifier spawn, but the capture file of a run whose
subagent evades the shell-string guard stays writable (no attestation backs it, so
neither harness counts such a slot).

**Qualification (§4.6):** in a graph that froze engine-run test evidence, the engine
writes the report at the manifest's path and mints the TestRun from its own receipt, so
the agent-writable-report residual is closed at the root there; `agent-command` graphs
(and the pre-#201 history they represent) keep it.

### 8.7 Coverage is only as good as the seeded cells

The security audit's publication refusal guarantees *no unaccounted* coverage — not
*good* coverage. An attack class nobody seeded is unaudited and the report says so
only by omission from the table. Structural honesty, not a strength guarantee.

### 8.8 Attribution gaps in contended sessions

A tool call with no `agent_id` in a session with multiple active subagents is neither
recorded nor gated (sole-active stands down). Pi children run **without the live
phase gate** — Pi cannot name a tool call's caller — so their gating is via write
grants and evidence grants only. An implementation result without engine-minted
attempt authority settles nothing: every executing Task carries an attempt
(ADR-0098), so no Task is ever guessed from the executing set.

Narrowed since the first scan: a trusted failing run whose every failing file belongs
to another in-flight Task of the same Wave is now attributed to that owner instead of
failing the settling Task (ADR-0080, #210 — with per-file results and one passing test
outside them required); and dead roster entries (never-started, or aborted on an API
error) no longer stand attribution and quiescence checks forever (#211/#207). The
no-`agent_id`-under-contention stand-down itself is unchanged.

### 8.9 Small drift-prone surfaces

- **The repo's own vocabulary drifted from the code it describes**: `CONTEXT.md`'s
  Judged Path entry still ends "the fallback is a Forward Fix", while #217 (ADR-0086)
  deleted forward-fix.ts and made the fallback an added Task through a plan edit.
  The mechanism is retired; the ubiquitous-language file was not updated in the wave.
  (Found by this re-audit; closed since: CONTEXT.md's Judged Path entry now names the
  audited plan-edit fallback and lists Forward Fix as retired.)
- The template gate's `FALSE_POSITIVES` set is hand-maintained and has already
  drifted between checkouts once (the `{system}` incident; resolved in main — the set
  now contains it — but the mechanism remains a manual list).
- `parseLoomPackageRoot` admits `..`/`//` segments despite the normalized-path brand —
  harmless for its callers (package self-naming), but the brand overstates what the
  parse proves.
- Interactive RPC children support standard relayed dialogs but not `ctx.ui.custom()`.
- GitHub Actions reusable workflows need explicit `secrets: inherit` — operational
  gotcha, not a code defect.

### 8.10 Fixed-and-instructive history (rounds 13–24)

Worth keeping visible because the *fix pattern* is the lesson: every incident was
closed by giving one module sole ownership of a judgment and pinning it with tests —
not by patching the incident's spelling. Round-24 (`${x:+w}` fail-open) is now
encoded as the `alternate` form in `shell-normalize.ts` with the mirror semantics
documented and tested; round-20/21 (double-quoted apostrophe) died with the single
`scanSubstitutions` walker.

### 8.11 Resolved since earlier scans (for the record)

- `installedLoomPackageRoot`'s fail-at-import refusals (relative path, trailing
  separator, control character) **are now tested**
  (`engine/tests/utils/loom-package-root.test.ts`).
- The exclude-pattern list-parsing triplication **is consolidated**:
  `parseExcludePatternListOrThrow` serves both the regex-rule loader and the
  programmatic config.
- The state-file guard's **rebinding hole** is closed: one rule (`commandNamesRebound`)
  both guards apply, judged from the command each segment runs (#219).
- **Owner verification could never verify a JavaScript sibling** in an allowJs project
  (extension ladder tried only TypeScript) — fixed (#208).
- The phase gate's **prompt-regex fallback** (a general-purpose agent refused for what
  its brief happened to say) is replaced by identity-based placement (#223).
- The CLI **exiting before pipe output drained** (128 KiB of 1 MiB lost under a paused
  reader) — `exit-after-flush.ts` (#207).
- Read-only `git`/`gh` invocations mentioning state (e.g. `git log -- <state>`) are
  admitted instead of refused (#206).

---

## 9. Verification record of this scan

- Full unit suite executed at scan time via `npm run test:unit` (Vitest; result
  recorded in §10). Re-run at deb8c369 after the #201–#223 wave; verdict in §10.
- Delta pass (#201–#223): every PR's diff read — new module headers, commit
  messages, and the guard/wave/spec changes verified against
  `guard-state-file.ts`, `shell-command-head.ts`, `attestation-writes.ts`,
  `engine-revision-pin.ts` + `docs/reference/recovery.md`, `task-addition.ts`,
  `coupled-file-sets.ts`, `regression-attribution.ts`, `roster-liveness.ts`,
  `wave-review-carry.ts`, `spec-amendment.ts`, `engine-test-run.ts`,
  `test-evidence-policy.ts`, and ADR-0079–ADR-0089 titles.
- Delta pass (#224/#225): both PR diffs read — the new modules
  `advisory-disposition.ts` / `advisory-disposition-record.ts` /
  `advisory-disposition-shape.ts`, `review-subject.ts`,
  `retired-wave-review-runs.ts` and `wave-review-carry-audit.ts`, plus the changes
  to `wave-review-carry.ts` / `wave-review-carry-plan.ts`,
  `wave-review-issuance.ts`, `wave-review-authority.ts`,
  `wave-gate-registration.ts`, `wave-gate-program.ts`, `wave-gate-start.ts` and
  `state-file-wire.ts`, verified against ADR-0089 (as amended), ADR-0090 and
  ADR-0091; the `--fresh-review` flag checked in `commands/wave-gate.md`; the
  §4.7/§4.9/§5/Appendix A additions and the README's Wave Gate claims written
  from those sources. No new full-suite verdict was taken for 98a9852c; §10's
  standing verdict remains the deb8c369 run.
- Delta pass (#233/#234): both PR diffs read — the new modules `comment-lexer.ts`,
  `reopen-scope.ts`, `review-change.ts`, `review-narrowing.ts` and
  `wave-review-roles.ts`, the changes to `proof-obligations.ts`,
  `implementation-application.ts` / `implementation-brief.ts` /
  `implementation-completion.ts`, `findings.ts` / `findings-shape.ts`,
  `wave-review-authority.ts` / `wave-review-issuance.ts`, the wave-review-carry
  trio, `wave-gate-registration.ts` / `wave-gate-program.ts` /
  `wave-gate-membership.ts`, `wave-gate-start.ts`, `state-file-wire.ts` and
  `contract-revision.ts`, verified against ADR-0093 and ADR-0094 and their spec
  fragments (`.claude/plans/2026-11-18-213-cause3-test-only-reopen.md`,
  `.claude/plans/2026-11-18-213-cause5-rereview-scaling.md`); the §4.6/§4.9 additions, catalog
  rows 41–42 and Appendix A rows written from those sources. A fresh full-suite
  verdict was taken at a585eb27 for this update (§10).
- Code-verified claims: routing table + fail-closed polarity (cli.ts,
  handler-routes.ts); guard policy + helper list + walker map (guard-state-file.ts);
  walker one-owner structure (shell-*.ts headers); machine pins (machines/README +
  machine-pins.ts); ledger fact kinds + trust rules + attribution (machines/README,
  machine/*, evidence.ts); proof obligations, manifest freeze, mutation check,
  distill task (core modules); review identity/packet/generation/run machinery
  (findings.ts, review-packet.ts, wave-review-authority.ts, standalone-review.ts);
  panel kernel; LC-1 proofs; acceptance contracts + skeletons; owner verification;
  remediation; security-audit program + honest limits; StateManager + wire;
  RunDirHandle; journals/effects; context packets; model policy + Pi adapter; linter
  scoping + programmatic rules + ReDoS safety; test inventory and scripts.
- Claims marked *(docs)* rest on documentation current at a28b6d6a and, where the wave
  changed them, at deb8c369; the #224/#225 additions were checked at 98a9852c.

---

## 10. Standing suite verdict

**Latest — full unit suite executed 2026-11-18 at revision a585eb27 (main at the time of
this update, #233/#234 included; run from the docs worktree with both locks installed via
`bun install --frozen-lockfile`): 21,360 tests passed, 2 skipped, 0 failed, across 821
test files (8.6 min), smoke 23/23.** Run with the
`LOOM_PI_*`/`PI_*` ambient markers explicitly unset (see the gotcha below); exit code 0.

**Prior — deb8c369, 2026-11-18: 21,061 tests passed, 2 skipped, 0 failed, across 811 test
files (7.8 min).**

**Earlier — a28b6d6a, 2026-11-17: 20,132 tests across 775 files — 20,125 passed, 5 failed,
2 skipped.**

The 5 failures were proven environmental, not a code defect. They fall in exactly the
Pi-marker-sensitive paths (`tests/pi-extension-review-events.test.ts` ×2,
`tests/pi/rules-gate-registration.test.ts` ×2, `tests/pi/subagent-authority-gate.test.ts` ×1),
which assert that an unmarked headless process behaves as a *parent*. The scan session
itself ran inside a live Pi session whose ambient environment (`LOOM_PI_PARENT_PID`,
`LOOM_PI_PARENT_SESSION`, `LOOM_PI_EXTENSION_RUNTIME_REVISION`, `PI_SESSION_*`, …)
leaked into the spawned vitest process — npm's `env -u PI_CODING_AGENT` strips only the
one variable. Re-running the same 3 files with the `LOOM_PI_*`/`PI_*` ambient stripped:
**232/232 passed**.

Operational gotcha for this map's next re-scan: run loom's suite outside a live Pi
session, or with the `LOOM_PI_*` marker set explicitly unset.

Scope note: the a28b6d6a verdict's provenance is the scan session; the deb8c369 verdict is
that re-audit's; the a585eb27 verdict is this update's. The first two ran from the main
checkout; the a585eb27 run came from the docs worktree.

---

## Appendix A — `engine/src/core/` file-by-file (one-liners from source headers)

advisory-disposition.ts / advisory-disposition-record.ts / advisory-disposition-shape.ts — advisory dispositions on the TaskGraph, anchored to reviewed bytes (ADR-0090) ·
affected-stop-check.ts — Affected-test stop check's pure core (I7, AD-10) ·
affected-stop-check-types.ts — CT-2 types file: the surface of I7 ·
agent-catalog-projections.ts — every agent set, phase map, classification ·
agent-skills.ts — parse block- or flow-style skills from already-read agent markdown ·
agent-tools.ts — Agent tool declarations written once, in Claude Code's vocabulary ·
artifact-baseline.ts — persisted shape shared by file and directory artifacts ·
artifact-write-scope.ts — write policy for non-implementation loom-owned agents, one policy/two harnesses ·
audit-run-authority.ts — security-audit run directory entry names + who may write them ·
bash-code-mutation.ts — pure recognizer: Bash commands that mutate implementation-code files ·
comment-lexer.ts — the conservative C-family comment lexer behind a comment-only Change Class (ADR-0094) ·
block-direct-edits.ts — block Edit/Write/MultiEdit from the main agent during orchestration ·
capture-attestation.ts — persisted proof that a harness wrote a capture (ADR-0067) ·
changed-files.ts — the one derivation of a Task's changed files at stop (INV-7) ·
claude-record-kind.ts — the one classification of a Claude transcript record ·
claude-transcript-integrity.ts — anti-corruption boundary for Claude JSONL transcripts ·
claude-transcript-projection.ts — everything the engine reads out of one transcript ·
cli-flag-token.ts — the value-is-a-flag rule every engine CLI grammar shares ·
compiler-diagnostic-policy.ts — what compiler diagnostics mean to the gate ·
completion-suite.ts — pure completion-suite kernel (frozen checks, digest, receipts) ·
context-packet-projection.ts — read-model projection of a packet's sections (expected identity supplied by delivery) ·
context-packets.ts — immutable, byte-aware context packets ·
contract-revision.ts — the one operator path that changes a frozen contract ·
contract-status.ts/-types.ts — CT-1 status view of contracts in a TaskGraph ·
contract-surface-section.ts — contract-surface lens of a Contract Task's wave review (ADR-0069) ·
decompose-payload.ts — the agent-authored JSON populate-task-graph reads ·
defect-family-accounting.ts — pure defect-family accounting kernel ·
digest.ts — SHA-256 over bytes as the branded ArtifactDigest ·
dispatch-holds.ts — the one hold rule shared by status, registration, and the brief ·
distill-pass-setting.ts — the operator's distill-pass switch (ADR-0068) ·
distill-snapshot.ts — the bytes a Distill Task attempt's scope froze ·
distill-task.ts — the one engine-added Task a Wave carries (ADR-0068) ·
emission-ingestion/observation/tool.ts — the emission vocabulary and frozen registry ·
engine-runtime-paths.ts — repository paths the engine writes while an attempt is live ·
exact-data.ts — exact own-data snapshots of untrusted JSON-shaped values ·
family-sites.ts — the family-site metric (counting raw second sites) ·
findings.ts/findings-shape.ts — Finding identity (agent, ordinal) and shape ·
frozen.ts — genuinely immutable collection singletons ·
git-sha.ts — exact lowercase Git object id grammar for SHA-1 and SHA-256 repositories ·
grandfathered-spawn-model.ts — grandfathered spawn-model authorization ·
guarded-locations.ts — the guarded directories as one domain value ·
guard-state-file.ts — the deny-by-default state-path Bash policy ·
harness-capture/-resources/-tool-call.ts — capture rules, resource rendering, tool-call adapters ·
i6-restore-scope.ts — which files the I6 repair may restore on retry ·
implementation-* (application/binding/brief/completion/evidence/lifecycle/retry/window) — the attempt lifecycle: binding, briefs, completion aggregate, evidence precedence, retry admission, window policy ·
invariant-id.ts — the branded Invariant id (INV-3) ·
issued-emission-capability.ts — the emission capability contract ·
judged-paths.ts — decompose-time rule: a judge never runs after its subject's Wave ·
ledger-epoch-view.ts — one epoch's facts rendered for I6 ·
lint-coverage-ignore.ts — the user's silenced-repository list ·
lint-runtime-skew.ts — did the full-tier lint judge the current bytes ·
loom-cli-command.ts — every command/path the engine prints that names itself ·
loom-status.ts — the canonical status read model ·
machine-integrity.ts/machine-pins.ts — ADR-0076 digest pins (generated) ·
model-calibration.ts — pure deterministic calibration scoring ·
model-profiles.ts/model-routing.ts — loom-owned model policy and Pi routing ·
orchestration-completion.ts — finish conditions for a finished TaskGraph ·
ordering.ts — deterministic ordering primitives ·
owner-check-authority.ts — the owner check's authority, named by suite + gate ·
panel-* (authority/contract/kernel/program/verdict-source) — the panel machinery ·
parse-plan-models.ts/parse-spec.ts — executable-model and spec parsers ·
path-coverage.ts — the one "is this path inside that scope" rule ·
persistent-panel*.ts — the durable, re-proved refutation panel program ·
phase-* (artifact-paths/policy/phases) — phase vocabulary and policy constants ·
pi-agent-directory/-config-value/-spawn-input/-write-grant-plan.ts — Pi-side resolution and parsing ·
plain-record.ts — the shared exact-parse kernel for untrusted JSON ·
plan-design-review.ts — ADR-0070 record + gate decision ·
plan-path-match.ts/plan-paths.ts — plan-declared path roles and matching ·
predecessor-archive/-output.ts — retained predecessor records ·
proof-boundary-observation.ts — compact record of TaskGraph proof state ·
proof-obligations.ts — what a Task must discharge to become implemented ·
project-command-environment.ts — the environment one project command runs under, as the harness set it ·
provider-key.ts — which key Pi would send to a custom provider ·
read-only-git.ts — which git invocations write nothing outside .git ·
red-then-green*.ts — the I6 judge and its surface ·
refutation-verifiers.ts — refutation panel verifier authority ·
remediation-machine.ts — scope authority, exclusions, audit/stage/install lifecycle ·
reopen-scope.ts — the Reopen Scope: what a Task Reopening says the Finding needs (ADR-0093) ·
report-file-attribution.ts/report-run-root.ts — reported↔declared attribution; report root reading ·
repository-path.ts — host-native path → canonical repo-relative ·
requirement-coverage.ts — spec index × task claims join ·
retired-wave-review-runs.ts — retired Wave review runs as protected provenance (ADR-0091) ·
review-* (authority-receipt/change/ed-workspace/emission-route/narrowing/output/packet/panel/protocol/retry) — review authority machinery; change classification and the Review Basis (ADR-0094) ·
review-subject.ts — the Subject Digest of a Wave review and its seal on an acceptance (ADR-0091) ·
reviewer-contract.ts — reviewer wire definitions only: no issuance, Findings behavior, or shell authority ·
rules-gate.ts — the shared rules-gate decision core ·
route-reachability.ts — the fail-closed gate before a Pi parent spawns children on a route ·
run-inspection.ts — what a run's own files say about it ·
runtime-baseline-restore.ts — restoration rules for implementation settlement ·
safe-io-cause.ts — bounded diagnostic classification: never echo paths, messages, stacks or arbitrary thrown data ·
scope-classification.ts — standalone-review scope policy ·
security-* (adjudication/audit-contract/audit-start/coverage/disposition/findings/lenses/lens-select/reports/sandbox/verification) — the audit program's pure machinery ·
served-model.ts — which model a provider serves right now, decided from what the shell observed ·
served-model-cause.ts — why a `served` routing target's model is unknown, as one closed union ·
set-phase.ts — the `set-phase` loop-back: an operator moves `current_phase` back, optionally dropping one artifact ·
sibling-entry-point.ts — the one plan shape the plan model and the owner-verification core share, in a dependency-free leaf ·
spawn-admission.ts — the pure decision that accepts or blocks one Pi subagent spawn batch before any state mutation ·
spawn-emission-gate.ts — the façade's emission gate: the verdict on a Pi parent's spawn batch ·
spawn-request-authority.ts — an emitted spawn batch's request authorities, parsed once as the stored-request parser admits them ·
spawn-task-text.ts — engine-issued spawn task text: authority markers, packet path, Skill marker, emission descriptor, delivery bootstrap; `parseIssuedTaskIdentity`, the one reader of the two authority markers for both harnesses (ADR-0099) ·
spec-check.ts/spec-trace*.ts — requirement trace and its amendment/migration ·
standalone-* (19 modules) — the standalone review program: kinds, scope, rosters, read coverage, attempt admission, transcripts, records, lineage, disposition, refutation, successor, checkpoint ·
stop-check-*.ts — the stop-check planner and note surface ·
structured-test-report.ts — one test file as its structured report lists it ·
subagent-authority.ts — which Bash a subagent may not run (ADR-0067 D6) ·
task-* (artifact-expectation/attribution/dependencies/graph-population/id/implementation-dispatch/mutation-check/reopening/revalidation) — task lifecycle machinery ·
test-evidence.ts/test-file-classification.ts — evidence precedence; the one test-file classifier (INV-2) ·
tool-vocabulary.ts — tool and test-runner vocabulary (TEST_COMMAND_PATTERNS, FILE_MODIFYING_TOOLS, SUBAGENT_SPAWN_TOOLS) ·
type-diagnostics.ts — compiler-in-the-loop advisory diagnostics ·
unified-diff.ts — deterministic line-based diff ·
user-decision.ts — the decision input `decide` reads ·
validate-* (phase-order/task-execution/template-substitution) — the spawn-gate cores ·
verification-* (manifest, manifest-install, policy, verified-claim-hashes) — manifest freeze and waivers; hash re-anchoring ·
test-evidence-{mode,policy,authority}.ts / engine-test-run.ts — the frozen test-evidence mode (#198), the engine-run receipt and its admission (#201) ·
verify-slice.ts — which part of `npm run verify` one invocation runs ·
wave-* (20 modules) — the Wave Gate: model, machine (LC-1), checks, membership, registration/replacement, preparation, completion-suite readiness, frozen source, review authority/issuance/roles, carry, transcripts, status facts ·
wire-contract.ts — the Wire Contract's stamping seam ·
skeleton/* (17 modules) — generation, resolution, conformance, records, refresh, status; pure TS/Java surfaces ·
shell-* (9 modules) — the shared bash grammar (see §4.4) ·
owner-verification/* (21 modules) — obligations, coverage, import graph, per-language readers (Java syntax and reach), mutation plan, outcome, verdict, integrity ·
acceptance-contract/* (12 modules) — model, tasks, binding, gate, freeze, wire, stop checks ·
orchestration-contract/* (12 modules) — the shared kernel: identity, rosters, artifacts, effects, publication, actions

**Added between a28b6d6a and deb8c369** (read from their own source headers, not the
original sweep):

attestation-writes.ts — attestation enforced, not instructed (ADR-0085) ·
coupled-file-sets.ts — manifest+lockfile belong to one Task (ADR-0082) ·
engine-owned-paths.ts — every engine path class in one place (#204) ·
engine-revision-pin.ts — the TaskGraph's engine-revision pin and adoption (#205) ·
option-words.ts — shared option-word reading for the read-only classifiers ·
read-only-filters.ts / read-only-gh.ts — audited read-only classifiers for sort/uniq/find and gh (#206) ·
regression-attribution.ts — sibling in-flight test failures attributed to their owner (ADR-0080) ·
retro-facts/-record/-status/-triggers.ts — friction facts, audit, report, triggers (ADR-0083) ·
roster-liveness.ts — never-started/aborted roster entries judged from transcripts (#211) ·
runner-presets.ts — known runners as affectedRunner presets (#202) ·
spec-amendment.ts / spec-rejudgement.ts — audited spec amendment and claim re-judgement (ADR-0087) ·
task-addition.ts — add/withdraw a Task through an audited plan edit (ADR-0086) ·
task-dependency-edit.ts / task-rescope.ts / task-scope-rules.ts — the audited active-Wave mutation cores (ADR-0081/#202/#203) ·
wave-plan-edit.ts — the wave_plan_edits audit ·
wave-review-carry.ts / wave-review-carry-plan.ts / wave-review-carry-audit.ts — restart and succession carry of accepted reviewer slots (ADR-0089, ADR-0091)

## Appendix B — other engine directories (file-by-file)

**handlers/** — implementation-binding, lint-coverage-shell, pi-adapter (pure post-edit
lint + advisory type functions), task-execution, type-diagnostics-{edit,runner,run-slot};
**pre-tool-use/** — the ten gates of §4.2–4.4 plus payload parse (`pre-tool-use-input`),
brief-marker expansion, spawn vetoes, transcript events, subagent-authority operations;
**post-tool-use/** — lint-file, record-evidence, record-orchestration-spawn,
surface-stop-check-notes, type-diagnostics;
**subagent-stop/** — dispatch, capture-orchestration-result, advance-phase,
update-task-status, store-reviewer-findings, store-spec-check-findings, stop-checks
(one shell, both checks), acceptance-stop-check (shared I/O), cleanup-subagent-flag;
**session-start/** — cleanup-stale-subagents, lint-coverage, resume-after-clear;
**subagent-start/** — mark-subagent-active (binding + machine + attempt, four jobs).

**machine/** — advance (pure reducer), evidence (identity brands, attribution,
SessionRegistry port), extract-evidence (pure; PACKAGE_RUN_HEADS and
NPX_PREFIX_OPTION live here), harness-tool-call-types, ledger
(shell), tool-evidence-recorder (the one minting shell), report-discovery,
session-registry (adapter), test-report (trust judgment), parse-machine, mermaid,
task-graph-pointer, types.

**parsers/** — parse-transcript, parse-bash-test-output, parse-files-modified
(Claude Code JSONL only; a Pi session file reads as harness records and attributes
nothing), parse-phase-artifacts, parse-subagent-{start,stop,lifecycle}-input.

**orchestration/** — run-directory-handle (2.2k, anchored handle), program-journal,
effect-runner, harness-capture-runtime, capture-attestation-store,
protected-entry-store, security-audit-run-registry, owner-verification-runner,
mutation-run-steps, owner-mutation-workspace, task-mutation-{record,runner},
skeleton-{materialization,observation,refresh,revision,writer},
frozen-{path,surface}-observation, artifact-probe, spec-index-observation,
context/stored-context-packets, standalone-{panel-context,read-coverage-evidence},
completion-check-runner, git-remediation, claude-run-authority,
claude-transcript-file, distill-snapshot (git adapter), implementation-brief (shell),
repository-leaf, session-run-bindings, wave-spec-check-documents,
contract-{conformance-observation,stub-materialization}, remediation-candidate.

**linter/** — exclude-pattern, executor, formatter, index, lint-coverage, loader,
markdown, positive-int, project-{root,scope,walk}, rule-sources, safety (ReDoS),
source-segments, starter-config, types; **programmatic/** — baseline{,-config},
config, exhaustive-discriminant-branching, fugue-generated-integrity,
max-function-lines, no-cross-boundary-imports, no-dangling-doc-reference,
no-duplicate-block, no-io-in-pure-modules, no-nested-ternary, no-wire-cast,
prefer-array-methods, switch-totality.

**utils/** — no-follow-fs (anchored fs primitives, lowest shell layer), lock, path-presence
(ENOENT-only absence), git* (command scope, execution policy, leaves, probe, spawn
outcome), declared-artifact-snapshot, repository-change-baseline,
workspace-digest, agent-definition, agent-transcript-path, child-launch-route,
claude-config-dir, emission-environment, find-file, frontmatter, hook-diagnostic,
loom-package-root, model-routing-context, persisted-output, pi-auth-store,
read-settled-jsonl, read-transcript-with-retry, render-pi-agent, route-endpoint,
secret-json-file, served-model-probe, strip-namespace, describe-cause, extract-task-id,
file-absence, runtime-baseline-restore.

**handlers/helpers/** — the façades: orchestration (status/brief/inspect/start/resume/
restart/… plus the audited mutations add-task, withdraw-task, add-dependency,
rescope-task, adopt-engine-revision, adopt-engine-run-tests), programs/ (37
per-program drivers), security-audit, populate-task-graph, wave-gate-observers,
complete-orchestration, accept-plan-design-review, mutation-check,
store-*-findings, validate-task-graph, write-verification-manifest, run-tests,
amend-spec, suggest-affected-runner, retro-facts, record-retro,
task-addition-operations, and the rest of the whitelisted-helper surface
(handlers/ also gained attestation-mode.ts for the enforced-attestation read).

## Appendix C — `pi/` module-by-module

extension.ts (registration shell, 718 ln); spawn machinery (spawn-{claims,
claim-shell, graph, lifecycle, preparation, reservation}, reserved-{slot,results},
subagent-{process,result,result-batch,result-route,settlement,stop}); emission
machinery (emission-{tool,readiness,readiness-gate,readiness-protocol,
readiness-sequence,launch-bridge}, interactive-{rpc,subagent}); capability machinery
(write-grant, child-write-grant, cleanup-actions, session-shutdown); evidence
(evidence-recorder — child → parent ledger under its grant's epoch); review machinery
(review-capture, review-run-authority, trusted-review-witness); adapters
(implementation-brief-expansion, rules-gate — twin of the Claude hook over one core,
lint-coverage — twin over one shell, ask-user-question, resources, session-model-env,
tool-input, transcript-adapter — the one Pi transcript projection: messages →
`HarnessToolCall`s paired with results through core/harness-tool-call's Pi vocabulary,
folded into write targets and structured test evidence; no regex fallback).
