/**
 * The legacy panel program's functional core (core/legacy-panel-decisions), at
 * its interface: registration, the issuance join, record parsing,
 * verdict-source selection, settlement, and the deterministic operation
 * reducer — all over plain data, no Run Directory. The shell adapters in
 * handlers/helpers/programs/legacy-panel (`resolvePanelAttemptVerdictSource`,
 * `settlePanelAttemptSubmission`, `panelOperationEvidence`) are exercised
 * end-to-end by tests/handlers/helpers/orchestration.test.ts.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { agentRequestAuthority } from "../../../fixtures/agent-request-authority";
import { issueEmissionBinding } from "../../../../src/core/emission-tool";
import { observeEmissionCalls } from "../../../../src/core/harness-capture";
import {
  executeDeterministicPanelOperation,
  joinPanelAttemptIssuance,
  logicalPanelRequestId,
  panelVerdictEmissionPort,
  parsePanelVerdictSourceRecordBytes,
  parseRegisteredPanelProgram,
  selectPanelAttemptVerdictSource,
  settlePanelAttempt,
  type PanelAttempt,
  type PanelEvidenceLookup,
  type PanelOperationEvidence,
  type RegisteredPanelProgram,
} from "../../../../src/core/legacy-panel-decisions";

const RUN = "run.legacy-panel";
const VERIFIER = "refutation:verifier:1";
const refutationInput = { criticalFindingIds: ["T1:finding-1"], lenses: ["reproduction"] };

function registration(raw: unknown): RegisteredPanelProgram {
  const parsed = parseRegisteredPanelProgram(raw);
  if (parsed === null) throw new Error("fixture registration refused");
  return parsed;
}

const refutation = () => registration({ schemaVersion: 1, kind: "refutation", input: refutationInput });
const architecture = () => registration({
  schemaVersion: 1,
  kind: "architecture",
  input: { candidateLenses: ["type-driven-fp"], judgeCriteria: ["simplicity"] },
});

const verdictPayload = (verdict: "upheld" | "refuted") => ({
  criterion: "reproduction",
  verdicts: [{
    finding_id: "T1:finding-1",
    verdict,
    reasoning: verdict === "upheld"
      ? "The current immutable packet still exhibits the finding"
      : "The current immutable packet does not exhibit the finding",
  }],
});

const verifierRequest = (overrides: Record<string, unknown> = {}) =>
  agentRequestAuthority(RUN, { requestId: VERIFIER, slotId: "refutation-slot:1", program: "refutation-panel", ...overrides });

function refutationEmission(requestId = VERIFIER, kind: "refutation-verdict" | "judge-verdict" = "refutation-verdict") {
  const binding = issueEmissionBinding({ requestId, kind, version: "v1" });
  if (!binding.ok) throw new Error(binding.error.message);
  const observation = observeEmissionCalls([Object.freeze({
    kind: "complete" as const,
    call: Object.freeze({
      requestId,
      toolCallId: "legacy-unit-call",
      kind: Object.freeze({ kind }),
      version: "v1" as const,
      arguments: verdictPayload("refuted"),
    }),
  })]);
  return { binding: binding.value, observation, port: panelVerdictEmissionPort };
}

function joined(attempt: PanelAttempt) {
  const result = joinPanelAttemptIssuance(attempt);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("logicalPanelRequestId", () => {
  it("strips the attempt-2 suffix only from a retried attempt", () => {
    fc.assert(fc.property(fc.string().filter((id) => !id.endsWith(":attempt-2")), (id) => {
      expect(logicalPanelRequestId(`${id}:attempt-2`, 2)).toBe(id);
      expect(logicalPanelRequestId(id, 2)).toBe(id);
      expect(logicalPanelRequestId(id, 1)).toBe(id);
      expect(logicalPanelRequestId(`${id}:attempt-2`, 1)).toBe(`${id}:attempt-2`);
    }));
  });
});

describe("parseRegisteredPanelProgram", () => {
  // Rows are explicit one-argument tuples: a bare `[]` row would be spread
  // into zero arguments by an array-spreading runner, never reaching `raw`.
  it.each<[unknown]>([[null], [[]], ["text"], [{ schemaVersion: 2, kind: "refutation", input: refutationInput }],
    [{ schemaVersion: 1, kind: "wave-gate", input: refutationInput }], [{ schemaVersion: 1, kind: "refutation", input: null }],
    [{ schemaVersion: 1, kind: "refutation", input: { lenses: ["not-a-lens"] } }]])("refuses %j", (raw) => {
    expect(parseRegisteredPanelProgram(raw)).toBeNull();
  });

  it("registers the translated input under its panel kind, defaulting the caller context to the input", () => {
    const parsed = refutation();
    expect(parsed).toEqual({ schemaVersion: 1, kind: "refutation", input: refutationInput, context: refutationInput });
    // Key order is the registration's byte order on disk.
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "kind", "input", "context"]);
    const withContext = registration({ schemaVersion: 1, kind: "architecture", input: { candidateLenses: ["type-driven-fp"], judgeCriteria: [] }, context: { caller: true } });
    expect(withContext.kind).toBe("architecture");
    expect(withContext.context).toEqual({ caller: true });
  });
});

describe("joinPanelAttemptIssuance", () => {
  it("admits an attempt without a live emission input", () => {
    expect(joinPanelAttemptIssuance({ request: verifierRequest(), raw: "raw" }).ok).toBe(true);
  });

  it("refuses a binding minted for another request", () => {
    const result = joinPanelAttemptIssuance({ request: verifierRequest({ requestId: "refutation:verifier:2" }), raw: "raw", emission: refutationEmission() });
    expect(result).toEqual({ ok: false, error: "issued emission binding certifies request refutation:verifier:1, not the submitted request refutation:verifier:2" });
  });

  it("refuses the wrong verdict kind for the attempt's panel program, and joins only the request on a non-panel program", () => {
    const wrongKind = joinPanelAttemptIssuance({ request: verifierRequest(), raw: "raw", emission: refutationEmission(VERIFIER, "judge-verdict") });
    expect(wrongKind).toEqual({ ok: false, error: `issued emission binding certifies producer kind judge-verdict, not the refutation-verdict kind the refutation-panel attempt ${VERIFIER} belongs to` });
    expect(joinPanelAttemptIssuance({ request: verifierRequest({ program: "wave-gate" }), raw: "raw", emission: refutationEmission(VERIFIER, "judge-verdict") }).ok).toBe(true);
  });
});

describe("parsePanelVerdictSourceRecordBytes", () => {
  it("reads absence as no evidence and fails closed on unreadable or malformed bytes", () => {
    expect(parsePanelVerdictSourceRecordBytes(VERIFIER, null)).toEqual({ ok: true, value: null });
    const notJson = parsePanelVerdictSourceRecordBytes(VERIFIER, new TextEncoder().encode("{"));
    expect(notJson.ok).toBe(false);
    if (notJson.ok) throw new Error("unreachable");
    expect(notJson.error).toContain(`the durable panel verdict source for request ${VERIFIER} is not valid JSON: `);
    const malformed = parsePanelVerdictSourceRecordBytes(VERIFIER, new TextEncoder().encode("{}"));
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error("unreachable");
    expect(malformed.error).toContain(`the durable panel verdict source for request ${VERIFIER} is malformed: `);
  });
});

describe("selectPanelAttemptVerdictSource and settlePanelAttempt", () => {
  it("settles a plain extraction attempt on the baseline and publishes nothing", () => {
    const attempt = joined({ request: verifierRequest(), raw: JSON.stringify(verdictPayload("upheld")) });
    const source = selectPanelAttemptVerdictSource(attempt, null);
    expect(source).toEqual({ ok: true, value: { kind: "baseline" } });
    if (!source.ok) throw new Error("unreachable");
    const settled = settlePanelAttempt({ ...attempt, registration: refutation(), logicalRequestId: VERIFIER }, source.value);
    expect(settled).toEqual({ ok: true, value: { problem: null, source: null, publication: null } });
  });

  it("carries a refused verdict as the attempt's problem, never as a failure", () => {
    const attempt = joined({ request: verifierRequest(), raw: "prose, not a verdict" });
    const settled = settlePanelAttempt({ ...attempt, registration: refutation(), logicalRequestId: VERIFIER }, { kind: "baseline" });
    expect(settled.ok && settled.value.problem).toContain("refutation verdict");
    expect(settled.ok && settled.value.publication).toBeNull();
  });

  it("owes a write-ahead record for an accepted live emission, and that record replays to the same selection", () => {
    const attempt = joined({ request: verifierRequest(), raw: "prose, not a verdict", emission: refutationEmission() });
    const live = selectPanelAttemptVerdictSource(attempt, null);
    if (!live.ok || live.value.kind !== "selected") throw new Error("live emission did not select");
    expect(live.value.record).toBeNull();
    expect(live.value.selection.kind).toBe("emission-tool-arguments");

    const settled = settlePanelAttempt({ ...attempt, registration: refutation(), logicalRequestId: VERIFIER }, live.value);
    if (!settled.ok) throw new Error(settled.error);
    expect(settled.value.problem).toBeNull();
    expect(settled.value.source).not.toBeNull();
    const publication = settled.value.publication;
    if (publication === null) throw new Error("accepted live emission owes a record");
    expect(publication.requestId).toBe(VERIFIER);

    // The record's on-disk bytes parse back and replay without the live input.
    const bytes = new TextEncoder().encode(`${JSON.stringify(publication, null, 2)}\n`);
    const reread = parsePanelVerdictSourceRecordBytes(VERIFIER, bytes);
    if (!reread.ok || reread.value === null) throw new Error("record did not round-trip");
    const replayed = selectPanelAttemptVerdictSource(joined({ request: verifierRequest(), raw: "prose, not a verdict" }), reread.value);
    if (!replayed.ok || replayed.value.kind !== "selected") throw new Error("record did not replay");
    expect(replayed.value.selection).toMatchObject({ kind: "emission-tool-arguments", call: { toolCallId: "legacy-unit-call" } });
    expect(replayed.value.record).toBe(reread.value);

    // A replayed selection settles on the record's source and never republishes.
    const resettled = settlePanelAttempt({ request: verifierRequest(), raw: "prose, not a verdict", registration: refutation(), logicalRequestId: VERIFIER }, replayed.value);
    expect(resettled).toEqual({ ok: true, value: { problem: null, source: reread.value.source, publication: null } });

    // A record that names another request refuses instead of being reused.
    const foreign = selectPanelAttemptVerdictSource(joined({ request: verifierRequest({ requestId: "refutation:verifier:2" }), raw: "prose" }), reread.value);
    expect(foreign).toEqual({ ok: false, error: `the durable panel verdict source for request ${VERIFIER} does not describe request refutation:verifier:2` });
  });
});

describe("executeDeterministicPanelOperation", () => {
  const evidence = (raws: Readonly<Record<string, string>>): PanelOperationEvidence => {
    const lookup = (id: string): PanelEvidenceLookup<string> => id in raws
      ? { ok: true, value: raws[id]! }
      : { ok: false, message: `operation is missing captured result for ${id}` };
    return { capturedRaw: lookup, parseTarget: lookup };
  };

  it("prepares refutation verifiers from the registration alone", () => {
    const executed = executeDeterministicPanelOperation(RUN, refutation(), "refutation-prepare-verifiers", evidence({}));
    if (!executed.ok) throw new Error(executed.message);
    expect(executed.artifacts.map(({ relativePath }) => relativePath)).toEqual(["operations/refutation-prepare-verifiers.json"]);
    expect(JSON.parse(Buffer.from(executed.artifacts[0]!.bytes).toString("utf-8"))).toEqual({
      schemaVersion: 1, runId: RUN, findingIds: ["T1:finding-1"], lenses: ["reproduction"],
    });
  });

  it("tallies captured verdicts into the panel result, and fails closed on missing evidence", () => {
    expect(executeDeterministicPanelOperation(RUN, refutation(), "refutation-tally", evidence({})))
      .toEqual({ ok: false, message: `operation is missing captured result for ${VERIFIER}` });
    const executed = executeDeterministicPanelOperation(RUN, refutation(), "refutation-tally",
      evidence({ [VERIFIER]: JSON.stringify(verdictPayload("refuted")) }));
    if (!executed.ok) throw new Error(executed.message);
    expect(executed.artifacts.map(({ relativePath }) => relativePath)).toEqual(["operations/refutation-tally.json", "result.json"]);
    const result = JSON.parse(Buffer.from(executed.artifacts[1]!.bytes).toString("utf-8")) as { kind: string; runId: string; outcomes: readonly { finding_id: string; refuted_by: readonly string[] }[] };
    expect(result).toMatchObject({ kind: "refutation-panel-result", runId: RUN });
    expect(result.outcomes).toMatchObject([{ finding_id: "T1:finding-1", refuted_by: ["reproduction"] }]);
    // Both artifacts carry the same canonical bytes.
    expect(executed.artifacts[0]!.bytes).toEqual(executed.artifacts[1]!.bytes);
  });

  it("refuses an unparseable captured candidate and any operation outside its panel's vocabulary", () => {
    const refused = executeDeterministicPanelOperation(RUN, architecture(), "architecture-prepare-judges", evidence({ "architecture:candidate:1": "not json" }));
    expect(refused.ok).toBe(false);
    expect(executeDeterministicPanelOperation(RUN, architecture(), "refutation-tally", evidence({})))
      .toEqual({ ok: false, message: "unsupported architecture operation refutation-tally" });
    expect(executeDeterministicPanelOperation(RUN, refutation(), "architecture-aggregate", evidence({})))
      .toEqual({ ok: false, message: "unsupported refutation operation architecture-aggregate" });
  });

  it("refuses a judge criterion outside the validated interview vocabulary before reading evidence", () => {
    const foreign = registration({ schemaVersion: 1, kind: "architecture", input: { candidateLenses: ["type-driven-fp"], judgeCriteria: ["my own taste"] } });
    expect(executeDeterministicPanelOperation(RUN, foreign, "architecture-aggregate", evidence({})))
      .toEqual({ ok: false, message: 'judge criterion "my own taste" is outside the validated interview vocabulary' });
  });
});
