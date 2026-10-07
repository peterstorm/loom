/**
 * The spawn-task render's emission projection seam, over real Run Directory
 * handles in temporary runs roots: the ineligible render advertises no tool,
 * and the program-path emission authority is joined against the durable
 * registration before any delivery I/O (AD-7, FR-012). Each handle is the
 * real adapter in a chosen durable state — no registration, an archived
 * registration, or unreadable registration storage — so the tests pin what the
 * render decides from that state, never which port it happens to read first.
 * The real facade CLI program paths are emission-program-path.integration.test.ts.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMISSION_DESCRIPTOR_MARKER } from "../../../../src/core/issued-emission-capability";
import { CURRENT_REVIEWER_PROTOCOL } from "../../../../src/core/reviewer-contract";
import { type RegisteredWaveGateProgram } from "../../../../src/core/wave-gate-program";
import { renderReviewProgramSpawn, renderSpawnTask } from "../../../../src/handlers/helpers/programs/spawn-task";
import { type RegisteredStandaloneProgram } from "../../../../src/handlers/helpers/programs/registration";
import { createRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { CONTEXT_DIGEST } from "../../../fixtures/issued-emission";
import { value } from "../../../fixtures/parse-result";
import { catalogAuthority, reviewerAuthority } from "../../../fixtures/reviewer-request";

const runsRoots: string[] = [];
afterEach(() => { for (const root of runsRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A fresh real run directory with no program registered. */
const emptyRun = (): RunDirHandle => {
  const runsRoot = canonicalTempDir("loom-spawn-task-emission-");
  runsRoots.push(runsRoot);
  return value(createRunDirectory(runsRoot, "run.probe"));
};

/** A real run directory whose durable registration is `registration`. */
const registeredRun = async (registration: unknown): Promise<RunDirHandle> => {
  const handle = emptyRun();
  value(await handle.registerProgram(registration));
  return handle;
};

/** A real run directory whose registration storage holds unreadable bytes:
 *  any registration read refuses, so a render that answers anything else
 *  provably decided before reading it. */
const unreadableRegistrationRun = (): RunDirHandle => {
  const handle = emptyRun();
  writeFileSync(join(handle.runDirectory, "program.json"), "{ not json");
  return handle;
};

describe("renderSpawnTask emission projection wiring", () => {
  const panelAuthority = catalogAuthority({
    role: "arch-judge-agent", program: "refutation-panel",
    requestId: "request:probe-1", runId: "run-probe", slotId: "slot-probe-1",
  });

  it("renders no descriptor and the instruction verbatim outside the reviewer emission gate (FR-001/FR-020)", () => {
    const handle = emptyRun();
    const instruction = "Complete the exact pending panel request.";
    const task = renderSpawnTask(handle, panelAuthority, instruction);
    expect(task).toBe(
      `LOOM_REQUEST_ID: ${panelAuthority.requestId}\n` +
      `LOOM_CONTEXT_DIGEST: ${CONTEXT_DIGEST}\n` +
      `LOOM_CONTEXT_PATH: ${handle.runDirectory}/contexts/${CONTEXT_DIGEST}.json\n` +
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
    // The registration storage is unreadable, so a render that read it first
    // would refuse with the bootstrap refusal instead of the program binding.
    const standaloneMessage = mustThrow(() =>
      renderReviewProgramSpawn(unreadableRegistrationRun(), standaloneReviewer, instruction, waveV2Registration).task);
    expect(standaloneMessage).toContain("not the request's standalone-review program");
    expect(standaloneMessage).toContain("a descriptor binds only its own program's issued contract");
    const waveMessage = mustThrow(() =>
      renderReviewProgramSpawn(unreadableRegistrationRun(), waveReviewer, instruction, standaloneV2Registration).task);
    expect(waveMessage).toContain("not the request's wave-gate program");
  });

  it("refuses a supplied authority whose issued protocol diverges from the durable registration (FR-012)", async () => {
    const handle = await registeredRun(waveV1StoredRegistration);
    const message = mustThrow(() => renderReviewProgramSpawn(handle, waveReviewer, instruction, waveV2Registration).task);
    expect(message).toContain("schema version 2 with issued digest");
    expect(message).toContain("not the durable registration's the archived schema-1 contract");
    expect(message).toContain("a descriptor names only the joined issued contract");
  });

  it("keeps the durable-only fallback and its exact bootstrap refusal when no authority is supplied", () => {
    const handle = unreadableRegistrationRun();
    const storage = handle.readProgramRegistration();
    if (storage.ok) throw new Error("fixture registration storage must be unreadable");
    const message = mustThrow(() => renderSpawnTask(handle, waveReviewer, instruction));
    expect(message).toBe(`reviewer bootstrap registration is unavailable: ${storage.error.message}`);
  });

  it("ignores a supplied authority on an ineligible render: extraction-only requests advertise no tool (FR-001)", () => {
    const panelJudge = catalogAuthority({
      role: "arch-judge-agent", program: "refutation-panel",
      requestId: "request:panel-wiring-1", slotId: "slot:panel-wiring-1",
    });
    // Ineligible renders consult no registration: unreadable storage is never read.
    const { task, route } = renderReviewProgramSpawn(unreadableRegistrationRun(), panelJudge, instruction, waveV2Registration);
    expect(task).not.toContain(EMISSION_DESCRIPTOR_MARKER);
    expect(task.endsWith(instruction)).toBe(true);
    // The render hands its route over as data: an ineligible request is
    // extraction-only by construction, so its retry closes with extraction.
    expect(route).toMatchObject({ kind: "extraction-only", reason: expect.stringContaining("not emission-eligible") });
  });
});
