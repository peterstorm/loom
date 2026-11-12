/**
 * Executable-models policy: validate that models declared in a plan bind to
 * executable artifacts, and that the task graph implements them.
 *
 * Opt-in: a plan with no `## Lifecycles` / `## Pipeline` / `## Invariants` /
 * `## Contracts` sections (and no stray model markers) produces zero checks —
 * except that a Task may not claim the contract new-test waiver. A plan that
 * declares a model must bind it — a descriptive model with nothing to run is
 * a validation error, not a warning. Near-miss declarations (see
 * PlanModels.strays) are errors too: a typo must not read as an opt-out.
 * `**Export bindings:**` in File Structure are refused by
 * `validateExportBindings` (FR-002) before population stamps them.
 *
 * Pure core (`validateModelBindings`) with filesystem access injected via
 * `ModelBindingDeps`; `checkPlanModelBindings` is the shared fail-closed
 * entry point used by the validate-task-graph handler, populate-task-graph,
 * and repair-task-graph — the whitelisted helpers that populate tasks into
 * state (repair-task-graph installs through `StateManager.replace`, see its
 * own header) — so none of them can skip enforcement. It reads the plan once
 * (`PlanBindingDeps.readPlan`) and returns the `ParsedPlan` it checked, digest
 * of the same raw bytes included, so no caller reads the plan a second time.
 */

import { match } from "ts-pattern";

import { readFileSync } from "node:fs";
import { parsePlanModels, parsePlanExportBindings, hasModels, renderStray, type PlanModels } from "../../core/parse-plan-models";
import { contractBindingErrors, contractWriter, frozenPaths, type ContractBindingTask } from "../../core/acceptance-contract";
import { firstOwingWave, type ScheduledTask } from "../../core/owner-verification/obligations";
import { dependsOnAny } from "../../core/task-dependencies";
import { parseVerificationPolicy, type NewTestWaiverReason, type VerificationPolicy } from "../../core/verification-policy";
import { bindingTaskView, NO_EXPORT_BINDINGS, renderBindingProblem, validateExportBindings } from "../../core/skeleton/bindings";
import type { ExportBindingsDeclaration } from "../../core/skeleton/types";
import { artifactDigestOfBytes } from "../../core/digest";
import type { ArtifactDigest } from "../../core/orchestration-contract/identity";
import type { OwnershipProblem, PlanInvariant } from "../../types";
import { observePathPresence, type PathPresence } from "../../utils/path-presence";
import { changesFamily, invariantRoles, type InvariantRoles, type OwnedInvariant } from "../../core/plan-paths";
import { normalizePlanPath, pathsMatch } from "../../core/plan-path-match";
import { type ValidationResult, ok, fail } from "./validation-result";

export type ModelFileRead =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

export interface ModelBindingDeps {
  /** Reads one binding artifact while preserving the concrete boundary failure. */
  readonly readFile: (path: string) => ModelFileRead;
  /** Whether a path an invariant names exists yet; only ENOENT is absent. */
  readonly pathPresence: (path: string) => PathPresence;
}

/** The plan file's raw bytes, or why they could not be read. */
type PlanBytesRead =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; error: string }>;

/** The binding port plus the one read `checkPlanModelBindings` makes of the plan itself. */
export interface PlanBindingDeps extends ModelBindingDeps {
  /** Reads the plan's raw bytes: the check digests these bytes and parses the text decoded from them. */
  readonly readPlan: (path: string) => PlanBytesRead;
}

/** A caught failure's message: the read errors the adapter reports and the JSON parse errors the check reports. */
const failureMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The production filesystem adapter for the binding check. It lives beside
 * the port it implements because three shell callers (populate-task-graph,
 * repair-task-graph, validate-task-graph) each had a byte-identical private
 * copy — three places to fix if the boundary failure shape ever changes.
 */
export const productionModelBindingDeps: PlanBindingDeps = {
  readFile: (path) => {
    try {
      return { ok: true, content: readFileSync(path, "utf-8") };
    } catch (error) {
      return { ok: false, error: failureMessage(error) };
    }
  },
  readPlan: (path) => {
    try {
      return { ok: true, bytes: readFileSync(path) };
    } catch (error) {
      return { ok: false, error: failureMessage(error) };
    }
  },
  pathPresence: observePathPresence,
};

function renderOwnershipProblem(problem: OwnershipProblem): string {
  return match(problem)
    .with({ kind: "missing-owner" }, () =>
      "no '**Owner module:**' declared — name the one module that implements the rule, or 'none' with an '**Unowned reason:**'")
    .with({ kind: "unowned-without-reason" }, () => "'**Owner module:** none' needs an '**Unowned reason:**'")
    .with({ kind: "owner-fields-on-unowned" }, ({ labels }) =>
      `an unowned invariant declares ${labels.map((label) => `'**${label}:**'`).join(" and ")} — remove them, or name the owner module`)
    .with({ kind: "reason-on-owned" }, () => "declares both an owner module and an '**Unowned reason:**' — keep one")
    .with({ kind: "missing-siblings" }, () =>
      "no '**Sibling entry points:**' declared — list every other entry point that applies the rule ('- path — note' lines), or write 'none'")
    .with({ kind: "malformed-sibling" }, ({ line }) => `sibling entry point line '${line}' is not '- path — note' (or 'none')`)
    .with({ kind: "missing-matrix-test" }, () =>
      "no '**Matrix test:**' declared — name the test that runs the rule through every entry point")
    .with({ kind: "exemption-without-reason" }, () =>
      "'**Mutation exemption:**' has no reason — state why the owner's mutants need not be killed, or remove the line")
    .with({ kind: "exemption-placeholder-reason" }, ({ reason }) =>
      `'**Mutation exemption:** ${reason}' is a placeholder, not a reason — state why the owner's mutants need not be killed, or remove the line`)
    .with({ kind: "exemption-on-unowned" }, () =>
      "'**Mutation exemption:**' on an unowned invariant — an exemption is meaningful only on an owned one; remove it, or name the owner module")
    .exhaustive();
}

type TaskRecord = Readonly<{
  id: string;
  /** The Task's Wave; null when malformed, which structural validation reports. */
  wave: number | null;
  files: readonly string[];
  dependsOn: readonly string[];
  /** Requirement Completion Claims (`spec_anchors`). */
  claims: readonly string[];
  /** The `verification_policy.new_tests` waiver reason, when waived. */
  newTestWaiver: NewTestWaiverReason | null;
  /** The authored `verification_policy`; null when it does not parse (structural validation reports it). */
  policy: VerificationPolicy | null;
}>;

const strings = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];

/** The authored policy and its new-test waiver, read through the one policy
 *  parser; a malformed policy waives nothing here, and structural validation
 *  reports it. */
function waivers(raw: unknown): Pick<TaskRecord, "newTestWaiver" | "policy"> {
  const parsed = parseVerificationPolicy(raw);
  if (!parsed.ok) return { newTestWaiver: null, policy: null };
  const { newTests } = parsed.value;
  return { newTestWaiver: newTests.kind === "waived" ? newTests.reason : null, policy: parsed.value };
}

/** Total over the raw roster: a repair input may carry entries that are not
 *  records at all, which structural validation reports — never a crash here. */
function taskRecords(tasks: readonly Record<string, unknown>[]): readonly TaskRecord[] {
  return tasks.filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null).map((t) => ({
    id: typeof t.id === "string" ? t.id : "<unnamed task>",
    wave: typeof t.wave === "number" && Number.isSafeInteger(t.wave) ? t.wave : null,
    files: strings(t.file_list),
    dependsOn: strings(t.depends_on),
    claims: strings(t.spec_anchors),
    ...waivers(t.verification_policy),
  }));
}

/** One Task with the roles its file_list plays in the family under check. */
type RoledTask = Readonly<{ record: TaskRecord; roles: InvariantRoles }>;

/** Every declared path with its role, in declaration order. */
type DeclaredRole = readonly [role: string, path: string];

function declaredRoles(ownership: OwnedInvariant): readonly DeclaredRole[] {
  return [
    ["owner module", ownership.owner],
    ...ownership.siblings.map(({ path }) => ["sibling entry point", path] as const),
    ["matrix test", ownership.matrixTest],
  ];
}

/** A declared path must exist already, or be one a Task creates. */
function unresolvedPathErrors(
  label: string,
  declared: readonly DeclaredRole[],
  records: readonly TaskRecord[],
  deps: ModelBindingDeps,
): string[] {
  return declared.flatMap(([role, path]) => {
    if (records.some(({ files }) => files.some((file) => pathsMatch(file, path)))) return [];
    const presence = deps.pathPresence(path);
    return match(presence)
      .with({ kind: "present" }, () => [])
      .with({ kind: "unknown" }, ({ cause }) => [`${label}: cannot observe ${role} '${path}': ${cause}`])
      .with({ kind: "absent" }, () => [
        `${label}: ${role} '${path}' neither exists nor is in any task's file_list — fix the path, or add the task that creates it`,
      ])
      .exhaustive();
  });
}

/** Each declared path plays exactly one role. */
function duplicateRoleErrors(label: string, declared: readonly DeclaredRole[]): string[] {
  const firstRole = new Map<string, string>();
  return declared.flatMap(([role, path]) => {
    const key = normalizePlanPath(path);
    const earlier = firstRole.get(key);
    if (earlier === undefined) {
      firstRole.set(key, role);
      return [];
    }
    return earlier === role
      ? [`${label}: '${key}' is listed twice as a ${role}`]
      : [`${label}: '${key}' is both the ${earlier} and a ${role} — give each path one role`];
  });
}

/**
 * A change to the owner or a sibling updates the family's matrix test, and
 * the matrix test lands no later than the first Wave the Wave Gate verifies
 * the family in (`firstOwingWave`, the gate's own schedule).
 */
function matrixTestErrors(
  label: string,
  ownership: OwnedInvariant,
  roled: readonly RoledTask[],
  contractTaskIds: ReadonlySet<string>,
): string[] {
  const familyTasks = roled.filter(({ roles }) => changesFamily(roles));
  if (familyTasks.length === 0) return [];
  const matrixTasks = roled.filter(({ roles }) => roles.matrixTest);
  if (matrixTasks.length === 0) {
    return [
      `${label}: ${familyTasks.map(({ record }) => record.id).join(", ")} touches the family but no task's file_list includes the matrix test ` +
        `'${ownership.matrixTest}' — a change to the owner or a sibling must update the test that runs the rule through every entry point`,
    ];
  }
  const scheduled = scheduledTasks(roled.map(({ record }) => record));
  if (scheduled === null) return [];
  const owing = firstOwingWave(scheduled, contractTaskIds, ownership);
  const lands = Math.min(...matrixTasks.map(({ record }) => record.wave ?? Number.POSITIVE_INFINITY));
  if (owing === null || lands <= owing) return [];
  const owingIds = familyTasks.filter(({ record }) => record.wave === owing && !contractTaskIds.has(record.id)).map(({ record }) => record.id);
  const landingIds = matrixTasks.filter(({ record }) => record.wave === lands).map(({ record }) => record.id);
  return [
    `${label}: ${owingIds.join(", ")} change the family in Wave ${owing}, but the matrix test '${ownership.matrixTest}' first lands in ` +
      `Wave ${lands} (${landingIds.join(", ")}) — the Wave Gate verifies the family in Wave ${owing}, so the matrix test must land in that Wave or earlier`,
  ];
}

/** The records as the family schedule reads them, or null when any Wave is malformed (structural validation reports it). */
function scheduledTasks(records: readonly TaskRecord[]): readonly ScheduledTask[] | null {
  const scheduled = records.flatMap(({ id, wave, files }) => (wave === null ? [] : [{ id, wave, file_list: [...files] }]));
  return scheduled.length === records.length ? scheduled : null;
}

/** A sibling's Task reaches the owner's Task, so the owner exists before its callers. */
function ownerFirstErrors(label: string, roled: readonly RoledTask[]): string[] {
  const ownerIds = new Set(roled.filter(({ roles }) => roles.owner).map(({ record }) => record.id));
  if (ownerIds.size === 0) return [];
  const byId = new Map(roled.map(({ record }) => [record.id, record] as const));
  return roled.flatMap(({ record, roles }) => {
    const sibling = roles.siblings[0];
    if (ownerIds.has(record.id) || sibling === undefined || dependsOnAny(record.dependsOn, ownerIds, (id) => byId.get(id)?.dependsOn ?? [])) return [];
    return [
      `${label}: ${record.id} changes sibling entry point '${sibling.path}' but does not reach the owner module's task — ` +
        `it must depend on ${[...ownerIds].join(" or ")}, directly or transitively, so the owner exists before its callers`,
    ];
  });
}

/**
 * Ownership checks for one invariant: a malformed declaration names its
 * problems; an owned one must name paths that exist or that a task creates,
 * give each path one role, update its matrix test whenever the family
 * changes and by the first Wave that owes it, and build siblings after the owner.
 */
function ownershipErrors(
  inv: PlanInvariant,
  tasks: readonly Record<string, unknown>[],
  contractTaskIds: ReadonlySet<string>,
  deps: ModelBindingDeps,
): string[] {
  const label = `${inv.id} ("${inv.title}")`;
  const ownership = inv.ownership;
  if (ownership.kind === "unowned") return [];
  if (ownership.kind === "malformed") return ownership.problems.map((problem) => `${label}: ${renderOwnershipProblem(problem)}`);

  const records = taskRecords(tasks);
  const roled = records.map((record) => ({ record, roles: invariantRoles(record.files, ownership) }));
  const declared = declaredRoles(ownership);
  return [
    ...unresolvedPathErrors(label, declared, records, deps),
    ...duplicateRoleErrors(label, declared),
    ...matrixTestErrors(label, ownership, roled, contractTaskIds),
    ...ownerFirstErrors(label, roled),
  ];
}

/**
 * The contract Tasks the plan's contracts resolve to under the one writer
 * rule. A contract that resolves to no single writer names none here; contract
 * binding reports it, and every Task's change then owes, which verifies more.
 */
function planContractTaskIds(models: PlanModels, tasks: readonly ContractBindingTask[]): ReadonlySet<string> {
  return new Set(models.contracts.flatMap(({ declaration }) => {
    if (declaration.kind === "malformed") return [];
    const writer = contractWriter(frozenPaths(declaration), tasks);
    return writer.ok ? [writer.value] : [];
  }));
}

/** The raw roster narrowed to what contract binding reads. */
function contractBindingTasks(tasks: readonly Record<string, unknown>[]): readonly ContractBindingTask[] {
  return taskRecords(tasks).map(({ id, files, dependsOn, claims, newTestWaiver: waiver }) =>
    ({ id, file_list: files, spec_anchors: claims, depends_on: dependsOn, newTestWaiver: waiver }));
}

/**
 * Validate a plan's model bindings against the task roster. `exportBindings`
 * is the plan's `parsePlanExportBindings` result; it is kept apart from
 * `models` so a plan without bindings validates to its pre-feature result.
 */
export function validateModelBindings(
  models: PlanModels,
  tasks: readonly Record<string, unknown>[],
  deps: ModelBindingDeps,
  exportBindings: ExportBindingsDeclaration = NO_EXPORT_BINDINGS,
): ValidationResult {
  const errors: string[] = [];
  const allFiles = taskRecords(tasks).flatMap(({ files }) => files);

  for (const stray of models.strays) {
    errors.push(`Model declaration problem: ${renderStray(stray)}`);
  }

  for (const lc of models.lifecycles) {
    const machineFile = lc.machineFile;
    if (machineFile === null) {
      errors.push(`${lc.id} ("${lc.title}"): no '**Machine file:**' declared — a lifecycle without an executable machine is a descriptive model (see references/executable-models.md)`);
      continue;
    }
    if (!allFiles.some((f) => pathsMatch(f, machineFile))) {
      errors.push(`${lc.id}: machine file '${machineFile}' is not in any task's file_list — decompose must emit a task that implements the statechart/reducer`);
    }
  }

  if (models.pipeline !== null) {
    const dagFile = models.pipeline.dagFile;
    if (dagFile === null) {
      errors.push("Pipeline section declares no '**AuthoredDag:**' path — a pipeline without an authored DAG is a descriptive model (see references/executable-models.md)");
    } else {
      const read = deps.readFile(dagFile);
      if (!read.ok) {
        errors.push(`Pipeline: cannot read AuthoredDag file '${dagFile}': ${read.error} — the architecture phase must author it before decompose`);
      } else {
        let dag: unknown;
        let parseError: string | null = null;
        try {
          dag = JSON.parse(read.content);
        } catch (e) {
          parseError = failureMessage(e);
        }
        if (parseError !== null) {
          errors.push(`Pipeline: AuthoredDag file '${dagFile}' is not valid JSON: ${parseError}`);
        } else if (typeof dag !== "object" || dag === null || Array.isArray(dag) || !Array.isArray((dag as Record<string, unknown>).nodes)) {
          errors.push(`Pipeline: AuthoredDag file '${dagFile}' must be a JSON object with a 'nodes' array (deep validation is fugue's job — 'fugue new --from' gates codegen)`);
        } else {
          // Narrow anti-corruption boundary: Loom knows only the node identity
          // field needed for plan↔sidecar drift checks. Fugue still owns every
          // deeper node-kind/schema invariant.
          const nodeIds = new Set<string>();
          const nodeErrors: string[] = [];
          for (const [index, node] of (dag as { nodes: unknown[] }).nodes.entries()) {
            if (typeof node !== "object" || node === null || Array.isArray(node)) {
              nodeErrors.push(`nodes[${index}] must be an object with a non-empty id`);
              continue;
            }
            const id = (node as Record<string, unknown>).id;
            if (typeof id !== "string" || id.trim() === "" || id.trim() !== id) {
              nodeErrors.push(`nodes[${index}].id must be a non-empty string without surrounding whitespace`);
              continue;
            }
            if (nodeIds.has(id)) nodeErrors.push(`nodes[${index}].id duplicates '${id}'`);
            nodeIds.add(id);
          }
          if (nodeErrors.length > 0) {
            errors.push(`Pipeline: AuthoredDag file '${dagFile}' has invalid node identities: ${nodeErrors.join("; ")}`);
          } else {
            const missing = models.pipeline.declaredNodes.filter((node) => !nodeIds.has(node));
            if (missing.length > 0) {
              errors.push(
                `Pipeline: node(s) named in the plan's table are absent from AuthoredDag file '${dagFile}': ${missing.join(", ")} — plan and sidecar have drifted; re-author the sidecar or fix the table`,
              );
            }
          }
        }
      }
    }
  }

  for (const inv of models.invariants) {
    // Three states, three messages: the old `tier: null` conflated "line
    // missing" with "line present but unrecognized", and the error could
    // only guess which failure the operator was looking at.
    const tier = match(inv.tier)
      .with({ status: "absent" }, () => {
        errors.push(`${inv.id} ("${inv.title}"): missing '**Tier:**' — must be 'checkable' or 'advisory'`);
        return null;
      })
      .with({ status: "unrecognized" }, ({ raw }) => {
        errors.push(`${inv.id} ("${inv.title}"): unrecognized '**Tier:**' '${raw}' — must be 'checkable' or 'advisory'`);
        return null;
      })
      .with({ status: "ok" }, ({ tier }) => tier)
      .exhaustive();
    if (tier === null) continue;
    if (tier === "advisory") {
      if (inv.ruleFile !== null) {
        errors.push(`${inv.id} ("${inv.title}"): tier is 'advisory' but declares a '**Rule file:**' — advisory invariants are never enforced; re-tier as 'checkable' or remove the rule file line`);
      }
      continue;
    }
    const ruleFile = inv.ruleFile;
    if (ruleFile === null) {
      errors.push(`${inv.id} ("${inv.title}"): tier is 'checkable' but no '**Rule file:**' declared — a checkable invariant must be a lint rule, or be honestly tiered 'advisory'`);
      continue;
    }
    const read = deps.readFile(ruleFile);
    if (!read.ok) {
      errors.push(`${inv.id}: cannot read rule file '${ruleFile}': ${read.error} — the architecture phase must write it (validate with the validate-lint-rules helper)`);
      continue;
    }
    let rule: unknown;
    let parseError: string | null = null;
    try {
      rule = JSON.parse(read.content);
    } catch (e) {
      parseError = failureMessage(e);
    }
    if (parseError !== null) {
      errors.push(`${inv.id}: rule file '${ruleFile}' is not valid JSON: ${parseError}`);
    } else if (typeof rule !== "object" || rule === null || Array.isArray(rule) || typeof (rule as Record<string, unknown>).kind !== "string" || typeof (rule as Record<string, unknown>).name !== "string") {
      errors.push(`${inv.id}: rule file '${ruleFile}' must be a JSON object with 'kind' and 'name' (full fail-closed load happens in the linter)`);
    }
  }

  const bindingTasks = contractBindingTasks(tasks);
  const contractTaskIds = planContractTaskIds(models, bindingTasks);
  for (const inv of models.invariants) errors.push(...ownershipErrors(inv, tasks, contractTaskIds, deps));

  errors.push(...contractBindingErrors(models.contracts, bindingTasks));

  const bindingViews = taskRecords(tasks).map(({ id, files, dependsOn, policy }) =>
    bindingTaskView({ id, file_list: files, depends_on: dependsOn }, policy));
  for (const problem of validateExportBindings(exportBindings, models.contracts, bindingViews)) {
    errors.push(`Export bindings: ${renderBindingProblem(problem)}`);
  }

  return errors.length === 0 ? ok() : fail(errors);
}

/**
 * The plan as its one read found it: its path, the digest of the raw bytes
 * that read returned, and the models and export bindings parsed from the text
 * decoded from those same bytes. Only `checkPlanModelBindings` builds one, so
 * a caller can never hold a digest of bytes other than the ones it checked.
 */
export type ParsedPlan = Readonly<{
  path: string;
  sha256: ArtifactDigest;
  models: PlanModels;
  exportBindings: ExportBindingsDeclaration;
}>;

/**
 * Outcome of the fail-closed plan-binding check. A discriminated union
 * instead of `ValidationResult & { plan?: ParsedPlan }`: `plan` is present
 * exactly when the plan was readable enough to parse — the type states it,
 * callers never guess. `ok` doubles as the pass/fail discriminant so gate
 * callers keep their `if (!check.ok)` shape.
 */
export type PlanBindingCheck =
  /** The plan itself could not be consulted (missing path / unreadable file) — nothing was parsed. */
  | { readonly kind: "plan-unavailable"; readonly ok: false; readonly errors: readonly string[] }
  /** Models were declared and at least one binding is broken. */
  | { readonly kind: "invalid-bindings"; readonly ok: false; readonly errors: readonly string[]; readonly plan: ParsedPlan }
  /** The plan parsed and declares no models — genuine opt-out, zero checks. */
  | { readonly kind: "opted-out"; readonly ok: true; readonly plan: ParsedPlan }
  /** Models were declared and every binding validated. */
  | { readonly kind: "validated"; readonly ok: true; readonly plan: ParsedPlan };

const planUnavailable = (error: string): PlanBindingCheck => ({ kind: "plan-unavailable", ok: false, errors: [error] });

/**
 * The fail-closed entry point: read the plan ONCE, through `deps.readPlan`,
 * parse its models and export bindings from the text of those bytes, and
 * validate their bindings. The verdict carries the parsed plan with the digest
 * of the same raw bytes, so whatever a caller stamps or gates on is what was checked.
 *
 * - Non-string or empty `planFile` → plan-unavailable (the graph names no plan to check)
 * - Plan file unreadable → plan-unavailable (a graph must not pass validation
 *   because its plan cannot be read — that would let a typo'd path disarm the gate)
 * - No models declared → opted-out (genuine opt-out)
 */
export function checkPlanModelBindings(
  planFile: unknown,
  tasks: readonly Record<string, unknown>[],
  deps: PlanBindingDeps,
): PlanBindingCheck {
  if (typeof planFile !== "string" || planFile.trim().length === 0) {
    return planUnavailable("plan_file must be a non-empty string path — executable-model bindings cannot be verified without the plan");
  }
  const read = deps.readPlan(planFile);
  if (!read.ok) {
    return planUnavailable(
      `cannot read plan_file '${planFile}': ${read.error} — executable-model bindings cannot be verified (fix the path or run from the repo root)`,
    );
  }
  const text = Buffer.from(read.bytes).toString("utf-8");
  const models = parsePlanModels(text);
  const exportBindings = parsePlanExportBindings(text);
  const plan: ParsedPlan = { path: planFile, sha256: artifactDigestOfBytes(read.bytes), models, exportBindings };
  // A model-free plan still validates: a Task may not claim the contract
  // new-test waiver when no contract exists to stand in for its tests.
  const result = validateModelBindings(models, tasks, deps, exportBindings);
  if (!result.ok) return { kind: "invalid-bindings", ok: false, errors: result.errors, plan };
  // Export bindings opt a plan in like any model; an invalid one never reaches here.
  const declared = hasModels(models) || exportBindings.bindings.length > 0;
  return declared ? { kind: "validated", ok: true, plan } : { kind: "opted-out", ok: true, plan };
}
