import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { parseTaskGraph, StateManager } from "../../src/state-manager";
import type { SpecParseError } from "../../src/core/parse-spec";
import type { SettledFloor } from "../../src/core/requirement-coverage";
import { epochSettledFloor } from "../../src/core/wave-review-authority";
import { parseSpecCheckOutput, reconcileSpecCheck, specCheckNeedsReapplication } from "../../src/core/spec-check";

const DIGEST = "a".repeat(64);
const REQUIRED = 'Task "T1" claim "FR-999" — names no entry in the Spec Index';
const CURRENT = { kind: "settled", count: 1, criticalFindings: [REQUIRED] } as const;
const UNPROJECTED = { kind: "unprojected", reason: "spec file was unavailable" } as const;
const graph = (fields: Readonly<Record<string, unknown>> = {}) => ({
  current_phase: "execute",
  current_wave: 1,
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: "spec.md",
  plan_file: null,
  tasks: [],
  wave_gates: {},
  ...fields,
});
const withFloor = (floor: unknown) => graph({
  wave_review_epoch: { runId: "run.authority-closure", wave: 1, batchEpoch: DIGEST, settledSpecCheckFloor: floor },
});
const withErrors = (errors: unknown) => graph({
  spec_index_observation: {
    kind: "unavailable",
    reason: { kind: "unparsed", path: "spec.md", contentDigest: DIGEST, errors },
  },
});
// The contract is JSON persistence, not arbitrary JavaScript objects or hostile proxies.
const reload = (raw: unknown) => parseTaskGraph(JSON.parse(JSON.stringify(raw)));
const accepted = (raw: unknown) => {
  const result = reload(raw);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const refused = (raw: unknown, path: string) => {
  expect(() => reload(raw)).not.toThrow();
  const result = reload(raw);
  expect(result).toMatchObject({ ok: false });
  if (result.ok) throw new Error("malformed authority was accepted");
  expect(result.error).toContain(path);
};

const ERROR_FIXTURES = {
  "unterminated-fence": { kind: "unterminated-fence" },
  "missing-section": { kind: "missing-section", section: "User Scenarios" },
  "repeated-section": { kind: "repeated-section", section: "Appendix: Glossary" },
  "entry-not-bulleted": { kind: "entry-not-bulleted", section: "Functional Requirements", line: 1 },
  "entry-not-canonical": { kind: "entry-not-canonical", section: "Acceptance Scenarios", line: 12 },
  "section-has-no-entries": { kind: "section-has-no-entries", section: "Out of Scope" },
  "duplicate-entry-id": { kind: "duplicate-entry-id", section: "Functional Requirements", id: "FR-001" },
  "scenario-not-bulleted": { kind: "scenario-not-bulleted", line: 4, insideBlock: false },
  "acceptance-block-has-no-bullets": { kind: "acceptance-block-has-no-bullets", headerLine: 3 },
  "no-acceptance-block": { kind: "no-acceptance-block" },
  "glossary-row-expected": { kind: "glossary-row-expected", line: 8 },
  "glossary-column-count": { kind: "glossary-column-count", line: 9 },
  "glossary-reserved-header-term": { kind: "glossary-reserved-header-term", line: 10, term: "Term" },
  "glossary-cell-empty": { kind: "glossary-cell-empty", line: 11 },
  "glossary-has-no-terms": { kind: "glossary-has-no-terms" },
  "duplicate-glossary-term": { kind: "duplicate-glossary-term", term: "Wave" },
  "id-outside-section": { kind: "id-outside-section", line: 13 },
} satisfies { readonly [K in SpecParseError["kind"]]: Extract<SpecParseError, { kind: K }> };

const TARGETS = [
  {
    label: "settled floor",
    path: "wave_review_epoch.settledSpecCheckFloor",
    supported: new Set<string>(["settled", "legacy-settled", "unprojected"] satisfies SettledFloor["kind"][]),
    populated: CURRENT,
    wrap: withFloor,
  },
  {
    label: "stored Spec Parse Error",
    path: "spec_index_observation.reason.errors[0]",
    supported: new Set<string>(Object.keys(ERROR_FIXTURES)),
    populated: ERROR_FIXTURES["entry-not-canonical"],
    wrap: (error: unknown) => withErrors([error]),
  },
];
const UNKNOWN_KINDS: readonly unknown[] = [
  ...Object.getOwnPropertyNames(Object.prototype),
  "unknown-json-kind", "manual-override", "", "SETTLED", "settled ",
  null, 0, true, [], {},
];

describe.each(TARGETS)("closed JSON discriminant: $label", ({ path, supported, populated, wrap }) => {
  it("accepts the exact positive control before mutation", () => {
    accepted(wrap(populated));
  });

  it.each(UNKNOWN_KINDS)("refuses kind %j without throwing or accepting malformed authority", (kind) => {
    refused(wrap({ kind }), path);
    refused(wrap({ ...populated, kind }), path);
  });

  it("refuses every generated unsupported string kind", () => {
    fc.assert(fc.property(fc.string().filter((kind) => !supported.has(kind)), (kind) => {
      refused(wrap({ ...populated, kind }), path);
    }), { seed: 430043, numRuns: 300 });
  });
});

const FLOORS = [
  { label: "current identities", stored: CURRENT, expected: CURRENT },
  { label: "historical count-only", stored: { kind: "settled", count: 1 }, expected: { kind: "legacy-settled", count: 1 } },
  { label: "explicit legacy", stored: { kind: "legacy-settled", count: 1 }, expected: { kind: "legacy-settled", count: 1 } },
  { label: "unprojected", stored: UNPROJECTED, expected: UNPROJECTED },
];
const transcript = (findings: readonly string[]) => parseSpecCheckOutput([
  "SPEC_CHECK_WAVE: 1",
  ...findings.map((finding) => `CRITICAL: ${finding}`),
  `SPEC_CHECK_CRITICAL_COUNT: ${findings.length}`,
  "SPEC_CHECK_HIGH_COUNT: 0",
  `SPEC_CHECK_VERDICT: ${findings.length === 0 ? "PASSED" : "BLOCKED"}`,
].join("\n"));

describe("floor identity and evidence causes survive public JSON reload", () => {
  it.each(FLOORS)("round-trips $label and preserves reconciliation policy", ({ stored, expected }) => {
    const first = accepted(withFloor(stored));
    const second = accepted(first);
    const floor = epochSettledFloor(second.wave_review_epoch);
    expect(floor).toEqual(expected);
    expect(second.wave_review_epoch).toEqual(first.wave_review_epoch);
    expect(Object.isFrozen(floor)).toBe(true);
    if (floor.kind === "settled") expect(Object.isFrozen(floor.criticalFindings)).toBe(true);

    const insufficient = reconcileSpecCheck(transcript([]), 1, "now", floor);
    const cause = floor.kind === "unprojected" ? "projection-unavailable" : "settled-floor";
    expect(insufficient).toMatchObject({ kind: "evidence-failed", specCheck: { cause } });
    const persisted = accepted({ ...second, spec_check: insufficient.specCheck });
    expect(persisted.spec_check).toEqual(insufficient.specCheck);
    expect(specCheckNeedsReapplication(persisted.spec_check, 1)).toBe(false);
    expect(epochSettledFloor(persisted.wave_review_epoch)).toEqual(expected);

    const exact = reconcileSpecCheck(transcript([REQUIRED, "additional finding"]), 1, "now", floor);
    expect(exact.kind).toBe(floor.kind === "unprojected" ? "evidence-failed" : "captured");
    const substituted = reconcileSpecCheck(transcript(["unrelated finding"]), 1, "now", floor);
    expect(substituted.kind).toBe(floor.kind === "legacy-settled" ? "captured" : "evidence-failed");
    const malformed = reconcileSpecCheck(parseSpecCheckOutput("not a footer"), 1, "now", floor);
    expect(malformed).toMatchObject({ kind: "evidence-failed", specCheck: { cause: "transcript" } });
    const retryable = accepted({ ...second, spec_check: malformed.specCheck });
    expect(retryable.spec_check).toEqual(malformed.specCheck);
    expect(specCheckNeedsReapplication(retryable.spec_check, 1)).toBe(true);
  });

  it("does not confuse an absent historical floor with a current zero floor", () => {
    const zero = { kind: "settled", count: 0, criticalFindings: [] };
    const floor = epochSettledFloor(accepted(withFloor(zero)).wave_review_epoch);
    expect(floor).toEqual(zero);
    expect(reconcileSpecCheck(transcript([]), 1, "now", floor).kind).toBe("captured");
    const historical = accepted(graph({ wave_review_epoch: { runId: "run.old", wave: 1, batchEpoch: DIGEST } }));
    expect(historical.wave_review_epoch?.settledSpecCheckFloor).toBeUndefined();
    expect(reconcileSpecCheck(transcript([]), 1, "now", epochSettledFloor(historical.wave_review_epoch)))
      .toMatchObject({ kind: "evidence-failed", specCheck: { cause: "projection-unavailable" } });
  });

  it.each([
    { ...CURRENT, count: -1 }, { ...CURRENT, count: 1.5 }, { ...CURRENT, count: Number.MAX_SAFE_INTEGER + 1 },
    { ...CURRENT, count: "1" }, { ...CURRENT, count: 2 }, { ...CURRENT, criticalFindings: null },
    { ...CURRENT, criticalFindings: [""] }, { ...CURRENT, criticalFindings: [REQUIRED, REQUIRED], count: 2 },
    { ...CURRENT, surplus: true }, { kind: "legacy-settled" }, { kind: "legacy-settled", count: null },
    { ...UNPROJECTED, reason: "  " }, { ...UNPROJECTED, reason: null }, { ...UNPROJECTED, count: 0 },
  ])("refuses one-field floor corruption %j", (floor) => {
    refused(withFloor(floor), "wave_review_epoch.settledSpecCheckFloor");
  });
});

describe("stored Spec Parse Error variants", () => {
  it.each(Object.values(ERROR_FIXTURES))("round-trips $kind with its exact payload", (error) => {
    const first = accepted(withErrors([error]));
    const second = accepted(first);
    expect(second.spec_index_observation).toEqual(first.spec_index_observation);
    expect(second.spec_index_observation).toMatchObject({ reason: { errors: [error] } });
    const observation = second.spec_index_observation;
    if (observation?.kind !== "unavailable" || observation.reason.kind !== "unparsed") {
      throw new Error("expected the unparsed observation");
    }
    expect(Object.isFrozen(observation.reason.errors)).toBe(true);
    expect(Object.isFrozen(observation.reason.errors[0])).toBe(true);
  });

  it.each(Object.values(ERROR_FIXTURES))("refuses missing, null, or surplus fields on $kind", (error) => {
    for (const field of Object.keys(error)) {
      const omitted = Object.fromEntries(Object.entries(error).filter(([key]) => key !== field));
      refused(withErrors([omitted]), "spec_index_observation.reason.errors[0]");
      refused(withErrors([{ ...error, [field]: null }]), "spec_index_observation.reason.errors[0]");
    }
    refused(withErrors([{ ...error, surplus: true }]), "spec_index_observation.reason.errors[0]");
  });

  it.each([
    { ...ERROR_FIXTURES["entry-not-canonical"], line: 0 },
    { ...ERROR_FIXTURES["entry-not-canonical"], line: 1.5 },
    { ...ERROR_FIXTURES["entry-not-canonical"], line: Number.MAX_SAFE_INTEGER + 1 },
    { ...ERROR_FIXTURES["entry-not-canonical"], section: "User Scenarios" },
    { ...ERROR_FIXTURES["missing-section"], section: "Acceptance Scenarios" },
    { ...ERROR_FIXTURES["acceptance-block-has-no-bullets"], headerLine: 0 },
    { ...ERROR_FIXTURES["duplicate-entry-id"], id: "AS-001" },
    { ...ERROR_FIXTURES["scenario-not-bulleted"], insideBlock: "false" },
    { ...ERROR_FIXTURES["duplicate-glossary-term"], term: " " },
  ])("refuses a one-field semantic mutation %j", (error) => {
    refused(withErrors([error]), "spec_index_observation.reason.errors[0]");
  });

  it("preserves every error in order and checks later errors, not just the head", () => {
    const errors = Object.values(ERROR_FIXTURES);
    expect(accepted(withErrors(errors)).spec_index_observation).toMatchObject({ reason: { errors } });
    refused(withErrors([...errors, { kind: "constructor" }]), `spec_index_observation.reason.errors[${errors.length}]`);
  });
});

const OBSERVATIONS = [
  { label: "indexed", specFile: "spec.md", observation: { kind: "indexed", path: "spec.md", contentDigest: DIGEST } },
  { label: "no-spec-file", specFile: null, observation: { kind: "unavailable", reason: { kind: "no-spec-file" } } },
  { label: "unreadable", specFile: "spec.md", observation: {
    kind: "unavailable", reason: { kind: "unreadable", path: "spec.md", reason: "EACCES" },
  } },
  { label: "invalid-encoding", specFile: "spec.md", observation: {
    kind: "unavailable", reason: { kind: "invalid-encoding", path: "spec.md", contentDigest: DIGEST, reason: "invalid UTF-8" },
  } },
  { label: "unparsed", specFile: "spec.md", observation: {
    kind: "unavailable", reason: {
      kind: "unparsed", path: "spec.md", contentDigest: DIGEST, errors: Object.values(ERROR_FIXTURES),
    },
  } },
];

describe("durable observation availability", () => {
  it.each(OBSERVATIONS)("preserves $label rather than fabricating indexed authority", ({ specFile, observation }) => {
    const first = accepted(graph({ spec_file: specFile, spec_index_observation: observation }));
    expect(accepted(first).spec_index_observation).toEqual(observation);
    expect(Object.isFrozen(first.spec_index_observation)).toBe(true);
    if (first.spec_index_observation?.kind === "unavailable") {
      expect(Object.isFrozen(first.spec_index_observation.reason)).toBe(true);
    }
  });

  it.each([
    { kind: "no-spec-file", surplus: true },
    { kind: "unreadable", path: "spec.md", reason: "" },
    { kind: "invalid-encoding", path: "spec.md", contentDigest: "bad", reason: "invalid UTF-8" },
    { kind: "unparsed", path: "spec.md", contentDigest: DIGEST, errors: [] },
    { kind: "unparsed", path: "spec.md", contentDigest: DIGEST, errors: null },
    { kind: "constructor" },
  ])("refuses malformed unavailable reason %j", (reason) => {
    refused(graph({ spec_index_observation: { kind: "unavailable", reason } }), "spec_index_observation.reason");
  });

  it("keeps absent legacy observations absent and refuses path disagreement", () => {
    expect(accepted(graph()).spec_index_observation).toBeUndefined();
    refused(graph({ spec_index_observation: { kind: "indexed", path: "other.md", contentDigest: DIGEST } }),
      "path must match protected spec_file");
  });
});

// Real filesystem adapter: fixtures live only in a private temporary directory;
// load() must translate typed parser refusal to an attributable corruption error.
describe("StateManager JSON load authority boundary", () => {
  it.each(TARGETS)("rejects all inherited $label kinds as corrupt state, preserving bytes", ({ wrap, populated, path }) => {
    const root = canonicalTempDir("loom-pr43-authority-");
    const directory = join(root, ".claude", "state");
    const statePath = join(directory, "active_task_graph.json");
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(statePath, JSON.stringify(wrap(populated)));
      const manager = new StateManager(statePath);
      expect(manager.load()).toEqual(accepted(wrap(populated)));
      for (const kind of Object.getOwnPropertyNames(Object.prototype).concat("unknown-json-kind")) {
        const bytes = JSON.stringify(wrap({ ...populated, kind }));
        writeFileSync(statePath, bytes);
        expect(() => manager.load()).toThrow(`Corrupt state file (`);
        expect(() => manager.load()).toThrow(path);
        expect(readFileSync(statePath, "utf8")).toBe(bytes);
      }
      writeFileSync(statePath, JSON.stringify(wrap(populated)));
      expect(manager.load()).toEqual(accepted(wrap(populated)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
