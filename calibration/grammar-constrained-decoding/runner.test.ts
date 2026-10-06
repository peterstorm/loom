import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPairSchedule,
  evaluatePilot,
  parseBlindingKey,
  parseQualityAssessment,
  type Preregistration,
} from "./pilot-core";
import type { ArmRequest } from "./pilot-dispatch";
import { pilotRequestId, renderTaskBody, rubricEscapes, type CaseInput } from "./pilot-workload";
import { blind, blindedPacket, caseInputKey, dispatchSchedule, rubricAssessment } from "./pilot-window";
import {
  accepted,
  ATTEMPT_MS,
  fakeRoute,
  fixtures,
  HERE,
  inputs,
  prereg,
  READY,
  REJECTED,
  REPO_ROOT,
  runWindow,
  TIMEOUT,
  WINDOW_ID,
} from "./pilot-test-fixtures";

/**
 * Shell-level behaviour of `scripts/run-model-calibration.ts --pilot/--decide`:
 *
 * - the CLI itself (spawned): the explicit opt-in, and — against an
 *   unreachable route — a blocked preflight recorded honestly (nothing
 *   dispatched, nothing fabricated, decision incomplete), the never-overwrite
 *   refusal and the offline re-decision with its preregistration-drift
 *   refusal. The retention rules behind them are pinned directly at the
 *   `WindowStore` port in pilot-retention.test.ts;
 * - against a fake route (pilot-test-fixtures.ts) wired into the window
 *   dispatch path the script runs (`pilot-window.ts`): the matched-arm
 *   dispatch, the attempt-2 retry budget, the blinding key / packet and the
 *   rubric assessor wiring, and the fail-closed aborts on a missing input or
 *   an inconsistent recorded sample. Transcript classification is covered in
 *   pilot.test.ts, the live Pi adapter in pilot-dispatch.test.ts.
 */

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unreachablePreregistration(): Readonly<{ dir: string; prereg: string; window: string }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-gcd-pilot-"));
  temps.push(dir);
  const raw = JSON.parse(readFileSync(join(HERE, "preregistration.json"), "utf-8")) as { route: { baseUrl: string } };
  // Port 9 (discard) on loopback: refused immediately, never a model server.
  raw.route.baseUrl = "http://127.0.0.1:9/v1";
  const preregPath = join(dir, "preregistration.json");
  writeFileSync(preregPath, JSON.stringify(raw, null, 2));
  return { dir, prereg: preregPath, window: join(dir, "window") };
}

const run = (args: readonly string[], env: NodeJS.ProcessEnv = {}) => spawnSync("bun", ["scripts/run-model-calibration.ts", ...args], {
  cwd: REPO_ROOT,
  encoding: "utf-8",
  env: { ...process.env, ...env },
  timeout: 60_000,
});

describe("run-model-calibration --pilot", () => {
  it("refuses to run without the explicit opt-in", () => {
    const fixture = unreachablePreregistration();
    const result = run(["--pilot", fixture.prereg, "--window-dir", fixture.window], { LOOM_RUN_MODEL_CALIBRATION: "" });
    expect(result.status).toBe(2);
    expect(existsSync(fixture.window)).toBe(false);
  });

  it("retains a blocked preflight honestly: no dispatch, no fabricated samples, decision incomplete", () => {
    const fixture = unreachablePreregistration();
    const result = run([
      "--pilot", fixture.prereg,
      "--fixtures", join(HERE, "workload-fixtures.json"),
      "--window-dir", fixture.window,
    ], { LOOM_RUN_MODEL_CALIBRATION: "1" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Release decision: incomplete-missing-measurement");

    const window = JSON.parse(readFileSync(join(fixture.window, "window.json"), "utf-8"));
    expect(window.preflight.kind).toBe("blocked");
    expect(window.preflight.blocks.map((block: { kind: string }) => block.kind)).toContain("route-unreachable");
    expect(window.dispatch.kind).toBe("not-attempted");
    expect(window.observations).toBe(0);
    expect(Date.parse(window.endedAt)).not.toBeNaN();
    expect(window.preflightFacts.stagedRuntimeRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(join(fixture.window, "observations.jsonl"))).toBe(false);

    const decision = JSON.parse(readFileSync(join(fixture.window, "release-decision.json"), "utf-8"));
    expect(decision.decision.kind).toBe("incomplete-missing-measurement");
    expect(decision.decision.missing.map((missing: { kind: string }) => missing.kind)).toEqual(
      expect.arrayContaining(["preflight-blocked", "no-qualified-capable-route", "cell-not-measured"]));
    expect(decision.cells.map((cell: { kind: string }) => cell.kind)).toEqual(["not-measured", "not-measured", "not-measured", "not-measured"]);
    expect(decision.preregistration.path).not.toMatch(/^\//);
  });

  it("never overwrites a retained window", () => {
    const fixture = unreachablePreregistration();
    const args = ["--pilot", fixture.prereg, "--fixtures", join(HERE, "workload-fixtures.json"), "--window-dir", fixture.window];
    expect(run(args, { LOOM_RUN_MODEL_CALIBRATION: "1" }).status).toBe(1);
    const second = run(args, { LOOM_RUN_MODEL_CALIBRATION: "1" });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/error: window \S+ already exists; a retained window is never overwritten/i);
    expect(JSON.parse(readFileSync(join(fixture.window, "window.json"), "utf-8")).dispatch.kind).toBe("not-attempted");
  });

  it("re-decides a retained window offline, retaining an --assessment, and refuses a preregistration changed after the window", () => {
    const fixture = unreachablePreregistration();
    run(["--pilot", fixture.prereg, "--fixtures", join(HERE, "workload-fixtures.json"), "--window-dir", fixture.window], { LOOM_RUN_MODEL_CALIBRATION: "1" });
    const external = join(fixture.dir, "human-blind-1.json");
    const assessment = JSON.stringify({ schemaVersion: 1, assessorId: "human-blind-1", method: "independent blinded review", blinded: true, entries: [] }, null, 2);
    writeFileSync(external, assessment);
    const redecided = run(["--decide", fixture.window, "--assessment", external], { LOOM_RUN_MODEL_CALIBRATION: "" });
    expect(redecided.status, redecided.stderr).toBe(1);
    expect(redecided.stderr).toContain("Release decision: incomplete-missing-measurement");
    expect(readFileSync(join(fixture.window, "assessments", "human-blind-1.json"), "utf-8")).toBe(assessment);
    expect(readFileSync(join(fixture.window, "decision-log.jsonl"), "utf-8").trim().split("\n")).toHaveLength(2);

    writeFileSync(fixture.prereg, readFileSync(fixture.prereg, "utf-8").replace("gcd-ad11-pilot-1", "gcd-ad11-pilot-edited"));
    const tampered = run(["--decide", fixture.window]);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain("changed after window");
  });
});

// ---------------------------------------------------------------------------
// The live dispatch path against a fake route
// ---------------------------------------------------------------------------

const schedule = buildPairSchedule(prereg);

const inputOf = (cell: ArmRequest["cell"], caseId: string): CaseInput => {
  const input = inputs.get(caseInputKey(cell, caseId));
  if (input === undefined) throw new Error(`${cell} ${caseId} has no resolved input`);
  return input;
};

const taskBody = (cell: ArmRequest["cell"], caseId: string): string => {
  const body = renderTaskBody(cell, inputOf(cell, caseId), fixtures);
  if (!body.ok) throw new Error(body.error);
  return body.value;
};

describe("run-model-calibration --pilot dispatch path against a fake route", () => {
  it("dispatches each scheduled pair once per arm, in scheduled order, over the same task body", async () => {
    const route = fakeRoute(accepted);
    const { records, landed, progress } = await runWindow(route);
    expect(route.requests).toHaveLength(schedule.length * 2);
    schedule.forEach((pair, index) => {
      const arms = route.requests.slice(index * 2, index * 2 + 2);
      expect(arms.map((request) => request.arm)).toEqual([...pair.armOrder]);
      const body = taskBody(pair.cell, pair.caseId);
      for (const request of arms) {
        expect(request.cell).toBe(pair.cell);
        expect(request.attempt).toBe(1);
        expect(request.cellBinding.binding.requestId).toBe(pilotRequestId(WINDOW_ID, pair.pairId, request.arm, 1));
        expect(request.prompt.startsWith(`${body}\n\n## Output\n\n`)).toBe(true);
      }
      expect(arms[0]?.cellBinding.contextDigest).toBe(arms[1]?.cellBinding.contextDigest);
    });
    const dispatchedCells = new Set(route.requests.map((request) => request.cell));
    const emissionCells = prereg.cells.filter((cell) => cell.qualification.kind !== "extraction-only").map((cell) => cell.cell);
    expect([...dispatchedCells].sort()).toEqual([...emissionCells].sort());
    expect(landed).toEqual(records);
    expect(records.map((record) => `${record.sample.pairId}|${record.sample.arm}`))
      .toEqual(schedule.flatMap((pair) => pair.armOrder.map((arm) => `${pair.pairId}|${arm}`)));
    expect(progress).toHaveLength(schedule.length);
    expect(progress.at(-1)).toBe(`${schedule.length}/${schedule.length} ${schedule.at(-1)?.pairId}`);
  });

  it("retries a semantic rejection with one fresh attempt 2 and times the sample across both attempts (AS-015)", async () => {
    const route = fakeRoute((request) => (request.attempt === 1 ? REJECTED : accepted(request)));
    const { records } = await runWindow(route);
    expect(route.requests).toHaveLength(schedule.length * 4);
    for (const record of records) {
      expect(record.sample.attempts.map((attempt) => [attempt.attempt, attempt.outcome.kind])).toEqual([[1, "rejected"], [2, "accepted"]]);
      expect(record.sample.dispatchToIngestionMs).toBe(2 * ATTEMPT_MS);
      expect(record.kind).toBe("accepted");
    }
    const retries = route.requests.filter((request) => request.attempt === 2);
    expect(new Set(retries.map((request) => request.cellBinding.binding.requestId)).size).toBe(retries.length);
    expect(retries.every((request) => request.cellBinding.binding.requestId.endsWith("-a2"))).toBe(true);
  });

  it("never spends more than the attempt-2 budget, and never retries a non-semantic failure", async () => {
    const exhausted = fakeRoute(() => REJECTED);
    const rejected = await runWindow(exhausted);
    expect(Math.max(...exhausted.requests.map((request) => request.attempt))).toBe(2);
    expect(exhausted.requests).toHaveLength(schedule.length * 4);
    expect(rejected.records.every((record) => record.sample.attempts.length === 2 && record.kind === "terminal")).toBe(true);

    const timedOut = fakeRoute(() => TIMEOUT);
    const terminal = await runWindow(timedOut);
    expect(timedOut.requests).toHaveLength(schedule.length * 2);
    for (const record of terminal.records) {
      expect(record.sample.attempts.map((attempt) => attempt.outcome.kind)).toEqual(["timeout"]);
      expect(record.sample.dispatchToIngestionMs).toBe(ATTEMPT_MS);
      expect(record.kind).toBe("terminal");
    }
  });

  it("blinds every accepted sample exactly once and the packet reveals no arm or pair", async () => {
    // The judge cell's extraction arm never lands: terminal samples are never blinded.
    const { records } = await runWindow(fakeRoute((request) =>
      request.cell === "judge-verdict/v1" && request.arm === "extraction-only" ? REJECTED : accepted(request)));
    const acceptedRecords = records.flatMap((record) => (record.kind === "accepted" ? [record] : []));
    expect(acceptedRecords.length).toBeLessThan(records.length);
    const blinded = blind(WINDOW_ID, records);
    const key = parseBlindingKey(blinded.key);
    if (!key.ok) throw new Error(key.error.join("; "));
    expect(key.value.windowId).toBe(WINDOW_ID);

    const sampleIds = acceptedRecords.map((record) => `${record.sample.pairId}|${record.sample.arm}`);
    const keyIds = key.value.entries.map((entry) => `${entry.pairId}|${entry.arm}`);
    expect([...keyIds].sort()).toEqual([...sampleIds].sort());
    expect(new Set(keyIds).size).toBe(keyIds.length);
    expect(keyIds).not.toEqual(sampleIds);
    for (const entry of blinded.entries) {
      const owners = acceptedRecords.filter((record) => record.sample.pairId === entry.pairId && record.sample.arm === entry.arm);
      expect(owners).toHaveLength(1);
      expect(entry.payload).toBe(owners[0]?.acceptedPayload);
    }

    const packet = blindedPacket(WINDOW_ID, blinded.entries);
    expect(packet.entries.map((entry) => entry.blindId)).toEqual(key.value.entries.map((entry) => entry.blindId));
    for (const entry of packet.entries) expect(Object.keys(entry).sort()).toEqual(["blindId", "caseId", "cell", "payload"]);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toMatch(/emission-enabled|extraction-only|emission-tool|"arm"|"pairId"/);
  });

  it("wires the rubric assessor over the blinded packet into evidence the release decision accepts", async () => {
    const { records } = await runWindow(fakeRoute(accepted));
    const blinded = blind(WINDOW_ID, records);
    const assessed = rubricAssessment(prereg, blinded.entries, inputs);
    if (!assessed.ok) throw new Error(assessed.error.join("; "));
    const rubric = parseQualityAssessment(assessed.value);
    if (!rubric.ok) throw new Error(rubric.error.join("; "));
    expect(rubric.value).toMatchObject({ assessorId: "rubric-v1", blinded: true });
    expect(rubric.value.entries.map((entry) => entry.blindId)).toEqual(blinded.key.entries.map((entry) => entry.blindId));
    blinded.entries.forEach((entry, index) => {
      const workloadCase = prereg.cells.find((cell) => cell.cell === entry.cell)?.workload.cases.find((item) => item.caseId === entry.caseId);
      if (workloadCase === undefined) throw new Error(`${entry.cell} ${entry.caseId} is not preregistered`);
      const escapes = rubricEscapes(workloadCase, inputOf(entry.cell, entry.caseId), entry.payload);
      expect(escapes.ok).toBe(true);
      expect(rubric.value.entries[index]?.escapedDefects).toEqual(escapes.ok ? [...escapes.value] : null);
    });

    const evaluated = evaluatePilot({
      preregistration: prereg, preflight: READY, observations: records.map((record) => record.sample),
      quality: { key: blinded.key, assessments: [rubric.value] },
    });
    if (!evaluated.ok) throw new Error(evaluated.error.problems.join("\n"));
    expect(evaluated.value.cells.every((cell) => cell.kind !== "not-measured")).toBe(true);
  });

  describe("aborts the window loudly instead of recording a fabricated sample", () => {
    const first = schedule[0] as (typeof schedule)[number];

    it("refuses a preregistered case with no resolved input before dispatching it", async () => {
      const route = fakeRoute(accepted);
      const landed: unknown[] = [];
      const missing = new Map([...inputs].filter(([key]) => key !== caseInputKey(first.cell, first.caseId)));
      await expect(dispatchSchedule({
        windowId: WINDOW_ID, prereg, fixtures, inputs: missing, dispatch: route.dispatch, now: route.now,
        onSample: (record) => { landed.push(record); }, onPair: () => {},
      })).rejects.toThrow(`no resolved input for ${first.cell} case ${first.caseId}`);
      expect(route.requests).toHaveLength(0);
      expect(landed).toHaveLength(0);
    });

    it("refuses a recorded observation the sample parser rejects", async () => {
      // An extraction-only attempt claiming the emission-tool source contradicts its arm.
      const route = fakeRoute(() => ({ kind: "accepted", source: "emission-tool", fallbackOverRefusal: false, payloadDigest: "a".repeat(64) }));
      const landed: unknown[] = [];
      await expect(runWindow(route, (record) => { landed.push(record); }))
        .rejects.toThrow(/^recorded observation for \S+\/extraction-only is malformed: /);
      expect(landed.length).toBeLessThan(2);
    });

    it("refuses an accepted attempt that carries no accepted payload", async () => {
      const route = fakeRoute(accepted);
      const payloadless = { ...route, dispatch: async (request: ArmRequest) => ({ ...(await route.dispatch(request)), acceptedPayload: null }) };
      const landed: unknown[] = [];
      await expect(runWindow(payloadless, (record) => { landed.push(record); }))
        .rejects.toThrow(`recorded sample for ${first.pairId}/${first.armOrder[0]} is inconsistent: its accepted outcome carries no accepted payload`);
      expect(landed).toHaveLength(0);
    });
  });

  describe("fails closed on an unresolvable entry — never zero escapes", () => {
    const blindedWindow = async () => blind(WINDOW_ID, (await runWindow(fakeRoute(accepted))).records).entries;

    it("refuses an entry whose case is not preregistered", async () => {
      const [first, ...rest] = await blindedWindow();
      if (first === undefined) throw new Error("the window blinded no entry");
      const assessed = rubricAssessment(prereg, [{ ...first, caseId: "not-preregistered" }, ...rest], inputs);
      expect(assessed).toEqual({ ok: false, error: [expect.stringContaining(`${first.blindId} (${first.cell} case not-preregistered): the case is not preregistered`)] });
    });

    it("refuses an entry whose case has no resolved input", async () => {
      const entries = await blindedWindow();
      const [first] = entries;
      if (first === undefined) throw new Error("the window blinded no entry");
      const missing = new Map([...inputs].filter(([key]) => key !== caseInputKey(first.cell, first.caseId)));
      const assessed = rubricAssessment(prereg, entries, missing);
      expect(assessed.ok).toBe(false);
      expect(assessed.ok ? [] : assessed.error).toContainEqual(expect.stringContaining(`${first.blindId} (${first.cell} case ${first.caseId}): no resolved input`));
    });

    it("refuses an escaped defect id the case does not declare, naming every such entry", async () => {
      const entries = await blindedWindow();
      const undeclared: Preregistration = {
        ...prereg,
        cells: prereg.cells.map((cell) => ({
          ...cell,
          workload: { ...cell.workload, cases: cell.workload.cases.map((entry) => ({ ...entry, knownDefects: [] })) },
        })),
      };
      const declared = rubricAssessment(prereg, entries, inputs);
      if (!declared.ok) throw new Error(declared.error.join("; "));
      const escaping = declared.value.entries.filter((entry) => entry.escapedDefects.length > 0);
      expect(escaping.length).toBeGreaterThan(0);

      const assessed = rubricAssessment(undeclared, entries, inputs);
      expect(assessed.ok).toBe(false);
      const problems = assessed.ok ? [] : assessed.error;
      expect(problems).toHaveLength(escaping.length);
      for (const entry of escaping) expect(problems).toContainEqual(expect.stringMatching(new RegExp(`${entry.blindId} .*declares no known defect`)));
    });
  });
});
