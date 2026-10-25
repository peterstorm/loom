/**
 * T11 / AD-10 status half, shell rows: `helper orchestration status [--json]`
 * (`renderStatus`) over a stamped graph, a live Wave Gate registration and a
 * persisted completion result built as the gate builds one. One status value
 * feeds both renderers, so --json carries the persisted observation as the
 * report, human status renders that very report (AS-029), and a blocking
 * finding's remedy reaches the next action (AS-030).
 *
 * The pure status rows live in `tests/core/owner-verification-status.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { deriveLoomStatusFromParsedGraph } from "../../src/core/loom-status";
import {
  renderOwnerVerificationStatus,
  type OwnerVerificationStatusReport,
} from "../../src/core/owner-verification/status";
import { renderStatus } from "../../src/handlers/helpers/orchestration";
import type { LoomStatus, LoomStatusDocument, WaveCompletionResultObservation } from "../../src/types";
import {
  LEDGER,
  LEDGER_GRAPH,
  SURVIVOR,
  ledgerStatusDeps,
  ledgerVerdict,
  ownerVerificationIn,
  persistedOwnerResult,
  survivorVerdict,
  verifiedRun,
} from "../fixtures/persisted-completion-result";

function statusOf(result: WaveCompletionResultObservation): Readonly<{ human: string; json: Record<string, unknown> }> {
  const graph = JSON.parse(JSON.stringify(LEDGER_GRAPH)) as unknown;
  return {
    human: renderStatus(graph, ledgerStatusDeps(result), false),
    json: JSON.parse(renderStatus(graph, ledgerStatusDeps(result), true)) as Record<string, unknown>,
  };
}

const OWNER_REMEDY = /owner verification blocks the Wave Gate/;

describe("helper orchestration status: owner verification", () => {
  it("AS-029: --json carries the persisted observation as the report and human status renders that very report", () => {
    const result = persistedOwnerResult([ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 4, timedOut: 1, invalid: 0, survivors: [], unmutated: 2 }))]);
    const { human, json } = statusOf(result);
    const expected: OwnerVerificationStatusReport = ownerVerificationIn(result);
    expect(json.ownerVerification).toEqual(expected);
    for (const line of renderOwnerVerificationStatus(expected)) expect(human).toContain(line);
  });

  it("AS-029: without a persisted result, --json and human status report owner verification as not observed", () => {
    const { human, json } = statusOf({ kind: "absent" });
    expect(json.ownerVerification).toEqual({ kind: "not-observed", reason: "no persisted completion result" });
    expect(human).toMatch(/- ownerVerification: not observed/);
  });

  it("the status document type requires ownerVerification and is exactly the shape --json emits", () => {
    expectTypeOf<LoomStatusDocument["ownerVerification"]>().toEqualTypeOf<OwnerVerificationStatusReport>();
    expectTypeOf<ReturnType<typeof deriveLoomStatusFromParsedGraph>>().toEqualTypeOf<LoomStatusDocument>();
    expectTypeOf<LoomStatus>().not.toHaveProperty("ownerVerification");
    const keys: readonly (keyof LoomStatusDocument)[] = ["schemaVersion", "facts", "next", "ownerVerification"];
    const { json } = statusOf({ kind: "absent" });
    expect(Object.keys(json).sort()).toEqual([...keys].sort());
  });

  it("an unavailable persisted completion result is reported as not observed, naming why, and names no remedy", () => {
    const { human, json } = statusOf({ kind: "unavailable", reason: "EIO: i/o error reading the completion result" });
    expect(json.ownerVerification).toEqual({
      kind: "not-observed",
      reason: "the persisted completion result is unavailable: EIO: i/o error reading the completion result",
    });
    expect(human).toContain("- ownerVerification: not observed (the persisted completion result is unavailable: EIO: i/o error reading the completion result)");
    expect(JSON.stringify(json.next)).not.toMatch(OWNER_REMEDY);
  });

  it("AS-030: a gate the suite rejected for a survivor names the Invariant and the remedy in the next action", () => {
    const { human, json } = statusOf(persistedOwnerResult([survivorVerdict()]));
    const next = JSON.stringify(json.next);
    expect(next).toContain("INV-1");
    expect(next).toContain(`${LEDGER.owner}:${SURVIVOR.line}`);
    expect(next).toMatch(/strengthen tests\/balance\.matrix\.test\.ts to kill it, or declare a mutation exemption with a reason on INV-1/);
    expect(human.slice(human.indexOf("- nextAction"))).toContain(`${LEDGER.owner}:${SURVIVOR.line}`);
  });

  it("a persisted survivor the suite did not reject for owner verification (its owner exit contradicts it) is reported but names no remedy", () => {
    const { human, json } = statusOf(persistedOwnerResult([survivorVerdict()], 0));
    expect(JSON.stringify(json.facts)).not.toContain("owner-verification-rejected");
    expect(JSON.stringify(json.ownerVerification)).toContain(SURVIVOR.mutantId);
    expect(human).toContain(`survivor at ${LEDGER.owner}:${SURVIVOR.line}`);
    expect(JSON.stringify(json.next)).not.toMatch(OWNER_REMEDY);
  });

  it("AS-030: a passing owner verification adds no remedy to the next action", () => {
    const { json } = statusOf(persistedOwnerResult([
      ledgerVerdict({ kind: "covered" }, verifiedRun({ killed: 3, timedOut: 0, invalid: 0, survivors: [], unmutated: 0 })),
    ]));
    expect(JSON.stringify(json.next)).not.toMatch(/strengthen|mutation exemption/);
  });
});
