import { describe, expect, it } from "vitest";
import { piAllSlotsFailedNote } from "../../../pi/subagent-result";

/**
 * A shared-infrastructure fault hits every slot of a batch at once, and that is
 * a strong signature — but it is invisible from inside any single slot, where
 * the evidence is one ordinary "the agent failed" rejection. Seven of those in
 * a row read as seven agent defects unless something names the pattern.
 *
 * The note is a diagnostic, so what matters is that it fires on exactly the
 * shape that warrants it: two or more results, all failed. One result is not a
 * pattern, and a single surviving sibling refutes the shared-fault reading
 * outright — a note in either case would be the engine guessing.
 */
describe("piAllSlotsFailedNote", () => {
  const failed = (stopReason: string) => ({ exitCode: 0, stopReason });
  const ok = { exitCode: 0, stopReason: "stop" };

  it("names the pattern when every slot in a multi-slot batch failed", () => {
    const note = piAllSlotsFailedNote([failed("error"), failed("error"), failed("error")]);

    expect(note).toContain("all 3 slots in this batch failed");
    expect(note).toContain("stopReason=error");
    expect(note).toContain("shared-infrastructure fault");
  });

  it("reports every distinct stop reason the batch carried, deduplicated and ordered", () => {
    expect(piAllSlotsFailedNote([failed("error"), failed("aborted"), failed("error")]))
      .toContain("stopReason=aborted|error");
  });

  it("degrades a missing stop reason to n/a rather than dropping the slot's contribution", () => {
    expect(piAllSlotsFailedNote([{ exitCode: 1 }, { exitCode: 1 }])).toContain("stopReason=n/a");
  });

  it("stays silent when a slot survived — the survivor refutes a shared fault", () => {
    expect(piAllSlotsFailedNote([failed("error"), ok, failed("error")])).toBeNull();
    expect(piAllSlotsFailedNote([ok, ok])).toBeNull();
  });

  it("stays silent below two slots, where there is no pattern to report", () => {
    expect(piAllSlotsFailedNote([])).toBeNull();
    expect(piAllSlotsFailedNote([failed("error")])).toBeNull();
  });
});
