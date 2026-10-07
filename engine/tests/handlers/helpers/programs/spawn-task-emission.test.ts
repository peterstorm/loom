/**
 * The spawn-task render's emission projection seam, over in-memory run
 * directory handles: the ineligible render advertises no tool, and the
 * program-path emission authority is joined against the durable registration
 * before any delivery I/O (AD-7, FR-012). The real facade CLI program paths
 * are emission-program-path.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { EMISSION_DESCRIPTOR_MARKER } from "../../../../src/core/issued-emission-capability";
import { parseAgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL } from "../../../../src/core/reviewer-contract";
import { type RegisteredWaveGateProgram } from "../../../../src/core/wave-gate-program";
import { renderReviewProgramSpawn, renderSpawnTask } from "../../../../src/handlers/helpers/programs/spawn-task";
import { type RegisteredStandaloneProgram } from "../../../../src/handlers/helpers/programs/registration";
import { type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { CONTEXT_DIGEST } from "../../../fixtures/issued-emission";
import { mustAuthority, reviewerAuthority } from "../../../fixtures/reviewer-request";

describe("renderSpawnTask emission projection wiring", () => {
  /** The confined fake: for requests outside the reviewer emission gate the
   *  render reads only `runDirectory` — the reviewer compatibility bootstrap
   *  and the panel view short-circuit empty before any other port. */
  const ineligibleHandle = { runDirectory: "/run/probe" } as unknown as RunDirHandle;
  const panelAuthority = (() => {
    const parsed = parseAgentRequestAuthority({
      runId: "run-probe",
      requestId: "request:probe-1",
      slotId: "slot-probe-1",
      program: "refutation-panel",
      role: "arch-judge-agent",
      attempt: 1,
      modelProfile: "panel-judge",
      harnessBinding: {
        pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
        claude: { harness: "claude-code", model: "opus" },
      },
      requiredSkill: null,
      contextDigest: CONTEXT_DIGEST,
      outputSlot: "transcripts/slot-probe-1/attempt-1.raw",
    });
    if (!parsed.ok) throw new Error(`fixture authority refused: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
    return parsed.value;
  })();

  it("renders no descriptor and the instruction verbatim outside the reviewer emission gate (FR-001/FR-020)", () => {
    const instruction = "Complete the exact pending panel request.";
    const task = renderSpawnTask(ineligibleHandle, panelAuthority, instruction);
    expect(task).toBe(
      `LOOM_REQUEST_ID: ${panelAuthority.requestId}\n` +
      `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}\n` +
      `LOOM_CONTEXT_PATH: /run/probe/contexts/${CONTEXT_DIGEST}.json\n` +
      instruction,
    );
    expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
  });
});

/** The current wave-gate registration shape, exactly as startWaveGateFacade
 *  freezes it — the program-path emission authority the wave program holds. */
const waveV2Registration: RegisteredWaveGateProgram = Object.freeze({
  schemaVersion: 2,
  reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
  kind: "wave-gate",
  input: Object.freeze({ wave: 1 }),
  taskIds: Object.freeze(["T1"]),
  authorityDigest: "a".repeat(64),
});

/** A standalone v2 registration for the program-binding refusal arm. */
const standaloneV2Registration: RegisteredStandaloneProgram = Object.freeze({
  schemaVersion: 2,
  reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
  kind: "standalone-review",
  input: Object.freeze({ kind: "all", files: null, dryRun: false }),
  authority: Object.freeze({}),
});

/** A parseable archived wave-gate v1 registration record (no issued emission
 *  schema): the durable side of the protocol-divergence refusal arm. */
const waveV1StoredRegistration = Object.freeze({
  schemaVersion: 1,
  kind: "wave-gate",
  input: Object.freeze({ wave: 1 }),
  taskIds: Object.freeze(["T1"]),
  authorityDigest: "legacy-digest",
});

const storedRegistrationHandle = (value: unknown): RunDirHandle =>
  ({ runDirectory: "/run/probe", readProgramRegistration: () => ({ ok: true as const, value }) }) as unknown as RunDirHandle;
/** An eligible render with an unreadable registration storage refuses with
 *  the exact bootstrap refusal; the run directory only feeds the path markers. */
const unavailableStorageHandle = Object.freeze({
  runDirectory: "/run/probe",
  readProgramRegistration: () => ({ ok: false as const, error: { message: "program registration storage is unavailable" } }),
}) as unknown as RunDirHandle;
/** Renders whose gate refuses before any read only need the path marker root. */
const portlessHandle = Object.freeze({ runDirectory: "/run/probe" }) as unknown as RunDirHandle;

/** The render throws are bounded (Error with a message), never silent. */
const mustThrow = (render: () => string): string => {
  try {
    render();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`render refused with a non-Error: ${String(error)}`);
    return error.message;
  }
  throw new Error("render was expected to fail closed but returned a task");
};

describe("program-path emission authority join (T6)", () => {
  const instruction = "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request.";
  const waveReviewer = reviewerAuthority("wave-gate", "request:wave-wiring-1");
  const standaloneReviewer = reviewerAuthority("standalone-review", "request:standalone-wiring-1");

  it("refuses a supplied authority naming another program before any registration read (AD-7)", () => {
    const standaloneMessage = mustThrow(() =>
      renderReviewProgramSpawn(portlessHandle, standaloneReviewer, instruction, waveV2Registration).task);
    expect(standaloneMessage).toContain("not the request's standalone-review program");
    expect(standaloneMessage).toContain("a descriptor binds only its own program's issued contract");
    const waveMessage = mustThrow(() =>
      renderReviewProgramSpawn(portlessHandle, waveReviewer, instruction, standaloneV2Registration).task);
    expect(waveMessage).toContain("not the request's wave-gate program");
  });

  it("refuses a supplied authority whose issued protocol diverges from the durable registration (FR-012)", () => {
    const message = mustThrow(() =>
      renderReviewProgramSpawn(
        storedRegistrationHandle(waveV1StoredRegistration), waveReviewer, instruction, waveV2Registration,
      ).task);
    expect(message).toContain("schema version 2 with issued digest");
    expect(message).toContain("not the durable registration's the archived schema-1 contract");
    expect(message).toContain("a descriptor names only the joined issued contract");
  });

  it("keeps the durable-only fallback and its exact bootstrap refusal when no authority is supplied", () => {
    const message = mustThrow(() => renderSpawnTask(unavailableStorageHandle, waveReviewer, instruction));
    expect(message).toBe("reviewer bootstrap registration is unavailable: program registration storage is unavailable");
  });

  it("ignores a supplied authority on an ineligible render: extraction-only requests advertise no tool (FR-001)", () => {
    const panelJudge = mustAuthority({
      runId: "run.wiring", requestId: "request:panel-wiring-1", slotId: "slot:panel-wiring-1",
      program: "refutation-panel", role: "arch-judge-agent", attempt: 1, modelProfile: "panel-judge",
      harnessBinding: {
        pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
        claude: { harness: "claude-code", model: "opus" },
      },
      requiredSkill: null, contextDigest: CONTEXT_DIGEST,
      outputSlot: "transcripts/slot:panel-wiring-1/attempt-1.raw",
    });
    const { task, route } = renderReviewProgramSpawn(portlessHandle, panelJudge, instruction, waveV2Registration);
    expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(task.endsWith(instruction)).toBe(true);
    // The render hands its route over as data: an ineligible request is
    // extraction-only by construction, so its retry closes with extraction.
    expect(route).toMatchObject({ kind: "extraction-only", reason: expect.stringContaining("not emission-eligible") });
  });
});
