import { describe, expect, it } from "vitest";
import { withBatchSubjects } from "../../../../src/handlers/helpers/programs/wave-review-requests";
import { waveReviewSubjects } from "../../../../src/core/wave-review-authority";

const subjects = waveReviewSubjects(["T1"]);
const requests = subjects.map((_, index) => `request-${index}`);

describe("withBatchSubjects", () => {
  it("pairs each published request with the subject at its batch index, in order", () => {
    expect(withBatchSubjects(requests, subjects)).toEqual(requests.map((request, index) => [request, subjects[index]]));
  });

  it("refuses a count mismatch either way before pairing any request", () => {
    expect(() => withBatchSubjects(requests.slice(1), subjects))
      .toThrow(`published ${subjects.length - 1} Wave review request(s) for ${subjects.length} batch subject(s)`);
    expect(() => withBatchSubjects([...requests, "extra"], subjects))
      .toThrow(`published ${subjects.length + 1} Wave review request(s) for ${subjects.length} batch subject(s)`);
  });
});
