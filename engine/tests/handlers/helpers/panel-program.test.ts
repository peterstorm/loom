import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGACY_PANEL_PROGRAM_SCHEMA_VERSION,
  prepareArchitecturePanelPersistenceOperations,
  prepareRefutationPanelPersistenceOperations,
  translateLegacyPanelJournal,
  translateLegacyPanelJournalBytes,
  type LegacyArchitecturePanelJournal,
} from "../../../src/handlers/helpers/panel-program";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOT = resolve(ENGINE, "..");
const CLI = join(ENGINE, "src/cli.ts");

function cli(panel: "architecture" | "refutation", document: unknown): unknown {
  return JSON.parse(execFileSync("bun", [CLI, "helper", "panel-program", panel], {
    cwd: ROOT,
    input: JSON.stringify(document),
    encoding: "utf-8",
  }));
}

const architectureInput = {
  candidateLenses: ["simplicity-first", "type-driven-fp"],
  judgeCriteria: ["simplicity", "pure functional core"],
} as const;

const refutationInput = {
  criticalFindingIds: ["T1:code-reviewer-1"],
  lenses: ["reproduction", "intent", "blast-radius"],
};

describe("legacy panel journal compatibility", () => {
  it("retains the exact legacy source bytes while exposing an in-memory compatibility view", () => {
    const source = ` {\n  \"input\": ${JSON.stringify(architectureInput)},\n  \"events\": []\n}\n`;
    const translated = translateLegacyPanelJournalBytes("architecture", source);
    expect(translated.ok).toBe(true);
    if (!translated.ok) throw new Error(translated.error);
    expect(translated.value.source).toBe(source);
    expect(new TextEncoder().encode(translated.value.source)).toEqual(new TextEncoder().encode(source));
    expect(translated.value.journal).toMatchObject({ panel: "architecture", events: [] });
  });

  it("exposes separate new-session helper persistence operations without a workflow DSL", () => {
    expect(prepareArchitecturePanelPersistenceOperations({
      state: {} as never,
      action: null,
    }, {} as never, (() => ({ ok: false })) as never)).toEqual({
      ok: false,
      error: "Architecture step has no durable event to persist",
    });
    expect(prepareRefutationPanelPersistenceOperations({
      state: {} as never,
      action: null,
    }, {} as never, (() => ({ ok: false })) as never)).toEqual({
      ok: false,
      error: "Refutation step has no durable event to persist",
    });
  });

  it("format-detects historical and explicitly-versioned journals without rewriting either", () => {
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
    const translated = translateLegacyPanelJournal("architecture", historical);
    expect(translated).toMatchObject({
      ok: true,
      value: {
        format: "legacy-panel-program",
        schemaVersion: LEGACY_PANEL_PROGRAM_SCHEMA_VERSION,
        panel: "architecture",
        events: [{ requestId: "architecture:candidate:2" }],
      },
    });
    expect(JSON.stringify(historical)).toBe(before);

    const versioned = translateLegacyPanelJournal("architecture", {
      schemaVersion: 1,
      input: architectureInput,
      events: historical.events,
    });
    expect(versioned).toEqual(translated);
  });

  it("rejects conflicting explicit legacy format and panel metadata", () => {
    expect(translateLegacyPanelJournal("architecture", {
      format: "other-format",
      input: architectureInput,
      events: [],
    })).toEqual({ ok: false, error: "Unsupported panel journal format: other-format" });
    expect(translateLegacyPanelJournal("architecture", {
      format: "legacy-panel-program",
      panel: "refutation",
      input: architectureInput,
      events: [],
    })).toEqual({
      ok: false,
      error: "Panel journal declares 'refutation' but was opened as 'architecture'",
    });
  });

  it("parses legacy lenses through exact architecture/refutation memberships", () => {
    expect(translateLegacyPanelJournal("architecture", {
      input: { ...architectureInput, candidateLenses: ["simplicity-first", "not-a-panel-lens"] },
      events: [],
    })).toEqual({
      ok: false,
      error: "unknown architecture design lens: not-a-panel-lens",
    });
    expect(translateLegacyPanelJournal("refutation", {
      input: { ...refutationInput, lenses: ["reproduction", "not-a-review-lens"] },
      events: [],
    })).toEqual({
      ok: false,
      error: "unknown refutation lens: not-a-review-lens",
    });
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
    const resumed = cli("architecture", document) as {
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
      input: refutationInput,
      events: [{
        type: "spawn-outcome",
        requestId: "refutation:verifier:1",
        attempt: 1,
        outcome: "failed",
        error: "malformed verdict",
      }],
    };
    const retry = cli("refutation", failedOnce) as {
      state: { stage: string; slots: Array<{ request: { id: string; attempt: number } }> };
      action: { type: string; requests: Array<{ id: string; attempt: number }> };
    };
    expect(retry.action).toMatchObject({
      type: "spawn-batch",
      requests: [{ id: "refutation:verifier:1", attempt: 2 }],
    });
    expect(retry.state.slots[0]!.request.attempt).toBe(2);

    const exhausted = cli("refutation", {
      ...failedOnce,
      events: [
        ...failedOnce.events,
        {
          type: "spawn-outcome",
          requestId: "refutation:verifier:1",
          attempt: 2,
          outcome: "failed",
          error: "still malformed",
        },
      ],
    }) as { state: { stage: string; reason: string }; action: { type: string } };
    expect(exhausted.state).toMatchObject({ stage: "blocked", reason: "still malformed" });
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

  it("returns a closed diagnostic instead of throwing on hostile legacy input", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    // The A1 contract: the rejection stays typed (never throws) AND carries the
    // thrown cause, so a hostile/typo'd journal is diagnosable — the static
    // message alone could not distinguish a proxy from a shape defect.
    expect(() => translateLegacyPanelJournal("architecture", proxy)).not.toThrow();
    const result = translateLegacyPanelJournal("architecture", proxy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Panel program journal could not be safely inspected");
      // The bound cause names the actual failure (revoked proxy) instead of a
      // blanket "could not be inspected". V8 wordings differ across runtimes
      // ("Cannot perform 'IsArray' on a proxy that has been revoked" vs the
      // older "Array.isArray called on a proxy..."); both prove the cause is
      // bound, which is the contract under test.
      expect(result.error).toMatch(/Array\.isArray|revoked/);
    }
  });

  it("makes cross-panel legacy journals impossible in types and rejects them during translation", () => {
    const architectureJournal: LegacyArchitecturePanelJournal = {
      format: "legacy-panel-program",
      schemaVersion: 1,
      panel: "architecture",
      input: architectureInput,
      events: [{
        type: "engine-outcome",
        // @ts-expect-error refutation operations cannot inhabit an architecture journal
        operationId: "refutation-tally",
        outcome: "succeeded",
      }],
    };
    void architectureJournal;

    expect(translateLegacyPanelJournal("architecture", {
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
    expect(translateLegacyPanelJournal("refutation", {
      input: refutationInput,
      events: [{
        type: "engine-outcome",
        operationId: "architecture-aggregate",
        outcome: "succeeded",
      }],
    })).toEqual({
      ok: false,
      error: "events[0] is not a valid refutation engine-outcome",
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
