# Language

Shared vocabulary for architectural improvement suggestions. Use these terms exactly — don't substitute "component", "service", "API", or "boundary". Consistent language is the whole point.

This vocabulary is complementary to the project's `CONTEXT.md` (domain terms) and `rules/architecture.md` (FC/IS, DDD, ports). Domain concepts use `CONTEXT.md` terms. Architectural shape uses these terms.

## Terms

**Module**:
Anything with an interface and an implementation. Deliberately scale-agnostic — applies equally to a function, class, package, or tier-spanning slice.
_Avoid_: unit, component, service.

**Interface**:
Everything a caller must know to use the module correctly. Includes the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics.
_Avoid_: API, signature (too narrow — those refer only to the type-level surface).

**Implementation**:
What's inside a module — its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repository) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth**:
Leverage at the interface — the amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface. A module is **shallow** when the interface is nearly as complex as the implementation.

**Seam** _(from Michael Feathers)_:
A place where you can alter behaviour without editing in that place. The *location* at which a module's interface lives. Choosing where to put the seam is its own design decision, distinct from what goes behind it.
_Avoid_: boundary (overloaded with DDD bounded contexts — use "seam" for architecture, "bounded context" for domain).

**Adapter**:
A concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside). Aligns with our Port/Adapter pattern in `rules/architecture.md`.

**Leverage**:
What callers get from depth. More capability per unit of interface they have to learn. One implementation pays back across N call sites and M tests.

**Locality**:
What maintainers get from depth. Change, bugs, knowledge, and verification concentrate at one place rather than spreading across callers. Fix once, fixed everywhere.

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, swappable parts — they just aren't part of the interface. A module can have **internal seams** (private to its implementation, used by its own tests) as well as the **external seam** at its interface.

- **The deletion test.** Imagine deleting the module. If complexity vanishes, the module wasn't hiding anything (it was a pass-through). If complexity reappears across N callers, the module was earning its keep.

- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape.

- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it. This aligns with our port rule: "skip the port and call the concrete thing" unless two adapters are justified (typically production + test fake).

## Relationship to Our Architecture

| Depth Term | Our Pattern | How They Connect |
|------------|------------|------------------|
| Module | Any unit in FC or IS | Scale-agnostic; applies to value objects, aggregates, orchestrators, ports |
| Interface | Port interface / aggregate command function signature | The surface callers and tests see |
| Seam | Port boundary at I/O edge | Where the functional core meets the imperative shell is the primary seam |
| Adapter | Port implementation | In-memory fake (test) and real implementation (production) |
| Deep module | Well-designed functional core function | Rich behaviour, small interface, trivially testable |
| Shallow module | Pass-through orchestrator or wrapper port | Interface as complex as implementation — consider deletion |
| Locality | Aggregate / value object with constructor invariants | Invariants, validation, and business rules concentrated in one place |

## Rejected Framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or Java `interface`**: too narrow — interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD bounded contexts. Say **seam** for architectural shape, **bounded context** for domain boundaries.
- **"Service"**: overloaded with DDD domain services, Spring @Service, and microservices. Use **module** for the general case, **shell orchestrator** for the FC/IS pattern.
