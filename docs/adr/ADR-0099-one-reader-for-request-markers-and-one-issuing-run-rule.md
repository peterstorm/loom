# ADR-0099: One reader for request markers and one issuing-run rule

## Status
Accepted (2026-11-20). Amends ADR-0017: the task identity its expected-capability decision reads is now
the one identity every harness reads.

## Context
Every engine-issued spawn task carries two authority markers, `LOOM_REQUEST_ID` and `LOOM_CONTEXT_DIGEST`,
written by one function (`renderSpawnTaskText`). They locate the issued request; they are never authority
on their own. Three readers disagreed about what the same task text meant:

- Claude's spawn correlator and SubagentStop (`claude-run-authority.ts`) matched `LOOM_REQUEST_ID` with a
  whitespace-tolerant regex, ignored `LOOM_CONTEXT_DIGEST` entirely, and refused an identical repeat. A
  malformed marker line did not match, so the prompt read as unrelated work and passed through.
- Pi's spawn and result paths (`pi/review-run-authority.ts`) used the same regex for both markers,
  required exactly one of each, and never parsed either value.
- The issued emission capability (ADR-0017) read line by line, accepted identical repeats, refused
  conflicting ones and parsed each value with its branded parser.

The rule that picks the run a marker belongs to ("the explicit `LOOM_ORCHESTRATION_*` run, both variables
or neither, else exactly one session binding issued the request") was also written twice. The two copies
differed: Pi matched the context digest as well, Claude only the request id. Request ids are not unique
across runs (a legacy panel request id is caller-chosen; a security verifier's derives from finding
fingerprints), so the digest is what separates two bound runs issuing the same id. The Claude path could
neither tell them apart nor refuse a prompt naming the right request under the wrong context.

## Options Considered

1. **Keep the per-harness readers and align them by review.**
   - Pros: No interface change.
   - Cons: Three parsers of one grammar is how they drifted. Nothing stops a fourth (the grandfathered
     model rescue was one, reading only `LOOM_REQUEST_ID` and taking its first match).

2. **One parser and one resolver, the stricter repeat rule (exactly one line per marker).**
   - Pros: Smallest accepted language.
   - Cons: An identical repeat names one identity, so refusing it buys no authority and makes a harmless
     re-render or echo a hook error. No caller relied on it.

3. **One parser beside the writer and one pure resolver, identical repeats accepted (chosen).**
   - Pros: The writer and the reader share one module and one line grammar, so a round-trip property pins
     them together. Both harnesses resolve the run by the same request id and digest.
   - Cons: The Claude path refuses prompts it used to accept (see Consequences).

## Decision
**`parseIssuedTaskIdentity` in `engine/src/core/spawn-task-text.ts` is the only reader of the authority
markers, and `resolveIssuingRun` in `engine/src/orchestration/session-run-bindings.ts` is the only rule
for the run that issued them.**

- `parseIssuedTaskIdentity(taskText)` returns `unbound` (no line claims either marker), `malformed` (a
  claim exists but the pair is incomplete, contradictory or not canonical) or `bound` with a branded
  `RequestId` and `ContextDigest`. A claim is any line starting `MARKER:`; it must be exactly `MARKER:
  value` with a whitespace-free value. Identical repeats stay bound; two different values are
  contradictory, and the reader never picks one. Each value goes through `parseRequestId` /
  `parseContextDigest`.
- `explicitRun(environment, harness)` decides the explicit run: both variables or neither, half is a
  fault. `resolveIssuingRun(explicit, reads, identities, harness)` returns the explicit run unchanged when
  set; otherwise exactly one session binding must list every request id and its run must have issued each
  one under the exact digest named. None or several fail closed. It is pure over two lazy reads (the
  session's bindings and a run's issued identities), so the shells supply only I/O.
- Claude's correlator write (`recordClaudeSpawnCorrelator`) refuses an issued request whose digest differs
  from the prompt's, so an explicit run, which resolution does not open, is held to the same identity.
- Every reader crosses this seam: Claude's PostToolUse correlator and SubagentStop, Pi's spawn admission,
  correlator, result path and review witness, the issued emission capability and the grandfathered model
  rescue. The project lint rule `.claude/linter/rules/inv-11-one-request-marker-parser.json` refuses a
  module outside `spawn-task-text.ts` that spells either marker in code.

## Consequences

**Positive:**
- One prompt means one identity on both harnesses; the round-trip with `renderSpawnTaskText` is a
  property test.
- Claude Code now binds a spawn to its request and its Context Packet, and separates two bound runs that
  issued one request id, as Pi already did.
- A malformed marker line is refused on every path instead of reading as unrelated work on Claude.

**Negative:**
- A Claude prompt carrying `LOOM_REQUEST_ID` without `LOOM_CONTEXT_DIGEST`, a non-canonical value, or a
  marker line with extra whitespace is now a hook error. Every engine-issued prompt is rendered by
  `renderSpawnTaskText`, which has written both markers since they were introduced, so only a hand-edited
  prompt hits it.
- Pi now accepts an identical repeated marker line it used to refuse, and refuses a non-canonical value it
  used to compare as a raw string.
- The grandfathered model rescue needs both markers; with only `LOOM_REQUEST_ID` it keeps its block.
