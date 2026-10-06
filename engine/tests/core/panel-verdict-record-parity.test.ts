/**
 * The durable panel verdict source record's accepted-call invariant has ONE
 * owner: the constructor refuses exactly what the parser refuses, so a
 * disagreeing record fails where it is built instead of first on re-read.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  panelVerdictSourceRecord,
  parsePanelVerdictSourceRecord,
  type PanelVerdictEmissionCall,
  type PanelVerdictSource,
} from "../../src/core/panel-verdict-source";
import {
  parseArtifactDigest,
  parseRequestId,
  parseSlotId,
  type ArtifactDigest,
  type RequestId,
} from "../../src/core/orchestration-contract";

const digest = (seed: string): ArtifactDigest => {
  const parsed = parseArtifactDigest(createHash("sha256").update(seed).digest("hex"));
  if (!parsed.ok) throw new Error("fixture digest must parse");
  return parsed.value;
};
const requestIdOf = (raw: string): RequestId => {
  const parsed = parseRequestId(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};
const slot = (() => {
  const parsed = parseSlotId("judge:1");
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
})();

const requestId = requestIdOf("run.record-parity:judge:1:1");
const source: PanelVerdictSource = {
  source: "emission-tool", toolCallId: "call-1", producerKind: "judge-verdict", emissionSchemaVersion: "v1", schemaDigest: digest("schema"),
};
const call: PanelVerdictEmissionCall = {
  requestId, toolCallId: "call-1", kind: { kind: "judge-verdict" }, version: "v1", arguments: { criterion: "simplicity" },
};
const build = (overrides: Readonly<{ source?: PanelVerdictSource; acceptedCall?: PanelVerdictEmissionCall | undefined }>) =>
  panelVerdictSourceRecord({
    requestId, slotId: slot, attempt: 1, source, acceptedCall: call,
    payloadDigest: digest("payload"), payloadByteLength: 12, ...overrides,
  });

/** Every disagreement the parser refuses on re-read, built through the constructor. */
const disagreements: readonly (readonly [string, Parameters<typeof build>[0], string])[] = [
  ["a different request", { acceptedCall: { ...call, requestId: requestIdOf("run.record-parity:judge:1:2") } }, "different request"],
  ["a different tool call", { acceptedCall: { ...call, toolCallId: "call-2" } }, "identity disagrees with the record's source arm"],
  ["a different producer kind", { acceptedCall: { ...call, kind: { kind: "refutation-verdict" } } }, "producer kind disagrees"],
  ["a different schema version", { acceptedCall: { ...call, version: "v2" } }, "schema version disagrees"],
  ["no accepted call on the emission arm", { acceptedCall: undefined }, "requires the accepted call"],
  ["an accepted call on the extraction arm", { source: { source: "extraction" } }, "must not carry an accepted call"],
];

describe("panel verdict source record: constructor and parser share one invariant", () => {
  it("builds an agreeing emission record that parses back unchanged", () => {
    const built = build({});
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error);
    expect(parsePanelVerdictSourceRecord(JSON.parse(JSON.stringify(built.value)))).toEqual({ ok: true, value: built.value });
  });

  it.each(disagreements)("refuses %s at construction with the parser's diagnostic", (_label, overrides, diagnostic) => {
    const built = build(overrides);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error).toContain(diagnostic);

    // The same disagreement, persisted, refuses on re-read with the same words
    // (JSON drops an `acceptedCall: undefined` override, as persistence would).
    const valid = build({});
    if (!valid.ok) throw new Error(valid.error);
    const reread = parsePanelVerdictSourceRecord(JSON.parse(JSON.stringify({ ...valid.value, ...overrides })));
    expect(reread.ok).toBe(false);
    if (reread.ok) throw new Error("unreachable");
    expect(reread.error).toContain(diagnostic);
  });
});
