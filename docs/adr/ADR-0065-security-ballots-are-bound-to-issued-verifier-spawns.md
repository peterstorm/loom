# ADR-0065: Security ballots are bound to issued verifier spawns

## Status

Proposed (2026-11-09). Supersedes the "ballot attribution is self-reported" limit recorded in
`docs/security-audit.md` (Honest limits) and deferred as cores `architecture-tech-lead-4` in
review campaign 3 (`run.rf3-cores-policy`). Amends ADR-0064 D2/D3, the verification step only.

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
- **Residual, stated in the docs:** the parent session is trusted (it runs every write); D6 is a
  shell-string fence with known bypass classes, so on Claude Code a determined subagent that
  evades it could still write a capture file; on Pi the trusted witness (extended to this program,
  see below) closes that by refusing any slot it did not witness in-process.
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
6. **Docs:** D7, the agent docs (verifier JSON block is test-bound), and ADR-0064's D2/D3 note.
