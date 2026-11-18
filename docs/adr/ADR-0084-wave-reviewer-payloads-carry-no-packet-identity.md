# ADR-0084: Wave reviewer payloads carry no packet identity; the issued subject binds it

## Status
Accepted (2026-11-17). Partly supersedes ADR-0009: the exact packet/generation join of a Wave payload. Issue #213, Cause 1.

## Context
ADR-0009 required every Wave reviewer payload to echo the exact `packetId` (a 64-hex SHA-256 digest) and
`generation` of its Review Packet, and admission refused a payload whose values differed from issuance.
Attempt 2 is final. In a live run a reviewer mistyped the hash on its final attempt. The slot was exhausted,
the Wave Gate could only be restarted, and `orchestration restart` reissued all 35 requests.

The echo proved nothing the engine did not already hold. Each issued request names its slot and the digest
of its Context Packet, and admission resolves the packet's subject, including the Review Packet ID and the
Review Generation, from that authority before it reads a byte of the payload. Copying 64 hex characters by
hand was the only part of the payload a reviewer could get wrong with no judgement involved.

## Options Considered

1. **Keep v2 and scope restarts to the failed slots**
   - Pros: no protocol change.
   - Cons: the defect stays. A mistyped hash still costs a reviewer its final attempt; only the blast radius
     shrinks. Restart carry-over is still worth doing, and is a separate change with its own ADR.

2. **Keep the fields and accept a near-miss**
   - Pros: no new descriptor.
   - Cons: a fuzzy join on an identity is no join. The fields would be decoration that admission ignores.

3. **A new Wave payload version without the fields; the issued subject binds them**
   - Pros: the reviewer copies nothing it cannot judge. The bound evidence keeps the same Review Packet ID and
     Review Generation, now taken from authority instead of from the payload.
   - Cons: a new descriptor, schema and emission cell, and the stamped wire contract must serve v2 and v4
     runs at once.

## Decision
**A Wave Gate registered from now on issues reviewer protocol v4. Its payload is
`{"schemaVersion": 4, "kind": "wave-review", "prior_findings", "findings"}` and nothing else.**

- The descriptor is `{protocol: "loom-reviewer", version: 4, rubricVersion: 1, schemaDigest, rubricDigest}`.
  It is version 4, never 3, so it cannot be confused with the standalone successor descriptor of ADR-0010.
  The registration and packet layout stay at schema version 2; the descriptor's `version` selects the
  decoder.
- v4 is Wave-only. A standalone review registration, its results and remediation admit the v2 descriptor
  alone, and the types say so (`ReviewerProtocolDescriptorV2`).
- The v4 schema is strict. A payload that still carries `packetId` or `generation` is refused, and the
  refusal names the v4 envelope.
- Everything else in ADR-0009 stands. Every issued prior Finding ID is assessed exactly once in packet
  order, an out-of-scope finding file is named, and attempt 2 is final.
- Admission binds `bound.packetId` and `bound.generation` from the issued subject. Stored review evidence is
  unchanged, so persisted state needs no migration.
- A Wave Gate registered under v2 before this change keeps v2 until it ends: its issued requests and its
  attempt-2 retries are decoded by v2, exactly as before. Persisted Task review state keeps its v2
  descriptor and stays readable.
- A restart or orphan-recovery replacement is a new registration and issues v4, whatever its predecessor
  issued. Every request is reissued, so no reviewer straddles the two protocols.
- The emission tool registry carries a reviewer-payload v4 cell, and the issued claim's version is the
  descriptor's own version.
- One stamped wire contract serves both: the packet's `reviewer-payload-schema` governs, and the task states
  whether `packetId` and `generation` are required. Its "Wave review v4" section shows a parsed v4 example
  (ADR-0073).

## Consequences
- A mistyped packet identity can no longer exhaust a Wave review slot.
- The probe manifest carries a reviewer-payload v4 fixture. The committed live recordings predate it: the
  qualified route's serializer has not yet been re-run against the v4 schema. The v4 schema uses only
  constructs the v2 Wave arm already uses, so it is expected to qualify, but no recording proves it yet.
- Standalone review is unchanged.
