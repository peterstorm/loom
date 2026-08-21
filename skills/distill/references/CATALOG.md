# The Move Catalog

Concrete behavior-preserving simplification moves, highest leverage first. Every move must pass the **reader test** (the next maintainer understands the code faster) and the **behavior test** (no observable output, error mode, or ordering changes). Uses the vocabulary in `SKILL.md` and deepen's `references/LANGUAGE.md`.

## 1. Reuse Before Rewrite

The cheapest code is code that already exists and is already tested.

- Hand-rolled logic duplicating a stdlib call (`Array.prototype.at`, `Objects.requireNonNullElse`, `Map.computeIfAbsent`) → use the stdlib
- Reimplementation of an existing project utility → call the utility; if the utility *almost* fits, prefer extending it over forking it
- Two near-identical blocks in the same change → extract one function *at the same altitude*, parameterized by what actually varies
- **Divergence check (report as wrongness, don't merge):** if the two "duplicates" have already drifted apart, that drift may be a bug. In review mode this is the classic critical finding; in apply mode, stop and report.

## 2. Compress with Types

Make the illegal states unrepresentable, then delete every branch that guarded them. A branch deleted because its state stopped existing is the strongest simplification in this catalog: the bug it defended against can no longer be written, and neither can the test that pinned it. This is `rules/architecture.md` applied as a *reduction* tool.

- **Flag combinations with illegal members** — two booleans with three legal combinations, a status string plus a nullable payload that must agree → one ADT / discriminated union per legal state. The `if (done && !result)` guard, the "should never happen" throw, and the comment explaining the coupling all become deletions.
- **Two representations of one concept** — `null` *and* a `"none"` sentinel, a raw string *and* its parsed form, an empty array *and* `undefined` both meaning "absent" → pick one canonical representation at the boundary. Every consumer's defensive second branch dies with the duality.
- **Re-validation of already-proven facts** — code that re-checks what an upstream parser already established → parse once at the boundary, carry the proof in the type (branded/parsed types), trust it downstream. If the type doesn't actually prove what downstream re-checks, that is the finding: the boundary parse is incomplete.
- **Optionals that travel together** — three fields that are always all-present or all-absent → one optional grouped value; `n` presence checks become one.
- **Stringly-typed state** — a `string` holding one of four known values → the union/enum the domain already names in `CONTEXT.md`.

**Deepen boundary:** compressing a type that only lives inside the scope is distill; compressing a type that crosses a caller-visible seam changes the interface — flag it for `deepen`. In review mode, an illegal-states-representable finding where the guards have *already* fallen out of agreement is the classic critical.

## 3. Delete Dead and Speculative Code

- Unreachable branches — conditions the type system or earlier guards already exclude
- Unused parameters, fields, return values, and exported symbols nothing imports
- Speculative generality: configurability nothing configures, type parameters with one instantiation, hooks with no second caller. YAGNI applies retroactively.
- Commented-out code — version control remembers; the file should not
- **Boundary:** a port with one adapter and no test fake is deepen's "hypothetical seam" call, not a distill deletion — flag it for deepen rather than removing it unilaterally, because removing it changes where callers bind.

## 4. Collapse Pass-Throughs

A wrapper earns its existence by adding an invariant, translating a domain, or standing at a real seam (two adapters). Otherwise:

- Function that only forwards its arguments → inline it, call the target
- Class whose every method delegates to one field → use the field's type
- "Manager"/"Helper"/"Util" that holds one function → free function
- Re-export layers that rename without translating → import from the source

Apply the **deletion test**: if deleting the wrapper makes complexity vanish, it was a pass-through; if complexity reappears at N call sites, it was earning its keep — leave it.

## 5. Flatten Control Flow

- Guard clauses / early returns over arrow-shaped nesting
- Exhaustive `switch`/pattern match over `if/else` chains that switch on the same discriminant — with ADTs this also buys compiler-checked totality
- **Never nested ternaries** — one level is the ceiling; beyond that, `if`/`switch`
- Merge sequential `if`s with identical bodies; hoist duplicated tails out of branches
- Loop + accumulator that reimplements `map`/`filter`/`reduce`/`find` → the named operation (only when it removes state, not when the loop is genuinely clearer)

## 6. Restore Altitude

Each function should read as one coherent level of abstraction.

- High-level orchestration interrupted by a wall of low-level detail → extract the detail under a name at the orchestration's vocabulary level
- A stack of trivial single-call wrappers between the reader and the one real operation → inline the stack
- A name that lies about its altitude (`process`, `handle`, `doWork`) → rename to what it actually decides or produces
- Boolean parameters that make call sites unreadable (`render(true, false)`) → named alternatives or an options object — *only if the signature is private to the scope being distilled*; a caller-visible signature change belongs to deepen

## 7. Apply FP Shape

Align with `rules/architecture.md` (FC/IS) without moving any seam:

- Mixed pure-logic-and-I/O inside one function, where the pure part can be extracted *without changing the function's own interface* → extract the pure core, keep the shell shape
- Mutation of a local accumulator across many statements → a single immutable transformation pipeline
- Type-level moves (re-validation, stringly-typed state) live in **Compress with Types** above — this section is about the shape of computation, that one about the shape of data

## 8. Cut Comment Noise

- Comments that restate the code (`// increment i`) → delete
- Comments that restate the *diff* ("changed to use X") → delete; that's commit-message content
- Comments papering over a bad name → fix the name, delete the comment
- **Keep** comments that carry constraints the code cannot show: protocol quirks, ordering requirements, links to external contracts, deliberate deviations from idiom. When in doubt whether a comment is load-bearing, keep it and say so.

## Sequencing in Apply Mode

Run the catalog top-down: reuse, type compression, and deletion first (they shrink the surface — and the state space — every later move must consider), altitude and FP shape last (they are judgment-heaviest). One move, one test run, one commit-sized diff at a time.
