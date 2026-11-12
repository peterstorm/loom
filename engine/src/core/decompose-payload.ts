/**
 * The decompose payload: the agent-authored JSON `populate-task-graph` reads
 * from stdin, parsed in the two steps its caller needs.
 *
 * `parseDecomposeEnvelope` admits the raw JSON value as a record with only the
 * decompose-contract fields and at least one Task. That record is what the
 * graph validator and its `--fix` repair read. `parseDecomposeInput` then
 * reads the typed input from a record, field by field: nothing is spread, so a
 * payload that pre-stamps execution state (`status`, `test_result`,
 * `review_status`) cannot carry it into TaskGraph Population.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { isRecord } from "./plain-record";
import type { AuthoredTask } from "./task-graph-population";
import { parseTaskVerificationPolicy, serializeVerificationPolicy } from "./verification-policy";

export type DecomposeParse<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: string }>;

const parsed = <T>(value: T): DecomposeParse<T> => ({ ok: true, value });
const refused = (error: string): DecomposeParse<never> => ({ ok: false, error });

/** The fields the decompose contract admits at the top level. */
export const DECOMPOSE_FIELDS: readonly string[] = Object.freeze([
  "spec_trace_version",
  "plan_title",
  "plan_file",
  "spec_file",
  "tasks",
]);

/** A decompose payload whose top-level shape is admitted; its field values are still unread. */
export type DecomposeEnvelope = Readonly<Record<string, unknown>> & Readonly<{ tasks: readonly [unknown, ...unknown[]] }>;

/** The typed decompose input: what TaskGraph Population reads of a validated payload. */
export type DecomposeInput = Readonly<{
  plan_title: string;
  plan_file?: string;
  spec_file?: string;
  tasks: readonly [AuthoredTask, ...AuthoredTask[]];
}>;

const hasTasks = (record: Readonly<Record<string, unknown>>): record is DecomposeEnvelope =>
  Array.isArray(record.tasks) && record.tasks.length > 0;

/** Admit a JSON value as a decompose payload: an object, contract fields only, at least one Task. */
export function parseDecomposeEnvelope(raw: unknown): DecomposeParse<DecomposeEnvelope> {
  if (!isRecord(raw)) return refused("Decompose JSON must be an object");
  const surplusFields = Object.keys(raw).filter((field) => !DECOMPOSE_FIELDS.includes(field)).sort();
  if (surplusFields.length > 0) {
    return refused(`Decompose JSON contains unsupported field(s): ${surplusFields.join(", ")}`);
  }
  return hasTasks(raw) ? parsed(raw) : refused("No tasks in decompose JSON");
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value as unknown) && (value as readonly unknown[]).every((entry) => typeof entry === "string");

/** An optional string field: absent, or the string it is. */
function optionalString(record: Readonly<Record<string, unknown>>, field: string, label: string): DecomposeParse<string | undefined> {
  const value = record[field];
  return value === undefined || typeof value === "string"
    ? parsed(value)
    : refused(`${label}: '${field}' must be a string when present`);
}

/** An optional string-array field: absent, or the strings it holds. */
function optionalStrings(record: Readonly<Record<string, unknown>>, field: string, label: string): DecomposeParse<readonly string[] | undefined> {
  const value = record[field];
  return value === undefined || isStringArray(value)
    ? parsed(value)
    : refused(`${label}: '${field}' must be an array of strings when present`);
}

function parseAuthoredTask(raw: unknown, index: number): DecomposeParse<AuthoredTask> {
  if (!isRecord(raw)) return refused(`Task [${index}]: must be an object`);
  const { id, description, agent, wave, depends_on: dependsOn, file_list: fileList } = raw;
  if (typeof id !== "string" || id === "") return refused(`Task [${index}]: missing 'id'`);
  const label = `Task ${id}`;
  if (typeof description !== "string") return refused(`${label}: 'description' must be a string`);
  if (typeof agent !== "string") return refused(`${label}: 'agent' must be a string`);
  if (typeof wave !== "number") return refused(`${label}: 'wave' must be a number`);
  // An absent or null dependency list is the empty one, as the graph validator admits it.
  if (dependsOn !== undefined && dependsOn !== null && !isStringArray(dependsOn)) {
    return refused(`${label}: 'depends_on' must be an array of strings`);
  }
  if (!isStringArray(fileList)) return refused(`${label}: 'file_list' must be an array of strings`);
  const specAnchors = optionalStrings(raw, "spec_anchors", label);
  if (!specAnchors.ok) return specAnchors;
  const specContributions = optionalStrings(raw, "spec_contributions", label);
  if (!specContributions.ok) return specContributions;
  const planContext = optionalString(raw, "plan_context", label);
  if (!planContext.ok) return planContext;
  const verification = parseTaskVerificationPolicy(raw, label, "authored");
  if (!verification.ok) return refused(verification.errors.join("; "));
  return parsed({
    id,
    description,
    agent,
    wave,
    depends_on: dependsOn ?? [],
    ...(specAnchors.value === undefined ? {} : { spec_anchors: specAnchors.value }),
    ...(specContributions.value === undefined ? {} : { spec_contributions: specContributions.value }),
    ...(planContext.value === undefined ? {} : { plan_context: planContext.value }),
    verification_policy: serializeVerificationPolicy(verification.value.policy),
    file_list: fileList,
  });
}

/**
 * Read the typed decompose input from an admitted payload. The first field
 * that is not what the contract says refuses the whole payload; a Task carries
 * only its authored fields, whatever else its record held.
 */
export function parseDecomposeInput(envelope: DecomposeEnvelope): DecomposeParse<DecomposeInput> {
  if (typeof envelope.plan_title !== "string") return refused("Field 'plan_title' must be a string");
  const planFile = optionalString(envelope, "plan_file", "Decompose JSON");
  if (!planFile.ok) return planFile;
  const specFile = optionalString(envelope, "spec_file", "Decompose JSON");
  if (!specFile.ok) return specFile;
  const [firstRaw, ...restRaw] = envelope.tasks;
  const first = parseAuthoredTask(firstRaw, 0);
  if (!first.ok) return first;
  const rest: AuthoredTask[] = [];
  for (const [offset, raw] of restRaw.entries()) {
    const task = parseAuthoredTask(raw, offset + 1);
    if (!task.ok) return task;
    rest.push(task.value);
  }
  return parsed({
    plan_title: envelope.plan_title,
    ...(planFile.value === undefined ? {} : { plan_file: planFile.value }),
    ...(specFile.value === undefined ? {} : { spec_file: specFile.value }),
    tasks: [first.value, ...rest],
  });
}
