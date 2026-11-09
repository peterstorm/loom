---
description: "Run a coverage-accounted, evidence-backed security audit over a repository"
argument-hint: "[--out ../audit-run-1] [--repo .] [--profile quick|standard|deep] [--budget N] [--resume <run-dir>]"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Write", "Edit", "Task", "Agent"]
---

# Security Audit — Registered Program, Not a Prompt

**Arguments:** "$ARGUMENTS"

Read `${CLAUDE_PLUGIN_ROOT}/skills/security-audit/SKILL.md` completely and run
the audit through the registered `security-audit` program. Do not reproduce or
improvise a second workflow from this command file: the program owns routing,
validation and persistence, and its run directory is the only record of what was
covered.

In particular:

- `start` first — it freezes the source revision, enumerates the coverage units,
  and selects the lenses. Read the selected lens files (in
  `references/security-lenses/`) before spawning a hunter; they carry the
  per-class attack mechanics and are the only part of the run that must not be
  re-derived.
- one hunter, one coverage unit, one boundary. `assign` it with `--agent
  security-hunter-agent` (a catalog agent), spawn `loom:security-hunter-agent`
  with the owner id `assign` printed, and `submit` its bytes — the hunter
  settles under exactly that owner id, in its own `security-hunter-result`
  envelope. A hunter's confirmed claim must carry a sandbox receipt bound to its
  artifact: run `loom helper security-audit nonce --out <run-dir> --artifact
  agents/<owner-id>/artifacts/<file>` (the line `assign` printed) and put its
  output in the brief — a hunter cannot compute the nonce itself. Without a
  receipt the claim is a lead, not a finding.
- keep `--out` **outside** the audited repository: the sandbox refuses a
  scratch inside its target, and `nonce` refuses to bind a run it would refuse.
- verify through an **issued** verification run, never stdin ballots
  (ADR-0065). Once the wave's hunt has settled (no hunter in flight, critic
  merged), run `status`: it prints the exact `loom helper orchestration start
  security-verification --runs-root <run-dir>/verification-runs --run …`
  command. Run it, spawn each `loom:security-verifier-agent` request it issues
  with its task verbatim, `resume` the run until it is `done`, then `loom
  helper security-audit verify --out <run-dir> --from <verification-run>`.
  Each ballot's profile is the minted request's (`refutation`), so a hunter
  cannot cast one; a run issued before the ledger or findings moved is refused
  as stale, and `status` names its replacement (also when a run blocked or
  cannot be imported: the next generation). Only native capture fills a
  verifier slot — `orchestration submit`/`correlate` refuse one — and every
  ballot must match the capture attestation its harness wrote; `--out`
  absolute on Pi.
- **only this parent session runs audit operations.** Hunters and verifiers are
  subagents: the subagent authority guard refuses them every writing `helper
  security-audit`/`helper orchestration` operation and every write onto the
  run's authority files. They return their result as their final message, and
  you record it (`submit` the hunter's envelope; the verifier's answer is
  captured by the harness).
- drive `merge-critic` when the coverage critic proposes units, and `defer`
  every unit the budget could not reach **with a reason**. A deferred unit is a
  disclosed gap; a silent one is a coverage claim the run cannot support.
- `status` before stopping. `runStatus` `incomplete` means the run reported what
  it covered and disclosed what it did not — report that, never "no critical
  findings".

**An audit never patches.** `publish` writes `security-findings.json` and the
report; `disposition` derives one decision per published record into
`disposition.json` and prints the `standalone-disposition` command that consumes
it. Hand confirmed findings to `/review-and-fix` from there.

## Operations

Every operation takes `--out <run-dir>`; the run directory is the whole record.
This is a summary; the authoritative table, with every refusal, is in
`docs/security-audit.md` (Operations).

| Operation | Input | What it does |
|-----------|-------|--------------|
| `start` | stdin | Freeze the revision, enumerate units, select lenses, write run metadata |
| `assign` | flags | Give a planned unit to a catalog agent; prints the owner id the hunter settles under and the `nonce` command for it |
| `nonce` | flags | Print the sandbox nonce and filled-in bounded-run instructions for one artifact of a unit in flight (read-only) |
| `submit` | stdin | Record a hunter's `security-hunter-result` against its unit; a re-filed fingerprint with different content is refused |
| `merge-critic` | stdin | Fold the critic's proposed units in, deduped by canonical coverage id |
| `verify` | flags | Import a finished `security-verification` run's bound ballots (`--from <verification-run>`; `status` prints the start command) that decide `confirmed`/`needs_validation`/`rejected` at `findings` and `publish` |
| `defer` | flags | Mark an unreachable unit with one of the four reason tokens |
| `findings` | flags | Render the report from the validated records (read-only) |
| `publish` | flags | Emit `security-findings.json`; refuses on any publication blocker |
| `disposition` | flags | Derive the decision set `/review-and-fix` consumes |
| `status` | flags | Is the ledger settled? (read-only) |

`status`, `findings` and `nonce` stay available while the Pi runtime is skewed —
they write nothing, and are what you read *while* recovering. Every other
operation proves the runtime first.
