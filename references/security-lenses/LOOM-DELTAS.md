# Loom deltas — guidance the vendored lenses must not carry

The other lens files in this directory are byte-identical to upstream and pinned
by `MANIFEST.json` (ADR-0064 D5). Anything Loom needs a hunter to know that
upstream does not say goes **here**, never into a vendored file. Keep it short:
each entry names the fact and the code that owns it, so this file never becomes a
second authority.

## Owner ids

`assign --agent` names a catalog agent; the ledger mints the owner id the hunter
settles under — the bare catalog name for a unit's first attempt,
`<agent>--<n>` (`security-hunter-agent--2`) after a critic reassignment. The
hunter's `agentId`, every check's `agent_id`, and its scratch and artifact paths
(`agents/<owner-id>/...`) use exactly that id. Owner: `engine/src/core/security-coverage.ts`
(`catalogAgentOfOwner`).

## Home is attested by observation

A sandbox receipt's `homeReadOnly` is true only when a write to the operator's
home actually failed inside the sandbox; an unknown home reads as open, and a
receipt with an open home does not count as an observed result. Owners:
`scripts/security-sandbox.sh`, `sandboxWithinLimits` in
`engine/src/core/security-sandbox.ts`.

## The profile caps lens breadth

Upstream lets the orchestrator pick "relevant" lenses. Loom derives the
selection from stack signals and caps it by the run's profile — `quick` 2,
`standard` 4, `deep` 8 documents in total, `ATTACK-CLASSES.md` always among
them. A trimmed lens is listed in `excluded` with its rank. Owner:
`engine/src/core/security-lens-select.ts`.
