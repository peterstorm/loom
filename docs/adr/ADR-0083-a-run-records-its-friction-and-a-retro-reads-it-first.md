# ADR-0083: A run records its friction, and a retro reads it first

## Status
Accepted (2026-11-17). Implements loom#200.

## Context
Two orchestration runs produced their retrospectives by hand, after the fact (loom#198, loom#199). In both,
several pull requests fixed correct but local symptoms of one shared cause before anyone stepped back, and one
of them (#197) was a patch that the root fix later replaced. Everything those retros needed was already in the
State File: attempt receipts with their failure kinds, escalations and remediations, reopenings, Forward Fixes,
plan edits, retired Wave Gate runs, Finding counts. Nothing surfaced it while the run was going.

A retrospective at every Wave Gate would surface it, but a run has five to seven Waves. That is five to seven
model-driven retros over thin evidence, each interrupting the run.

## Options Considered

1. **Engine-derived friction, a cheap digest every Wave, a suggested retro on friction, an enforced retro at the
   end (chosen).**
   - Pros: the engine computes the facts deterministically, so none is missed and none costs a model call. A
     retro runs only when a Wave crossed a threshold, while the friction is fresh, and once at the end.
   - Cons: the thresholds are judgement; a Wave below them gets no suggestion, only its digest.
2. **A full retro after every Wave.**
   - Cons: cost and interruption grow with the number of Waves, and most Waves have nothing to learn from.
3. **A retro only at the end.**
   - Cons: the end is too late. loom#199's deadlock built up over three Waves of patches.

## Decision
- `core/retro-facts.ts` derives `RetroFacts` from a parsed TaskGraph, live or archived: per Wave a friction
  digest (gate runs, reopenings, Forward Fixes and withdrawals, plan edits, spec-trace amendments, retry,
  escalation, remediation and infrastructure counts, Finding counts), the Tasks with friction and their failure
  kinds, and run-level engine-revision adoptions. It is pure and reads only protected state.
- `core/retro-triggers.ts` judges each Wave's digest: an escalation, a second Wave Gate run (abandoned
  runs count, as the audits that retired them name them), a plan change (plan edit, Forward Fix or its
  withdrawal, completed-Wave reopening), Task reopenings beyond the one that acting on a Finding takes, or the
  engine moved under the run. Each Wave that crosses one gets a suggestion to run `/retro --wave <N>`. A
  suggestion never blocks.
- The status document carries a `retro` report beside the skeleton report: every started Wave's digest, and
  suggestions for the active Wave and the Wave that completed last; older Waves are the end-of-run retro's.
  `/wave-gate` relays the completed Wave's digest with its receipt. The canonical facts and next action are
  unchanged, except that after the final Wave status names `retro-required` until the run's retro is recorded.
- `helper retro-facts [--wave <N>]` prints the facts for the live graph, or for an archived one with
  `--graph <path>`.
- A retro is recorded on the TaskGraph (`retro_records`) by `helper record-retro`: a Markdown file under
  the .claude/retros directory, scoped to one Wave or the whole run and bound to the sha256 of its bytes, or a whole-run
  skip with the operator's reason. `judgeOrchestrationCompletion` refuses until a whole-run record exists, so
  `complete-orchestration` enforces the end-of-run retro.
- `/retro` (`skills/retro/SKILL.md`) reads the facts first and the transcript only for the why. Every finding
  carries evidence, its class, a prevention test (a fix that fails it is labelled a patch and names the root fix
  it defers to) and a fix tier: engine invariant or type, then deterministic check, then reviewed standard, then
  navigation pointer. Project findings become project changes; Loom findings extend or open Loom issues. Outside
  a Loom run it reviews the session and its environment the same way, without the engine facts.

## Consequences
- Every Wave ends with a deterministic friction signal, and a model-driven retro runs only where there is
  friction to explain.
- A retro starts from facts with ids, so its findings cite evidence rather than memory.
- Run-directory facts (Review Run retries, stop checks that did not decide) are not in the State File; the retro
  skill reads them from the run directories. Folding them into `retro-facts` is a later extension.
