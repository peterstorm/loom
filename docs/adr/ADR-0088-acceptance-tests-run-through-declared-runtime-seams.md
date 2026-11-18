# ADR-0088: Acceptance tests run through declared runtime seams

## Status
Accepted (2026-11-18). Implements loom#199, Cause 5.

## Context
In the fugue-dags host-memory run, a DAG change put a symbol-keyed value in the output one node hands to the next.
It passed every unit test, review, Wave Gate and the memory benchmark, and then failed every request on the real
host. The host checkpoints each node output with its checkpoint encoder (encodeNodeCheckpoint), and nothing in the run ran the DAG under
the host. The memory benchmark also measured a checkpoint path that production does not take for that route, so
the memory budget was judged on the wrong path. Nothing in plan alignment, decompose, the contract or spec-check
asked which runtime seams the route passes through in production, or whether an acceptance test goes through them.

## Options Considered

1. **Declared seams with a static check (chosen).** A contract names the production symbols its requests pass
   through. The engine refuses the contract's freeze unless every acceptance file references each one. Plan
   alignment asks for seams per route, and spec-check flags a harness that bypasses them.
   - Pros: cheap, mechanical, and it catches the fugue-dags shape. The DAG test never named the host's encoder.
   - Cons: a test can reference a seam without exercising it. Spec-check's reading of the test is the second
     line.
2. **A required production harness per contract.**
   - Cons: every project must build and name such a harness before its first contract.
3. **Prompts only.**
   - Cons: enforcement by instruction is what failed for attestation (loom#199 Cause 6, ADR-0085), where agents
     told to change nothing edited anyway.

## Decision
- A contract may declare `**Runtime seams:**`, one ``- `symbol` (source)`` line each (`parse-plan-models.ts`).
  The declaration refuses a malformed line and a repeated symbol.
- The contract persists them as `runtimeSeams`, omitted when none were declared. The State File parser refuses an
  empty list, a non-identifier symbol, a blank source, a repeated symbol and an extra key.
- At the contract Wave's Acceptance Freeze, `stampAcceptanceFreezes` refuses the freeze while an acceptance file
  does not reference a declared seam as a whole identifier (`runtimeSeamGaps`). The refusal names each file and
  seam. Comments and string literals do not count as a reference. To read the text, the frozen-path observation
  carries the decoded bytes beside their digest.
- Plan alignment reports `SEAM-N` gaps: a route the production runtime wraps whose contract declares no seams, or
  an acceptance test or benchmark that drives the code around them.
- Spec-check reads a seamed contract's acceptance tests and benchmarks, and reports a harness whose path differs
  from the declared production path as HIGH.

## Consequences
- A contract that declares seams cannot freeze acceptance tests that never touch them.
- A contract without seams freezes as before. The plan-alignment check is what asks for them.
- A test that names a seam without exercising it still passes the engine check. Spec-check is the judgement
  layer for that.
