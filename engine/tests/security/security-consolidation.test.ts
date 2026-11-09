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

type TraceStep = ConfirmedFinding["trace"][number];

const trace = (sinkLine: number): readonly TraceStep[] => [
  { kind: "entrypoint", file: "src/api/login.ts", line: 12, scope: "HTTP handler", description: "Reads `email`." },
  { kind: "sink", file: "src/db/users.ts", line: sinkLine, scope: "SQL builder", description: "Interpolates the value." },
];

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
      trace: [trace(40)[0] as TraceStep, propagation(20), trace(40)[1] as TraceStep],
    });
    const merged = consolidateCandidates(parse([shallow, deep]));
    expect(merged.map((finding) => finding.fingerprint)).toEqual(["b/deep"]);
  });

  it("keeps two defects that share a root-cause SENTENCE but land on different sinks", () => {
    const left = aConfirmedFinding({ fingerprint: "a/left", root_cause: "Concatenated query.", trace: trace(40) });
    const right = aConfirmedFinding({ fingerprint: "b/right", root_cause: "Concatenated query.", trace: trace(55) });
    expect(consolidateCandidates(parse([left, right])).map((finding) => finding.fingerprint)).toEqual(["a/left", "b/right"]);
  });

  it("never merges a finding whose trace names no sink", () => {
    const noSink = aConfirmedFinding({
      fingerprint: "a/no-sink",
      root_cause: "Concatenated query.",
      trace: [trace(40)[0] as TraceStep],
    });
    const withSink = aConfirmedFinding({ fingerprint: "b/with-sink", root_cause: "Concatenated query.", trace: trace(40) });
    expect(consolidateCandidates(parse([noSink, withSink]))).toHaveLength(2);
  });

  it("keeps the first record for a repeated fingerprint and orders the survivors", () => {
    // Duplicates arrive from DIFFERENT hunter documents, each parsed on its own:
    // the parser refuses a duplicated fingerprint inside one file, so this is
    // exactly the cross-file case consolidation exists for.
    const first = aConfirmedFinding({ fingerprint: "b/two", root_cause: "Concatenated query.", trace: trace(40) });
    const duplicate = aConfirmedFinding({ fingerprint: "b/two", root_cause: "Different.", trace: trace(41) });
    const other = aConfirmedFinding({ fingerprint: "a/one", root_cause: "Concatenated query.", trace: trace(90) });
    const merged = consolidateCandidates([...parse([first]), ...parse([duplicate]), ...parse([other])]);
    expect(merged.map((finding) => finding.fingerprint)).toEqual(["a/one", "b/two"]);
    const survivor = merged[1];
    expect(survivor?.verdict === "confirmed" ? survivor.root_cause : null).toBe("Concatenated query.");
  });

  it("merges a claim and its unvalidated lead sharing the sink and root cause", () => {
    const claim = aConfirmedFinding({ fingerprint: "a/claim", root_cause: "Concatenated query.", trace: trace(40) });
    const lead = aNeedsValidationFinding({ fingerprint: "b/lead", claimed_root_cause: "Concatenated query.", trace: trace(40) });
    expect(consolidateCandidates(parse([claim, lead]))).toHaveLength(1);
  });

  it("is idempotent", () => {
    const set = parse([
      aConfirmedFinding({ fingerprint: "a/one", root_cause: "Concatenated query.", trace: trace(40) }),
      aConfirmedFinding({ fingerprint: "b/two", root_cause: "Concatenated query.", trace: trace(40) }),
      aConfirmedFinding({ fingerprint: "c/three", root_cause: "Unescaped HTML.", trace: trace(90) }),
    ]);
    const once = consolidateCandidates(set);
    expect(consolidateCandidates(once)).toEqual(once);
  });
});

describe("filing a hunter's records into the run (fileCandidates)", () => {
  const held = parse([aConfirmedFinding()]);

  it("keeps one copy of a record re-filed verbatim, whatever its key order", () => {
    const reordered = parse([Object.fromEntries(Object.entries(aConfirmedFinding()).reverse())]);
    expect(ok(fileCandidates(held, reordered))).toEqual(held);
  });

  it("is idempotent: filing what the run holds converges on what it holds", () => {
    const once = ok(fileCandidates([], held));
    expect(ok(fileCandidates(once, held))).toEqual(once);
  });

  it("adds a fresh record and returns the document sorted and consolidated", () => {
    const fresh = parse([aNeedsValidationFinding({ fingerprint: "a/earlier", trace: trace(90) })]);
    expect(ok(fileCandidates(held, fresh)).map((finding) => finding.fingerprint)).toEqual(["a/earlier", "api/login:sqli-email"]);
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
