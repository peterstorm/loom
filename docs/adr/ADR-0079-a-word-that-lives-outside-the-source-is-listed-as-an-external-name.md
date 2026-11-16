# ADR-0078: A word that lives outside the source is listed as an external name

## Status
Accepted (2026-11-16). Amends ADR-0074 (how a word reference resolves).

## Context
`no-dangling-doc-reference` resolves a backticked word only when the project's source corpus holds it
(ADR-0074). Some names a document must use never appear in that corpus: an OpenTelemetry attribute the SDK
emits at runtime, a Python evaluation scorer, a Microsoft Graph permission, a model id, a federated identity
credential's name. ADR-0074 measured the effect on Fugue: most of its 1,072 unresolved words named an
external system, and it set a configured vocabulary of external names aside as a separate decision.

Without one, a document can either baseline every occurrence or drop the backticks. Fugue's documents did
both, so sibling identifiers were formatted differently, and about a dozen review findings were about
exactly that mixed formatting.

## Options Considered

1. **Baseline every occurrence.**
   - Pros: no new mechanism.
   - Cons: an entry excuses one occurrence in one file, so each new mention of a legitimate name is a new
     violation. The baseline reads as debt, and these names are not debt.

2. **Read the names from somewhere else in the tree** (a Python corpus, a telemetry schema file).
   - Pros: no list to maintain.
   - Cons: a reader per source of truth, and for vendor values (Graph permissions, model ids) no file in
     the repository holds them at all.

3. **Pattern entries** (`ai.llm.*`).
   - Pros: one entry covers a family.
   - Cons: a pattern keeps any spelling alive, including the misspelling the rule exists to catch, and a
     pattern cannot report that one of its names has gone.

4. **An exact, reasoned list in the scope that reports its own decay (chosen).**

## Decision
**`docReferences.externalNames` lists the words a project's documents name though its source never spells
them: groups of exact names, each group with the reason its names live outside the source.**

- **Shape.** `externalNames: { names: string[]; reason: string }[]`, optional, parsed strictly with the rest
  of `docReferences` (`linter/programmatic/config.ts`). A group with no names or no reason, an unknown key, a
  name listed twice and a name that is not a word are refused by name.
- **A name is a word.** `parseExternalName` (`linter/doc-references/external-names.ts`) accepts exactly the
  strings the extractor reads as a word reference: one word or dotted path. A glob, whitespace, a path, a
  file name, a call, placeholder grammar and another document's id are refused, so a listed name is always
  something a document can reference. The parsed name is the branded `ExternalName`.
- **Resolution.** The reference frame carries the scope's names (`ReferenceFrame.externalNames`). A word
  reference whose text is exactly a listed name resolves `via: "external"`, with its group's reason
  (`resolve.ts`). The match is exact: not a prefix, a longer dotted path, a call or another case. Paths,
  file names, links, spec ids and ADR ids never read the list.
- **Decay.** As with every list that only subtracts, the full run reports an entry that names nothing:
  - a listed name no governed file references as a word is unreferenced;
  - a listed name the source already resolves, judged by the same resolver with no external names, is
    not external.
  `externalNameDrift` (`no-dangling-doc-reference.ts`) decides both over every governed file of the project,
  never a targeted run's subset, and `lint-project` reports each as a stale entry naming its group's reason.
  The shell reads the files; the decision is pure.
- **Unchanged.** Lint coverage and `--init` do not read the field; a project without it behaves as before.

## Consequences

**Positive:**
- A name that lives outside the source is backticked like its siblings, wherever it is written, and the
  reason it is allowed is stated once, beside it.
- The list cannot rot quietly. A name the documents stop using, or one the code later defines, fails the
  full run until it is removed.
- A misspelling of a listed name still dangles, because the match is exact.

**Negative:**
- Each external name is written out. A family of fifty attributes is fifty entries; a pattern would be
  one, but it would also accept every misspelling.
- The full run reads every governed file a second time to collect the words the documents reference.
- A listed name resolves in every governed file, including one where the name would be wrong. The list
  says the name exists outside the source; it does not say where it may be used.
