/**
 * The one direct release a refusal owes: it runs once, and the refusal it
 * decorates carries its failure as a cleanup-failure suffix — never instead of
 * the refusal's own cause.
 */

import { describe, expect, it } from "vitest";
import { directReleaseFailureSuffix } from "../../../pi/cleanup-actions";

describe("directReleaseFailureSuffix", () => {
  it("adds nothing to the refusal when the release succeeds", async () => {
    const released: string[] = [];
    await expect(directReleaseFailureSuffix({
      label: "revoke unclaimed write grant for spawn item 1",
      run: () => { released.push("token-0"); },
    })).resolves.toBe("");
    expect(released).toEqual(["token-0"]);
  });

  it("names the failed release under its label, awaiting an asynchronous one", async () => {
    await expect(directReleaseFailureSuffix({
      label: "roll back unclaimed task-graph pointer",
      run: async () => { throw new Error("exact pointer ownership lost (not-owned)"); },
    })).resolves.toBe(" Cleanup failures: roll back unclaimed task-graph pointer: exact pointer ownership lost (not-owned)");
  });
});
