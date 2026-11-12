/**
 * The user decision parser (`core/user-decision`): any JSON object for a run
 * with no program registration, exactly `{"kind":"approve"}` for a registered
 * Wave Gate, each refusal returned as data in the words `decide` prints.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseUserDecision, type DecisionRecipient } from "../../src/core/user-decision";
import { notAJsonObject } from "../fixtures/json-wire";
import { refusal, value } from "../fixtures/parse-result";

const RECIPIENTS: readonly DecisionRecipient[] = ["wave-gate", "unregistered-run"];
const objects = fc.dictionary(fc.string(), fc.jsonValue());

describe("parseUserDecision", () => {
  it("property: an unregistered run records any JSON object as given", () => {
    fc.assert(fc.property(objects, (decision) => {
      expect(value(parseUserDecision(JSON.stringify(decision), "unregistered-run"))).toEqual(JSON.parse(JSON.stringify(decision)));
    }));
  });

  it("a registered Wave Gate admits exactly the approval", () => {
    expect(value(parseUserDecision('{"kind":"approve"}', "wave-gate"))).toEqual({ kind: "approve" });
  });

  it("property: a registered Wave Gate refuses every other object", () => {
    const others = objects.filter((decision) => JSON.stringify(decision) !== '{"kind":"approve"}');
    fc.assert(fc.property(others, (decision) => {
      expect(refusal(parseUserDecision(JSON.stringify(decision), "wave-gate")))
        .toBe("Wave advisory decision must be exactly {\"kind\":\"approve\"}");
    }));
  });

  it.each(RECIPIENTS)("refuses blank stdin for %s", (recipient) => {
    expect(refusal(parseUserDecision(" \n", recipient))).toBe("a decision must be supplied on stdin");
  });

  it.each(RECIPIENTS)("refuses text that is not JSON for %s, keeping the JSON parser's cause", (recipient) => {
    expect(refusal(parseUserDecision("{", recipient))).toMatch(/^decision must be valid JSON: .+/);
  });

  it("property: refuses every JSON value that is not an object", () => {
    fc.assert(fc.property(notAJsonObject, fc.constantFrom(...RECIPIENTS), (raw, recipient) => {
      expect(refusal(parseUserDecision(JSON.stringify(raw), recipient))).toBe("decision must be a JSON object");
    }));
  });
});
