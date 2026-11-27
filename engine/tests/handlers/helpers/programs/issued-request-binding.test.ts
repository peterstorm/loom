/**
 * The runtime producer of the Task/Wave binding line, exercised end to end:
 * a Wave request rendered through `renderIssuedRequestTask` against a real run
 * directory emits the binding its own Context Packet carries, and an unusable
 * packet fails closed with the request named.
 *
 * The pure composers (`taskBindingLine`, `withTaskBinding`) are pinned by
 * core/issued-request-task.test.ts; this suite pins the step that turns a
 * published packet into a binding — the packet read, the subject mapping and
 * the two refusal throws — whose loss is the fugue-dags re-emission failure
 * (a reviewer whose echo names no Task can never be attributed).
 *
 * The batch is issued by the production preparation over a fixture graph
 * (fixtures/wave-review-issuance.ts), so the packets are the exact bytes
 * publication would publish, not hand-built approximations.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { buildContextPacket, encodeByteSection } from "../../../../src/core/context-packets";
import { parseRequestId } from "../../../../src/core/orchestration-contract";
import { renderIssuedRequestTask } from "../../../../src/handlers/helpers/programs/spawn-task";
import { publishReviewInitialBatch } from "../../../../src/handlers/helpers/programs/request-publication";
import { REVIEWER_RESULT_INSTRUCTION } from "../../../../src/core/spawn-task-text";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import {
  issueWaveBatchFixture,
  packetOf,
  projectWithPlanFile,
  reviewedTaskFixture,
  reviewGraphFixture,
  waveRegistrationFixture,
} from "../../../fixtures/wave-review-issuance";
import { agentRequestAuthority } from "../../../fixtures/agent-request-authority";
import { orFail } from "../../../support/or-fail";

const RUN_ID = "run.wave-review-fixture";

const runsRoots: string[] = [];
const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real run directory under the fixture's run id, with the Wave 1 program registered. */
async function bindingRun(): Promise<RunDirHandle> {
  const runsRoot = canonicalTempDir("loom-issued-request-binding-");
  runsRoots.push(runsRoot);
  const handle = orFail(await createRunDirectory(runsRoot, RUN_ID), runDirectoryFailure);
  orFail(await handle.registerProgram(waveRegistrationFixture(2, ["T1"])), runDirectoryFailure);
  return handle;
}

const runDirectoryFailure = (error: { field: string; message: string }): string => `${error.field}: ${error.message}`;

/** A Wave 1 project whose Task T1 is implemented over two files, with its issued batch. */
function waveProject(): ReturnType<typeof issueWaveBatchFixture> {
  const root = projectWithPlanFile("loom-issued-request-binding-project-", join("plan", "plan.md"), projectRoots);
  const graph = reviewGraphFixture(join(root, "plan", "plan.md"), [
    reviewedTaskFixture("T1", ["src/one.ts", "src/two.ts"]),
  ]);
  return issueWaveBatchFixture(root, graph, 2);
}

describe("renderIssuedRequestTask binds the packet's Wave subject", () => {
  it("publication emits the Task reviewer's task with the binding its packet's subject names, and a re-render is byte-identical", async () => {
    const batch = waveProject();
    const handle = await bindingRun();
    const packet = packetOf(batch, "code-reviewer", "T1");
    const authority = agentRequestAuthority(RUN_ID, {
      requestId: packet.requestId,
      contextDigest: packet.digest,
      slotId: "standalone-slot:1:code-reviewer",
    });
    const registration = waveRegistrationFixture(2, ["T1"]);
    const published = await publishReviewInitialBatch(handle, [
      { authority, context: { digest: packet.digest, slot: { kind: "fixed-artifact-slot", path: `contexts/${packet.digest}.json` } } },
    ], [packet], "wave-gate-current", registration);
    if (!published.ok) throw new Error(published.message);
    const emitted = published.action.requests[0];
    expect(emitted, "publication emitted one request").toBeDefined();
    expect(emitted.task.trimEnd().endsWith("\nReview Task T1.")).toBe(true);
    expect(emitted.task).toContain(REVIEWER_RESULT_INSTRUCTION);

    // The re-emission (the collection path's shape) recomposes from the same
    // durable state and must not differ by a byte.
    expect(renderIssuedRequestTask(handle, authority, registration).task).toBe(emitted.task);
  }, 30_000);

  it("the spec-check slot binds the Wave, not a Task", async () => {
    const batch = waveProject();
    const handle = await bindingRun();
    const packet = packetOf(batch, "spec-check-invoker", null);
    const authority = agentRequestAuthority(RUN_ID, {
      requestId: packet.requestId,
      contextDigest: packet.digest,
      role: "spec-check-invoker",
      slotId: "standalone-slot:1:spec-check-invoker",
    });
    orFail(await handle.publishContext(packet), runDirectoryFailure);

    const { task } = renderIssuedRequestTask(handle, authority, null);
    expect(task.trimEnd().endsWith("\nSpec-check Wave 1.")).toBe(true);
    expect(task).not.toContain("Review Task");
  }, 30_000);

  it("an unavailable packet refuses with the request named", async () => {
    const handle = await bindingRun();
    const authority = agentRequestAuthority(RUN_ID, {
      role: "spec-check-invoker",
      contextDigest: "b".repeat(64),
      slotId: "standalone-slot:1:spec-check-invoker",
    });
    expect(() => renderIssuedRequestTask(handle, authority, null))
      .toThrow(new RegExp(`request ${authority.requestId}.*unavailable Context Packet`));
  }, 30_000);

  it("a packet without a usable Wave review subject refuses with the request named", async () => {
    const handle = await bindingRun();
    const packet = orFail(
      buildContextPacket({
        requestId: orFail(parseRequestId("request:binding-corrupt:1"), (error) => error.message),
        role: "spec-check-invoker",
        requiredSkill: "none",
        outputContract: "No Wave authority rides in this packet.",
        fixedContext: [orFail(encodeByteSection("note", "no wave authority here"), (error) => `${error.field}: ${error.message}`)],
        variableContext: [],
      }),
      (error) => `${error.field}: ${error.message}`,
    );
    await handle.publishContext(packet);
    const authority = agentRequestAuthority(RUN_ID, {
      requestId: packet.requestId,
      contextDigest: packet.digest,
      role: "spec-check-invoker",
      slotId: "standalone-slot:1:spec-check-invoker",
    });
    expect(() => renderIssuedRequestTask(handle, authority, null))
      .toThrow(new RegExp(`request ${authority.requestId}.*no usable Wave review subject`));
  }, 30_000);
});
