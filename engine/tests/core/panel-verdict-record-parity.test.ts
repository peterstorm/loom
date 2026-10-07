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
  type EmissionToolVerdictSource,
  type PanelVerdictSource,
} from "../../src/core/panel-verdict-source";
import type { EmissionToolCall } from "../../src/core/emission-observation";
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
const source: EmissionToolVerdictSource = {
  source: "emission-tool", toolCallId: "call-1", producerKind: "judge-verdict", emissionSchemaVersion: "v1", schemaDigest: digest("schema"),
};
const call: EmissionToolCall = {
  requestId, toolCallId: "call-1", kind: { kind: "judge-verdict" }, version: "v1", arguments: { criterion: "simplicity" },
};
const build = (overrides: Readonly<{ source?: PanelVerdictSource; acceptedCall?: EmissionToolCall | undefined }>) =>
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
  // A record names a verdict producer kind: the constructor refuses a
  // non-verdict call exactly as the parser does, so no such record is ever
  // built and handed to the replay.
  ["a non-verdict producer kind", {
    source: { ...source, producerKind: "reviewer-payload", emissionSchemaVersion: "v2" },
    acceptedCall: { ...call, kind: { kind: "reviewer-payload" }, version: "v2" },
  }, "is not a panel verdict kind"],
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

  // The panel-verdict-kind guard reads its table by OWN key only. An inherited
  // `Object.prototype` name is truthy under a plain index lookup
  // (`PANEL_VERDICT_KINDS["constructor"]` is a function), and the table's own
  // `false` row must refuse exactly as an unknown name does.
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "reviewer-payload"])(
    "refuses an accepted call naming %j as its producer kind, at construction and on re-read", (kindName) => {
      const kind = { kind: kindName } as unknown as EmissionToolCall["kind"];
      const built = build({
        source: { ...source, producerKind: kindName as EmissionToolVerdictSource["producerKind"] },
        acceptedCall: { ...call, kind },
      });
      expect(built.ok).toBe(false);
      if (built.ok) throw new Error("unreachable");
      expect(built.error).toContain(`producer kind ${JSON.stringify(kindName)}, which is not a panel verdict kind`);

      const valid = build({});
      if (!valid.ok) throw new Error(valid.error);
      const persisted = JSON.parse(JSON.stringify(valid.value)) as Record<string, unknown>;
      const reread = parsePanelVerdictSourceRecord({
        ...persisted,
        source: { ...(persisted.source as object), producerKind: kindName },
        acceptedCall: { ...(persisted.acceptedCall as object), kind: JSON.parse(`{"kind":${JSON.stringify(kindName)}}`) },
      });
      expect(reread.ok).toBe(false);
      if (reread.ok) throw new Error("unreachable");
      expect(reread.error).toContain(`producer kind ${JSON.stringify(kindName)}, which is not a panel verdict kind`);
    });
});
