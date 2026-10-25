/**
 * The pure decisions the owner-verification shell used to make inline:
 * which commit an owner's mutation plan diffs against (`waveBaseOf`, over
 * the Wave Tasks that list the owner) and whether the re-read plan still
 * proves the stamp (`planModelsIntegrityFailure`).
 */

import { describe, expect, it } from "vitest";
import { ownerScopeOf } from "../../src/core/owner-verification/obligations";
import { planModelsIntegrityFailure } from "../../src/core/owner-verification/plan-integrity";
import { ownerTasks, waveBaseOf, type WaveBaseTask } from "../../src/core/owner-verification/wave-base";
import { parsePlanModels } from "../../src/core/parse-plan-models";
import { ownerObligation } from "../fixtures/owner-obligation";

const OWNER = "src/rules/owner.ts";

const task = (id: string, wave: number, files: readonly string[], start?: string): WaveBaseTask => ({
  id, wave, file_list: [...files], ...(start === undefined ? {} : { start_sha: start }),
});

describe("waveBaseOf", () => {
  it("no Wave Task lists the owner: the owner is unchanged, whatever other Waves did", () => {
    const tasks = [task("T1", 1, ["src/other.ts"], "a1"), task("T2", 2, [OWNER], "b2")];
    expect(waveBaseOf(tasks, 1, OWNER)).toEqual({ ok: true, value: { kind: "owner-unchanged" } });
  });

  it("one listing Task, or several sharing one start: that commit", () => {
    expect(waveBaseOf([task("T1", 1, [OWNER], "a1")], 1, OWNER)).toEqual({ ok: true, value: { kind: "commit", sha: "a1" } });
    expect(waveBaseOf([task("T1", 1, [OWNER], "a1"), task("T2", 1, [OWNER], "a1")], 1, OWNER))
      .toEqual({ ok: true, value: { kind: "commit", sha: "a1" } });
  });

  it("several distinct starts: their merge-base, each start once, in Task order", () => {
    const tasks = [task("T1", 1, [OWNER], "a1"), task("T2", 1, [OWNER], "b2"), task("T3", 1, [OWNER], "a1"), task("T4", 1, [OWNER], "c3")];
    expect(waveBaseOf(tasks, 1, OWNER)).toEqual({ ok: true, value: { kind: "merge-base", shas: ["a1", "b2", "c3"] } });
  });

  it.each([["absent", undefined], ["empty", ""]] as const)("a listing Task whose start_sha is %s is the missing-wave-base failure naming it", (_case, start) => {
    const tasks = [task("T1", 1, [OWNER], "a1"), { ...task("T2", 1, [OWNER]), ...(start === undefined ? {} : { start_sha: start }) }];
    const base = waveBaseOf(tasks, 1, OWNER);
    expect(base).toEqual({
      ok: false,
      error: { kind: "missing-wave-base", detail: `Task T2 changed ${OWNER} but records no start_sha, so the owner's Wave base is unknown` },
    });
  });

  it("ownerTasks matches the owner under the plan path rule and keeps graph order", () => {
    const tasks = [task("T1", 1, [`./${OWNER}`]), task("T2", 1, ["src/other.ts"]), task("T3", 1, [OWNER]), task("T4", 2, [OWNER])];
    expect(ownerTasks(tasks, 1, OWNER).map(({ id }) => id)).toEqual(["T1", "T3"]);
  });
});

const ADMISSION = ownerObligation({
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: "Every entry point admits through decide().",
  owner: OWNER,
  siblings: [{ path: "src/rules/sibling-a.ts", note: "admits members" }],
  matrixTest: "tests/rules.matrix.test.ts",
  mutation: { kind: "verify" },
});

const invariant = (extra: readonly string[] = []): string => [
  "# Plan", "", "## Invariants", "",
  "### INV-1: Admission is decided only by the owner", "",
  "**Tier:** advisory",
  `**Owner module:** \`${OWNER}\``,
  "**Sibling entry points:**",
  "- `src/rules/sibling-a.ts` — admits members",
  "**Matrix test:** `tests/rules.matrix.test.ts`",
  "**Statement:** Every entry point admits through decide().",
  ...extra, "",
].join("\n");

const stamped = ownerScopeOf({ tasks: [], owner_obligations: [ADMISSION] });

describe("planModelsIntegrityFailure", () => {
  it("is null when the plan re-derives the stamp exactly", () => {
    expect(planModelsIntegrityFailure("plan.md", parsePlanModels(invariant()), stamped)).toBeNull();
  });

  it("an exemption without a reason is malformed ownership, never an opt-out", () => {
    const failure = planModelsIntegrityFailure("plan.md", parsePlanModels(invariant(["**Mutation exemption:**"])), stamped);
    expect(failure).toMatchObject({ kind: "plan-malformed", detail: expect.stringContaining("plan plan.md declares malformed models: INV-1") });
  });

  it("a plan that derives other obligations is drift", () => {
    const failure = planModelsIntegrityFailure("plan.md", parsePlanModels(invariant(["**Mutation exemption:** generated"])), stamped);
    expect(failure).toMatchObject({ kind: "plan-drift", detail: expect.stringContaining("plan plan.md no longer derives the owner_obligations") });
  });

  it("a graph without a stamp has nothing the plan could agree with: drift", () => {
    expect(planModelsIntegrityFailure("plan.md", parsePlanModels(invariant()), ownerScopeOf({ tasks: [] })))
      .toMatchObject({ kind: "plan-drift" });
  });

  it("an owned Invariant naming one path in two roles derives no obligation: malformed", () => {
    const doubled = invariant().replace("**Matrix test:** `tests/rules.matrix.test.ts`", `**Matrix test:** \`${OWNER}\``);
    expect(planModelsIntegrityFailure("plan.md", parsePlanModels(doubled), stamped))
      .toMatchObject({ kind: "plan-malformed" });
  });
});
