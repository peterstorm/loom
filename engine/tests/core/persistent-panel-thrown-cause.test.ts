/**
 * The persistent panel's canonical verdict parsers fail closed when their
 * parse throws, and keep the thrown class in the diagnostic, so a code
 * regression stays distinguishable from merely malformed input. A BigInt score
 * in an in-memory durable judge event drives the throw: JSON cannot serialize
 * it, so the canonical re-serialization before `parseJudgeVerdict` throws a
 * TypeError. The publication authority is minted through the real reconciler
 * by the shared panel-authority fixture.
 */
import { describe, expect, it } from "vitest";
import {
  panelRequestIdentity,
  parsePersistentArchitecturePanelEvent,
  startPersistentArchitecturePanel,
  submitArchitectureCandidateResult,
} from "../../src/core/persistent-panel";
import { createPanelPublications } from "../fixtures/panel-authority";
import { value } from "../fixtures/parse-result";

const { architecturePanelFixture, resolver } = createPanelPublications();

function awaitingJudges() {
  const { authority, candidates, judges } = architecturePanelFixture("run.thrown-cause.arch");
  let step = startPersistentArchitecturePanel(authority);
  for (const index of [1, 0]) {
    step = value(submitArchitectureCandidateResult(step.state, resolver, panelRequestIdentity(candidates[index]!), {
      lens: authority.candidateLenses[index],
      candidate: authority.candidateIds[index],
      artifact: `# candidate ${index + 1}`,
    }));
  }
  return { state: step.state, authority, judge: judges[0]! };
}

describe("persistent panel canonical judge parse", () => {
  it("keeps the thrown class when the canonical judge parse throws", () => {
    const { state, authority, judge } = awaitingJudges();
    const event = (score: unknown) => ({
      schemaVersion: 1,
      type: "architecture-judge-accepted",
      request: panelRequestIdentity(judge),
      value: {
        criterion: authority.judgeCriteria[0],
        entries: authority.candidateIds.map((candidate, index) => ({
          candidate, score: index === 0 ? score : 8, fatalFlaw: null, strongestIdea: `idea ${index + 1}`,
        })),
      },
    });

    expect(parsePersistentArchitecturePanelEvent(state, event(9), resolver).ok).toBe(true);

    const thrown = parsePersistentArchitecturePanelEvent(state, event(9n), resolver);
    expect(thrown.ok).toBe(false);
    if (thrown.ok) throw new Error("unreachable");
    expect(thrown.error.kind).toBe("request-binding-mismatch");
    expect(thrown.error.message).toBe("judge result could not be safely parsed (TypeError)");
  });
});
