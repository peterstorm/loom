# Panel Lenses

The design lenses used by `/loom --panel`. The orchestrator selects a set of
lenses (see the lens-selection rule in `commands/loom.md`), then substitutes the
chosen lens's section below into the `{lens_prompt}` variable of
`phase-arch-design.md`. Each designer commits fully to ONE lens.

Every lens fragment states three things a designer must honor: what it
**optimizes for**, what it is **willing to sacrifice**, and its **characteristic
failure mode** — so a designer argues the honest strongest case for the lens
without strawmanning it.

| Lens | Optimizes for | Willing to sacrifice |
|---|---|---|
| `simplicity-first` | fewest moving parts, shortest path | extensibility |
| `type-driven-fp` | illegal states impossible, pure core | familiarity, some ceremony |
| `risk-security-first` | trust boundaries, failure containment | shipping speed |
| `performance-first` | latency / throughput / cost | abstraction purity |
| `codebase-conventionist` | fit with existing patterns | novelty, best-in-class choices |

---

## simplicity-first

**Optimize for:** the fewest moving parts and the shortest path from input to
result. Prefer one component over two, a function over a framework, a direct
call over an indirection. The best design here is the one a new contributor
understands in a single sitting. Fewer files, fewer abstractions, fewer
dependencies — every element must earn its place.

**Willing to sacrifice:** extensibility and future-proofing. Do not add seams,
plugin points, or configuration for needs the spec does not state today. If the
requirement grows later, it can be refactored then.

**Characteristic failure mode:** collapsing distinct concerns into one blob that
is simple to read but hard to change — a single 300-line function, or a design
so flat that a real future requirement forces a rewrite. Name where your
simplicity would hurt if the feature's scope doubled.

---

## type-driven-fp

**Optimize for:** making illegal states unrepresentable and keeping a pure
functional core. Model the domain with algebraic data types (sealed
types/records in Java, discriminated unions in TypeScript, enums/structs in
Rust). Push I/O and effects to the edges; keep the core a total function of its
inputs. Parse, don't validate — turn unstructured input into precise types at
the boundary and let the types carry invariants the rest of the way.

**Willing to sacrifice:** familiarity and a little ceremony. Some contributors
find heavy type modeling verbose; accept that cost for the compile-time
guarantees and mock-free testability it buys.

**Characteristic failure mode:** over-modeling — a tower of type parameters and
wrapper types that encodes invariants nobody asked for, making the code
astronaut-architecture rather than clear. Name where your type discipline adds
ceremony out of proportion to the invariant it protects.

---

## risk-security-first

**Optimize for:** explicit trust boundaries and failure containment. Identify
every point where untrusted input, external systems, authentication, sensitive
data, uploads, command execution, or deserialization cross into the system, and
design the boundary to be defensible: validate at the edge, fail closed, least
privilege, contain blast radius so one component's compromise or crash does not
cascade. Prefer designs whose security properties are auditable.

**Willing to sacrifice:** shipping speed and some convenience. Extra validation
layers, stricter interfaces, and defensive boundaries cost time and ergonomics;
that is the trade this lens accepts.

**Characteristic failure mode:** over-fortification — threat-modeling risks that
do not exist for this feature, adding auth/validation/isolation the spec's trust
model does not warrant, and slowing delivery for defense against a nonexistent
adversary. Name where your hardening exceeds the feature's actual threat surface.

---

## performance-first

**Optimize for:** latency, throughput, and resource cost. Design the hot path
deliberately: minimize allocations and round-trips, choose data structures and
access patterns for the expected load, batch and stream where it pays, and place
caching or concurrency where the numbers justify it. Be concrete about the
performance budget the spec implies and design to hit it.

**Willing to sacrifice:** abstraction purity. Accept a leakier boundary, a
denormalized store, or a hand-tuned path when it materially moves the numbers —
but say so explicitly rather than hiding it.

**Characteristic failure mode:** premature optimization — complicating the
design for throughput the feature will never see, trading clarity and
correctness for micro-gains, or optimizing a path that is not actually hot. Name
where your performance work would be wasted if load stayed modest.

---

## codebase-conventionist

**Optimize for:** fit with the existing codebase. Mirror the patterns,
libraries, directory layout, naming, error-handling style, and testing approach
already in use. The best design here is the one that looks like it was always
part of the codebase — minimal cognitive tax on the existing team, maximal
reuse of what is already there. Extend existing modules before introducing new
ones.

**Willing to sacrifice:** novelty and best-in-class choices. Do not introduce a
better library or a cleaner pattern if it diverges from established practice;
consistency wins over local optimality here.

**Characteristic failure mode:** cargo-culting — faithfully reproducing an
existing anti-pattern or a convention that is a poor fit for this specific
feature, and propagating technical debt in the name of consistency. Name where
following convention would carry forward a flaw.
