import { describe, expect, it } from "vitest";
import { authorizeGraphCompletionSuite } from "../../src/core/owner-verification/suite-authority";
import type { TaskGraph } from "../../src/types";
import { activeWaveGateFixture, graphFixture } from "../fixtures/task-lifecycle";

const WORKSPACE = "b".repeat(64);

describe("authorizeGraphCompletionSuite: the one place a Wave's completion suite is authorized from a graph", () => {
  it("authorizes the active Wave's suite under the graph's own frozen manifest", () => {
    const graph = {
      ...graphFixture([]),
      active_wave_gate: activeWaveGateFixture({ runId: "wave-run", wave: 1, authorityDigest: "a".repeat(64) }),
    };

    const authorized = authorizeGraphCompletionSuite(graph, WORKSPACE);

    expect(authorized).toMatchObject({
      ok: true,
      value: { runId: "wave-run", wave: 1, manifestDigest: graph.verification_manifest.manifestDigest, workspaceDigest: WORKSPACE },
    });
  });

  it("refuses a manifested graph with no active Wave Gate registration, naming why", () => {
    expect(authorizeGraphCompletionSuite(graphFixture([]), WORKSPACE)).toEqual({
      ok: false,
      error: {
        kind: "invalid-verification-manifest",
        errors: ["the TaskGraph has no active Wave Gate registration to authorize a completion suite for"],
      },
    });
  });

  it("takes only a graph proven to carry its frozen manifest: a manifest-less graph does not typecheck", () => {
    const { verification_manifest: _manifest, ...unmanifested } = graphFixture([]);
    const plain: TaskGraph = unmanifested;
    // @ts-expect-error a TaskGraph whose manifest is unproven cannot reach the suite authorization
    const call = () => authorizeGraphCompletionSuite(plain, WORKSPACE);
    void call;
  });
});
