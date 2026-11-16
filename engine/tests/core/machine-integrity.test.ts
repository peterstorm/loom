import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  admitMachineDefinition,
  parseMachinePins,
  PIN_MACHINES_COMMAND,
  renderMachinePinsModule,
  renderMachineRefusal,
  type MachinePinEntry,
  type MachinePins,
  type MachineRefusal,
  type MachineTrust,
} from "../../src/core/machine-integrity";
import { artifactDigestOfBytes } from "../../src/core/digest";
import { parseAgentType, type AgentType } from "../../src/machine/evidence";

function agentType(raw: string): AgentType {
  const parsed = parseAgentType(raw);
  if (parsed === null) throw new Error(`test fixture: invalid agent type ${JSON.stringify(raw)}`);
  return parsed;
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const pinned = (entries: ReadonlyArray<readonly [AgentType, Uint8Array]>): MachineTrust => ({
  kind: "pinned",
  pins: new Map(entries.map(([type, bytes]) => [type, artifactDigestOfBytes(bytes)])) as MachinePins,
});
const operator: MachineTrust = { kind: "operator-directory" };

const IMPLEMENTER = agentType("code-implementer-agent");
const DEFINITION = bytesOf('{"agent":"code-implementer-agent"}\n');

/** Agent types built through the production parser, never by cast. */
const agentTypes = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,24}$/)
  .map((raw) => parseAgentType(raw))
  .filter((parsed): parsed is AgentType => parsed !== null);
const definitionBytes = fc.uint8Array({ minLength: 0, maxLength: 512 });

describe("admitMachineDefinition: the shipped directory", () => {
  it("admits a definition whose bytes match its pin, handing back exactly those bytes", () => {
    const admission = admitMachineDefinition(pinned([[IMPLEMENTER, DEFINITION]]), IMPLEMENTER, DEFINITION);
    expect(admission).toEqual({ kind: "admitted", bytes: DEFINITION });
  });

  it("refuses a rewritten definition, naming both digests", () => {
    const rewritten = bytesOf('{"agent":"code-implementer-agent","enforcedTools":[]}\n');
    expect(admitMachineDefinition(pinned([[IMPLEMENTER, DEFINITION]]), IMPLEMENTER, rewritten)).toEqual({
      kind: "refused",
      refusal: {
        kind: "digest-mismatch",
        agentType: IMPLEMENTER,
        pinned: artifactDigestOfBytes(DEFINITION),
        actual: artifactDigestOfBytes(rewritten),
      },
    });
  });

  it("refuses a deleted pinned definition instead of ungating its agent", () => {
    expect(admitMachineDefinition(pinned([[IMPLEMENTER, DEFINITION]]), IMPLEMENTER, null)).toEqual({
      kind: "refused",
      refusal: { kind: "pinned-machine-missing", agentType: IMPLEMENTER, pinned: artifactDigestOfBytes(DEFINITION) },
    });
  });

  it("refuses an added definition no pin names", () => {
    const added = agentType("ts-test-agent");
    expect(admitMachineDefinition(pinned([[IMPLEMENTER, DEFINITION]]), added, DEFINITION)).toEqual({
      kind: "refused",
      refusal: { kind: "unpinned-machine", agentType: added, actual: artifactDigestOfBytes(DEFINITION) },
    });
  });

  it("leaves an agent with neither a pin nor a file ungated", () => {
    expect(admitMachineDefinition(pinned([[IMPLEMENTER, DEFINITION]]), agentType("ts-test-agent"), null))
      .toEqual({ kind: "ungated" });
  });

  it("a pin is per agent type: another agent's pin never admits this agent's bytes", () => {
    const other = agentType("distill-agent");
    expect(admitMachineDefinition(pinned([[other, DEFINITION]]), IMPLEMENTER, DEFINITION)).toMatchObject({
      kind: "refused",
      refusal: { kind: "unpinned-machine" },
    });
  });
});

describe("admitMachineDefinition: an operator directory", () => {
  it("admits whatever definition it holds and ungates an absent one", () => {
    expect(admitMachineDefinition(operator, IMPLEMENTER, DEFINITION)).toEqual({ kind: "admitted", bytes: DEFINITION });
    expect(admitMachineDefinition(operator, IMPLEMENTER, null)).toEqual({ kind: "ungated" });
  });
});

describe("admitMachineDefinition properties", () => {
  it("round trip: bytes pinned for an agent type are admitted unchanged", () => {
    fc.assert(fc.property(agentTypes, definitionBytes, (type, bytes) => {
      const admission = admitMachineDefinition(pinned([[type, bytes]]), type, bytes);
      return admission.kind === "admitted" && admission.bytes === bytes;
    }));
  });

  it("tamper evidence: any other bytes for a pinned agent are refused", () => {
    fc.assert(fc.property(agentTypes, definitionBytes, definitionBytes, (type, original, tampered) => {
      fc.pre(Buffer.compare(Buffer.from(original), Buffer.from(tampered)) !== 0);
      const admission = admitMachineDefinition(pinned([[type, original]]), type, tampered);
      return admission.kind === "refused" && admission.refusal.kind === "digest-mismatch";
    }));
  });

  it("a pinned agent type is never ungated, whatever its file holds or whether it exists", () => {
    fc.assert(fc.property(agentTypes, definitionBytes, fc.option(definitionBytes, { nil: null }), (type, original, file) => {
      return admitMachineDefinition(pinned([[type, original]]), type, file).kind !== "ungated";
    }));
  });

  it("an operator directory never refuses", () => {
    fc.assert(fc.property(agentTypes, fc.option(definitionBytes, { nil: null }), (type, file) => {
      return admitMachineDefinition(operator, type, file).kind !== "refused";
    }));
  });
});

describe("renderMachineRefusal", () => {
  const digest = artifactDigestOfBytes(DEFINITION);
  const refusals: readonly MachineRefusal[] = [
    { kind: "pinned-machine-missing", agentType: IMPLEMENTER, pinned: digest },
    { kind: "unpinned-machine", agentType: IMPLEMENTER, actual: digest },
    { kind: "digest-mismatch", agentType: IMPLEMENTER, pinned: digest, actual: artifactDigestOfBytes(bytesOf("x")) },
  ];

  it.each(refusals)("names the agent, the digest and the re-pin command ($kind)", (refusal) => {
    const text = renderMachineRefusal(refusal);
    expect(text).toContain(IMPLEMENTER);
    expect(text).toContain(digest);
    expect(text).toContain(PIN_MACHINES_COMMAND);
  });
});

describe("parseMachinePins", () => {
  const digest = artifactDigestOfBytes(DEFINITION);

  it("parses agent types to digests", () => {
    const parsed = parseMachinePins({ "code-implementer-agent": digest });
    expect(parsed.ok && [...parsed.value]).toEqual([[IMPLEMENTER, digest]]);
  });

  it("refuses a key that is not an agent type", () => {
    expect(parseMachinePins({ "../outside": digest })).toMatchObject({ ok: false, error: expect.stringContaining("not an agent type") });
  });

  it("refuses a value that is not a SHA-256 digest", () => {
    expect(parseMachinePins({ "code-implementer-agent": "not-a-digest" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("not a SHA-256 digest") });
  });
});

describe("renderMachinePinsModule", () => {
  const entry = (type: AgentType, bytes: Uint8Array): MachinePinEntry => ({ agentType: type, digest: artifactDigestOfBytes(bytes) });

  it("renders a generated module whose record parses back to the same pins", () => {
    const entries = [entry(IMPLEMENTER, DEFINITION), entry(agentType("distill-agent"), bytesOf("d"))];
    const text = renderMachinePinsModule(entries);
    expect(text).toMatch(/^\/\*\*\n \* @generated by `npm run pin-machines`/);
    const record: unknown = JSON.parse(`{${[...text.matchAll(/^ {2}("[^"]+": "[0-9a-f]{64}"),$/gm)].map((m) => m[1]).join(",")}}`);
    const parsed = parseMachinePins(record as Record<string, string>);
    expect(parsed.ok && Object.fromEntries(parsed.value)).toEqual(
      Object.fromEntries(entries.map(({ agentType: type, digest }) => [type, digest])),
    );
  });

  it("is independent of entry order", () => {
    const entries = fc.uniqueArray(
      fc.tuple(agentTypes, definitionBytes).map(([type, bytes]) => entry(type, bytes)),
      { selector: (pin) => pin.agentType, maxLength: 8 },
    );
    fc.assert(fc.property(entries, (pins) => {
      return renderMachinePinsModule(pins) === renderMachinePinsModule([...pins].reverse());
    }));
  });
});
