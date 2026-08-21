# Review Lenses

The refutation lenses used by the wave gate's adversarial review panel (Step 3.5
of `commands/wave-gate.md`). The `review-panel` helper selects the lens set from
the finding brief; the orchestrator substitutes the chosen lens's section below
into the `{lens_prompt}` variable of `commands/templates/review-verify.md`. Each
verifier commits fully to ONE lens and judges **every** finding through it.

Every lens fragment states three things a verifier must honor: what it **tries
to refute**, what it **refuses to refute on** (so a lens does not stray into
another's territory and produce a correlated vote), and its **characteristic
failure mode** — the way this lens gets it wrong.

There are **five** lenses. `reproduction` and `intent` are always included; the
rest are selected from signals in the finding set, then this table's order fills
any remaining slots. The accepted panel size is 2–5 lenses; values outside that
range are rejected.

The first three are therefore the default unsignalled panel — cause, intent,
consequence — the smallest set covering the three ways a finding is wrong on its
own terms. `security` and `test-coverage` sit below them because an unsignalled
finding set has no security or test surface for them to judge; when it does, the
signals pull them up regardless of this order.

| Lens | Tries to refute | Refuses to refute on |
|---|---|---|
| `reproduction` | the failure cannot actually be triggered | style, taste, or design preference |
| `intent` | the "flaw" is deliberate architecture | whether the deliberate choice is *good* |
| `blast-radius` | the claimed consequence does not follow from the cause | whether the cause itself is real |
| `security` | the claimed security consequence does not hold | non-security correctness |
| `test-coverage` | the missing test would not catch a real bug | production-code claims |

## The standing rule for every lens

**Ties favor keeping the finding.** A false positive costs one remediation
cycle; a false negative ships a bug. When you cannot tell, vote `uncertain` —
it counts toward neither side. Do not vote `refuted` to seem decisive, and do
not vote `upheld` to seem agreeable. `upheld` means you actively tried to refute
the claim and failed.

---

## reproduction

**Try to refute:** that the failure can actually be triggered. Trace a concrete
path from a real caller to the claimed failure. What input, what state, what
ordering? If the guard clause three lines up makes the null impossible, if the
type system already excludes the case, if the only caller passes a literal, if
the branch is unreachable — the finding is refuted.

**Refuse to refute on:** style, taste, or design preference. "This is ugly but
works" is not your call; `intent` and the human reviewer own that. A finding you
cannot trigger BUT that describes a latent hazard one refactor away is
`uncertain`, not `refuted`.

**Characteristic failure mode:** demanding a test case as proof. Many real bugs
have no reproducer yet; absence of a written repro is not absence of a path.
Refute only when you can name the specific thing that makes the path impossible.

---

## intent

**Try to refute:** that the flagged code is a mistake at all. Codebases have
deliberate, load-bearing patterns that read as smells to a reviewer without
context: never-throw functions that return `Either`/`Result` instead,
fail-closed defaults that look like over-caution, algebraic data types whose
"redundant" cases make illegal states unrepresentable, exhaustive matches whose
"unreachable" branch is the invariant's guard. Read the surrounding module,
`CLAUDE.md`, and the architecture rules. If the finding is asking for the
codebase's documented convention to be violated, it is refuted.

**Refuse to refute on:** whether the deliberate choice is a GOOD one. Your
question is "was this intended?", not "would I have done it this way?". A
convention you dislike is still a convention.

**Characteristic failure mode:** rationalizing. Anything can be narrated as
intentional after the fact. Refute only with evidence of intent — a comment, a
documented rule, a consistent pattern across siblings, a type that only makes
sense under that reading. A plausible story is `uncertain`.

---

## blast-radius

**Try to refute:** that the claimed consequence follows from the claimed cause.
Findings routinely name a real flaw and then overstate what it does — "this
crashes the server" for a caught exception, "data loss" for a retried write,
"breaks every caller" for a private function with one caller. Trace the actual
propagation: who catches it, what the fallback is, how far it gets. If the cause
is real but the consequence is not, the finding is refuted **as written** — say
so precisely in your reasoning, because a rewritten version may be valid.

**Refuse to refute on:** whether the cause is real. Assume the cause; judge the
consequence. `reproduction` owns the cause.

**Characteristic failure mode:** minimizing. "It only affects one endpoint" is
not a refutation if that endpoint matters. Refute an overstated consequence,
not a merely unglamorous one.

---

## security

**Try to refute:** that the claimed security consequence holds. Is the input
actually untrusted at this point, or already parsed at a boundary above? Is the
data reachable by an attacker, or internal-only? Is the sink actually dangerous
here — a parameterized query, an escaped template, a path already canonicalized?
Is the "secret" a test fixture? If the trust boundary the finding assumes does
not exist, it is refuted.

**Refuse to refute on:** non-security correctness. A finding that is wrong about
the security consequence but right that the code is broken is `uncertain` from
this lens — say so in your reasoning and let another lens decide.

**Characteristic failure mode:** refuting on "defense in depth is unnecessary".
A redundant check that costs nothing is not a false positive just because a
prior layer also catches it — but a finding that claims exploitability where
there is none IS refuted. Judge the claim, not the fix's necessity.

---

## test-coverage

**Try to refute:** that the missing or weak test would catch a real bug.
Is the untested path already covered by an integration test, a property test, or
the type system? Is the suggested test asserting implementation detail rather
than behavior? Would it be brittle — pinned to a mock's call order, a string
format, an internal name? Would writing it cost more than the bug it prevents?
A finding demanding academic completeness on a trivial path is refuted.

**Refuse to refute on:** claims about production code. If the finding is really
about a bug and only mentions tests in passing, that is another lens's item.

**Characteristic failure mode:** refuting real coverage gaps because "the code
is obviously correct". Obvious correctness is what regressions eat first.
Refute when the test would not catch a real failure, not when the code currently
happens to work.
