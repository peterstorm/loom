# Loom deltas — guidance the vendored lenses must not carry

The other lens files in this directory are byte-identical to upstream and pinned
by `MANIFEST.json` (ADR-0066 D5). Anything Loom needs a hunter to know that
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

## Receipt nonces are engine-issued

A hunter cannot compute the nonce its sandbox receipt is bound to. The parent
runs the engine's `helper security-audit nonce --out <run> --artifact
agents/<owner-id>/artifacts/<file>` — issued only for an owner with a unit in
flight, never for an artifact an archived attempt cited — and the hunter runs
the printed command verbatim, redirecting stdout into exactly that artifact.
Owners: `admitArtifactNonce` in `engine/src/core/security-coverage.ts`,
`bindSandboxRun` in `engine/src/core/security-sandbox.ts`.

## The hunter files its own envelope

A hunter returns `{ "schemaVersion": 1, "kind": "security-hunter-result",
"units", "findings" }` — not a reviewer payload. A fingerprint the run already
holds, re-filed with different content, is refused. Owners:
`parseHunterResult` in `engine/src/core/security-coverage.ts`,
`fileCandidates` in `engine/src/core/security-findings.ts`.

## Home is attested by observation

A sandbox receipt's `homeReadOnly` is true only when a write to the operator's
home actually failed inside the sandbox; an unknown home reads as open, and a
receipt with an open home does not count as an observed result. Owners:
`scripts/security-sandbox.sh`, `sandboxWithinLimits` in
`engine/src/core/security-sandbox.ts`.

## The sandbox needs `unshare`

Upstream's "bounded local fixtures" are, in Loom, one script that runs under
Linux `unshare`. On a host without it the script exits before running anything
and prints no receipt, so a claim there is `needs_validation` naming the
missing capability. Owner: `scripts/security-sandbox.sh`.

## Lens paths are plugin-relative

`start` prints the selection as `references/security-lenses/<LENS>.md`. That
path is relative to the Loom plugin root, never to the audited repository, and
the parent gives a hunter absolute paths. Upstream's "Phase 1" (reconnaissance)
is not vendored; the `security-audit` skill's "Enumerating units" replaces it.
Owner: `renderLensSelection` in `engine/src/core/security-lens-select.ts`.

## The profile caps lens breadth

Upstream lets the orchestrator pick "relevant" lenses. Loom derives the
selection from stack signals and caps it by the run's profile — `quick` 2,
`standard` 4, `deep` 8 documents in total, `ATTACK-CLASSES.md` always among
them. A trimmed lens is listed in `excluded` with its rank. Owner:
`engine/src/core/security-lens-select.ts`.
