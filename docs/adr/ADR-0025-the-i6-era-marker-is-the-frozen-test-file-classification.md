# ADR-0025: The I6-era marker is the frozen test-file classification

## Status
Accepted

## Context

I6 (red-then-green) obliges a non-claimant implementation Task whose frozen verification policy says
`newTests: required` to show its new tests failing before its implementation and passing after it. That
obligation must apply only to TaskGraphs populated after the feature shipped (FR-005). A TaskGraph populated
earlier has Tasks, receipts and stored proof that were settled under the old rules. If re-derivation in
revalidation, the State File obligation-match check or the stored-evidence reconcile suddenly obliged those
Tasks, an in-flight or historical graph would stop parsing, or its settled Tasks would turn unsettled.

So the engine needs a way to tell, from the TaskGraph alone and in pure code, whether a graph is "pre-I6" or
"I6-era". Several entry points derive proof obligations: population, `state-file-wire.ts`,
`task-revalidation.ts`, the reconcile helper, `validate-task-graph.ts` and `implementation-application.ts`.
All of them must give the same answer, or one would accept a graph that another refuses.

Two more facts shape the choice. First, I6 needs a test-file classification to know which of a Task's files
are tests. FR-014 requires that classification to be frozen at population, either the operator's declared
suffixes or the engine default, so a new frozen field has to exist in any case. Second, frozen manifests are
digest-checked (FR-016, AS-019). Any new field that enters the digest changes the digest. Old graphs must keep
the digests their suite receipts were stamped with, including graphs that carry no `verification_manifest`
at all and fall back to the engine default when read.

## Options Considered

1. **Treat the presence of the frozen `testFiles` classification as the era marker**
   - Pros: no new field. The classification has to be frozen anyway (FR-014), and it is present exactly when
     the graph was populated after this feature. Only new freezes change their digest. A single pure function
     can compute the era from the frozen manifest.
   - Cons: one field means two things, the classification and the era. Every freeze path must carry it,
     including the engine default when there is no manifest file, or a new graph would wrongly read
     `not-owed`. The engine-default manifest's bytes change, so the read-time fallback for graphs without a
     manifest needs a separate legacy default to keep old digests valid.

2. **A separate TaskGraph boolean (for example `red_then_green: true`)**
   - Pros: explicit and self-describing. Independent of the manifest shape.
   - Cons: it says again what the frozen manifest already says, so the two can disagree (a graph with
     `testFiles` but no flag, or the reverse), and every parser would have to reject that mismatch. It adds one
     more State File field to write, parse and keep stable.

3. **Derive the era from the TaskGraph schema version**
   - Pros: no new field. Version gating is a familiar pattern.
   - Cons: schema versions move for reasons that have nothing to do with I6. Any older graph that is upgraded
     or re-stamped to the new version would become obliged, including unrelated older graphs, which breaks
     FR-005. It also couples the I6 era to every later schema bump.

## Decision
**A TaskGraph owes I6 exactly when its frozen verification manifest carries `testFiles`. Only
`redThenGreenEra` computes that, and every freeze made after this feature carries `testFiles`.**

**Manifest source (`engine/src/core/verification-manifest.ts`).** Schema 2 of
`.loom/verification-manifest.json` gains two optional keys:
- `affectedRunner` gets the same form checks as `acceptanceRunner`: `{files}` passed as one whole argument,
  a `required-file` JUnit report under `.loom/completion-reports/`,
  `timeoutMs <= MAX_AFFECTED_RUNNER_TIMEOUT_MS` (`120_000`), and a report path that differs from
  `acceptanceRunner`'s and from every Wave check's.
- `testFileSuffixes: NonEmpty<string>`.

**Frozen shape.** A post-feature `FrozenVerificationManifest` carries
`testFiles: { source: "operator-manifest" | "engine-default"; suffixes: NonEmpty<string> }`
(`FrozenTestFiles`, `engine/src/core/test-file-classification.ts`). `testFiles` enters the manifest digest.
`affectedRunner` enters the digest only when it is declared. An `engine-default` classification must equal
`DEFAULT_TEST_FILE_SUFFIXES` (`.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`). The parser refuses any other
suffixes under that source.

**Freeze cases.** Population always freezes a manifest. `populate-task-graph.ts` reads
`.loom/verification-manifest.json`. On ENOENT it freezes `defaultVerificationManifest()`, and
`task-graph-population.ts` writes the result as `verification_manifest`. Every freeze path carries `testFiles`:
- a schema-2 operator manifest with `testFileSuffixes` freezes `{ source: "operator-manifest", suffixes }`;
- a schema-2 operator manifest without that key, or any schema-1 manifest, freezes `ENGINE_DEFAULT_TEST_FILES`;
- no manifest file freezes `defaultVerificationManifest()`, which carries `ENGINE_DEFAULT_TEST_FILES`.

Only TaskGraphs frozen before this feature lack `testFiles`: those with a pre-feature frozen manifest and those
with no manifest at all.

**Legacy default split.** `defaultVerificationManifest()` is now only the population freeze, and it carries
`testFiles`. `legacyDefaultVerificationManifest()` keeps the old engine-default bytes and digest exactly. The
two read-time fallbacks for a graph without a `verification_manifest` use it: the suite-receipt digest check
in `engine/src/state-file-wire.ts` and `engine/src/core/wave-completion-suite-readiness.ts`.
`parseFrozenVerificationManifest` accepts `testFiles` as an optional key and includes it in the digest
re-check only when it is present. An old graph therefore keeps both its receipts and its `not-owed` era.

**Era derivation (INV-6).** `engine/src/core/proof-obligations.ts` defines
`RedThenGreenEra = "owed-if-new-tests" | "not-owed"` and the only function that computes it:

```ts
export function redThenGreenEra(manifest: FrozenVerificationManifest | undefined): RedThenGreenEra
```

`deriveProofObligations` takes `redThenGreen: RedThenGreenEra` as an input. It never checks `testFiles`
itself. Population (`task-graph-population.ts`), the State File obligation-match check
(`state-file-wire.ts`), revalidation (`task-revalidation.ts`) and `handlers/helpers/validate-task-graph.ts`
compute the era with `redThenGreenEra(graph.verification_manifest)`, or with the equivalent frozen manifest
they hold. Settlement and the stored-evidence reconcile (`handlers/helpers/reconcile-implementation-proof.ts`)
go through `redThenGreenDuty(task, manifest)` in `implementation-application.ts`: a Task's frozen Proof
decides, and `redThenGreenEra` is consulted only for a Task with no frozen Proof. None of them checks
`testFiles` presence inline.

**Resulting invariants.**
- An old TaskGraph has no `testFiles`, so its re-derived obligations stay exactly as they were (FR-005).
- Claimant Tasks already carry `newTests: waived(covered-by-acceptance-contract)`, so they are never obliged
  for step 1 in either era. They are credited red from the frozen acceptance red window (FR-010).
- At settlement, the frozen classification is what decides which of a Task's files are tests
  (`classifyTaskFiles(task.file_list, duty.testFiles)`). The era marker and the classification it supplies
  therefore cannot drift apart.

## Consequences

**Positive:**
- There is one source of truth. The era cannot disagree with the classification because it is the
  classification's presence. No combination of flag and manifest has to be refused.
- Pre-feature graphs are untouched: no new obligations, unchanged digests, valid suite receipts. Graphs with
  no manifest stay valid through the legacy default.
- Digest changes reach only new freezes (FR-016, AS-019). A changed suffix list or affected runner after
  population fails the digest check, as `acceptanceRunner` already does.
- The decision lives in one pure function, so every entry point gives the same answer, and adding a new
  caller means calling `redThenGreenEra` rather than copying a rule.

**Negative:**
- `testFiles` carries two meanings. A future change that made `testFiles` optional on some new freeze path,
  or dropped it from the engine default, would quietly turn I6 off for those graphs. The rule that every
  freeze path carries `testFiles` must hold forever and is enforced only by tests and review, not by the type
  system: `testFiles` stays optional in `FrozenVerificationManifest` so that pre-feature graphs still parse.
  A possible follow-up is an explicit era sum type on the frozen manifest (pre-feature vs post-feature), which
  would make `redThenGreenEra` a total match and let post-feature freeze paths require `testFiles` by type.
- The engine now has two engine-default manifests (`defaultVerificationManifest` and
  `legacyDefaultVerificationManifest`). Using the wrong one at a read-time fallback would break old receipts
  or obligation matching. Each fallback must be chosen on purpose.
- The era cannot be switched on per graph after population. A graph frozen before this feature never owes
  I6, even if it is resumed long after the feature shipped. To get I6 on that work, the graph has to be
  re-populated.
- An `engine-default` classification is locked to the current `DEFAULT_TEST_FILE_SUFFIXES`. Changing that
  default later requires a new source tag, or a parser that accepts the old suffix list, so that graphs
  frozen earlier still parse.
