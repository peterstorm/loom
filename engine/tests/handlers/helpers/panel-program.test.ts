import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { criterionOf, type ArchitectureCriterion } from "../../../src/core/panel-contract";
import {
  parseArchitecturePanelJournal,
  type ArchitectureEngineOperation,
  type ArchitecturePanelJournal,
  type ArchitectureProgramInput,
} from "../../../src/core/panel-program";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOT = resolve(ENGINE, "..");
const CLI = join(ENGINE, "src/cli.ts");

function cli(document: unknown): unknown {
  return JSON.parse(execFileSync("bun", [CLI, "helper", "panel-program", "architecture"], {
    cwd: ROOT,
    input: JSON.stringify(document),
    encoding: "utf-8",
  }));
}

const architectureInput = {
  candidateLenses: ["simplicity-first", "type-driven-fp"],
  judgeCriteria: ["simplicity", "pure functional core"],
} as const;

/** `architectureInput` as the journal parser returns it: each criterion an `ArchitectureCriterion`. */
const parsedArchitectureInput: ArchitectureProgramInput = {
  candidateLenses: architectureInput.candidateLenses,
  judgeCriteria: [criterionOf("simplicity"), criterionOf("pure functional core")],
};

describe("the architecture panel journal", () => {
  it("reads the unversioned spelling and the explicitly tagged one alike, without rewriting either", () => {
    const historical = {
      input: architectureInput,
      events: [{
        type: "spawn-outcome",
        requestId: "architecture:candidate:2",
        attempt: 1,
        outcome: "succeeded",
      }],
    };
    const before = JSON.stringify(historical);
    const parsed = parseArchitecturePanelJournal(historical);
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        input: architectureInput,
        events: [{ requestId: "architecture:candidate:2" }],
      },
    });
    expect(JSON.stringify(historical)).toBe(before);

    const tagged = parseArchitecturePanelJournal({
      schemaVersion: 1,
      format: "legacy-panel-program",
      panel: "architecture",
      input: architectureInput,
      events: historical.events,
    });
    expect(tagged).toEqual(parsed);
  });

  it("rejects a conflicting format or panel tag", () => {
    expect(parseArchitecturePanelJournal({
      format: "other-format",
      input: architectureInput,
      events: [],
    })).toEqual({ ok: false, error: "Unsupported panel journal format: other-format" });
    expect(parseArchitecturePanelJournal({
      format: "legacy-panel-program",
      panel: "refutation",
      input: architectureInput,
      events: [],
    })).toEqual({
      ok: false,
      error: "Panel journal declares 'refutation' but was opened as 'architecture'",
    });
  });

  it("parses lenses through the exact architecture membership", () => {
    expect(parseArchitecturePanelJournal({
      input: { ...architectureInput, candidateLenses: ["simplicity-first", "not-a-panel-lens"] },
      events: [],
    })).toEqual({
      ok: false,
      error: "unknown architecture design lens: not-a-panel-lens",
    });
  });

  it("parses criteria through the closed judge-criterion vocabulary", () => {
    expect(parseArchitecturePanelJournal({
      input: { ...architectureInput, judgeCriteria: ["simplicity", "not-a-criterion", "also-not-one"] },
      events: [],
    })).toEqual({
      ok: false,
      error: "unknown architecture judge criterion: not-a-criterion",
    });

    const parsed = parseArchitecturePanelJournal({ input: architectureInput, events: [] });
    expect(parsed).toEqual({ ok: true, value: { input: parsedArchitectureInput, events: [] } });
    if (parsed.ok) expectTypeOf(parsed.value.input.judgeCriteria).toEqualTypeOf<readonly ArchitectureCriterion[]>();
  });

  it("names an unknown lens before a malformed judgeCriteria, and the input shape otherwise", () => {
    const shape = "architecture input requires exact PanelLens candidateLenses[] and judgeCriteria[]";
    expect(parseArchitecturePanelJournal({ input: { candidateLenses: ["not-a-panel-lens"], judgeCriteria: 7 }, events: [] }))
      .toEqual({ ok: false, error: "unknown architecture design lens: not-a-panel-lens" });
    expect(parseArchitecturePanelJournal({ input: { ...architectureInput, judgeCriteria: [7] }, events: [] }))
      .toEqual({ ok: false, error: shape });
    expect(parseArchitecturePanelJournal({ input: { ...architectureInput, candidateLenses: ["simplicity-first", 7] }, events: [] }))
      .toEqual({ ok: false, error: shape });
    expect(parseArchitecturePanelJournal({ input: { judgeCriteria: architectureInput.judgeCriteria }, events: [] }))
      .toEqual({ ok: false, error: shape });
  });

  it.each<ArchitectureEngineOperation>(["architecture-prepare-candidates", "architecture-prepare-judges", "architecture-aggregate"])(
    "reads a journalled %s engine-outcome, carrying its error text",
    (operationId) => {
      expect(parseArchitecturePanelJournal({
        input: architectureInput,
        events: [{ type: "engine-outcome", operationId, outcome: "failed", error: "boom" }],
      })).toMatchObject({ ok: true, value: { events: [{ type: "engine-outcome", operationId, outcome: "failed", error: "boom" }] } });
    },
  );

  it("refuses an event whose error is not a string", () => {
    expect(parseArchitecturePanelJournal({
      input: architectureInput,
      events: [{ type: "spawn-outcome", requestId: "architecture:candidate:1", attempt: 1, outcome: "failed", error: 7 }],
    })).toEqual({ ok: false, error: "events[0].error must be a string" });
  });

  it("resumes an in-flight architecture prefix and preserves accepted slots", () => {
    const document = {
      input: architectureInput,
      events: [{
        type: "spawn-outcome",
        requestId: "architecture:candidate:2",
        attempt: 1,
        outcome: "succeeded",
      }],
    };
    const resumed = cli(document) as {
      state: { stage: string; slots: Array<{ request: { id: string }; status: string }> };
      action: null;
    };
    expect(resumed.state.stage).toBe("candidates");
    expect(resumed.state.slots).toEqual([
      expect.objectContaining({ request: expect.objectContaining({ id: "architecture:candidate:1" }), status: "pending" }),
      expect.objectContaining({ request: expect.objectContaining({ id: "architecture:candidate:2" }), status: "succeeded" }),
    ]);
    expect(resumed.action).toBeNull();
    expect(document.events).toHaveLength(1);
  });

  it("preserves consumed retry authority across helper invocations", () => {
    const failedOnce = {
      input: architectureInput,
      events: [{
        type: "spawn-outcome",
        requestId: "architecture:candidate:1",
        attempt: 1,
        outcome: "failed",
        error: "empty candidate",
      }],
    };
    const retry = cli(failedOnce) as {
      state: { stage: string; slots: Array<{ request: { id: string; attempt: number } }> };
      action: { type: string; requests: Array<{ id: string; attempt: number }> };
    };
    expect(retry.action).toMatchObject({
      type: "spawn-batch",
      requests: [{ id: "architecture:candidate:1", attempt: 2 }],
    });
    expect(retry.state.slots[0]!.request.attempt).toBe(2);

    const exhausted = cli({
      ...failedOnce,
      events: [
        ...failedOnce.events,
        {
          type: "spawn-outcome",
          requestId: "architecture:candidate:1",
          attempt: 2,
          outcome: "failed",
          error: "still empty",
        },
      ],
    }) as { state: { stage: string; reason: string }; action: { type: string } };
    expect(exhausted.state).toMatchObject({ stage: "blocked", reason: "still empty" });
    expect(exhausted.action.type).toBe("blocked");
  });

  it.each([
    ["future schema", { schemaVersion: 2, input: architectureInput, events: [] }, "schemaVersion"],
    ["malformed event", { input: architectureInput, events: [{ type: "spawn-outcome" }] }, "valid spawn-outcome"],
    ["duplicate event", {
      input: architectureInput,
      events: [
        { type: "spawn-outcome", requestId: "architecture:candidate:1", attempt: 1, outcome: "succeeded" },
        { type: "spawn-outcome", requestId: "architecture:candidate:1", attempt: 1, outcome: "succeeded" },
      ],
    }, "duplicate-outcome"],
  ])("fails closed for %s", (_label, document, expected) => {
    const run = spawnSync("bun", [CLI, "helper", "panel-program", "architecture"], {
      cwd: ROOT,
      input: JSON.stringify(document),
      encoding: "utf-8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(expected);
  });

  it("has no refutation mode: the Refutation Panel runs inside its review (ADR-0096)", () => {
    const run = spawnSync("bun", [CLI, "helper", "panel-program", "refutation"], {
      cwd: ROOT,
      input: JSON.stringify({ input: { criticalFindingIds: ["T1:code-reviewer-1"], lenses: ["reproduction", "intent"] }, events: [] }),
      encoding: "utf-8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Usage: helper panel-program architecture");
  });

  it("returns a closed diagnostic instead of throwing on hostile input", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    // The rejection stays typed (never throws) AND carries the thrown cause, so
    // a hostile/typo'd journal is diagnosable — the static message alone could
    // not distinguish a proxy from a shape defect.
    expect(() => parseArchitecturePanelJournal(proxy)).not.toThrow();
    const result = parseArchitecturePanelJournal(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Panel program journal could not be safely inspected");
      // V8 wordings differ across runtimes ("Cannot perform 'IsArray' on a proxy
      // that has been revoked" vs the older "Array.isArray called on a
      // proxy..."); both prove the cause is bound, which is the contract.
      expect(result.error).toMatch(/Array\.isArray|revoked/);
    }
  });

  it("makes a foreign operation unrepresentable in types and rejects it while parsing", () => {
    const architectureJournal: ArchitecturePanelJournal = {
      input: parsedArchitectureInput,
      events: [{
        type: "engine-outcome",
        // @ts-expect-error refutation operations cannot inhabit an architecture journal
        operationId: "refutation-tally",
        outcome: "succeeded",
      }],
    };
    void architectureJournal;

    expect(parseArchitecturePanelJournal({
      input: architectureInput,
      events: [{
        type: "engine-outcome",
        operationId: "refutation-tally",
        outcome: "succeeded",
      }],
    })).toEqual({
      ok: false,
      error: "events[0] is not a valid architecture engine-outcome",
    });

    const run = spawnSync("bun", [CLI, "helper", "panel-program", "architecture"], {
      cwd: ROOT,
      input: JSON.stringify({
        input: architectureInput,
        events: [{ type: "engine-outcome", operationId: "refutation-tally", outcome: "succeeded" }],
      }),
      encoding: "utf-8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("not a valid architecture engine-outcome");
  });
});
