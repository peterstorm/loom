/**
 * Persisted-state parsers for Acceptance Contracts, the gate expectation a
 * result was judged under, and the acceptance facts it recorded. Exact
 * records only; the first failure is the diagnostic.
 */

import {
  canonicalStructuralEquals,
  parseArtifactDigest,
  type DomainResult,
  type NonEmpty,
} from "../orchestration-contract";
import { exactRecordErrors, isPlainRecord, parseExactRecord } from "../plain-record";
import { isRepoRelativePlanPath, normalizePlanPath } from "../plan-path-match";
import type { ReportTestcaseOutcome } from "../structured-test-report";
import { err, freeze, nonEmpty, ok } from "./kernel";
import {
  COVERABLE_ANCHOR,
  CONTRACT_ID,
  type AcceptanceContract,
  type AcceptanceFreeze,
  type AcceptanceTestcase,
  type ContractAcceptanceFile,
  type ContractRevision,
  type ContractTypes,
  type FrozenPathDigest,
} from "./model";
import { frozenPaths } from "./tasks";
import type {
  AcceptanceExpectation,
  AcceptanceReportFacts,
  ContractGateExpectation,
  ObservedAcceptanceTestcase,
} from "./gate";

type Parsed<T> = DomainResult<T, string>;

function exactRecord(raw: unknown, keys: readonly string[], path: string): Parsed<Record<string, unknown>> {
  const record = parseExactRecord(raw, keys, path);
  return record.ok ? ok(record.value) : err(exactRecordErrors(record, path, "a plain object").join("; "));
}

const text = (raw: unknown, path: string): Parsed<string> =>
  typeof raw === "string" && raw.trim() !== "" ? ok(raw) : err(`${path} must be a non-empty string`);

const parseWave = (raw: unknown, path: string): Parsed<number> =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? ok(raw) : err(`${path} must be a positive integer`);

function list<T>(raw: unknown, path: string, item: (value: unknown, path: string) => Parsed<T>): Parsed<readonly T[]> {
  if (!Array.isArray(raw)) return err(`${path} must be an array`);
  const values: T[] = [];
  for (const [index, value] of raw.entries()) {
    const parsed = item(value, `${path}[${index}]`);
    if (!parsed.ok) return parsed;
    values.push(parsed.value);
  }
  return ok(Object.freeze(values));
}

function nonEmptyList<T>(raw: unknown, path: string, item: (value: unknown, path: string) => Parsed<T>): Parsed<NonEmpty<T>> {
  if (Array.isArray(raw) && raw.length === 0) return err(`${path} must be non-empty`);
  const values = list(raw, path, item);
  return values.ok ? ok(nonEmpty(values.value)!) : values;
}

/** A non-empty anchor list naming each anchor once, as the plan grammar does. */
function anchorList(raw: unknown, path: string, item: (value: unknown, path: string) => Parsed<string>): Parsed<NonEmpty<string>> {
  const anchors = nonEmptyList(raw, path, item);
  if (!anchors.ok) return anchors;
  return new Set(anchors.value).size === anchors.value.length ? anchors : err(`${path} names an anchor more than once`);
}

function parseTypes(raw: unknown, path: string): Parsed<ContractTypes> {
  if (isPlainRecord(raw) && raw.kind === "file") {
    const record = exactRecord(raw, ["kind", "path"], path);
    if (!record.ok) return record;
    const file = text(record.value.path, `${path}.path`);
    return file.ok ? ok(freeze({ kind: "file", path: file.value })) : file;
  }
  if (isPlainRecord(raw) && raw.kind === "none") {
    const record = exactRecord(raw, ["kind", "reason"], path);
    if (!record.ok) return record;
    const reason = text(record.value.reason, `${path}.reason`);
    return reason.ok ? ok(freeze({ kind: "none", reason: reason.value })) : reason;
  }
  return err(`${path}.kind must be file or none`);
}

function parseAcceptanceFile(raw: unknown, path: string): Parsed<ContractAcceptanceFile> {
  const record = exactRecord(raw, ["path", "anchors"], path);
  if (!record.ok) return record;
  const file = text(record.value.path, `${path}.path`);
  if (!file.ok) return file;
  const anchors = anchorList(record.value.anchors, `${path}.anchors`, (value, anchorPath) =>
    typeof value === "string" && COVERABLE_ANCHOR.test(value) ? ok(value) : err(`${anchorPath} must be an FR-n or AS-n id`));
  if (!anchors.ok) return anchors;
  return ok(freeze({ path: file.value, anchors: anchors.value }));
}

function parsePathDigests(raw: unknown, path: string, expected: readonly string[]): Parsed<NonEmpty<FrozenPathDigest>> {
  const entries = nonEmptyList(raw, path, (value, entryPath) => {
    const record = exactRecord(value, ["path", "sha256"], entryPath);
    if (!record.ok) return record;
    const file = text(record.value.path, `${entryPath}.path`);
    const sha256 = parseArtifactDigest(record.value.sha256);
    if (!file.ok) return file;
    return sha256.ok ? ok(freeze({ path: file.value, sha256: sha256.value })) : err(`${entryPath}.sha256 must be a sha256 digest`);
  });
  if (!entries.ok) return entries;
  return canonicalStructuralEquals(entries.value.map(({ path: file }) => file), expected)
    ? entries
    : err(`${path} must digest exactly the contract's frozen paths, in order`);
}

function parseRoster(raw: unknown, path: string, files: readonly ContractAcceptanceFile[]): Parsed<NonEmpty<AcceptanceTestcase>> {
  return nonEmptyList(raw, path, (value, entryPath) => {
    const record = exactRecord(value, ["file", "name", "anchors"], entryPath);
    if (!record.ok) return record;
    const file = files.find(({ path: declared }) => declared === record.value.file);
    const name = text(record.value.name, `${entryPath}.name`);
    if (file === undefined) return err(`${entryPath}.file must be one of the contract's acceptance files`);
    if (!name.ok) return name;
    const anchors = anchorList(record.value.anchors, `${entryPath}.anchors`, (anchor, anchorPath) =>
      typeof anchor === "string" && file.anchors.includes(anchor) ? ok(anchor) : err(`${anchorPath} must be one of the file's anchors`));
    return anchors.ok ? ok(freeze({ file: file.path, name: name.value, anchors: anchors.value })) : anchors;
  });
}

function parseFreeze(raw: unknown, path: string, contract: Pick<AcceptanceContract, "types" | "acceptance">): Parsed<AcceptanceFreeze> {
  const expected = frozenPaths(contract);
  if (isPlainRecord(raw) && raw.state === "awaiting-red") {
    const record = exactRecord(raw, ["state"], path);
    return record.ok ? ok(freeze({ state: "awaiting-red" })) : record;
  }
  if (isPlainRecord(raw) && raw.state === "frozen") {
    const record = exactRecord(raw, ["state", "wave", "paths", "roster"], path);
    if (!record.ok) return record;
    const frozenWave = parseWave(record.value.wave, `${path}.wave`);
    const paths = parsePathDigests(record.value.paths, `${path}.paths`, expected);
    const roster = parseRoster(record.value.roster, `${path}.roster`, contract.acceptance);
    if (!frozenWave.ok) return frozenWave;
    if (!paths.ok) return paths;
    if (!roster.ok) return roster;
    return ok(freeze({ state: "frozen", wave: frozenWave.value, paths: paths.value, roster: roster.value }));
  }
  if (isPlainRecord(raw) && raw.state === "revised") {
    const record = exactRecord(raw, ["state", "paths"], path);
    if (!record.ok) return record;
    const paths = parsePathDigests(record.value.paths, `${path}.paths`, expected);
    return paths.ok ? ok(freeze({ state: "revised", paths: paths.value })) : paths;
  }
  return err(`${path}.state must be awaiting-red, frozen or revised`);
}

function parseRevision(raw: unknown, path: string, index: number, expected: readonly string[]): Parsed<ContractRevision> {
  const record = exactRecord(raw, ["revision", "reason", "previous", "paths", "revalidatedTaskIds"], path);
  if (!record.ok) return record;
  if (record.value.revision !== index + 1) return err(`${path}.revision must be ${index + 1}`);
  const reason = text(record.value.reason, `${path}.reason`);
  const previous = parsePathDigests(record.value.previous, `${path}.previous`, expected);
  const paths = parsePathDigests(record.value.paths, `${path}.paths`, expected);
  const taskIds = list(record.value.revalidatedTaskIds, `${path}.revalidatedTaskIds`, text);
  if (!reason.ok) return reason;
  if (!previous.ok) return previous;
  if (!paths.ok) return paths;
  if (!taskIds.ok) return taskIds;
  return ok(freeze({
    revision: index + 1,
    reason: reason.value,
    previous: previous.value,
    paths: paths.value,
    revalidatedTaskIds: taskIds.value,
  }));
}

function parseContract(raw: unknown, path: string): Parsed<AcceptanceContract> {
  const record = exactRecord(raw, [
    "schemaVersion", "id", "title", "statement", "contractTask", "types", "acceptance", "supportedDomain", "freeze", "revisions",
  ], path);
  if (!record.ok) return record;
  const fields = record.value;
  if (fields.schemaVersion !== 1) return err(`${path}.schemaVersion must be 1`);
  if (typeof fields.id !== "string" || !CONTRACT_ID.test(fields.id)) return err(`${path}.id must be CT-n`);
  const title = text(fields.title, `${path}.title`);
  const statement = text(fields.statement, `${path}.statement`);
  const contractTask = text(fields.contractTask, `${path}.contractTask`);
  const types = parseTypes(fields.types, `${path}.types`);
  const acceptance = nonEmptyList(fields.acceptance, `${path}.acceptance`, parseAcceptanceFile);
  if (!title.ok) return title;
  if (!statement.ok) return statement;
  if (!contractTask.ok) return contractTask;
  if (!types.ok) return types;
  if (!acceptance.ok) return acceptance;
  const files = acceptance.value;
  const paths = frozenPaths({ types: types.value, acceptance: files });
  if (new Set(paths.map(normalizePlanPath)).size !== paths.length) return err(`${path} freezes one path twice`);
  const unsafe = paths.find((frozen) => !isRepoRelativePlanPath(frozen));
  if (unsafe !== undefined) return err(`${path} freezes '${unsafe}', which is not a repository-relative path`);
  if (fields.supportedDomain !== null && !files.some(({ path: file }) => file === fields.supportedDomain)) {
    return err(`${path}.supportedDomain must be null or one of the acceptance files`);
  }
  const frozen = parseFreeze(fields.freeze, `${path}.freeze`, { types: types.value, acceptance: files });
  if (!frozen.ok) return frozen;
  if (!Array.isArray(fields.revisions)) return err(`${path}.revisions must be an array`);
  const revisions: ContractRevision[] = [];
  for (const [index, value] of fields.revisions.entries()) {
    const revision = parseRevision(value, `${path}.revisions[${index}]`, index, paths);
    if (!revision.ok) return revision;
    revisions.push(revision.value);
  }
  // The freeze and its revision history must tell one story: a revision is
  // recorded only after the freeze, each revision starts from the bytes the
  // one before it stamped, and the bytes frozen now are the last revision's.
  const broken = revisions.findIndex((revision, index) =>
    index > 0 && !canonicalStructuralEquals(revision.previous, revisions[index - 1]!.paths));
  if (broken !== -1) return err(`${path}.revisions[${broken}].previous must equal revision ${broken}'s paths`);
  const last = revisions.at(-1);
  if (last === undefined && frozen.value.state === "revised") return err(`${path}.freeze is revised but records no revision`);
  if (last !== undefined && frozen.value.state === "awaiting-red") return err(`${path}.revisions precede the freeze`);
  if (last !== undefined && frozen.value.state !== "awaiting-red" && !canonicalStructuralEquals(frozen.value.paths, last.paths)) {
    return err(`${path}.freeze.paths must equal the last revision's paths`);
  }
  return ok(freeze({
    schemaVersion: 1,
    id: fields.id,
    title: title.value,
    statement: statement.value,
    contractTask: contractTask.value,
    types: types.value,
    acceptance: files,
    supportedDomain: fields.supportedDomain as string | null,
    freeze: frozen.value,
    revisions: Object.freeze(revisions),
  }));
}

/** Parse the persisted `acceptance_contracts`: exact records, unique ids, and
 *  no path frozen by two contracts. */
export function parseAcceptanceContracts(raw: unknown): Parsed<readonly AcceptanceContract[]> {
  const contracts = list(raw, "acceptance_contracts", parseContract);
  if (!contracts.ok) return contracts;
  const ids = contracts.value.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) return err("acceptance_contracts must have unique ids");
  const paths = contracts.value.flatMap((contract) => frozenPaths(contract));
  if (new Set(paths.map(normalizePlanPath)).size !== paths.length) {
    return err("acceptance_contracts must not freeze one path in two contracts");
  }
  return contracts;
}

const OUTCOMES: readonly ReportTestcaseOutcome[] = ["passed", "failed", "skipped"];

function parseObservedTestcase(raw: unknown, path: string): Parsed<ObservedAcceptanceTestcase> {
  const record = exactRecord(raw, ["file", "name", "outcome", "failureType", "collectionError"], path);
  if (!record.ok) return record;
  const { file, name, outcome, failureType, collectionError } = record.value;
  if (typeof file !== "string" || file === "" || typeof name !== "string" || name === "" ||
      !OUTCOMES.includes(outcome as ReportTestcaseOutcome) ||
      (failureType !== null && typeof failureType !== "string") || typeof collectionError !== "boolean") {
    return err(`${path} has an invalid file, name, outcome, failureType or collectionError`);
  }
  if (failureType !== null && outcome !== "failed") return err(`${path}.failureType is recorded only for a failed testcase`);
  return ok(freeze({
    file,
    name,
    outcome: outcome as ReportTestcaseOutcome,
    failureType: failureType as string | null,
    collectionError,
  }));
}

function parseGateExpectation(raw: unknown, path: string): Parsed<ContractGateExpectation> {
  if (!isPlainRecord(raw) || (raw.phase !== "red" && raw.phase !== "green")) return err(`${path}.phase must be red or green`);
  const green = raw.phase === "green";
  const record = exactRecord(raw, green
    ? ["contract", "files", "phase", "dueWave", "roster"]
    : ["contract", "files", "phase", "dueWave"], path);
  if (!record.ok) return record;
  const { contract, dueWave } = record.value;
  if (typeof contract !== "string" || !CONTRACT_ID.test(contract)) return err(`${path}.contract must be CT-n`);
  const files = nonEmptyList(record.value.files, `${path}.files`, parseAcceptanceFile);
  if (!files.ok) return files;
  if (!isPlainRecord(dueWave) || Object.entries(dueWave).some(([anchor, due]) =>
    !COVERABLE_ANCHOR.test(anchor) || !parseWave(due, anchor).ok)) {
    return err(`${path}.dueWave must map FR-n/AS-n ids to positive Waves`);
  }
  const base = { contract, files: files.value, dueWave: freeze({ ...(dueWave as Record<string, number>) }) };
  if (!green) return ok(freeze({ ...base, phase: "red" }));
  const roster = record.value.roster;
  const parsedRoster = roster === null ? ok(null) : parseRoster(roster, `${path}.roster`, files.value);
  if (!parsedRoster.ok) return parsedRoster;
  return ok(freeze({ ...base, phase: "green", roster: parsedRoster.value }));
}

/** Parse the expectation a persisted completion result was judged under. */
export function parseAcceptanceExpectation(raw: unknown, path = "acceptance.expectation"): Parsed<AcceptanceExpectation> {
  const record = exactRecord(raw, ["wave", "contracts", "unobservable"], path);
  if (!record.ok) return record;
  const gateWave = parseWave(record.value.wave, `${path}.wave`);
  if (!gateWave.ok) return gateWave;
  const contracts = list(record.value.contracts, `${path}.contracts`, parseGateExpectation);
  if (!contracts.ok) return contracts;
  const unobservable = list(record.value.unobservable, `${path}.unobservable`, (value, entryPath) => {
    const entry = exactRecord(value, ["contract", "reason"], entryPath);
    if (!entry.ok) return entry;
    const contract = text(entry.value.contract, `${entryPath}.contract`);
    const reason = text(entry.value.reason, `${entryPath}.reason`);
    if (!contract.ok) return contract;
    return reason.ok ? ok(freeze({ contract: contract.value, reason: reason.value })) : reason;
  });
  if (!unobservable.ok) return unobservable;
  return ok(freeze({ wave: gateWave.value, contracts: contracts.value, unobservable: unobservable.value }));
}

/** Parse one persisted `AcceptanceReportFacts` exactly. */
export function parseAcceptanceReportFacts(raw: unknown, path = "acceptance"): Parsed<AcceptanceReportFacts> {
  const unprojectable = isPlainRecord(raw) && raw.kind === "unprojectable";
  const record = exactRecord(raw, unprojectable
    ? ["kind", "checkId", "reportDigest", "reason"]
    : ["kind", "checkId", "reportDigest", "testcases", "otherFailures"], path);
  if (!record.ok) return record;
  const checkId = text(record.value.checkId, `${path}.checkId`);
  const reportDigest = parseArtifactDigest(record.value.reportDigest);
  if (!checkId.ok) return checkId;
  if (!reportDigest.ok) return err(`${path}.reportDigest must be a sha256 digest`);
  if (unprojectable) {
    const reason = text(record.value.reason, `${path}.reason`);
    return reason.ok
      ? ok(freeze({ kind: "unprojectable", checkId: checkId.value, reportDigest: reportDigest.value, reason: reason.value }))
      : reason;
  }
  if (record.value.kind !== "projected") return err(`${path}.kind must be projected or unprojectable`);
  const testcases = list(record.value.testcases, `${path}.testcases`, parseObservedTestcase);
  if (!testcases.ok) return testcases;
  const otherFailures = record.value.otherFailures;
  if (typeof otherFailures !== "number" || !Number.isSafeInteger(otherFailures) || otherFailures < 0) {
    return err(`${path}.otherFailures must be a non-negative integer`);
  }
  return ok(freeze({
    kind: "projected",
    checkId: checkId.value,
    reportDigest: reportDigest.value,
    testcases: testcases.value,
    otherFailures,
  }));
}
