/**
 * Round 36 critical #1 — a panel must survive a capture-refusal record.
 *
 * Both panel replay paths fold the run's event journal through their machine.
 * A terminalised capture refusal journals an audit record beside the program's
 * own events, and the translators had no case for it: the record fell into
 * `parseEvent`, which reported it as journal corruption, so a run with a
 * refused attempt could never be replayed or adjudicated — the refusal that
 * exists to make a failure visible instead wedged the panel that had to report
 * it.
 *
 * The carry-past rule is deliberately narrow: `isCaptureRejectionAuditRecord`
 * matches the exact key set and field types, so genuine corruption keeps
 * failing loudly. These tests pin BOTH halves of that promise.
 */

import { describe, expect, it } from "vitest";
import { captureRejectionAuditRecord, captureRejectionDedupKey } from "../../src/core/harness-capture";
import { translateLegacyPanelJournal } from "../../src/core/legacy-archive";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";

// Built from the canonical authority fixture so the branded `RequestId` and
// `SlotId` are minted by the domain, not asserted by this test.
const attemptOne = agentRequestAuthority("run.panel-refusal", {
  requestId: "request:reviewer:1",
  slotId: "slot-1",
  attempt: 1,
});
const attemptTwo = agentRequestAuthority("run.panel-refusal", {
  requestId: "request:reviewer:1",
  slotId: "slot-1",
  attempt: 2,
});

const refusal = captureRejectionAuditRecord(
  attemptOne,
  "no-final-payload: result carried no final text payload",
);

const architectureJournal = (events: readonly unknown[]): unknown => ({
  format: "legacy-panel-program",
  schemaVersion: 1,
  panel: "architecture",
  input: { candidateLenses: ["type-driven-fp"], judgeCriteria: ["does the model hold?"] },
  events,
});

const refutationJournal = (events: readonly unknown[]): unknown => ({
  format: "legacy-panel-program",
  schemaVersion: 1,
  panel: "refutation",
  input: { criticalFindingIds: ["task-1:code-reviewer-1"], lenses: ["reproduction"] },
  events,
});

describe("a panel replay carries a capture-refusal record past its reducer", () => {
  it.each([
    ["architecture", architectureJournal, "architecture"],
    ["refutation", refutationJournal, "refutation"],
  ] as const)("%s replays with only a refusal in the journal", (_label, build, panel) => {
    const translated = translateLegacyPanelJournal(panel, build([refusal]));

    expect(translated.ok).toBe(true);
    if (!translated.ok) return;
    // Carried PAST the reducer, not folded INTO it: the machine sees no event
    // it has no transition for, and the refusal stays in the journal on disk.
    expect(translated.value.events).toEqual([]);
  });

  it("still reports a journal that holds a lookalike record as corruption", () => {
    const lookalike = { ...refusal, unexpected: true };

    const translated = translateLegacyPanelJournal("refutation", refutationJournal([lookalike]));

    expect(translated.ok).toBe(false);
    if (translated.ok) return;
    // Still corruption, still located: the extra key means it is NOT the audit
    // record, so it reaches the reducer and the reducer says which event broke.
    expect(translated.error).toContain("events[0]");
  });

  it.each([
    ["requestId", "request:reviewer/escape"],
    ["slotId", "../slot-escape"],
  ] as const)("keeps malformed %s identity as journal corruption", (field, value) => {
    const malformed = { ...refusal, [field]: value };

    const translated = translateLegacyPanelJournal("refutation", refutationJournal([malformed]));

    expect(translated.ok).toBe(false);
    if (!translated.ok) expect(translated.error).toContain("events[0]");
  });

  it("keys one refused attempt by one journal identity, for both harnesses", () => {
    const first = captureRejectionDedupKey(attemptOne.requestId, attemptOne.attempt);
    const replay = captureRejectionDedupKey(attemptOne.requestId, attemptOne.attempt);
    const otherAttempt = captureRejectionDedupKey(attemptTwo.requestId, attemptTwo.attempt);

    expect(replay).toBe(first);
    expect(otherAttempt).not.toBe(first);
    expect(first).toMatch(/^capture-rejected:[0-9a-f]{64}$/);
  });
});
