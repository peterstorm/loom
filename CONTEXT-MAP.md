# Context Map

[CONTEXT.md](./CONTEXT.md) is the core vocabulary and is always loaded. Load a context file below only when the work is in its area. A term is defined in exactly one file.

## Contexts

- [Review](./docs/contexts/review/CONTEXT.md) — reviewer protocol, Wave review rosters, panels and programs, standalone lineage, remediation. Load for work on reviewers, the Wave Gate's review, `/review-pr` or either panel.
- [Implementation proof](./docs/contexts/implementation-proof/CONTEXT.md) — attempts, receipts, verification, test-first proof, stop checks, the distill pass, reopening. Load for work on Task dispatch, completion or proof.
- [Acceptance contracts](./docs/contexts/acceptance-contracts/CONTEXT.md) — executable models, Contract Tasks, export bindings, the freeze and its revision. Load for work on `CT-N` contracts, skeletons or lifecycle machines.
- [Owner verification](./docs/contexts/owner-verification/CONTEXT.md) — invariant owners, sibling entry points, matrix tests, lint tiers. Load for work on `INV-N` invariants or the linter.
- [Requirements trace](./docs/contexts/requirements-trace/CONTEXT.md) — completion claims, contributions, content hashes, spec-check. Load for work on the spec parser, decompose's trace or spec-check.
- [Harness](./docs/contexts/harness/CONTEXT.md) — Agent Catalog, model profiles, spawning, Pi write grants and bookkeeping, emission, guards. Load for work under `pi/`, on hooks or on emission.

## Relationships

- **Requirements trace → Implementation proof**: a Task's claims decide which Requirements its Wave's spec-check answers for
- **Acceptance contracts → Implementation proof**: a contract's frozen tests are its claimants' regression authority
- **Owner verification, Acceptance contracts → Review**: an owned invariant or a contract's types file adds a reviewer and a packet section
- **Implementation proof → Review**: a settled implementation yields the Task's Review Packet
- **Harness → every context**: it spawns each Agent, grants its writes and mints its evidence
