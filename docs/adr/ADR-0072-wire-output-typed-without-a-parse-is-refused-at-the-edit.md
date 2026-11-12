# ADR-0072: Wire output typed without a parse is refused at the edit

## Status
Proposed (2026-11-12). Implements the immediate-tier half of Q6 of the deterministic-implementation plan's
Q-track.

## Context
`JSON.parse(text)` and `response.json()` return `any`. Writing `JSON.parse(text) as Order`, or
`const order: Order = JSON.parse(text)`, names a type for whatever arrived and checks nothing; every read
written afterwards is believed by the compiler. Of 53 recent critical review findings, 7 came from one file
doing this. Each was found at review, after the code settled, and each fix was the same: bind the value as
`unknown` and write the parser that should have been there.

The rules that exist do not cover it. `no-unsafe-as-any` and `no-any-type` match the word `any`; an
assertion to a named type passes both. The advisory type diagnostics see nothing, because the code is
well-typed: that is the defect.

The linter reads text. ADR-0042 and ADR-0053 keep the TypeScript compiler API out of `engine/src/linter`
(a boundary grant, enforced by `no-cross-boundary-imports`), and the edit hook's per-file budget is 50 ms.

## Options Considered

1. **A regex rule (`JSON\.parse\(.*\)\s+as\s+`).**
   - Pros: one JSON file.
   - Cons: regex rules match one line. The argument, the type or the `as` on another line is missed, and so
     is every annotated binding and every assignment. It cannot tell `as unknown` from `as Order`, an
     argument position from a cast, or a string that quotes the shape from code.

2. **A compiler-API rule that asks the checker where `any` flows.**
   - Pros: sees every position — returns, properties, arguments, unannotated bindings.
   - Cons: breaks ADR-0042/0053, needs a program per edit, and cannot run inside 50 ms. It is the right
     shape for a Wave Gate check, not for the edit hook.

3. **Ban every `as T` (the E-track rule), or allow `JSON.parse` only in `*-wire.ts` files.**
   - Cons: both are larger decisions with their own backlogs (branded-type constructors assert by design;
     most projects have no `*-wire.ts` convention). Deferred, below.

4. **A text rule that walks balanced brackets over the file's code (chosen).**
   - Pros: catches the shapes that produced the findings, multi-line forms included, with no type
     information and inside the budget. Runs in every TypeScript project without configuration.
   - Cons: sees only the shapes it names (limits, below).

## Decision

### 1. The rule
`no-wire-cast` (`engine/src/linter/programmatic/no-wire-cast.ts`) is a programmatic rule in the `immediate`
tier, so it runs on every edit on both harnesses and again at the Wave Gate and in `lint-project`. It reads
every non-test TypeScript file (`.ts .tsx .mts .cts`; the engine-wide test-file classifier decides "test",
as for `switch-totality`).

A **wire call** is `JSON.parse(…)` or a `.json()` call with no arguments. With `T` any type but `unknown`,
the rule refuses:

- **an assertion** on the call — `JSON.parse(text) as T`, `x.json() as T`, `(await x.json()) as T` — through
  any number of grouping parentheses and through a chain: `as unknown as T` asserts `T`;
- **an annotated binding** — `const|let|var name: T = <wire call>`, awaited or not, a destructuring pattern
  included;
- **a typed assignment** — `name = <wire call>` (also `??=`, `||=`, `&&=`) where the nearest
  `const|let|var` declaration of `name` whose block still encloses the assignment is annotated `T`.

It accepts `as unknown`, a `: unknown` binding, an assignment to a name declared `unknown`, and the call in
argument position (`parseOrder(JSON.parse(text))`): what the callee's parameter accepts is the parser's
business. `Promise<unknown>` counts as `unknown`, for a `.json()` call that has not been awaited.

The message names the fix: bind the value as `unknown` and pass it through a parser or decoder that returns
the typed value or an error.

### 2. How it reads
The source segmenter gains a finer split, `lexicalSpans`, in which template text and regex literals are
spans of their own; `sourceSegments` is that split with the two read as code, and its output is unchanged.
The rule blanks every span that is not code, pairs every bracket in one pass, and answers each question
about a site from those two tables. A refused shape inside a string, a comment, template text or a regex
literal is therefore no site, and a bracket inside one cannot unbalance the walk. A file that names neither
call is answered before it is lexed.

### 3. Baseline
Pre-existing sites are grandfathered per project in `wireCastBaseline`, keyed `path::as T` for an assertion
and `path::name: T` for a binding or assignment, one entry per site. The rule registers a baseline owner, so
`lint-project --write-baseline` records the list and the full tier reports an entry no live site consumes.
Loom's own list is empty: its sites are fixed, not recorded.

## Shapes ruled out
- **The angle-bracket assertion `<T>JSON.parse(text)`.** `>` before the call is also a comparison; text
  cannot tell them apart, and the form is invalid in `.tsx`.
- **`.json()` with arguments.** `Response.json(body)` and Express's `res.json(body)` write a body.
- **A generic `.json<T>()`** (some HTTP clients). It is a cast by another name, but it is the library's
  declared API; refusing it is a per-project decision.
- **`satisfies T`.** It asserts nothing: the value stays `any`.

## Consequences
- An agent that writes one of the three shapes is stopped at the edit, on both harnesses, with the fix in
  the message.
- `as unknown as T` is no longer a way past `no-unsafe-as-any` for a wire value.
- A target project adopting the rule on an existing codebase runs `--write-baseline` once; the list only
  shrinks.
- The rule reads the file twice (lexical spans, bracket pairs) and its cost grows linearly with the text.
  On a CI runner a 10,500-line, 515 kB file with 4,500 wire calls (3,000 of them sites) took about 50 ms,
  the whole per-file budget: roughly 5 µs per line. A file that large and that dense in wire calls can
  therefore overrun the deadline on slow hardware, and the edit then fails closed with a timeout error.
  The test pins a 2,100-line file of the same shape inside the budget and pins linear growth as a ratio
  between two sizes. A file with no wire call costs a substring search.

## Known limits
The rule reads text and has no type information. None of the following is caught:

- **`any` flowing through a position the checker owns.** An unannotated binding
  (`const value = JSON.parse(text)`), a `return JSON.parse(text)` under a declared return type (for example
  `core/emission-tool.ts:257`), a property read (`JSON.parse(text).id`), an operand
  (`JSON.parse(text) ?? []`), a ternary arm without an assertion, an argument whose parameter is a named
  type. Each needs the type checker to say where the `any` lands.
- **Declarations the scan does not read.** A class field (`private order: Order = JSON.parse(text)`), a
  parameter default, the second and later declarators of one `let a, b: T = …` statement.
- **Scope is by block, and parameters are not declarations.** A parameter that shadows an outer annotated
  `let` is judged by the outer declaration; a `var` is treated as block-scoped.
- **Aliases.** `const parse = JSON.parse; parse(text) as T` and a wrapper function that returns `any` are
  not wire calls to the rule.
- **Test-file helpers that are not named as tests.** Scope follows the test-file classifier's suffixes
  (`.test.`, `.spec.`), so a harness module under `tests/` is in scope.

## Deferred
- The wider E-track rule refusing every `as T` outside a smart constructor.
- "`JSON.parse` only in `*-wire.ts`": confining wire reads to named modules.
- A type-aware Wave Gate check for the positions listed under Known limits.
