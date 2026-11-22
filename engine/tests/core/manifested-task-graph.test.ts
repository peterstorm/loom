import { describe, expect, it } from "vitest";
import { MANIFEST_ABSENT_REFUSAL, parseManifestedTaskGraph } from "../../src/core/manifested-task-graph";
import { graphFixture } from "../fixtures/task-lifecycle";

describe("parseManifestedTaskGraph", () => {
  it("proves a graph carrying its frozen manifest, returning the graph itself", () => {
    const graph = graphFixture([]);
    const parsed = parseManifestedTaskGraph(graph);
    expect(parsed).toEqual({ ok: true, value: graph });
    if (parsed.ok) expect(parsed.value).toBe(graph);
  });

  it.each(["decompose", "execute"] as const)("refuses a %s graph carrying no manifest, naming why", (phase) => {
    const { verification_manifest: _manifest, ...rest } = graphFixture([]);
    expect(parseManifestedTaskGraph({ ...rest, current_phase: phase })).toEqual({ ok: false, error: MANIFEST_ABSENT_REFUSAL });
  });
});
