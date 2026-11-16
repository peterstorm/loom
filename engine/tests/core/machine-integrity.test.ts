import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  admitMachineDefinition,
  machineTrustOf,
  operatorMachineSource,
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
import { frozenMap } from "../../src/core/frozen";
import { parseAgentType, type AgentType } from "../../src/machine/evidence";
import { agentTypeOf as agentType } from "../fixtures/machine-identities";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const pinned = (entries: ReadonlyArray<readonly [AgentType, Uint8Array]>): MachineTrust => ({
  kind: "pinned",
  pins: frozenMap(entries.map(([type, bytes]) => [type, artifactDigestOfBytes(bytes)] as const)),
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

describe("admitMachineDefinition: a known-answer pin", () => {
  // The pin format is anchored to a value computed outside this code base:
  // FIPS 180-2's SHA-256 of "abc". A change of algorithm, encoding or case in
  // the digest would move both sides of every other test together; not this one.
  const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  it("admits the bytes \"abc\" against their published SHA-256, and only those", () => {
    const pins = parseMachinePins({ "code-implementer-agent": ABC_SHA256 });
    if (!pins.ok) throw new Error(pins.error);
    const trust: MachineTrust = { kind: "pinned", pins: pins.value };
    expect(admitMachineDefinition(trust, IMPLEMENTER, bytesOf("abc"))).toEqual({ kind: "admitted", bytes: bytesOf("abc") });
    expect(admitMachineDefinition(trust, IMPLEMENTER, bytesOf("abd"))).toMatchObject({
      kind: "refused",
      refusal: { kind: "digest-mismatch", pinned: ABC_SHA256 },
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

describe("machineTrustOf: which spellings the pins govern", () => {
  const PINS: MachinePins = frozenMap([[IMPLEMENTER, artifactDigestOfBytes(DEFINITION)] as const]);
  const SHIPPED = ["/plugin/machines", "/real/plugin/machines"] as const;
  const paths = fc.stringMatching(/^\/[a-z]{1,6}(\/[a-z]{1,6}){0,3}$/);

  it("pins a directory whose resolved path or realpath is a spelling of the shipped one", () => {
    expect(machineTrustOf(["/link/machines", "/real/plugin/machines"], SHIPPED, PINS)).toEqual({ kind: "pinned", pins: PINS });
    expect(machineTrustOf(["/plugin/machines"], SHIPPED, PINS).kind).toBe("pinned");
  });

  it("a shipped directory that cannot be canonicalized still matches by its resolved path alone", () => {
    // The shell passes only the resolved path when realpath fails; the shipped
    // directory under that spelling must stay pinned.
    expect(machineTrustOf(["/plugin/machines"], ["/plugin/machines"], PINS).kind).toBe("pinned");
  });

  it("property: pinned exactly when the spelling sets meet", () => {
    fc.assert(fc.property(fc.array(paths, { minLength: 1, maxLength: 3 }), fc.array(paths, { minLength: 1, maxLength: 3 }), (configured, shipped) => {
      const meets = configured.some((spelling) => shipped.includes(spelling));
      return machineTrustOf(configured, shipped, PINS).kind === (meets ? "pinned" : "operator-directory");
    }));
  });

  it("property: a pinned trust carries exactly the pins it was given", () => {
    fc.assert(fc.property(fc.array(paths, { minLength: 1, maxLength: 3 }), (spellings) => {
      const trust = machineTrustOf(spellings, spellings, PINS);
      return trust.kind === "pinned" && trust.pins === PINS;
    }));
  });

  it("operatorMachineSource reads its directory as it stands", () => {
    expect(operatorMachineSource("/fixtures/machines")).toEqual({
      directory: "/fixtures/machines",
      trust: { kind: "operator-directory" },
    });
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

  it("returns pins that stay immutable at runtime, even through a cast", () => {
    const parsed = parseMachinePins({ "code-implementer-agent": digest });
    if (!parsed.ok) throw new Error(parsed.error);
    const writable = parsed.value as Map<AgentType, unknown>;
    expect(() => writable.set(agentType("forged-agent"), digest)).toThrow(/immutable/);
    expect(() => writable.delete(IMPLEMENTER)).toThrow(/immutable/);
    expect([...parsed.value.keys()]).toEqual([IMPLEMENTER]);
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
