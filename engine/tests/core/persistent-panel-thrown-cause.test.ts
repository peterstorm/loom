/**
 * The persistent panel's canonical verdict parser fails closed when its parse
 * throws, and keeps the thrown class in the diagnostic, so a code regression
 * stays distinguishable from merely malformed input. A BigInt reasoning in an
 * in-memory durable verdict event drives the throw: JSON cannot serialize it,
 * so the canonical re-serialization before `parseRefutationVerdict` throws a
 * TypeError. The publication authority is minted through the real reconciler
 * by the shared panel-authority fixture.
 */
import { describe, expect, it } from "vitest";
import {
  panelRequestIdentity,
  parsePersistentRefutationPanelEvent,
  startPersistentRefutationPanel,
} from "../../src/core/persistent-panel";
import { createPanelPublications } from "../fixtures/panel-authority";

const { refutationPanelFixture, resolver } = createPanelPublications();

describe("persistent panel canonical verdict parse", () => {
  it("keeps the thrown class when the canonical verdict parse throws", () => {
    const { authority, requests } = refutationPanelFixture("run.thrown-cause.refutation", ["reproduction", "intent"]);
    const { state } = startPersistentRefutationPanel(authority);
    const event = (reasoning: unknown) => ({
      schemaVersion: 1,
      type: "refutation-verdict-accepted",
      request: panelRequestIdentity(requests[0]!),
      value: {
        criterion: authority.lenses[0],
        entries: authority.findings.map(({ id }, index) => ({
          findingId: id, verdict: "upheld", reasoning: index === 0 ? reasoning : "still exhibited",
        })),
      },
    });

    expect(parsePersistentRefutationPanelEvent(state, event("still exhibited"), resolver).ok).toBe(true);

    const thrown = parsePersistentRefutationPanelEvent(state, event(9n), resolver);
    expect(thrown.ok).toBe(false);
    if (thrown.ok) throw new Error("unreachable");
    expect(thrown.error.kind).toBe("request-binding-mismatch");
    expect(thrown.error.message).toBe("refutation result could not be safely parsed (TypeError)");
  });
});
