# ADR-0082: A package manifest and its lockfile belong to one Task

## Status
Accepted (2026-11-17). Implements loom#199, Cause 3.

## Context
Every file in a TaskGraph has one owner per Wave, and nothing related files that must change together. In a
live run, `package.json` belonged to T12 (Wave 5, open) and `bun.lock` to T28 (the same Wave). The lockfile had
also been written earlier by T6 (Wave 2, sealed). Moving `@fuguejs` to a new version edits both files at once.
No Task owned both, so every state in between was legitimately red: the lockfile and installed packages were
on 0.7.0 and the manifest on 0.6.0. A sealed test pinning the installed version then failed whichever Task ran
it.

## Options Considered

1. **Coupled file sets, enforced where Tasks are created or changed (chosen).** A built-in rule couples each
   `package.json` with the lockfiles in its directory. A Task that lists any member of a set lists every member
   that any Task of the graph lists.
   - Pros: the split cannot be planned, and an edit that would create one is refused with the missing members
     named.
   - Cons: a Task that bumps a dependency now owns the lockfile too, which can mean naming a sealed lockfile
     explicitly (`rescope-task --add-sealed-file`).
2. **Detect the split only when a test fails.**
   - Cons: by then an attempt is spent, which is the failure this replaces.

## Decision
`core/coupled-file-sets.ts` holds the rule: a manifest and the lockfiles beside it (`bun.lock`, `bun.lockb`,
`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`) form one set. Population validation
refuses a graph in which a Task lists part of a set another Task lists. `rescope-task` and add-forward-fix
(`add-task` since ADR-0086) refuse an edit that leaves the Task they write listing part of a set. Loading an existing State File does not
apply the rule, because live graphs predate it.

Sets declared by the plan (a contract package and its consumers' types, for example) are a later extension of
the same rule.

## Consequences
- A dependency bump is one Task's change, so no state in between is left red for a sibling to run into.
- A live graph that already splits a set is repaired by moving the members onto one Task with `rescope-task`.
