# ADR-0005: Program façade drivers stay per-program; no shared driver framework

## Status
Accepted

## Context

A deepen session (2026-08-17, branch `feat/architecture-panel-mode-plan`)
proposed extracting the orchestration façades' drive lifecycle — recover
durable requests → publish batch → issue retries → capture → reduce →
publish result — into one `ProgramDriver` module parameterized by a pure
per-program policy. The motivating friction was real on the surface:
`programs/wave-gate.ts` (~1,800 lines), `programs/standalone.ts` (~600), and
`programs/remediation.ts` (~160) each contain a long drive function, and
"how does a retry get issued" is answered slightly differently in each.

Reading the three façades in full falsified the premise in two ways.

First, the shared lifecycle already lives in deep modules with real seams:
`fugue-program-runtime` owns durable persistence (journal → checkpoint) for
every program; `core/panel-program` owns the persistent refutation-panel
sub-lifecycle and is consumed by BOTH standalone review and the wave gate;
and `programs/helpers` owns spawn-request publication, durable request
recovery, retry task rendering (`renderSpawnTask`), and the publication
resolver. The per-program files were already reduced to one driver each by
the A14 volume split.

Second, what remains in each drive function is program-essential policy, not
a restated sequence. The wave gate's epoch authority checks, per-task Review
Packets, spec-check slot, and advisory await-user stage have no counterpart
in standalone review; remediation is not a spawn-lifecycle program at all —
it is a git staging/verification/installation pipeline with no agents. A
`ProgramDriver` interface covering all three would be a configuration-taking
framework whose interface is as complex as the implementations it hides:
the definition of a shallow module. Its "policy" adapters would not be three
implementations of one concept; they would be three unrelated programs
squeezed through one signature, and every future divergence would grow the
signature.

## Decision

The drive functions remain per-program. Shared mechanics continue to be
extracted DOWNWARD into the existing deep modules (`fugue-program-runtime`,
`core/panel-program`, `programs/helpers`) when — and only when — two programs
need the same computation, as `renderSpawnTask` and `durableRequests` were.
No horizontal driver/framework layer is introduced above them.

## Consequences

- Adding a program means writing its drive function in full, reusing the
  helper modules directly. This is deliberate: the sequence IS the program.
- Anyone re-proposing a driver framework should first identify a computation
  two drive functions restate, and extract that computation into `helpers`
  instead — the same test this ADR's proposal failed.
- The wave-gate driver's length is accepted as essential; its named step
  functions (`waveRequests`, `deriveWaveAttemptTwo`, `installWaveReviewRuns`,
  …) are the unit-test surface, not a driver seam.
