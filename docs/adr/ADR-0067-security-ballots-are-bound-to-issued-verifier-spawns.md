# ADR-0067: Security ballots are bound to issued verifier spawns

## Status

Accepted (2026-11-09). Supersedes the "ballot attribution is self-reported" limit recorded in
`docs/security-audit.md` (Honest limits) and deferred as cores `architecture-tech-lead-4` in
review campaign 3 (`run.rf3-cores-policy`). Amends ADR-0066 D2/D3, the verification step only.

## Context

INV-S3 says a `confirmed` claim is published only on a ballot cast from a catalog profile that
did not hunt. Today that rests on two self-reported strings:

- `loom helper security-audit verify --out <run>` reads `security-verdict` records from stdin
  (`runVerify`, `engine/src/handlers/helpers/security-audit.ts`), and `parseVerificationVerdicts`
  (`engine/src/core/security-adjudication.ts`) checks only that `profile` equals
  `catalogProfileOfAgent(agent)`.
- Whoever runs the CLI chooses `agent`. A hunter has Bash (`agents/security-hunter-agent.md`),
  so it can file a ballot on its own claim labelled `security-verifier-agent` / `refutation`, and
  adjudication counts it as independent.

The engine already proves "this output came from a spawn of role R answering request X" for the
review programs (ADR-0004, ADR-0005, ADR-0009):

- `mintAgentRequestAuthority` (`core/orchestration-contract/roster.ts`) fixes `role`,
  `modelProfile` and `harnessBinding` from the Agent Catalog at minting; the caller supplies only
  identity fields.
- Claude Code: `validate-agent-model` checks the spawned model against that binding;
  `recordClaudeSpawnCorrelation` (PostToolUse) and `resolveClaudeStopRun` (SubagentStop) bind the
  harness's own `agent_id` / `subagent_type` and the located transcript to the issued request,
  refusing a role mismatch (`claude-run-authority.ts`).
- Pi: `recordPiSpawnCorrelators` binds `toolCallId`/agent to the request, and the in-process
  trusted review witness (`pi/trusted-review-witness.ts`) refuses any captured slot it did not
  itself witness.
- `bindCapture` (`core/harness-capture.ts`) never trusts `requestId`/`attempt` from the agent.

Two gaps keep that proof from holding against a shell-capable subagent:

1. **CLI write paths.** `helper orchestration submit` and `correlate` write bytes or correlators
   into any reserved slot for any caller (`handlers/helpers/orchestration.ts`). They exist for
   harnesses without native capture, and they are reachable from a subagent's Bash.
2. **Run-directory files.** Correlators, transcripts and the security run's own documents
   (`verdicts.json`, `ledger.json`, `findings.json`, `run.json`) are ordinary files a subagent can
   overwrite; `guard-state-file` protects only `subagentDir()` and the machines directory.

The security audit is also the one review-shaped program that is NOT a facade program: it has no
issued requests, so verifier spawns carry no `LOOM_REQUEST_ID` and their stops pass through.

## Options Considered

### Option A: Verification as a registered facade program (chosen, with B)

Add a `security-verification` facade program that issues one `security-verifier-agent` request
per verification brief, captures each verifier's output through the existing native capture
path, and publishes a canonical, digest-bound ballot set. `verify` imports that published result;
stdin ballots are removed.

- Reuses issuance, minting, capture, retry (attempt 2), read coverage, the Pi witness and the
  journal unchanged — the same machinery the Refutation Panel already depends on.
- A ballot's `agent` and `profile` stop being payload fields: they are read from the minted
  request authority, so a ballot cannot carry a role or profile its spawn did not have.
- Alone it still leaves gap 1 and 2: a subagent could `orchestration submit` into a verifier slot.

### Option B: Subagent write gate (chosen, with A)

A PreToolUse gate (Claude Code `Bash`, Pi `tool_call` for `bash`) that refuses, **inside a
subagent**, every command that mutates audit or program authority: `helper security-audit` write
operations, `helper orchestration submit|correlate|decide|start|resume|abandon`, and writes or
redirections onto a registered audit run's authority paths.

- The signal is harness-supplied, not self-reported: Claude Code sets `agent_id` on PreToolUse
  only for calls originating in a subagent (`types.ts`), and SubagentStart already writes the
  active roster (`readActiveAgentRoles`) into the protected `subagentDir()`. Pi's extension sees
  the calling agent on `tool_call`.
- Subagents never need these operations: hunters call only `nonce` (read-only) and the sandbox
  script; verifiers return JSON and call nothing.
- Shell-string matching has the bypass classes `guard-state-file` already documents (eval,
  constructed command names). It is a fence, not a proof — which is why it backs A, not replaces it.

### Option C: Sign ballots with an engine-held key (rejected)

A MAC over each ballot with a key the CLI holds. Rejected: the CLI runs as the same user as the
subagent's shell, so any key the CLI can read the subagent can read. It would add a primitive that
proves nothing beyond who can run the CLI.

### Option D: Keep stdin ballots, record the caller (rejected)

Stamp the invoking agent (from the roster) onto each stdin ballot. Rejected: a CLI process cannot
tell who invoked it (no per-agent environment marker exists), and the parent legitimately pipes
ballots on the agent's behalf — the stamp would always say "parent".

### Option E: Status quo, documented limit (rejected)

INV-S3 is the audit's central claim; "holds against an honest orchestrator" is not the claim the
report prints.

## Decision

**D1 — `security-verification` is a facade program.** `ORCHESTRATION_PROGRAMS`,
`parseFacadeRegistration`, `START_PROGRAMS` and capture routing gain one kind. Start input:

```json
{ "schemaVersion": 1, "audit": { "locator": "<abs audit run dir>", "runId": "<audit runId>",
  "ledgerDigest": "<sha256>", "findingsDigest": "<sha256>" }, "wave": 1 }
```

The program authenticates the audit run (same shape as the disposition handoff's `source`),
derives the verification briefs from `findings.json` (every `confirmed` candidate not yet carrying
a bound ballot, grouped into briefs of at most N fingerprints, deterministic order), and issues one
request per brief: `role: "security-verifier-agent"`, `program: "security-verification"`, slot
`security-verification-slot:<sha256(runId, wave, fingerprints)[:32]>`. Profile and harness binding
come from minting, so every request is `refutation`. Its run directory is
`<audit>/verification-runs/run.verify-w<wave>`, outside the target by the same rule as `--out`.

**D2 — Ballot wire without identity.** The verifier returns
`{ "schemaVersion": 1, "kind": "security-verification-result", "verdicts": [...] }` where each
verdict is `{fingerprint, vote, reason, missingFact}` — no `agent`, `profile` or `wave`. Admission
(per slot, like refutation verdicts) refuses a verdict for a fingerprint outside its brief, a
missing fingerprint, or a duplicate; malformed output gets the standard single retry.

**D3 — Bound ballots.** On `done`, the program publishes `result.json` holding, per admitted
verdict, the D2 fields plus a binding taken from authority only:

```ts
type BallotBinding = Readonly<{
  program: "security-verification"; runId: string; requestId: string; slotId: string;
  attempt: 1 | 2; role: "security-verifier-agent"; profile: LlmProfileId;   // from the minted request
  captureDigest: string;                                                     // CaptureReceipt.digest
}>;
```

`VerificationVerdict` becomes `{fingerprint, vote, reason, missingFact, wave, binding}`; `agent`
and `profile` are derived from `binding`, never parsed from a payload.

**D4 — `verify` imports, never ingests.** `helper security-audit verify --out <audit> --from
<verification-run>` reads the verification run's published `result.json`, authenticates it the
way remediation authenticates its source (program kind, run id, result digest, audit locator and
the ledger/findings digests it was issued against — a run issued against older findings is
refused), and appends its bound ballots to `verdicts.json`. Stdin ballots are refused. Because the
audit ships with this ADR, there is no unbound-ballot read path to migrate.

**D5 — Adjudication reads bindings.** `adjudicateCandidates` counts a ballot as independent only
if `binding.profile` is not a hunting profile; `huntingProfiles` is unchanged. A `verdicts.json`
entry without a well-formed binding is a parse refusal, not an unverified gap.

**D6 — Subagent write gate.** New PreToolUse handler `guard-subagent-authority` (Claude Code
`Bash`, Pi `tool_call` bash), active only when the harness identifies the caller as a subagent:

- refuses `helper security-audit {start,assign,submit,defer,merge-critic,verify,publish,disposition}`
  and `helper orchestration {start,resume,submit,correlate,decide,abandon}`;
- allows `helper security-audit {nonce,status,findings}`, `scripts/security-sandbox.sh`, and
  everything else;
- refuses writes/redirections onto a **registered** audit run's authority files
  (`run.json`, `ledger.json`, `findings.json`, `verdicts.json`, `security-findings.json`,
  `disposition.json`, `verification-runs/**`), while `agents/<owner>/{scratch,artifacts}/**` stay
  writable. `start` registers the run directory in `subagentDir()` (protected), so the guard knows
  which directories are audit runs without trusting the command line.

The refusal names the rule and tells the agent to return its result to the parent instead.

**D7 — Docs.** `docs/security-audit.md` replaces the "self-reported" limit with the residual
limit in Consequences; the verifier agent doc drops `agent`/`profile`/`wave` from its JSON block;
the skill's running section shows `start security-verification` → spawn → `verify --from`.

## Consequences

- INV-S3 holds against a mislabelled ballot and against a hunter filing ballots: a ballot exists
  only as a harness-captured output of a `security-verifier-agent` spawn on the `refutation`
  profile, and the commands that could inject one are fenced off from subagents.
- **Residual, stated in the docs (amended):** the parent session is trusted (it runs every write
  and every capture hook). D6 is defence in depth with known bypass classes: a subagent that
  evades it can still write FILES — a transcript into a verification run, a ballot into
  `verdicts.json` — but it cannot produce an ATTESTED capture, and nothing unattested is ever
  imported or counted, on either harness. The attestations live in the protected `subagentDir()`
  (refused to Bash/helper writes by `guard-state-file`, to file tools by `block-direct-edits`, to
  subagents by D6; exclusive publish, never replaced, read fail-closed). The store's own residual
  is the fence's: a subagent that evades every Bash guard and writes a canonical attestation for a
  forged transcript by hand would be believed.
- The Pi trusted review witness, which today verifies only `standalone-review`, is generalised to
  `security-verification` (same capture event shape).
- Verification costs no extra invocations: the same verifier spawns, now issued. Retries consume
  the existing per-slot budget (attempt 2), matching the Refutation Panel.
- One more facade program to keep in step with ADR-0005's driver contract; it reuses the
  refutation driver's admission/retry shape, which is its main maintenance cost.
- `verify`'s wire changes; the hunter and critic wires are untouched.

## Implementation plan

1. **Core (pure):** `core/security-verification.ts` — brief derivation, slot identity, the D2
   parser, admission per brief, the D3 `BallotBinding` and result builder. `security-adjudication`
   switches `VerificationVerdict` to D3 and reads `binding.profile`. Property tests: no verdict
   outside its brief is admitted; every admitted ballot's profile equals its minted request's;
   brief derivation is deterministic and covers every unbound confirmed candidate exactly once.
2. **Facade program:** registration, start-input parser, driver (issue → capture → admit → retry →
   publish), modelled on `wave-refutation.ts`; `capture-orchestration-result` and Pi
   `review-run-authority` route the new program; extend the trusted witness.
3. **Shell:** `verify --from` (authenticate + import), remove stdin ballots; `start` registers the
   run in `subagentDir()`.
4. **Guard (D6):** `handlers/pre-tool-use/guard-subagent-authority.ts` + Pi `tool_call` twin, wired
   in `hooks/hooks.json`; table-driven tests for allowed/refused commands, subagent vs parent
   caller, registered vs unregistered run paths, and the documented bypass classes as known gaps.
5. **End to end:** the handler test drives hunt → `start security-verification` → native capture
   fixture (`tests/fixtures/standalone-native-capture.ts` pattern) → `verify --from` → publish;
   plus refusal tests: stdin ballots, stale findings digest, a hunter-role capture into a verifier
   slot, a subagent `verify`.
6. **Docs:** D7, the agent docs (verifier JSON block is test-bound), and ADR-0066's D2/D3 note.

## Implementation notes

Steps 1, 2, 3 and 5 landed in `core/security-verification.ts` (pure),
`handlers/helpers/programs/security-verification.ts` (driver),
`handlers/helpers/security-audit-run.ts` (the audit read seam shared by the CLI and the
program) and `handlers/helpers/security-audit.ts` (`verify --from`, `status`, `start`).
Step 4 landed in `core/subagent-authority.ts` (pure decision),
`handlers/pre-tool-use/guard-subagent-authority.ts` (Claude Code) and
`pi/subagent-authority-gate.ts` (Pi, with the parent's witness check below); step 6 in
`docs/security-audit.md`, the skill, the command and the agent docs.
Where the code forced a choice the ADR left open, or a deviation, it is recorded here.

- **Eligibility and briefs.** A candidate is eligible when it is `confirmed` in
  `findings.json` and no ballot in `verdicts.json` names its fingerprint (any wave).
  Eligible fingerprints are sorted and cut into consecutive briefs of at most
  `MAX_BRIEF_FINGERPRINTS = 4`: small enough that a verifier reads every trace, a quarter
  of the spawns one-per-claim would need, and a malformed answer retries only its own
  brief. The briefs are frozen in the registration at `start`; resume never re-derives
  them from a `verdicts.json` that may have moved.
- **Run name (deviation).** The run directory is
  `<audit>/verification-runs/run.verify-w<wave>-<id>`, not `run.verify-w<wave>`: `<id>` is
  the first 12 hex of the SHA-256 of the brief slot ids (which bind audit run, wave and
  fingerprints). A program registration is immutable, so a fixed per-wave name would make
  a run refused as stale — or a second claim set in the same wave — permanently block its
  replacement. The program refuses any name other than the derived one, and any runs root
  other than the audit's own `verification-runs/`. `start` creates that runs root
  (`orchestration start` never creates one).
- **Start command.** No new operation: `status` (and `status --json`, field
  `verification`) prints the exact `helper orchestration start security-verification
  --runs-root … --run …` command with its D1 input on a here-document, and the follow-up
  `verify --from`. The operation table is unchanged except `verify`'s input trait, which is
  now `flags`; a stdin payload is refused with a pointer to the new flow.
- **Result authentication (stronger than a digest).** `verify --from` does not take a
  caller-supplied digest. It (1) requires the run to be a registered
  `security-verification` program under this audit's `verification-runs/`, (2) applies the
  pure import rule — result describes the registration (run id, registration digest,
  audit, wave), the audit's current locator/run id/ledger/findings digests equal the
  issued ones, the ballots cover exactly the registered fingerprints, and a re-import is
  idempotent while a partial one is refused — and (3) replays the run's outcome from its
  captured evidence and requires `result.json` to be byte-identical to that replay. A
  hand-edited `result.json` is refused even when it is internally consistent.
- **Driver shape.** The program keeps no checkpoint: every drive recomputes each slot's
  decision (`decideVerificationSlot`) from the durable batch receipt, captures and capture
  rejections, so `verify --from` replays exactly what the driver decided. A refused
  attempt 1 gets one attempt-2 retry, published through the Refutation Panel's
  `recoverOrPublishRefutationRetry` and told the admission diagnostic; a refused attempt 2
  blocks the run with the new `security-verification-blocked` diagnostic. A run whose
  audit moved blocks rather than spawning. Slots already on record are read back as
  history (ADR-0023), never re-minted.
- **Ballot shape.** `verdicts.json` holds exactly the D3 shape
  (`fingerprint, vote, reason, missingFact, wave, binding`); `binding.profile` must be a
  catalog profile, `binding.role` `security-verifier-agent`, `binding.program`
  `security-verification`, and one request may cast at most one ballot per fingerprint.
- **Capture routing.** Claude needs no new branch: the request-bound SubagentStop path is
  generic once the registration parses, and the existing correlator role check refuses a
  hunter-role spawn answering a verifier request. Pi classifies a verifier request as
  `security-verification-extraction` (the archived no-schema claim: no emission tool,
  final-message extraction) in `authenticatePiIssuedReviewRequest`, which spawn admission
  and capture share. `orchestration submit` into a verification run resumes the program
  (the parent path for harnesses without native capture; D6 fences it from subagents).
- **Pi witness.** `createTrustedReviewWitnesses` gains `verifySecurityVerification`,
  which proves a named run from the session's in-process witnesses (every captured slot
  witnessed with identical authority and bytes, `result.json` equal to the witnessed
  replay). `verify --from` is a separate CLI process and cannot consult it, and the
  review-authority bridge is an in-process publication for harness consumers, not a CLI
  check — so the Pi `tool_call` chain calls it: `piParentVerifyWitnessDecision`
  (`pi/subagent-authority-gate.ts`, wired in `pi/extension.ts` beside the D6 gate) reads
  every `helper security-audit verify` invocation in a PARENT bash call with the guard's
  own command walker (`securityAuditVerifyInvocations`, `core/subagent-authority.ts`: the
  same heredoc/substitution/`bash -c`/`eval`/`xargs` traversal and helper recognition),
  reads `--out`/`--from` with the CLI's own `argumentValue`, places the run with the
  CLI's own `parseRunDirectoryReference(verificationRunsRoot(out), from)`, and blocks the
  call when the witness refuses (an unwitnessed slot, a slot of another session, an
  altered `result.json`). An invocation whose arguments the shell completes at runtime, a
  relative `--out`, or a relative `--from` path is blocked rather than guessed (the
  `status`-printed command is absolute). Claude Code is unaffected; its residual stays the
  D6 fence. Residual on Pi: the witness lives in the extension process, so a session that
  restarts between the captures and the import cannot prove that run, and since the run
  name derives from its briefs, `status` names the same run until the ledger or findings
  change.
- **Registration (amended).** Every WRITING `helper security-audit` operation registers
  the audit run with the subagent write guard's registry (`registerSecurityAuditRun`):
  `start` after its fresh documents land (as before), every other writer BEFORE it writes
  (`refreshRunRegistration`, `handlers/helpers/security-audit.ts`). Registration is
  idempotent, so a registry wiped mid-audit (the subagent dir under `/tmp` cleaned) is
  rebuilt by the next write, and an operation whose run cannot be registered fails without
  writing. A read-only projection registers nothing.
- **D6 operation split (amended).** D6 lists specific operations; the implementation
  derives the split instead, from each helper's operation table
  (`handlers/pre-tool-use/subagent-authority-operations.ts`): an operation whose
  `runtimeSkew` trait is `available` is a read-only projection a subagent may run; every
  other operation writes run state and is refused, as is an operation name the guard
  cannot resolve statically. A new operation is classified by the trait it must declare,
  never by a copied list. At this writing the split is — `security-audit` allowed:
  `findings`, `nonce`, `status`; refused: `assign`, `defer`, `disposition`,
  `merge-critic`, `publish`, `start`, `submit`, `verify`. `orchestration` allowed:
  `brief`, `inspect`, `status`; refused: `abandon`, `attest`, `complete`, `correlate`,
  `decide`, `recover-orphan`, `remediate`, `reopen-task`, `restart`, `resume`, `start`,
  `submit`. This is a superset of D6's lists (it also refuses `attest`, `complete`,
  `recover-orphan`, `remediate`, `reopen-task`, `restart`).
- **Authority entries (amended).** The run directory's entry names have one owner,
  `core/audit-run-authority.ts`, imported by the CLI, its read seam, the disposition
  handoff and the guard. The protected set is every run document plus both facade runs
  roots the audit names: D6's list, the lens selection, the derived prose and
  `standalone-disposition.json`, `verification-runs/`, and `disposition-runs/` (the
  `standalone-disposition` runs root the handoff command names — a forged remediation run
  is forged authority too). A test drives a whole audit through the CLI and checks the
  guard refuses a write onto every entry it left.

### Implementation notes (amended — second review round)

The adversarial review of the first implementation found that its security rested on
shell-string matching. This round moves the proof onto the DATA path; the D6 fence stays as
defence in depth. Where a bullet below contradicts one above, this one wins.

- **A — no CLI write into a verifier slot.** `helper orchestration submit` and `correlate`
  refuse every request whose program is `security-verification` (`verifierSlotRefusal`,
  `handlers/helpers/orchestration.ts`): verifier output is captured natively only. The
  "`orchestration submit` into a verification run resumes the program" note above is withdrawn.
- **B — persisted capture attestation (the authority on both harnesses).** The native capture
  pipeline (`persistBoundCapture` → `attestCapture`, `orchestration/harness-capture-runtime.ts`),
  which both Claude Code's SubagentStop capture and Pi's request-bound capture run, writes —
  write-ahead, before the transcript lands — one attestation per verifier attempt
  `{program, runId, runDirectory (realpath), requestId, slotId, attempt, role, harness, nativeId,
  digest, byteLength}` into `<subagentDir>/security-capture-attestations/`
  (`orchestration/capture-attestation-store.ts`; record, canonical bytes, entry name and the
  `ballotsAttested` decision pure in `core/capture-attestation.ts`). Entries are exclusive
  publishes, idempotent for identical bytes and never replaced; the store is in `protectedDirs()`
  and in `PERSISTENT_SUBAGENT_DIR_ENTRIES`; a malformed, renamed or non-canonical entry is
  refused (fail closed). `BallotBinding.captureDigest` is D3's `CaptureReceipt.digest`, and must
  equal the attested digest. `verify --from` (`proveVerificationSource`,
  `handlers/helpers/security-verification-proofs.ts`) requires `result.json` to equal the evidence
  replay AND every ballot to match its attestation — no attestation is refused as "not natively
  captured". `verdicts.json` is a cache: `findings`, `status` and `publish` re-prove every run a
  cached ballot names (`proveCachedBallots` → pure `admitCachedBallots`,
  `core/security-verification.ts`): a registered security-verification run of this audit (locator
  and run id), whose evidence replays — bound to the audit's identity only (`AuditBinding
  "issued"`), so later waves moving the ledger do not unprove earlier ballots — to a result holding
  exactly the cached ballots, each attested. A failing run contributes no ballot and one named
  publication blocker. The Pi in-process witness gate is now secondary: it is consulted first and,
  when it cannot prove the run, the gate falls back to the same persisted proof — closing the Pi
  restart gap recorded above.
- **C — registry spellings.** A run is registered under both `resolve(out)` as spelled and its
  realpath; the guard expands every registered directory with its realpath and judges every
  literal path also in its canonical spelling — the realpath of its deepest existing ancestor
  (`canonicalizeDeepestAncestor`, through the core's `SubagentFilesystemView` port). A symlink to a
  run created on the same line with a runtime-built target stays a gap.
- **D — registry during verification.** `start` and `resume` of the `security-verification`
  program register (refresh) the audit run before driving, refusing when it cannot be registered.
- **E — run name and generations.** The start input gains `generation` (1..16). A brief's slot id
  binds the audit run id, both audit digests, the wave and the generation, so no two
  verification runs share a slot or request id (a harness resolves a spawn to its run by request
  id); the run name is `run.verify-w<wave>-g<generation>-<id>`, the id hashing the slot ids, the
  first 8 hex of the ledger and findings digests, and the generation. `status` names the first
  generation whose run is absent or live (in flight, or complete and importable); a blocked,
  malformed or unimportable run (a capture without attestation) is dead and the next generation
  is named. This supersedes the "Run name (deviation)" note above.
- **F — fence normalisations (`core/subagent-authority.ts`, `core/shell-command-head.ts`).**
  Command words are unescaped (`\loom`); `time` is a wrapper beside `command`, `builtin`,
  `nice`, `nohup`, `timeout`, `stdbuf`, `setsid` (already wrappers); `coproc` and `!` are syntax;
  `find -exec` runs its command. A shell (`sh|bash|zsh|dash|ksh|…`) fed a program through a pipe,
  a here-string, an input redirect, a script file argument, `source`/`.`, or an executed script
  (`#!` shell or `.sh`) has that program judged — files read at decision time through the port
  (bounded, regular files only); an unreadable script refuses only a line that concerns
  authority; a script FILE is judged on the paths it names literally (its runtime words and
  `case` patterns are plumbing, so `scripts/security-sandbox.sh` stays allowed). Interpreter code
  (`python* -c`, `node -e/-p`, `bun -e/-p`, `perl -e`, `ruby -e`, awk programs, and code fed by a
  pipe or here-string) is refused when it invokes a writing helper operation, a CLI hook route, or
  imports an engine authority module. A subagent may not invoke a Loom CLI hook route
  (`HARNESS_HOOK_ROUTES`, derived from `KNOWN_HANDLERS`) nor launch a nested harness (`claude`,
  `pi`, `npx|bunx|pnpm dlx` of either). `securityAuditVerifyInvocations` walks the same forms; an
  invocation found in fed text is unresolved (the shell reads it after the gate). Remaining gaps,
  pinned as allowed: runtime-built command or helper names, a variable holding a whole path,
  runtime-built interpreter code, names in `printf` escapes, a runtime-built script then run, a
  same-line symlink with a runtime-built target, and an interpreter's own script file.
- **G — Pi subagent detection.** `pi/subagent-process.ts` decides from an explicit environment
  marker, never launch flags: every Loom Pi session publishes `LOOM_PI_PARENT_PID` (+
  `LOOM_PI_PARENT_SESSION`) into its own environment at load and session start, which every
  process it launches inherits (the installed json-mode launcher copies `process.env`); the
  extension's own `--mode rpc` child (`pi/interactive-subagent.ts`) is spawned with
  `LOOM_PI_SUBAGENT=1` explicitly. A process is a subagent when it carries `LOOM_PI_SUBAGENT=1`
  or a parent pid that is not its own; a subagent never re-marks itself a parent. The rules gate
  uses the same marker — semantics change: a headless parent (`pi --mode json -p --no-session`
  without the marker) is now GATED (the old inference exempted it); `LOOM_GATE_MODES` still
  overrides.
- **H — lows.** One fingerprint, one verification run: an import whose fingerprint already
  carries another run's ballot is refused, and a cache holding such a pair is a blocker (two
  finished generations of one claim set must not let the second outvote the first). Every path
  in a printed command (`status`'s start and import commands, `renderVerificationStart`, the
  disposition handoff, `assign`'s nonce line) is one `quoteShellArgument` word. The registry cap
  (4096) counts live runs only: the registrar prunes entries whose directory is gone once at the
  cap, and the reader fails closed only while live entries still exceed it.
