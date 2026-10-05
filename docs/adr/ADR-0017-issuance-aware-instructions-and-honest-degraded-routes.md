# ADR-0017: Issuance-aware instructions and honest degraded routes

## Status
Accepted

## Context
Grammar-constrained decoding adds an optional emission path: a producer Agent
(reviewer `reviewer-payload` v2/v3, `judge-verdict` v1, `refutation-verdict` v1)
can deliver its structured payload by calling one exact, frozen-schema emission
tool instead of writing a final-message JSON object for extraction. That tool
only exists on a subset of routes. Claude Code has no Loom extension seam that
can register it. Pi routes are emission-capable only when the exact
provider/model has been qualified for the frozen schema digests. Archived
reviewer protocols (schema-1 registrations), panel verdict paths and
implementation spawns have no issued emission schema at all. Final-message
extraction stays the deterministic contract everywhere.

Spawn instructions are the only thing the model reads, so they have to match
the route the engine actually issued. If every context told the Agent to "call
`<tool>` exactly once", a Claude Code reviewer or one on an unqualified route
would be pointed at a tool that does not exist. That wastes turns, can produce
malformed fallbacks, and calls itself "degradation compatibility" when it is
really a silent contract mismatch. Rewriting instructions globally would also
change the bytes of archived v1/v2/v3 request and context packets. Those packets
are digest-bound issued evidence, and existing replay and admission joins rely
on them staying byte-stable.

Second, the spawn task text needs to carry enough identity for parent admission
(and the ADR-0014 launcher readiness barrier) to know which tool, kind, version and
schema digest a child must activate. Task text is model- and operator-visible
prose, so it cannot itself grant permission. A model or a forwarded prompt could
contain any marker. Version and digest must come from the issued packet, not
from current registry defaults or tool-call arguments. When an
emission-enabled request is missing its descriptor, that has to be an error, not
an ordinary absence. When a non-producer or explicitly extraction-only request
has no descriptor, that has to be normal.

## Options Considered

1. **Issuance-aware rendering from the issued route (chosen)**
   - Pros: an instruction never names a tool the route cannot provide. Archived
     and extraction-only contracts keep their exact final-message bytes. One pure
     route decision drives both the descriptor and the instruction text. The
     descriptor is only a projection that admission re-joins against
     independently read issued authority. Descriptor loss on an emission-enabled
     request fails closed.
   - Cons: two instruction variants to keep consistent (tool-primary and
     final-message). The render shell must read the durable program registration
     and qualify the route before producing task text. Docs tests have to pin
     both wordings separately.

2. **Globally stamp tool-primary wording into all historical and current contexts**
   - Pros: one instruction text everywhere, and stamping is simple.
   - Cons: it tells Claude Code, unqualified Pi routes and archived protocols to
     call a tool they do not have. It mutates archived v1/v2/v3 request/context
     bytes, breaking digest-bound replay and evidence. Degradation would be
     dishonest: the instruction claims a capability the route lacks.

3. **Accept the first emission marker found in prompt text as the capability claim**
   - Pros: no issued-authority read at admission. Simple string scan.
   - Cons: any model-, operator- or forwarded-prompt-supplied marker becomes a
     permission claim. Duplicated or contradictory markers are resolved by
     position instead of refused. Version and digest could come from text or
     defaults instead of the issued packet. A missing descriptor on an
     emission-enabled request looks the same as a legitimately extraction-only
     request.

4. **Advertise the tool everywhere and rely on extraction fallback when it is missing**
   - Pros: no route-specific rendering.
   - Cons: the instruction still points at an unavailable tool. On Claude Code
     the tool cannot be registered at all. The cost of a missing tool shows up as
     extra model turns and noisy fallbacks instead of an explicit, operator-visible
     extraction-only route.

## Decision
**Render tool-primary instructions and the emission descriptor only for requests whose issued route is emission-enabled. Every other request keeps its caller's final-message instruction verbatim, and the descriptor is a projection of issued authority, never a standalone permission claim.**

Route decision (pure, `engine/src/core/spawn-admission.ts`):
- `decideRequestEmissionRoute(claim, capability)` returns a closed
  `EmissionRouteDecision`: `emission` (binding + context digest),
  `extraction-only` (with reason) or `refused` (with reason).
  - An issued contract that selects no frozen registry cell is `extraction-only`
    by issuance, regardless of surface.
  - A provided surface whose schema digest differs from the issued cell's is
    `refused`.
  - A not-provided surface follows its degradation class (`extraction` or
    `refuse`).
- `qualifyIssuedSpawnEmissionRoute` derives capability from authenticated
  request route data plus the shell-observed fact that the parent is Pi.
  - A non-Pi parent (Claude Code) is extraction-only.
  - A Pi provider/model other than the qualified route is extraction-only.
  - A missing registry cell is extraction-only.
  - The parent's mutable provider/model is deliberately not an input.
- `EmissionRouteDecision` is the one route vocabulary. Issued spawn authority
  carries its non-refused subtype (`IssuedSpawnEmissionRoute`), so request
  programs, the capture runtime, and Pi parent admission all discriminate on
  the same `kind` and no consumer translates between vocabularies.

Instruction and descriptor projection:
- `projectEmissionTaskText(route, baseInstruction)` (`spawn-admission.ts`) is
  the single task-text projection.
  - **Emission routes** get `renderEmissionDescriptor(binding, contextDigest)`
    plus `baseInstruction` followed by `emissionToolPrimaryInstruction(binding)`.
    That instruction names the exact issued tool, makes one call the primary
    final action, forbids a second call in the same spawn, and describes
    final-message fallback for when the tool is unavailable or refuses the
    arguments.
  - **Extraction-only routes** get an empty descriptor and `baseInstruction`
    verbatim. The extraction-only reason is kept outside the task bytes and
    reported on an operator surface (`loom-emission-route` stderr event).
- `renderReviewerWireInstructions(route)`
  (`engine/src/core/reviewer-protocol.ts`) renders either
  `reviewerEmissionToolContract(toolName)` or the frozen
  `REVIEWER_OUTPUT_CONTRACT` verbatim.
  - `ReviewerWireInstructionRoute` has no refused arm, so a refused route
    cannot be rendered.
  - Tool-primary wording lives once in `engine/src/core/reviewer-contract.ts`
    (`reviewerEmissionToolContract`, `REVIEWER_EMISSION_TOOL_CONTRACT_TEMPLATE`).
    It reaches stamped shims only through `scripts/stamp-wire-contract.ts`.
  - Schema and rubric bytes are unchanged, so protocol descriptor digests are
    stable.
- `reviewerEmissionProjection` (`engine/src/handlers/helpers/programs/spawn-task.ts`)
  is the shell.
  - It gates eligibility with `reviewerEmissionEligible`: reviewer roles on
    `standalone-review` or `wave-gate` only. Spec-check slots, panel verdicts and
    implementation spawns are projected with no descriptor and their instruction
    verbatim.
  - It binds any supplied emission authority to the request's own program.
  - It joins that authority against the durable program registration's protocol
    projection before any delivery I/O.
  - It qualifies the route and throws on `refused`. There is no silent
    degradation and no fallback to a tool the surface cannot provide.
  - Archived schema-1 publication renders every task extraction-only. It refuses
    when an emission-eligible request's registration is current rather than
    archived.

Descriptor grammar and admission:
- One line: `LOOM_EMISSION_DESCRIPTOR: <toolName> <kind> <version> <requestId>
  <contextDigest> <schemaDigest>` (`EMISSION_DESCRIPTOR_MARKER`). The render is
  deterministic, so retries and recovered spawns carry byte-identical
  descriptors.
- `parseEmissionDescriptor` is total over arbitrary text and returns `absent`,
  `issued` or `malformed`.
  - More than one line is `descriptor-cardinality`. The parser never picks the
    "first marker".
  - A wrong field count is `descriptor-fields`.
  - Tool, kind, version, request and schema fields are re-minted through
    `issueEmissionBinding` against the frozen registry, not trusted.
  - The context digest is parsed independently.
- `expectedSpawnEmissionCapability` joins the parsed descriptor with
  independently read issued authority (`readIssuedRequest` keyed by the task's
  `LOOM_REQUEST_ID` / `LOOM_CONTEXT_DIGEST` markers):
  - A descriptor on an unbound task fails.
  - A descriptor on a non-producer Agent (per `producerKindsOfAgent`) fails.
  - A descriptor on an issued extraction-only route fails. Extraction-only
    authority cannot be upgraded by task text.
  - An issued route that differs from request/protocol authority fails.
  - A **missing or malformed descriptor on an issued emission-enabled request
    fails**.
  - Absence on non-producer or extraction-only requests is the ordinary
    `no-emission-tool` expectation.
- Version and schema digest always come from the issued claim and its frozen
  registry cell. They never come from current defaults or from the model's tool
  arguments.

Invariants:
- No rendered instruction names a tool that the issued route cannot provide.
- Archived v1/v2/v3 request/context bytes and extraction-only instruction text
  are byte-identical to their pre-feature forms.
- A descriptor alone never authorizes emission. Admission requires matching
  issued authority.
- Tests: `engine/tests/core/spawn-admission.test.ts` (expected capability and
  explicit extraction-only routes), `engine/tests/core/reviewer-protocol-docs.test.ts`
  (new vs archived/extraction-only wording) and `engine/tests/wire-contract.test.ts`
  (stamp/schema consistency). The extraction-only flow is documented in
  `agents/README.md`.

## Consequences

**Positive:**
- Claude Code, unqualified Pi routes and archived protocols get honest
  final-message instructions. Their extraction behavior and bytes are unchanged
  (the zero-call containment baseline of ADR-0019).
- Emission-enabled Agents are told the exact issued tool name and the one-call
  rule. That rule is also enforced by the engine's duplicate-call ambiguity
  policy, so the instruction and the engine agree.
- Descriptor loss, duplication, tampering, or an attempted upgrade of an
  extraction-only request fails closed at parent admission with a named reason,
  before any model request.
- The route decision is pure and in one place. The render, admission and
  launcher readiness barrier (ADR-0014) consume the same decision instead of
  re-deriving it.
- The extraction-only reason is visible to operators without polluting the task
  bytes the model sees.

**Negative:**
- Two instruction variants (tool-primary and final-message) must be kept in sync
  by docs/stamp tests. A wording change in either one needs re-stamping through
  `scripts/stamp-wire-contract.ts`.
- Rendering now depends on reading and parsing the durable program registration
  and qualifying the route. A corrupt registration or a refused route makes the
  render throw, which surfaces as a drive failure, not a degraded spawn. This is
  intended, but it is stricter than before.
- Route qualification is a hard-coded trusted route (`QUALIFIED_EMISSION_ROUTE`).
  Any other Pi provider/model is extraction-only until it is explicitly qualified
  and admitted, even if it would work in practice.
- The descriptor travels in task text. It is safe only because admission
  re-joins it with issued authority. Any future consumer that reads the
  descriptor without that join would bring back the rejected "first marker wins"
  trust model.
