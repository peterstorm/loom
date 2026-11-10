/**
 * Consolidation semantics: "one root cause, one record" must not become
 * "one sentence, one record".
 *
 * Two hunters describing one defect from different entry points earn different
 * fingerprints; merging them is the point. But a terse hunter can paste the same
 * root-cause sentence onto two different defects, and merging those silently
 * removes a finding from the published set — the failure mode a review would
 * never see, because the set that gets published still looks coherent.
 */

import { describe, expect, it } from "vitest";
import {
  consolidateCandidates,
  fileCandidates,
  parseSecurityFindings,
  type ConfirmedFinding,
  type SecurityFinding,
} from "../../src/core/security-findings";
import { aConfirmedFinding, aNeedsValidationFinding, ok } from "./fixtures";

const parse = (raw: readonly unknown[]): readonly SecurityFinding[] => ok(parseSecurityFindings(raw));

/** The fingerprints consolidation keeps. */
const keptOf = (candidates: readonly SecurityFinding[], pinned?: ReadonlySet<string>): readonly string[] =>
  consolidateCandidates(candidates, pinned).kept.map((finding) => finding.fingerprint);

type TraceStep = ConfirmedFinding["trace"][number];

const ENTRY: TraceStep = { kind: "entrypoint", file: "src/api/login.ts", line: 12, scope: "HTTP handler", description: "Reads `email`." };
const sinkAt = (line: number): TraceStep => ({ kind: "sink", file: "src/db/users.ts", line, scope: "SQL builder", description: "Interpolates the value." });

const trace = (sinkLine: number): ConfirmedFinding["trace"] => [ENTRY, sinkAt(sinkLine)];

/** A middle step the trace grammar allows (entrypoint → propagation* → sink). */
const propagation = (line: number): TraceStep => ({
  kind: "propagation",
  file: "src/api/login.ts",
  line,
  scope: "HTTP handler",
  description: "No session check before the query.",
});

describe("root-cause consolidation", () => {
  it("merges one defect seen from two entry points, keeping the fuller trace", () => {
    const shallow = aConfirmedFinding({ fingerprint: "a/shallow", root_cause: "Concatenated query.", trace: trace(40) });
    const deep = aConfirmedFinding({
      fingerprint: "b/deep",
      root_cause: "Concatenated query.",
      trace: [ENTRY, propagation(20), sinkAt(40)],
    });
    const merged = consolidateCandidates(parse([shallow, deep]));
    expect(merged.kept.map((finding) => finding.fingerprint)).toEqual(["b/deep"]);
    expect(merged.absorbed).toEqual([{ fingerprint: "a/shallow", keptAs: "b/deep" }]);
  });

  it("keeps two defects that share a root-cause SENTENCE but land on different sinks", () => {
    const left = aConfirmedFinding({ fingerprint: "a/left", root_cause: "Concatenated query.", trace: trace(40) });
    const right = aConfirmedFinding({ fingerprint: "b/right", root_cause: "Concatenated query.", trace: trace(55) });
    const kept = consolidateCandidates(parse([left, right]));
    expect(kept.kept.map((finding) => finding.fingerprint)).toEqual(["a/left", "b/right"]);
    expect(kept.absorbed).toEqual([]);
  });

  it("never merges a finding whose trace names no sink", () => {
    const noSink = aConfirmedFinding({
      fingerprint: "a/no-sink",
      root_cause: "Concatenated query.",
      trace: [ENTRY],
    });
    const withSink = aConfirmedFinding({ fingerprint: "b/with-sink", root_cause: "Concatenated query.", trace: trace(40) });
    expect(keptOf(parse([noSink, withSink]))).toHaveLength(2);
  });

  it("keeps the first record for a repeated fingerprint and orders the survivors", () => {
    // Duplicates arrive from DIFFERENT hunter documents, each parsed on its own:
    // the parser refuses a duplicated fingerprint inside one file, so this is
    // exactly the cross-file case consolidation exists for.
    const first = aConfirmedFinding({ fingerprint: "b/two", root_cause: "Concatenated query.", trace: trace(40) });
    const duplicate = aConfirmedFinding({ fingerprint: "b/two", root_cause: "Different.", trace: trace(41) });
    const other = aConfirmedFinding({ fingerprint: "a/one", root_cause: "Concatenated query.", trace: trace(90) });
    const merged = consolidateCandidates([...parse([first]), ...parse([duplicate]), ...parse([other])]).kept;
    expect(merged.map((finding) => finding.fingerprint)).toEqual(["a/one", "b/two"]);
    const survivor = merged[1];
    expect(survivor?.verdict === "confirmed" ? survivor.root_cause : null).toBe("Concatenated query.");
  });

  it("merges a claim and its unvalidated lead sharing the sink and root cause", () => {
    const claim = aConfirmedFinding({ fingerprint: "a/claim", root_cause: "Concatenated query.", trace: trace(40) });
    const lead = aNeedsValidationFinding({ fingerprint: "b/lead", claimed_root_cause: "Concatenated query.", trace: trace(40) });
    expect(keptOf(parse([claim, lead]))).toEqual(["a/claim"]);
  });

  it("is idempotent", () => {
    const set = parse([
      aConfirmedFinding({ fingerprint: "a/one", root_cause: "Concatenated query.", trace: trace(40) }),
      aConfirmedFinding({ fingerprint: "b/two", root_cause: "Concatenated query.", trace: trace(40) }),
      aConfirmedFinding({ fingerprint: "c/three", root_cause: "Unescaped HTML.", trace: trace(90) }),
    ]);
    const once = consolidateCandidates(set);
    const twice = consolidateCandidates(once.kept);
    expect(twice.kept).toEqual(once.kept);
    expect(twice.absorbed).toEqual([]);
  });

  it("names the FINAL keeper of a record absorbed into one that was itself displaced", () => {
    // a/short is kept first, then b/mid outranks it (longer trace), then c/long
    // outranks b/mid: both absorptions point at c/long, the record that stands.
    const short = aConfirmedFinding({ fingerprint: "a/short", root_cause: "Concatenated query.", trace: trace(40) });
    const mid = aConfirmedFinding({ fingerprint: "b/mid", root_cause: "Concatenated query.", trace: [ENTRY, propagation(20), sinkAt(40)] });
    const long = aConfirmedFinding({
      fingerprint: "c/long",
      root_cause: "Concatenated query.",
      trace: [ENTRY, propagation(20), propagation(21), sinkAt(40)],
    });
    const merged = consolidateCandidates(parse([short, mid, long]));
    expect(merged.kept.map((finding) => finding.fingerprint)).toEqual(["c/long"]);
    expect(merged.absorbed).toEqual([
      { fingerprint: "a/short", keptAs: "c/long" },
      { fingerprint: "b/mid", keptAs: "c/long" },
    ]);
  });

  it("accounts for every candidate: each one is kept or absorbed into a kept record, never both, never neither", () => {
    const candidates = parse([
      aConfirmedFinding({ fingerprint: "a/one", root_cause: "Concatenated query.", trace: trace(40) }),
      aNeedsValidationFinding({ fingerprint: "b/two", claimed_root_cause: "Concatenated query.", trace: trace(40) }),
      aConfirmedFinding({ fingerprint: "c/three", root_cause: "Unescaped HTML.", trace: trace(90) }),
      aConfirmedFinding({ fingerprint: "d/four", root_cause: "Unescaped HTML.", trace: [ENTRY, propagation(5), sinkAt(90)] }),
      aConfirmedFinding({ fingerprint: "e/five", root_cause: "Concatenated query.", trace: [ENTRY] }),
    ]);
    for (const pinned of [new Set<string>(), new Set(["b/two"]), new Set(["c/three", "a/one"])]) {
      const merged = consolidateCandidates(candidates, pinned);
      const kept = new Set(merged.kept.map((finding) => finding.fingerprint));
      const absorbed = merged.absorbed.map((entry) => entry.fingerprint);
      expect([...kept, ...absorbed].sort()).toEqual(candidates.map((finding) => finding.fingerprint).sort());
      for (const entry of merged.absorbed) expect(kept.has(entry.keptAs)).toBe(true);
      for (const fingerprint of pinned) expect(kept.has(fingerprint)).toBe(true);
    }
  });
});

describe("filing a hunter's records into the run (fileCandidates)", () => {
  const held = parse([aConfirmedFinding()]);

  it("keeps one copy of a record re-filed verbatim, whatever its key order", () => {
    const reordered = parse([Object.fromEntries(Object.entries(aConfirmedFinding()).reverse())]);
    expect(ok(fileCandidates(held, reordered))).toEqual({ findings: held, absorbed: [] });
  });

  it("is idempotent: filing what the run holds converges on what it holds", () => {
    const once = ok(fileCandidates([], held)).findings;
    expect(ok(fileCandidates(once, held))).toEqual({ findings: once, absorbed: [] });
  });

  it("adds a fresh record and returns the document sorted and consolidated", () => {
    const fresh = parse([aNeedsValidationFinding({ fingerprint: "a/earlier", trace: trace(90) })]);
    expect(ok(fileCandidates(held, fresh)).findings.map((finding) => finding.fingerprint)).toEqual(["a/earlier", "api/login:sqli-email"]);
  });

  it("never displaces a record the run holds with a later filing of the same defect", () => {
    // The run holds a LEAD; a later hunter files the same sink and root cause as
    // a CONFIRMED claim under a new fingerprint. Consolidation alone would keep
    // the stronger verdict and drop the held record — the record a verifier may
    // have balloted and a unit's `result_fingerprints` may list. Held records
    // are pinned: the run keeps what it holds, and the re-description yields.
    const lead = parse([aNeedsValidationFinding({ fingerprint: "b/held-lead", claimed_root_cause: "Concatenated query.", trace: trace(40) })]);
    const stronger = parse([aConfirmedFinding({ fingerprint: "a/fresh-claim", root_cause: "Concatenated query.", trace: [ENTRY, propagation(20), sinkAt(40)] })]);
    const filed = ok(fileCandidates(lead, stronger));
    expect(filed.findings.map((finding) => finding.fingerprint)).toEqual(["b/held-lead"]);
    // ...and the absorbed claim is SAID, naming the record kept in its place —
    // even though the filing is confirmed and the held record only a lead.
    expect(filed.absorbed).toEqual([{ fingerprint: "a/fresh-claim", keptAs: "b/held-lead" }]);
    // Unpinned, the same pair consolidates to the stronger claim — the rule the pin overrides.
    expect(keptOf([...lead, ...stronger])).toEqual(["a/fresh-claim"]);
    expect(keptOf([...lead, ...stronger], new Set(["b/held-lead"]))).toEqual(["b/held-lead"]);
  });

  it("refuses a held fingerprint re-filed with different content, naming every conflict", () => {
    const heldTwo = parse([aConfirmedFinding(), aConfirmedFinding({ fingerprint: "z/other", trace: trace(77), root_cause: "Unescaped HTML." })]);
    const refiled = parse([
      aConfirmedFinding({ title: "A different title for the same defect" }),
      aNeedsValidationFinding({ fingerprint: "m/fresh", trace: trace(91) }),
      aConfirmedFinding({ fingerprint: "z/other", trace: trace(77), root_cause: "Unescaped HTML.", title: "Retitled" }),
    ]);
    const refused = fileCandidates(heldTwo, refiled);
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== "conflicting-refiling") throw new Error("expected a re-filing conflict");
    expect(refused.error.fingerprints).toEqual(["api/login:sqli-email", "z/other"]);
    expect(refused.error.message).toContain("the run already holds a different record for api/login:sqli-email, z/other");
    expect(refused.error.message).toContain("verification adjudicates the record the run already holds");
  });
});
