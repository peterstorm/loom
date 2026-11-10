# ADR-0066: Security audit is a registered program, not a skill-side workflow

## Status

Accepted (2026-11-07). Plan: `.dotfiles/docs/plans/2026-11-07-loom-security-audit-program.md`.
Upstream taxonomy vendored from `cloudflare/security-audit-skill@c1c8a8c` (MIT), see
`references/security-lenses/ATTRIBUTION.md`.

## Context

A whole-repository vulnerability sweep is not a diff review and not a task-graph phase. It
must:

- enumerate coverage deterministically (surface × boundary × attack class × subsystem) so no
  unit is silently unassigned, and so a later run can resume rather than restart;
- separate the agent that hunts from the agent that judges, on a different model profile;
- refuse to call something confirmed without a bounded observed result, while still recording
  source-grounded leads that only a deployment fact could settle;
- bound spend in counted agent invocations, with reserves for coverage critics and validation
  computed before hunting;
- never let a hunter edit the target source to make its own reproduction pass;
- publish records and prose that cannot disagree with each other.

Cloudflare's `security-audit-skill` specifies all of this in ~2,300 lines of prompt prose and
zero executable checks. Loom already implements every routing, isolation, evidence, and
publication guarantee involved — but has no vulnerability verdict vocabulary, no coverage
ledger state machine, no sandbox, and no bounded-execution evidence event.

## Options Considered

1. **Vendor the skill wholesale as `skills/security-audit/` (orchestration in prose).**
   - Pros: fastest; upstream prose already encodes hard-won epistemics.
   - Cons: duplicates scope derivation, roster selection, retries, aggregation, publication,
     and budget accounting that the engine owns. Two sources of routing truth diverge on the
     first schema change. Its verbatim-prompt-assembly rule is specified but unenforced, so a
     paraphrasing orchestrator weakens the audit with no validator catching it.

2. **Register a new program beside Standalone Review, reusing the reviewer wire contract.**
   - Pros: one routing authority; independence, write isolation, retries, and immutable run
     directories are already proven; findings shape is close enough to carry vulnerability
     records; the taxonomy drops in as reference data.
   - Cons: the vulnerability trichotomy, coverage ledger, and sandbox must become real code.

3. **A fourth producer kind with its own frozen emission schema for security findings.**
   - Pros: strict-sampling for the trichotomy on the wire.
   - Cons: touches `agent-catalog-projections`, `core/emission-tool`, wire stamps, probes and
     route qualification (~2 days) for a guarantee reviewer payload v2 already provides.

## Decision

Option 2. `security-audit` is a registered program (P5 of the plan), with four
non-negotiables. (The D-numbers follow the originating plan's decision list; D1
and D4 are plan decisions this ADR does not restate.)

- **D2 — Reuse reviewer payload v2 for hunter candidates.** *Superseded in part by the amendment
  below — the hunter submits its own `security-hunter-result` document; the Finding vocabulary
  and the deferred fourth producer kind stand.* A Loom Finding already carries
  preconditions, violated contract, consequence and evidence limits. The vulnerability
  trichotomy lives in the coverage ledger and the published `security-findings.json`, never on
  the wire. A fourth producer kind is deferred until a real sampling failure demands it.
  *Amended 2026-11-09:* the hunter's submit envelope no longer borrows the reviewer label.
  It used to travel as `{schemaVersion: 2, kind: "standalone-review", units, findings}`, which
  falsely claimed conformance to `reviewer-payload-schema` — the payload was never valid
  against it, since it carries unit settlements and upstream report records rather than
  reviewer Findings. It is now its own document, `{schemaVersion: 1, kind:
  "security-hunter-result", units, findings?}`, parsed strictly by `parseHunterResult`
  (`core/security-coverage`); `submit` refuses the old envelope by its kind. This is a wire
  label, not a fourth producer kind: no emission schema, wire stamp or route qualification
  changes, so the deferral above stands.
- **D3 — Severity stays loom's ballot.** Adjudication remains `critical | advisory` with no
  downgrade authority (`references/review-lenses.md`). Upstream's five-level
  `overall_severity` is a recorded, refutable field. Invariant: overall severity never exceeds
  demonstrated impact.
  *Amended 2026-11-09 by ADR-0067 (the verification step only):* a ballot is no longer read
  from `verify`'s stdin with a self-reported `agent`/`profile`. It is the captured answer of a
  `security-verifier-agent` spawn issued by the `security-verification` facade program, its
  identity bound from the minted request; `verify --from <verification-run>` imports a
  finished run's bound ballots, and subagents are fenced off from every writing audit and
  orchestration operation. The `critical | advisory` ballot and its adjudication are unchanged.
- **D5 — The taxonomy is vendored byte-identically.** `references/security-lenses/` keeps
  upstream filenames (uppercase) so intra-taxonomy links stay valid and re-vendoring is a
  plain copy. `MANIFEST.json` pins each file's SHA-256; a test fails on unexplained drift.
  Loom-specific guidance lives in `LOOM-DELTAS.md`, never inside a vendored file.
- **D6 — One accounting kernel.** Coverage units are declared into
  `core/defect-family-accounting`, not a parallel proof path. The security ledger schedules
  and settles units; it never becomes a second authority on evidence.

New pure cores: `security-audit-contract` (grammar, limits, budget admission),
`security-coverage` (ledger state machine), `security-findings` (trichotomy, consolidation),
`security-reports` (derived prose), `security-sandbox` (limits policy), `security-lens-select`
(stack → the lenses the run's profile cap admits; *amended 2026-11-09*, was a fixed
"2–3 lenses" — the cap is the profile's, see `docs/security-audit.md`). New machine evidence kind `SandboxRun` so
a bounded local check is a fact, not a claim.

## Consequences

- Hunters become structurally unable to edit source: the agent machine denies `Edit`/`Write`/
  `MultiEdit` for the whole phase order.
  *Amended 2026-11-09:* "structurally unable" overstated it. Tool-level edits are denied; a
  shell write (a Bash redirect) is detected and recorded as a shell write, not prevented.
  Inside the sandbox the target and the operator's home are read-only.
- A run that exhausts budget is unrepresentable as clean coverage: it ends `incomplete` with a
  reason token, or every planned unit has a terminal state.
- The published prose is derived from validated records by code, so a divergent `REPORT.md`
  fails a test rather than misleading a reader.
- Rejected claims persist across runs; a later run must not re-report one without changed
  evidence.
- The sandbox is a real script (`unshare -Urmn`), not a promise; where its controls cannot be
  enforced, the claim degrades to `needs_validation` with the missing capability named.
- Upstream's orchestration prose is intentionally absent. Anything a reader needs about
  routing belongs in `docs/architecture.md`, not in a skill file.
