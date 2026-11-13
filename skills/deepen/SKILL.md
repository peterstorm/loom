---
name: deepen
version: "1.0.0"
description: "Find shallow modules and misplaced seams in existing code and propose interface-changing refactors (consolidate modules, move a seam, narrow an interface). Not for cleanup inside existing interfaces (distill), new-feature design (architecture-tech-lead) or PR review (/review-pr)."
---

# Deepen — Proactive Architecture Improvement

Surface architectural friction in existing code and propose **deepening opportunities**: refactors that turn shallow modules into deep ones. The goal is testability, locality and leverage.

Deepen is for when the interface itself is the problem. Cleanup that leaves every interface alone is `distill`; the boundary between the two is stated in distill's `SKILL.md`. New-feature design is `architecture-tech-lead`. PR review is `/review-pr`, whose `architecture-tech-lead` reviewer preloads this skill in review mode.

## Context Loading

If not already in context this session, read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` and the one language rule matching the files in scope.

Also read `CONTEXT.md` at the repo root if it exists (the ubiquitous language) and `docs/adr/` (decisions already made). If a `CONTEXT-MAP.md` exists, read only the context files it lists for the area you are working in.

## Vocabulary

Use the terms defined in [LANGUAGE.md](./references/LANGUAGE.md) in every suggestion: **module**, **interface**, **depth** (deep / shallow), **seam**, **adapter**, **leverage**, **locality**. Read it before the first session; it also maps each term to the FC/IS and DDD patterns in the architecture rule. Say "seam", not "boundary", so the word does not collide with bounded contexts.

Three tests do most of the work:

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam.
- **One adapter is a hypothetical seam; two adapters is a real one.** A port needs a production adapter and a test fake to exist.

Frame every proposal in the project's FC/IS and DDD model, and name where things move using the package structure in the language rule:

- "This logic is scattered across 3 shell orchestrators — extract a pure domain function in the functional core"
- "These 5 small validators are shallow; merge into one aggregate command function with a rich Either error type"
- "This port wraps another port — one adapter, hypothetical seam, delete the indirection"
- "This orchestrator imports from infra/ directly — introduce a port in domain/port/, move the concrete to infra/"

## Two Modes

The skill runs in exactly one of two modes. Decide which before exploring.

### Review mode — findings, never a session

Active when preloaded by the `architecture-tech-lead` reviewer (standalone `/review-pr` or any engine-issued review), or whenever the user asks for an assessment rather than a design session.

- Scope is the exact frozen scope you were given. Explore it with the questions from Process step 1, but never widen it.
- Report each candidate as a finding: **files**, **problem** (depth/leverage/locality terms), **proposed deepening**, **benefits**. Stop at Process step 2 — the candidates are the findings.
- Do not walk the design tree, do not design interfaces, do not update `CONTEXT.md`, and never edit files.

**Severity discipline.** Deepening findings are almost always **advisory** — an interface can nearly always be deepened later. Reserve **critical** for shallowness that hides *wrongness*: a seam whose adapters disagree about its contract, an invariant enforced in some callers and not others, business logic in the shell that no test can reach. "This module could be deeper" is advisory, always. In an engine-issued review, the issued schema and rubric override this paragraph.

### Session mode — walk the design tree

Active when the user invokes deepen directly. Run the full Process below: explore, present candidates, grill, optionally design interfaces, and update `CONTEXT.md` as each decision lands.

## Process

### 1. Explore

Explore the codebase and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where has logic been extracted "for testability" but the real bugs hide in how it's called? (No **locality**)
- Where do tightly-coupled modules leak across their seams?
- Where is business logic mixed with I/O?
- Where are there ports with only one adapter and no test fake?
- Where are aggregates too large (god aggregate) or too fragmented (logic scattered)?

Apply the deletion test to anything suspicious: would deleting it concentrate complexity, or just move it?

### 2. Present Candidates

Present a numbered list of deepening opportunities. For each:

- **Files** — which files/modules are involved
- **Problem** — why the current shape causes friction (use depth/leverage/locality language)
- **Deepening** — plain English description of what changes
- **Benefits** — in terms of locality, leverage, testability, and FC/IS alignment

Use `CONTEXT.md` vocabulary for the domain and depth vocabulary for the architecture. If `CONTEXT.md` defines "Order", say "the Order aggregate command functions", not "the OrderHandler" or "the order service".

If a candidate contradicts an existing ADR, surface it only when the friction is real and specific, and mark it: _"contradicts ADR-0007 — worth reopening because…"_

Do NOT propose interfaces yet. Ask: **"Which of these would you like to explore?"**

### 3. Grilling Loop

Once the user picks a candidate, walk its design tree depth-first:

- What constraints must any new interface satisfy?
- What does the module depend on? Classify each dependency with [DEEPENING.md](./references/DEEPENING.md) (in-process, local-substitutable, own service across a network, true external); the category decides where the seam goes and how it is tested.
- What sits behind the seam? What is the interface?
- Which tests survive the refactor, and which are deleted? ("Replace, don't layer" in DEEPENING.md.)

Record decisions as they land, never in a batch at the end:

- A new domain concept, or a fuzzy term sharpened: update `CONTEXT.md`, or the context file `CONTEXT-MAP.md` lists for that area when a map exists (format: [CONTEXT-FORMAT.md](../grill/references/CONTEXT-FORMAT.md)).
- The user rejects a candidate for a load-bearing reason: offer an ADR, but only when a future explorer would re-suggest the refactor without it.

### 4. Interface Design (optional)

If the user wants alternatives for the deepened module, propose two or three radically different designs:

1. **Minimal interface** — 1-3 entry points. Maximum leverage per entry point.
2. **Flexible interface** — supports many callers and extension points.
3. **Default-optimized** — the most common caller's path is trivial.

For each, show the interface shape (types, methods, invariants, error modes), a usage example for the most common caller, what the implementation hides behind the seam, the dependency strategy and adapters, and where leverage is high or thin. Compare by depth, locality and seam placement, then recommend one.

## What NOT to Do

- Don't propose deepenings that only reduce line count — depth is about leverage, not brevity.
- Don't deepen across bounded contexts without checking `CONTEXT.md`.
- Don't implement — this skill proposes and designs; implementation is a separate task.

## Completion

**Review mode output:** the candidate findings, each anchored to its files, severity-disciplined as above. Nothing designed, nothing written.

**Session mode** is complete when the selected candidates are designed to shared understanding, any explored interface shapes are agreed, the testing strategy is clear and the `CONTEXT.md` updates are written. Output:

- Summary of deepening decisions
- `CONTEXT.md` changes (terms added or modified)
- Suggested implementation order
- Whether this warrants a `/loom` orchestration or is a targeted refactor
