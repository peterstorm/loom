import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { withBatchSubjects } from "../../../../src/handlers/helpers/programs/wave-review-requests";
import { waveReviewSubjects } from "../../../../src/core/wave-review-authority";

const subjects = waveReviewSubjects(["T1"]);
const requests = subjects.map((_, index) => `request-${index}`);

describe("withBatchSubjects", () => {
  it("pairs each published request with the subject at its batch index, in order", () => {
    expect(withBatchSubjects(requests, subjects)).toEqual({
      ok: true,
      value: requests.map((request, index) => [request, subjects[index]]),
    });
  });

  it("refuses a count mismatch either way as a typed result, before pairing any request", () => {
    expect(withBatchSubjects(requests.slice(1), subjects)).toEqual({ ok: false, error: {
      kind: "batch-subject-mismatch",
      published: subjects.length - 1,
      subjects: subjects.length,
      message: `published ${subjects.length - 1} Wave review request(s) for ${subjects.length} batch subject(s)`,
    } });
    expect(withBatchSubjects([...requests, "extra"], subjects)).toEqual({ ok: false, error: {
      kind: "batch-subject-mismatch",
      published: subjects.length + 1,
      subjects: subjects.length,
      message: `published ${subjects.length + 1} Wave review request(s) for ${subjects.length} batch subject(s)`,
    } });
  });

  it("admits exactly the publications whose count equals the subject count", () => {
    fc.assert(fc.property(fc.array(fc.string(), { maxLength: subjects.length * 3 }), (published) => {
      const paired = withBatchSubjects(published, subjects);
      expect(paired.ok).toBe(published.length === subjects.length);
      if (paired.ok) expect(paired.value.map(([request]) => request)).toEqual(published);
    }));
  });
});
