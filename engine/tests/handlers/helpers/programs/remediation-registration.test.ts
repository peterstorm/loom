/**
 * Direct tests of the remediation registration boundary parsers.
 *
 * `parseRemediationStartInputV2` admits raw operator input, `createRegisteredRemediationProgramV2`
 * mints the schema-v2 registration (and its digest) from parser-minted authority, and
 * `parseRegisteredRemediationProgram` re-admits a stored registration with strict v1/v2 dispatch.
 * Every rejection path is pinned to its exact `invalid-remediation-registration` message.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  createRegisteredRemediationProgramV2,
  parseRegisteredRemediationProgram,
  parseRemediationStartInputV2,
  type CreateRemediationRegistrationInput,
  type RegisteredRemediationProgramV2,
  type RemediationRegistrationError,
} from "../../../../src/handlers/helpers/programs/remediation-registration";
import {
  createCandidateRepositoryWitness,
  prepareDefectFamilyAccounting,
  prepareDefectFamilyVerification,
  type CandidateRepositoryWitness,
  type DefectFamilyVerificationPlan,
  type PreparedDefectFamilyAccounting,
} from "../../../../src/core/defect-family-accounting";
import { canonicalStructuralEquals, type DomainResult, type OrchestrationRunId } from "../../../../src/core/orchestration-contract";
import { parseRepositorySnapshotWitness } from "../../../../src/core/remediation-machine";
import { sha256Hex } from "../../../../src/core/digest";
import {
  VERIFICATION_MANIFEST_KIND,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../../../src/core/verification-manifest";
import type { AuthoritativeStandaloneReviewResult } from "../../../../src/core/standalone-review";
import { standaloneFixture } from "../../../fixtures/standalone-remediation-authority";
import { value } from "../../../fixtures/parse-result";

// ---------------------------------------------------------------------------
// Fixtures — built only through the production parsers (no forged authority).
// ---------------------------------------------------------------------------

const SOURCE_RUN_ID = "run.remediation-1";
const REMEDIATION_RUN_ID = "run.remediation-target-1" as OrchestrationRunId;
const REPORT_PATH = ".loom/completion-reports/0.json";

const INPUT_FIELDS = "sourceRunsRoot, sourceRun, supportPaths, defectFamily";
const V1_INPUT_FIELDS = "sourceRunsRoot, sourceRun, supportPaths";
const V1_FIELDS = "schemaVersion, kind, input";
const V2_FIELDS = "schemaVersion, kind, input, source, verification, candidateBaseline, registrationDigest";

const hex = (character: string): string => character.repeat(64);

const cleanSource = (): AuthoritativeStandaloneReviewResult =>
  standaloneFixture(["src/clean.ts"]).input.standaloneResult;
const criticalSource = (): AuthoritativeStandaloneReviewResult =>
  standaloneFixture(["src/main.ts", "src/family.ts"], true).input.standaloneResult;

function repairDeclaration(source: AuthoritativeStandaloneReviewResult): Record<string, unknown> {
  const findingId = source.survivingCriticals[0]?.id;
  if (findingId === undefined) throw new Error("critical source fixture must carry a surviving critical");
  return {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [{ findingId, status: "repaired", repairGroupId: "family:parser" }],
    groups: [{
      kind: "declared-repair-group",
      provenance: "DECLARED",
      repairGroupId: "family:parser",
      findingIds: [findingId],
      rootCause: { provenance: "DECLARED", statement: "The parser admitted an invalid state." },
      invariant: { provenance: "DECLARED", statement: "Only parser-produced states cross the seam." },
      siblings: { kind: "none-declared", provenance: "DECLARED", reason: "No sibling paths were identified." },
      checks: [{
        checkId: "project:defect-family",
        historicalRed: {
          kind: "historical-red",
          provenance: "DECLARED",
          statement: "The regression distinguishes the vulnerable behavior.",
          reference: null,
        },
      }],
    }],
  };
}

function frozenManifest(): FrozenVerificationManifest {
  const raw = {
    schemaVersion: 1,
    kind: VERIFICATION_MANIFEST_KIND,
    checks: [{
      id: "project:defect-family",
      scope: "wave",
      executable: "bun",
      args: ["test", "tests/0.test.ts"],
      cwd: ".",
      timeoutMs: 60_000,
      report: { kind: "required-file", path: REPORT_PATH },
    }],
  };
  return value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify(raw))));
}

type NotRequiredPlan = Extract<DefectFamilyVerificationPlan, { kind: "not-required" }>;
type SelectedPlan = Extract<DefectFamilyVerificationPlan, { kind: "selected-operator-checks" }>;

type NotRequiredAuthority = Readonly<{ accounting: PreparedDefectFamilyAccounting; plan: NotRequiredPlan }>;
type SelectedAuthority = Readonly<{
  accounting: PreparedDefectFamilyAccounting;
  plan: SelectedPlan;
  manifest: FrozenVerificationManifest;
}>;

let notRequiredCache: NotRequiredAuthority | undefined;
function notRequired(): NotRequiredAuthority {
  if (notRequiredCache !== undefined) return notRequiredCache;
  const accounting = value(prepareDefectFamilyAccounting(cleanSource(), { kind: "not-required" }));
  const plan = value(prepareDefectFamilyVerification(accounting, null));
  if (plan.kind !== "not-required") throw new Error("not-required plan required");
  notRequiredCache = { accounting, plan };
  return notRequiredCache;
}

let selectedCache: SelectedAuthority | undefined;
function selected(): SelectedAuthority {
  if (selectedCache !== undefined) return selectedCache;
  const source = criticalSource();
  const accounting = value(prepareDefectFamilyAccounting(source, repairDeclaration(source)));
  const manifest = frozenManifest();
  const plan = value(prepareDefectFamilyVerification(accounting, manifest));
  if (plan.kind !== "selected-operator-checks") throw new Error("selected plan required");
  selectedCache = { accounting, plan, manifest };
  return selectedCache;
}

function candidate(
  overrides: Readonly<{ generatedReportExclusions?: readonly string[]; workspaceCharacter?: string }> = {},
): CandidateRepositoryWitness {
  const gitWitness = value(parseRepositorySnapshotWitness({
    baseTreeDigest: hex("1"),
    indexDigest: hex("2"),
    worktreeDigest: hex("3"),
  }));
  return value(createCandidateRepositoryWitness({
    kind: "candidate-repository-witness",
    repositoryRoot: "/repo",
    workspaceDigest: hex(overrides.workspaceCharacter ?? "4"),
    pathCount: 2,
    observedPaths: ["src/family.ts", "src/main.ts"],
    gitWitness,
    generatedReportExclusions: overrides.generatedReportExclusions ?? [REPORT_PATH],
  }));
}

type StartFields = Readonly<{ sourceRunsRoot: string; sourceRun: string; supportPaths: readonly string[] }>;
const DEFAULT_START: StartFields = { sourceRunsRoot: "/runs", sourceRun: SOURCE_RUN_ID, supportPaths: ["src/support.ts"] };

/** The request skeleton both verification arms share; only the authority differs. */
function registrationRequest(
  { accounting, plan, manifest }: Readonly<{
    accounting: PreparedDefectFamilyAccounting;
    plan: CreateRemediationRegistrationInput["verification"];
    manifest: CreateRemediationRegistrationInput["manifest"];
  }>,
  start: StartFields,
  overrides: Partial<CreateRemediationRegistrationInput>,
): CreateRemediationRegistrationInput {
  return {
    remediationRunId: REMEDIATION_RUN_ID,
    input: { ...start, defectFamily: accounting.declaration },
    verification: plan,
    manifest,
    candidateBaseline: candidate(),
    ...overrides,
  };
}

function notRequiredRequest(start: StartFields = DEFAULT_START, overrides: Partial<CreateRemediationRegistrationInput> = {}) {
  return registrationRequest({ ...notRequired(), manifest: null }, start, overrides);
}

function selectedRequest(start: StartFields = DEFAULT_START, overrides: Partial<CreateRemediationRegistrationInput> = {}) {
  return registrationRequest(selected(), start, overrides);
}

const registered = (request: CreateRemediationRegistrationInput): RegisteredRemediationProgramV2 =>
  value(createRegisteredRemediationProgramV2(request));

/** The stored form: exactly what JSON persistence hands back to the parser. */
const stored = (record: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(record)) as Record<string, unknown>;

function refusal<T>(result: DomainResult<T, RemediationRegistrationError>): RemediationRegistrationError {
  expect(result.ok, `expected refusal, got ${JSON.stringify(result)}`).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  return result.error;
}

const refusedWith = (message: string): RemediationRegistrationError =>
  ({ kind: "invalid-remediation-registration", message });

function rawStart(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { sourceRunsRoot: "/runs", sourceRun: SOURCE_RUN_ID, supportPaths: ["src/a.ts", "src/b.ts"], defectFamily: { kind: "not-required" }, ...overrides };
}

function withoutKey(record: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

// Values that are never a plain own-data object.
const nonObjectArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.bigInt(),
  fc.string(),
  fc.array(fc.anything(), { maxLength: 4 }),
);

const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
const startArbitrary: fc.Arbitrary<StartFields> = fc.record({
  sourceRunsRoot: segment.map((name) => `/runs/${name}`),
  sourceRun: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,20}$/),
  supportPaths: fc.array(segment.map((name) => `src/${name}.ts`), { maxLength: 5 }),
});

// ---------------------------------------------------------------------------
// parseRemediationStartInputV2
// ---------------------------------------------------------------------------

describe("parseRemediationStartInputV2", () => {
  it("admits the exact four fields as a frozen copy with defectFamily passed through uninterpreted", () => {
    const defectFamily = { kind: "anything-the-accounting-parser-decides-later" };
    const raw = rawStart({ defectFamily });
    const parsed = value(parseRemediationStartInputV2(raw));

    expect(parsed).toEqual({ sourceRunsRoot: "/runs", sourceRun: SOURCE_RUN_ID, supportPaths: ["src/a.ts", "src/b.ts"], defectFamily });
    expect(parsed.defectFamily).toBe(defectFamily);
    expect(parsed.supportPaths).not.toBe(raw.supportPaths);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.supportPaths)).toBe(true);
  });

  it("admits an empty supportPaths roster and a null-prototype record", () => {
    const raw = Object.assign(Object.create(null) as Record<string, unknown>, rawStart({ supportPaths: [] }));
    expect(value(parseRemediationStartInputV2(raw)).supportPaths).toEqual([]);
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["a string", "input"],
    ["an array", [rawStart()]],
    ["a function", () => rawStart()],
    ["a class instance", new (class Input { readonly sourceRunsRoot = "/runs"; })()],
    ["an object with an inherited prototype", Object.create(rawStart())],
    ["a Map", new Map(Object.entries(rawStart()))],
  ])("refuses %s as a non-plain record", (_label, raw) => {
    expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith("remediation input must be a plain own-data object"));
  });

  it.each([
    ["sourceRunsRoot is missing", withoutKey(rawStart(), "sourceRunsRoot")],
    ["defectFamily is missing (a v1 input)", withoutKey(rawStart(), "defectFamily")],
    ["a surplus field is present", rawStart({ verification: null })],
    ["the record is empty", {}],
  ])("refuses an inexact key set when %s", (_label, raw) => {
    expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith(`remediation input must contain exactly ${INPUT_FIELDS}`));
  });

  it("refuses symbol-keyed fields", () => {
    const raw = { ...rawStart(), [Symbol("smuggled")]: true };
    expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith("remediation input must not contain symbol fields"));
  });

  it("refuses an accessor-backed field without invoking the accessor", () => {
    let invoked = false;
    const raw = withoutKey(rawStart(), "sourceRun");
    Object.defineProperty(raw, "sourceRun", { enumerable: true, get: () => { invoked = true; return SOURCE_RUN_ID; } });
    expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith("remediation input.sourceRun must be an enumerable own data field"));
    expect(invoked).toBe(false);
  });

  it("refuses a non-enumerable own data field", () => {
    const raw = withoutKey(rawStart(), "supportPaths");
    Object.defineProperty(raw, "supportPaths", { enumerable: false, value: [] });
    expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith("remediation input.supportPaths must be an enumerable own data field"));
  });

  it("returns a typed refusal when a proxy trap throws during record inspection", () => {
    const raw = new Proxy(rawStart(), { ownKeys: () => { throw new Error("hostile trap"); } });
    expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith("remediation input could not be safely inspected"));
  });

  it.each([
    ["an empty sourceRunsRoot", { sourceRunsRoot: "" }],
    ["a numeric sourceRunsRoot", { sourceRunsRoot: 1 }],
    ["an empty sourceRun", { sourceRun: "" }],
    ["a null sourceRun", { sourceRun: null }],
  ])("refuses %s", (_label, overrides) => {
    expect(refusal(parseRemediationStartInputV2(rawStart(overrides))))
      .toEqual(refusedWith("remediation input sourceRunsRoot and sourceRun must be non-empty strings"));
  });

  class PathList extends Array<string> {}
  const sparse: string[] = [];
  sparse[1] = "src/a.ts";
  const accessorIndexed = ["src/a.ts"];
  Object.defineProperty(accessorIndexed, "0", { enumerable: true, get: () => "src/a.ts" });

  it.each([
    ["a string", "src/a.ts", "remediation input.supportPaths must be a plain array"],
    ["an object", { 0: "src/a.ts", length: 1 }, "remediation input.supportPaths must be a plain array"],
    ["an Array subclass", PathList.from(["src/a.ts"]), "remediation input.supportPaths must be a plain array"],
    ["an empty entry", ["src/a.ts", ""], "remediation input.supportPaths[1] must be a non-empty own-data string"],
    ["a non-string entry", [7], "remediation input.supportPaths[0] must be a non-empty own-data string"],
    ["a hole", sparse, "remediation input.supportPaths[0] must be a non-empty own-data string"],
    ["an accessor entry", accessorIndexed, "remediation input.supportPaths[0] must be a non-empty own-data string"],
  ])("refuses supportPaths that is %s", (_label, supportPaths, message) => {
    expect(refusal(parseRemediationStartInputV2(rawStart({ supportPaths })))).toEqual(refusedWith(message));
  });

  it("reports the supportPaths defect ahead of a sourceRun defect", () => {
    expect(refusal(parseRemediationStartInputV2(rawStart({ sourceRun: "", supportPaths: [""] }))))
      .toEqual(refusedWith("remediation input.supportPaths[0] must be a non-empty own-data string"));
  });

  it("property: every non-plain-object raw value is refused with the same typed error", () => {
    fc.assert(fc.property(nonObjectArbitrary, (raw) => {
      expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith("remediation input must be a plain own-data object"));
    }));
  });

  it("property: any surplus string key is refused", () => {
    const surplusKey = fc.string({ minLength: 1 }).filter((key) =>
      !["sourceRunsRoot", "sourceRun", "supportPaths", "defectFamily", "__proto__"].includes(key));
    fc.assert(fc.property(surplusKey, fc.anything(), (key, surplus) => {
      const raw = { ...rawStart() };
      Object.defineProperty(raw, key, { value: surplus, enumerable: true });
      expect(refusal(parseRemediationStartInputV2(raw))).toEqual(refusedWith(`remediation input must contain exactly ${INPUT_FIELDS}`));
    }));
  });

  it("property: every well-formed input is admitted unchanged and survives a JSON round trip", () => {
    fc.assert(fc.property(startArbitrary, fc.jsonValue(), (start, defectFamily) => {
      const raw = { ...start, supportPaths: [...start.supportPaths], defectFamily };
      const parsed = value(parseRemediationStartInputV2(raw));
      expect(parsed).toEqual(raw);
      expect(value(parseRemediationStartInputV2(stored(parsed)))).toEqual(stored(parsed));
    }));
  });
});

// ---------------------------------------------------------------------------
// createRegisteredRemediationProgramV2
// ---------------------------------------------------------------------------

/** The documented registration identity whose SHA-256 is the registration digest. */
function expectedDigest(request: CreateRemediationRegistrationInput): string {
  const { verification } = request;
  return sha256Hex(JSON.stringify({
    schemaVersion: 2,
    kind: "remediation",
    input: request.input,
    source: {
      runId: verification.source.sourceRunId,
      resultDigest: verification.source.sourceResultDigest,
      inventory: verification.source,
    },
    verification: verification.kind === "not-required"
      ? { kind: "not-required", reason: "no-surviving-critical-findings" }
      : { kind: verification.kind, manifestDigest: verification.manifestDigest },
    candidateBaselineDigest: request.candidateBaseline.digest,
  }));
}

describe("createRegisteredRemediationProgramV2", () => {
  it("registers a not-required remediation with no manifest authority and a digest over its identity", () => {
    const request = notRequiredRequest();
    const registration = registered(request);

    expect(registration).toEqual({
      schemaVersion: 2,
      kind: "remediation",
      input: request.input,
      source: {
        runId: SOURCE_RUN_ID,
        resultDigest: notRequired().plan.source.sourceResultDigest,
        inventory: notRequired().plan.source,
      },
      verification: { kind: "not-required", reason: "no-surviving-critical-findings" },
      candidateBaseline: request.candidateBaseline,
      registrationDigest: expectedDigest(request),
    });
    expect(registration.source.inventory).toBe(notRequired().plan.source);
    expect(registration.candidateBaseline).toBe(request.candidateBaseline);
    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(registration.source)).toBe(true);
    expect(Object.isFrozen(registration.verification)).toBe(true);
  });

  it("registers selected operator checks bound to the remediation run, registration digest and candidate", () => {
    const request = selectedRequest();
    const registration = registered(request);
    const { plan, manifest } = selected();

    expect(registration.registrationDigest).toBe(expectedDigest(request));
    expect(registration.source).toEqual({ runId: SOURCE_RUN_ID, resultDigest: plan.source.sourceResultDigest, inventory: plan.source });
    if (registration.verification.kind !== "selected-operator-checks") throw new Error("selected verification required");
    expect(registration.verification.manifest).toBe(manifest);
    expect(registration.verification.checks).toHaveLength(1);
    const [check] = registration.verification.checks;
    expect(check.kind).toBe("authorized-remediation-check");
    expect(check.manifestDigest).toBe(plan.manifestDigest);
    expect(check.command).toEqual(plan.commands[0]);
    expect(check.scope).toEqual({
      kind: "standalone-remediation",
      remediationRunId: REMEDIATION_RUN_ID,
      sourceRunId: SOURCE_RUN_ID,
      registrationDigest: registration.registrationDigest,
      candidateWitnessDigest: request.candidateBaseline.digest,
    });
  });

  it("is deterministic: the same authority always mints the same registration", () => {
    expect(canonicalStructuralEquals(registered(selectedRequest()), registered(selectedRequest()))).toBe(true);
    expect(registered(notRequiredRequest()).registrationDigest).toBe(registered(notRequiredRequest()).registrationDigest);
  });

  it("binds the digest to the candidate baseline and the remediation input", () => {
    const base = registered(notRequiredRequest()).registrationDigest;
    expect(registered(notRequiredRequest(DEFAULT_START, { candidateBaseline: candidate({ workspaceCharacter: "9" }) })).registrationDigest).not.toBe(base);
    expect(registered(notRequiredRequest({ ...DEFAULT_START, sourceRunsRoot: "/elsewhere" })).registrationDigest).not.toBe(base);
  });

  it("property: the registration digest equals SHA-256 of the identity and separates distinct inputs", () => {
    fc.assert(fc.property(startArbitrary, startArbitrary, (left, right) => {
      const leftRequest = notRequiredRequest(left);
      const leftDigest = registered(leftRequest).registrationDigest;
      expect(leftDigest).toBe(expectedDigest(leftRequest));
      const sameInput = JSON.stringify(left) === JSON.stringify(right);
      expect(registered(notRequiredRequest(right)).registrationDigest === leftDigest).toBe(sameInput);
    }), { numRuns: 50 });
  });

  it("refuses selected checks without their frozen manifest", () => {
    expect(refusal(createRegisteredRemediationProgramV2(selectedRequest(DEFAULT_START, { manifest: null }))))
      .toEqual(refusedWith("selected remediation verification requires its frozen manifest"));
  });

  it("refuses a not-required remediation that retains manifest authority", () => {
    expect(refusal(createRegisteredRemediationProgramV2(notRequiredRequest(DEFAULT_START, { manifest: frozenManifest() }))))
      .toEqual(refusedWith("not-required remediation must not retain manifest authority"));
  });

  it("refuses selected checks whose remediation run reuses the source run identity", () => {
    expect(refusal(createRegisteredRemediationProgramV2(selectedRequest(DEFAULT_START, {
      remediationRunId: SOURCE_RUN_ID as OrchestrationRunId,
    })))).toEqual(refusedWith("remediation and source runs must have distinct identities"));
  });

  it("refuses selected checks against a structurally copied (not parser-minted) candidate", () => {
    const forged = { ...candidate() } as CandidateRepositoryWitness;
    expect(refusal(createRegisteredRemediationProgramV2(selectedRequest(DEFAULT_START, { candidateBaseline: forged }))))
      .toEqual(refusedWith("scope requires parser-minted source and candidate authority"));
  });

  it("refuses selected checks whose candidate report exclusions differ from the frozen report paths", () => {
    const drifted = candidate({ generatedReportExclusions: [".loom/completion-reports/other.json"] });
    expect(refusal(createRegisteredRemediationProgramV2(selectedRequest(DEFAULT_START, { candidateBaseline: drifted }))))
      .toEqual(refusedWith("candidate report exclusions must exactly equal selected frozen report paths"));
  });

  it("refuses a structurally copied (not parser-minted) verification plan", () => {
    const forged = { ...selected().plan } as SelectedPlan;
    expect(refusal(createRegisteredRemediationProgramV2(selectedRequest(DEFAULT_START, { verification: forged }))))
      .toEqual(refusedWith("check authorization requires matching parser-minted plan and scope"));
  });
});

// ---------------------------------------------------------------------------
// parseRegisteredRemediationProgram
// ---------------------------------------------------------------------------

const storedV1 = (): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: "remediation",
  input: { sourceRunsRoot: "/runs", sourceRun: SOURCE_RUN_ID, supportPaths: ["src/support.ts"] },
});

const storedSelected = (): Record<string, unknown> => stored(registered(selectedRequest()));
const storedNotRequired = (): Record<string, unknown> => stored(registered(notRequiredRequest()));

function tamper(record: Record<string, unknown>, path: readonly string[], replacement: unknown): Record<string, unknown> {
  const copy = stored(record);
  let cursor = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[path[path.length - 1]!] = replacement;
  return copy;
}

describe("parseRegisteredRemediationProgram", () => {
  describe("round trip: create -> JSON -> parse", () => {
    it.each([
      ["not-required", storedNotRequired, () => registered(notRequiredRequest())],
      ["selected-operator-checks", storedSelected, () => registered(selectedRequest())],
    ] as const)("re-admits a stored %s registration canonically equal to the minted one", (_label, persisted, minted) => {
      const raw = persisted();
      const parsed = value(parseRegisteredRemediationProgram(raw));
      expect(parsed).toEqual(minted());
      expect(canonicalStructuralEquals(stored(parsed), stored(minted()))).toBe(true);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(minted()));
      expect(Object.isFrozen(parsed)).toBe(true);
    });

    it("property: serialize -> parse is the identity over generated not-required registrations", () => {
      fc.assert(fc.property(startArbitrary, (start) => {
        const minted = registered(notRequiredRequest(start));
        const json = JSON.stringify(minted);
        const parsed = value(parseRegisteredRemediationProgram(JSON.parse(json)));
        expect(JSON.stringify(parsed)).toBe(json);
        expect(parsed).toEqual(minted);
      }), { numRuns: 50 });
    });

    it("property: serialize -> parse is the identity over generated selected registrations", () => {
      fc.assert(fc.property(startArbitrary, (start) => {
        const minted = registered(selectedRequest(start));
        const json = JSON.stringify(minted);
        expect(JSON.stringify(value(parseRegisteredRemediationProgram(JSON.parse(json))))).toBe(json);
      }), { numRuns: 25 });
    });
  });

  describe("schema version dispatch", () => {
    it("admits an exact v1 registration as a frozen copy", () => {
      const parsed = value(parseRegisteredRemediationProgram(storedV1()));
      expect(parsed).toEqual(storedV1());
      expect(Object.isFrozen(parsed)).toBe(true);
      if (parsed.schemaVersion !== 1) throw new Error("v1 required");
      expect(Object.isFrozen(parsed.input)).toBe(true);
    });

    const inheritedVersion = Object.create({ schemaVersion: 2 }) as object;
    const accessorVersion = withoutKey(storedNotRequired(), "schemaVersion");
    Object.defineProperty(accessorVersion, "schemaVersion", { enumerable: true, get: () => 2 });

    it.each([
      ["schemaVersion 0", { ...storedV1(), schemaVersion: 0 }],
      ["schemaVersion 3", { ...storedV1(), schemaVersion: 3 }],
      ["a string schemaVersion", { ...storedV1(), schemaVersion: "2" }],
      ["a null schemaVersion", { ...storedV1(), schemaVersion: null }],
      ["no schemaVersion", withoutKey(storedV1(), "schemaVersion")],
      ["an inherited schemaVersion", inheritedVersion],
      ["an accessor schemaVersion", accessorVersion],
      ["an array", [storedV1()]],
    ])("refuses %s", (_label, raw) => {
      expect(refusal(parseRegisteredRemediationProgram(raw)))
        .toEqual(refusedWith("remediation registration schemaVersion must equal 1 or 2"));
    });

    it("property: every non-object raw value is refused at version dispatch", () => {
      fc.assert(fc.property(nonObjectArbitrary.filter((raw) => !Array.isArray(raw)), (raw) => {
        expect(refusal(parseRegisteredRemediationProgram(raw)))
          .toEqual(refusedWith("remediation registration schemaVersion must equal 1 or 2"));
      }));
    });

    it("never falls back: a v2 registration relabelled as v1 is refused by the v1 key set", () => {
      expect(refusal(parseRegisteredRemediationProgram({ ...storedSelected(), schemaVersion: 1 })))
        .toEqual(refusedWith(`remediation registration v1 must contain exactly ${V1_FIELDS}`));
    });

    it("never upgrades: a v1 registration relabelled as v2 is refused by the v2 key set", () => {
      expect(refusal(parseRegisteredRemediationProgram({ ...storedV1(), schemaVersion: 2 })))
        .toEqual(refusedWith(`remediation registration v2 must contain exactly ${V2_FIELDS}`));
    });

    it("refuses a v1 envelope carrying a v2 input (defectFamily)", () => {
      expect(refusal(parseRegisteredRemediationProgram(tamper(storedV1(), ["input", "defectFamily"], { kind: "not-required" }))))
        .toEqual(refusedWith(`remediation input must contain exactly ${V1_INPUT_FIELDS}`));
    });

    it("refuses a v2 envelope carrying a v1 input (no defectFamily)", () => {
      const raw = storedNotRequired();
      raw.input = withoutKey(raw.input as Record<string, unknown>, "defectFamily");
      expect(refusal(parseRegisteredRemediationProgram(raw)))
        .toEqual(refusedWith(`remediation input must contain exactly ${INPUT_FIELDS}`));
    });
  });

  describe("v1 rejection paths", () => {
    const v1SymbolKeyed = { ...storedV1(), [Symbol("smuggled")]: 1 };
    it.each([
      ["a surplus key", { ...storedV1(), registrationDigest: hex("a") }, `remediation registration v1 must contain exactly ${V1_FIELDS}`],
      ["a symbol key", v1SymbolKeyed, "remediation registration v1 must not contain symbol fields"],
      ["a wrong kind", { ...storedV1(), kind: "standalone-review" }, "remediation registration v1 kind is invalid"],
      ["a non-object input", { ...storedV1(), input: "input" }, "remediation input must be a plain own-data object"],
      ["an empty sourceRun", tamper(storedV1(), ["input", "sourceRun"], ""), "remediation input sourceRunsRoot and sourceRun must be non-empty strings"],
      ["a non-array supportPaths", tamper(storedV1(), ["input", "supportPaths"], "src/a.ts"), "remediation input.supportPaths must be a plain array"],
      ["an empty support path", tamper(storedV1(), ["input", "supportPaths"], [""]), "remediation input.supportPaths[0] must be a non-empty own-data string"],
    ])("refuses %s", (_label, raw, message) => {
      expect(refusal(parseRegisteredRemediationProgram(raw))).toEqual(refusedWith(message));
    });
  });

  describe("tampered v2 registrations", () => {
    it.each([
      ["a surplus top-level key", () => ({ ...storedSelected(), installed: true }), `remediation registration v2 must contain exactly ${V2_FIELDS}`],
      ["a missing registrationDigest", () => withoutKey(storedSelected(), "registrationDigest"), `remediation registration v2 must contain exactly ${V2_FIELDS}`],
      ["a wrong kind", () => ({ ...storedSelected(), kind: "standalone-review" }), "remediation registration v2 kind is invalid"],
      ["a non-object input", () => ({ ...storedSelected(), input: null }), "remediation input must be a plain own-data object"],
      ["an empty sourceRunsRoot", () => tamper(storedSelected(), ["input", "sourceRunsRoot"], ""), "remediation input sourceRunsRoot and sourceRun must be non-empty strings"],
      ["a non-string support path", () => tamper(storedSelected(), ["input", "supportPaths"], [1]), "remediation input.supportPaths[0] must be a non-empty own-data string"],
      ["a non-object source", () => ({ ...storedSelected(), source: [] }), "remediation registration v2 source must be a plain own-data object"],
      ["a surplus source key", () => tamper(storedSelected(), ["source", "byteLength"], 1), "remediation registration v2 source must contain exactly runId, resultDigest, inventory"],
      ["a non-canonical source runId", () => tamper(storedSelected(), ["source", "runId"], "../escape"), 'orchestration-run-id must be a non-empty canonical authority id; received "../escape"'],
      ["an uppercase resultDigest", () => tamper(storedSelected(), ["source", "resultDigest"], hex("A")), `artifact-digest must be a lowercase SHA-256 digest; received "${hex("A")}"`],
      ["a numeric registrationDigest", () => ({ ...storedSelected(), registrationDigest: 42 }), "artifact-digest must be a lowercase SHA-256 digest; received 42"],
      ["a null verification", () => ({ ...storedSelected(), verification: null }), "remediation registration v2 verification must be a plain own-data object"],
      ["selected checks with the manifest removed", () => ({ ...storedSelected(), verification: withoutKey(storedSelected().verification as Record<string, unknown>, "manifest") }), "remediation registration v2 verification must contain exactly kind, manifest, checks"],
      ["not-required verification carrying a manifest", () => tamper(storedNotRequired(), ["verification", "manifest"], {}), "remediation registration v2 verification must contain exactly kind, reason"],
      ["selected verification relabelled not-required", () => tamper(storedSelected(), ["verification", "kind"], "not-required"), "remediation registration v2 verification must contain exactly kind, reason"],
      ["not-required verification with a changed reason", () => tamper(storedNotRequired(), ["verification", "reason"], "operator-skipped"), "remediation registration v2 not-required reason is invalid"],
      ["an unknown verification kind", () => tamper(storedSelected(), ["verification", "kind"], "blocked-declaration"), "remediation registration v2 verification kind is invalid"],
    ])("refuses %s", (_label, raw, message) => {
      expect(refusal(parseRegisteredRemediationProgram(raw()))).toEqual(refusedWith(message));
    });

    it("reports input, then source, then verification, then identity defects in that order", () => {
      const allBroken = { ...storedSelected(), input: null, source: null, verification: null, registrationDigest: 1 };
      expect(refusal(parseRegisteredRemediationProgram(allBroken))).toEqual(refusedWith("remediation input must be a plain own-data object"));
      const sourceAndLater = { ...allBroken, input: storedSelected().input };
      expect(refusal(parseRegisteredRemediationProgram(sourceAndLater))).toEqual(refusedWith("remediation registration v2 source must be a plain own-data object"));
      const verificationAndLater = { ...sourceAndLater, source: storedSelected().source };
      expect(refusal(parseRegisteredRemediationProgram(verificationAndLater))).toEqual(refusedWith("remediation registration v2 verification must be a plain own-data object"));
      const identityOnly = { ...verificationAndLater, verification: storedSelected().verification };
      expect(refusal(parseRegisteredRemediationProgram(identityOnly))).toEqual(refusedWith("artifact-digest must be a lowercase SHA-256 digest; received 1"));
    });

    it("refuses accessor-backed nested authority without invoking it", () => {
      let invoked = false;
      const raw = storedSelected();
      const source = withoutKey(raw.source as Record<string, unknown>, "inventory");
      Object.defineProperty(source, "inventory", { enumerable: true, get: () => { invoked = true; return {}; } });
      expect(refusal(parseRegisteredRemediationProgram({ ...raw, source })))
        .toEqual(refusedWith("remediation registration v2 source.inventory must be an enumerable own data field"));
      expect(invoked).toBe(false);
    });

    it("is a shape gate only: well-formed but rewritten identity fields are admitted for rehydration to re-derive", () => {
      // The parser does not recompute registrationDigest nor re-validate inventory, defectFamily,
      // manifest, checks or candidateBaseline; `rehydrateV2` rebuilds the registration from
      // re-derived authority and compares it with `canonicalStructuralEquals`. Pin that division
      // so a tampered-but-well-formed record is shown to diverge from its canonical rebuild.
      const minted = registered(selectedRequest());
      const rewritten = tamper(tamper(stored(minted), ["registrationDigest"], hex("b")), ["input", "sourceRun"], "run.other-source");
      const parsed = value(parseRegisteredRemediationProgram(rewritten));
      if (parsed.schemaVersion !== 2) throw new Error("v2 registration required");
      expect(parsed.registrationDigest).toBe(hex("b"));
      expect(parsed.input.sourceRun).toBe("run.other-source");
      expect(canonicalStructuralEquals(stored(parsed), stored(minted))).toBe(false);
    });
  });
});
