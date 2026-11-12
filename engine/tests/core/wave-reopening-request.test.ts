/**
 * The completed-Wave reopening payload parser (`core/wave-reopening-request`):
 * exactly `runId`, `wave`, `authorityDigest` and `taskIds`, each refusal
 * returned as data in the words the helper prints.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ArtifactDigest, OrchestrationRunId } from "../../src/core/orchestration-contract/identity";
import type { TaskId } from "../../src/core/task-id";
import { parseReopenRequest } from "../../src/core/wave-reopening-request";
import { notAJsonObject } from "../fixtures/json-wire";
import { refusal, value } from "../fixtures/parse-result";

const DIGEST = "a".repeat(64);
const VALID = { runId: "run.completed-wave-3", wave: 3, authorityDigest: DIGEST, taskIds: ["T19", "T22"] };

const taskIds = fc.uniqueArray(fc.nat({ max: 999 }), { minLength: 1, maxLength: 5 }).map((ns) => ns.map((n) => `T${n}`));
const requests = fc.record({
  runId: fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/),
  wave: fc.integer({ min: 1, max: 50 }),
  authorityDigest: fc.stringMatching(/^[0-9a-f]{64}$/),
  taskIds,
});

const INVALID_IDS = "reopening payload has invalid run/wave/authority/task ids";

describe("parseReopenRequest", () => {
  it("property: admits every exact payload and returns its fields as given", () => {
    fc.assert(fc.property(requests, (request) => {
      expect(value(parseReopenRequest(JSON.stringify(request)))).toEqual(request);
    }));
  });

  it("returns each field as the identity its parse proved: a run id, an artifact digest and a non-empty list of Task ids", () => {
    const request = value(parseReopenRequest(JSON.stringify(VALID)));
    // Compile-time: each assignment typechecks only while the parsed type carries the brand.
    const runId: OrchestrationRunId = request.runId;
    const authorityDigest: ArtifactDigest = request.authorityDigest;
    const [first, ...rest]: readonly [TaskId, ...TaskId[]] = request.taskIds;
    expect({ runId, authorityDigest, taskIds: [first, ...rest] }).toEqual({ runId: VALID.runId, authorityDigest: DIGEST, taskIds: VALID.taskIds });
  });

  it("refuses text that is not JSON, keeping the JSON parser's cause", () => {
    expect(refusal(parseReopenRequest("{"))).toMatch(/^reopening payload must be valid JSON: .+/);
  });

  it("property: refuses every JSON value that is not an object", () => {
    fc.assert(fc.property(notAJsonObject, (raw) => {
      expect(refusal(parseReopenRequest(JSON.stringify(raw)))).toBe("reopening payload must be an object");
    }));
  });

  it.each([
    ["a missing key", { runId: VALID.runId, wave: VALID.wave, authorityDigest: DIGEST }],
    ["a surplus key", { ...VALID, reason: "drift" }],
  ])("refuses %s", (_label, raw) => {
    expect(refusal(parseReopenRequest(JSON.stringify(raw)))).toBe("reopening payload must contain exactly runId/wave/authorityDigest/taskIds");
  });

  it.each([
    ["a blank runId", { ...VALID, runId: "  " }],
    ["a runId that is not a canonical run id", { ...VALID, runId: "wave run 3" }],
    ["a runId that names a path", { ...VALID, runId: "../wave-run" }],
    ["a zero wave", { ...VALID, wave: 0 }],
    ["a fractional wave", { ...VALID, wave: 1.5 }],
    ["a wave given as text", { ...VALID, wave: "3" }],
    ["a short digest", { ...VALID, authorityDigest: "a".repeat(63) }],
    ["an upper-case digest", { ...VALID, authorityDigest: "A".repeat(64) }],
    ["no Task ids", { ...VALID, taskIds: [] }],
    ["a Task id that is not one", { ...VALID, taskIds: ["T1", "task-2"] }],
    ["a repeated Task id", { ...VALID, taskIds: ["T1", "T1"] }],
    ["Task ids that are not a list", { ...VALID, taskIds: "T1" }],
  ])("refuses %s", (_label, raw) => {
    expect(refusal(parseReopenRequest(JSON.stringify(raw)))).toBe(INVALID_IDS);
  });
});
