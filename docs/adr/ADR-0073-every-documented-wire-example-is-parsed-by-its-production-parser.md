# ADR-0073: Every documented wire example is parsed by its production parser

## Status
Accepted (2026-11-12). Implemented in PR #160. Implements Q5 of the deterministic-implementation plan's Q-track.

## Context
An agent definition, command, skill or operations doc that shows a wire shape is the contract a model or an
operator copies. When the doc and the parser disagree, the engine refuses the output at run time and the
suite stays green.

One test closed this for three docs. `engine/tests/security/security-agent-docs.test.ts` read the first JSON
fence of the hunter, critic and verifier definitions and put it through the real parsers, after a review
found all three teaching keys the parsers refused. Every other documented shape was unchecked: the judge and
refutation verdicts, the decompose graph, the orchestration start inputs, the verification manifest, the
lint configuration, the Requirement trace roster. The stamped reviewer contract is the exception: it is
rendered from the executable codec and compared byte for byte.

Marking the existing examples and parsing them found three whose parser refuses them as written. Each was a
prose stand-in written as a literal value:

- `agents/review-verifier-agent.md`: `"criterion": "your lens, verbatim"`.
- `commands/templates/phase-arch-judge.md`: `"criterion": "the criterion, verbatim"`.
- `commands/templates/review-verify.md`: `"criterion": "the lens, verbatim"` and
  `"finding_id": "the manifest id, verbatim"`.

A fourth was not JSON at all: a heredoc in `skills/security-audit/SKILL.md` whose body was the elision
`{ …the input status printed… }`. It taught no wrong key; it could not be read.

Each is now written as a `<…>` placeholder. Every other example parsed on the first run.

## Options Considered

1. **Generate every example from code, as the reviewer contract is.**
   - Pros: an example cannot drift.
   - Cons: an example is teaching text. It carries hints (`<your lens, verbatim>`), elisions and a chosen
     minimal case, and it sits inside prose a human wrote around it. A renderer per shape, a stamp region per
     doc and a stamp check for twenty shapes is far more machinery than the defect needs, and a rendered
     example teaches less.

2. **Extend the existing test: first JSON fence of a named list of docs.**
   - Cons: a doc's second example is never read, a new doc is never read, and a heredoc is not a JSON fence.
     Nothing fails when someone adds an example. That is the state this ADR starts from.

3. **Check key sets against the parsers' allowlists.**
   - Cons: most parsers export no allowlist, and a key set says nothing about values, required fields or
     cross-field rules. The literal `criterion` strings above have the right keys.

4. **Infer the shape from the example's content** (`kind`, `schemaVersion`, the keys).
   - Cons: several shapes carry no discriminator (a judge verdict, a lint rule, a trace roster), and a
     drifted example is exactly the one inference would misfile or skip.

5. **A marker above every example, a registry of shape to production parser, completeness both ways
   (chosen).**
   - Pros: the doc states what the example is; the suite puts the example itself through the function the
     engine calls; an unmarked example and an untaught shape both fail.
   - Cons: one comment line per example. The registry needs surrounding authority for parsers that take it
     (a lens, a candidate list, a source review).

## Decision

### 1. The marker
A marker is an HTML comment on the nearest non-blank line above a fence, so it renders as nothing:

- `<!-- wire-example: <shape-id> -->`: the fence documents that shape.
- `<!-- wire-example: none — <reason> -->`: the fence shows JSON that is not a wire example. The reason is
  required and the suite refuses one shorter than 20 characters.

A marker line that is neither is kept as a `malformed` marker and reported, not skipped. The shape id is parsed
once, at the scan, into the closed `WireShapeId`: a well-formed id the registry does not hold is kept as an
`unregistered` marker and reported. An example therefore always names a registered shape, and nothing
downstream of the scan re-checks the id.

### 2. What counts as an example
A fence's language is the first word of its info string, so ` ```json title="x" ` and ` ```json {1,2} ` are
`json` fences. An info string is any text without a backtick, as in CommonMark.

- A `json` or `jsonc` fence is one example.
- A shell fence is one example per heredoc whose body begins with `{` or `[`. The marker sits above the
  shell fence and applies to each.
- Any other fence is an example only when it carries a shape marker. Its body is then the example text,
  which is how a marker-line shape (`LOOM_IMPLEMENTATION_BRIEF`) is documented.

A JSON fence or JSON heredoc with no marker is a defect. So is a marker with prose between it and its fence,
and a marker naming a shape the registry does not hold.

### 3. The governed docs
Every `*.md` under `agents/`, `commands/`, `skills/`, `docs/` and `references/`. The exceptions are a list
with a reason each (`UNGOVERNED` in `engine/tests/support/doc-wire-examples.ts`):

- `agents/_shared/wire-contract.md`, rendered whole from the reviewer codec;
- `docs/adr/`, which records a shape at the time of a decision and is not edited to follow it;
- `references/reviewer-protocol-v1/` and `-v2/`, byte-frozen archives;
- `skills/security-expert/` and `skills/nextjs-frontend-design/`, which teach third-party formats.

Inside a governed doc, the region between the wire-contract stamp markers is skipped: the stamp check
already compares those bytes with the codec's rendering.

### 4. The registry
`WIRE_SHAPE_IDS` is a closed list (`engine/tests/support/doc-wire-shape-ids.ts`) and `WIRE_SHAPES` is a
record over it (`engine/tests/support/doc-wire-shapes.ts`), so an id without a parser does not compile. Each
entry calls the production function for that input, and its `parse` body is the one statement of which
function that is: no free-text label restates it, so a renamed parser cannot leave a stale name behind. No
entry restates a rule.

Where a parser needs surrounding authority, the entry builds it from the suite's fixtures: the minted
criterion and candidate filename for a judge verdict, a lens and the documented Finding ids for a refutation
verdict, a published source review for Defect-Family Accounting. A declarative lint rule is parsed by the
loader as it reads a directory, so the example is installed as the one rule of a scratch rules directory.
An architecture panel journal is decoded and then replayed through the program's reducer, as
`helper panel-program` does, so an example whose events are well formed but out of order fails.

A parser a doc teaches is exported for the registry to call, from the functional core. `parseUserDecision`
(the Wave Gate decision, `engine/src/core/user-decision.ts`) and `parseReopenRequest` (the completed-Wave
reopening payload, `engine/src/core/wave-reopening-request.ts`) are pure and return a `DomainResult`; the
`decide` and `reopen-completed-wave` handlers keep the I/O and render the refusal in the same words as before.
The registry calls the same functions and reads their result directly, with no adapter.

Every entry must refuse a document that is not its shape, and no documented example may parse under another
shape's id. Without the first check an entry that admitted everything would reduce the suite to "the docs
hold well-formed JSON"; without the second a marker naming the wrong shape could pass.

### 5. Reading an example
Docs are prose first. Three repairs are applied outside string literals, and nothing else: a `/* … */`
comment is dropped, `[ … ]` is read as an empty list, and a trailing comma is dropped.

Placeholders follow one convention, which the corrected examples now obey:

- a value the reader replaces is written `<…>`; every other value is a literal the parser must accept;
- `"a | b"` is a documented choice and is read as its first option;
- a placeholder whose hint says `null` is read as `null`;
- any other placeholder resolves through the shape's table by the field it sits under, so a doc may reword
  its hint. A field with no entry fails by name.

### 6. Completeness
The suite fails when a governed doc has an unmarked example, a malformed or dangling marker, or an
unregistered shape id; when a registered shape is taught by no doc; when any marked example is refused by
its parser; when an example also parses under another shape's id; and when an `UNGOVERNED` entry names no
existing path (a trailing slash names a directory, anything else a file) or one the governed rule still
covers. `security-agent-docs.test.ts` keeps its key-set and identity checks and now reads its blocks
through the same extraction.

## Consequences
- Adding a JSON example to a governed doc requires a marker, and adding a wire shape requires a registry
  entry and one documented example. `docs/operations.md` ("Documented wire examples") is the contributor
  procedure.
- Three fences are opted out, and none is Loom input: the `suggest-spec-anchors` output and the State File
  orientation snippet in `commands/loom.md`, and the Pi settings file in `docs/pi-usage.md`. An opt-out is
  not available to an example whose parser is merely unexported; the parser is exported instead.
- The lint rule parser (`parseRuleJson`) stays unexported and is reached through `loadRules`, the function
  the linter calls.
- **Not detected: JSON outside a labelled fence.** A shape written inline in a sentence or a table cell, or
  in a fence with no language, is not an example to the suite. Nor is a tilde (`~~~`) fence: the scan reads
  backtick fences only. The hunter envelope and the `merge-critic`
  wrapper in `skills/security-audit/SKILL.md` are written that way, as are the inline shapes in
  `docs/security-audit.md` and `references/security-lenses/LOOM-DELTAS.md`.
- **Context comes from fixtures.** A verdict is parsed against the lens, criterion, candidates and Finding
  ids the suite supplies or the example itself names. "Every manifest finding exactly once" is therefore
  checked against the example, not against a manifest.
- **Shapes with no documented example are not covered**: the `security-verification` start input, which
  `status` prints and no doc restates, and the engine-rendered marker lines (`LOOM_DISTILL_PASS`, the retry
  and attestation contexts).
- An example's literal values are contract. A doc that wants to hint at a value must use a placeholder; a
  hint written as a literal fails the suite, as three did.
- The archived reviewer protocols keep the old literal `criterion` hint. They are frozen and ungoverned.
