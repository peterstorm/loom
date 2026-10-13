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
 *
 * Pure core (`validateModelBindings`) with filesystem access injected via
 * `ModelBindingDeps`; `checkPlanModelBindings` is the shared fail-closed
 * entry point used by the validate-task-graph handler, populate-task-graph,
 * and repair-task-graph — the whitelisted helpers that populate tasks into
 * state (repair-task-graph installs through `StateManager.replace`, see its
 * own header) — so none of them can skip enforcement.
 */

import { match } from "ts-pattern";

import { readFileSync } from "node:fs";
import { parsePlanModels, hasModels, renderStray, type PlanModels } from "../../core/parse-plan-models";
import { contractWriter, coveredAnchors, frozenPaths, type ContractWriterProblem } from "../../core/acceptance-contract";
import type { ContractProblem, OwnershipProblem, PlanContract, PlanInvariant } from "../../types";
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

/**
 * The production filesystem adapter for the pure binding check. It lives beside
 * the port it implements because three shell callers (populate-task-graph,
 * repair-task-graph, validate-task-graph) each had a byte-identical private
 * copy — three places to fix if the boundary failure shape ever changes.
 */
export const productionModelBindingDeps: ModelBindingDeps = {
  readFile: (path) => {
    try {
      return { ok: true, content: readFileSync(path, "utf-8") };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  pathPresence: observePathPresence,
};

function jsonParseError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
    .exhaustive();
}

type TaskRecord = Readonly<{
  id: string;
  files: readonly string[];
  dependsOn: readonly string[];
  /** Requirement Completion Claims (`spec_anchors`). */
  claims: readonly string[];
  /** The `verification_policy.new_tests` waiver reason, when waived. */
  newTestWaiver: string | null;
}>;

const strings = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];

function newTestWaiver(policy: unknown): string | null {
  if (typeof policy !== "object" || policy === null) return null;
  const newTests = (policy as Record<string, unknown>).new_tests;
  if (typeof newTests !== "object" || newTests === null) return null;
  const { kind, reason } = newTests as Record<string, unknown>;
  return kind === "waived" && typeof reason === "string" ? reason : null;
}

/** Total over the raw roster: a repair input may carry entries that are not
 *  records at all, which structural validation reports — never a crash here. */
function taskRecords(tasks: readonly Record<string, unknown>[]): readonly TaskRecord[] {
  return tasks.filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null).map((t) => ({
    id: typeof t.id === "string" ? t.id : "<unnamed task>",
    files: strings(t.file_list),
    dependsOn: strings(t.depends_on),
    claims: strings(t.spec_anchors),
    newTestWaiver: newTestWaiver(t.verification_policy),
  }));
}

/** Whether `from` depends on any of `targets`, directly or transitively. */
function dependsOnAny(from: TaskRecord, targets: ReadonlySet<string>, byId: ReadonlyMap<string, TaskRecord>): boolean {
  const seen = new Set<string>();
  const queue = [...from.dependsOn];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (targets.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
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

/** A change to the owner or a sibling updates the family's matrix test. */
function matrixTestErrors(label: string, ownership: OwnedInvariant, roled: readonly RoledTask[]): string[] {
  const familyTasks = roled.filter(({ roles }) => changesFamily(roles));
  if (familyTasks.length === 0 || roled.some(({ roles }) => roles.matrixTest)) return [];
  return [
    `${label}: ${familyTasks.map(({ record }) => record.id).join(", ")} touches the family but no task's file_list includes the matrix test ` +
      `'${ownership.matrixTest}' — a change to the owner or a sibling must update the test that runs the rule through every entry point`,
  ];
}

/** A sibling's Task reaches the owner's Task, so the owner exists before its callers. */
function ownerFirstErrors(label: string, roled: readonly RoledTask[]): string[] {
  const ownerIds = new Set(roled.filter(({ roles }) => roles.owner).map(({ record }) => record.id));
  if (ownerIds.size === 0) return [];
  const byId = new Map(roled.map(({ record }) => [record.id, record] as const));
  return roled.flatMap(({ record, roles }) => {
    const sibling = roles.siblings[0];
    if (ownerIds.has(record.id) || sibling === undefined || dependsOnAny(record, ownerIds, byId)) return [];
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
 * changes, and build siblings after the owner.
 */
function ownershipErrors(
  inv: PlanInvariant,
  tasks: readonly Record<string, unknown>[],
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
    ...matrixTestErrors(label, ownership, roled),
    ...ownerFirstErrors(label, roled),
  ];
}

function renderContractProblem(problem: ContractProblem): string {
  return match(problem)
    .with({ kind: "missing-types" }, () =>
      "no '**Types file:**' declared — name the new declarations-only file consumers import, or 'none' with a '**No types reason:**'")
    .with({ kind: "none-without-reason" }, () => "'**Types file:** none' needs a '**No types reason:**'")
    .with({ kind: "reason-with-types-file" }, () => "declares both a types file and a '**No types reason:**' — keep one")
    .with({ kind: "missing-acceptance" }, () =>
      "no '**Acceptance tests:**' listed — a contract freezes at least one '- path — AS-n' acceptance file")
    .with({ kind: "malformed-acceptance" }, ({ line }) => `acceptance line '${line}' is not '- path — FR-n, AS-n'`)
    .with({ kind: "invalid-anchor" }, ({ path, anchor }) =>
      `'${path}' names '${anchor}', which a test cannot decide — list only FR-n and AS-n Requirements`)
    .with({ kind: "duplicate-acceptance" }, ({ path }) => `'${path}' is listed twice under '**Acceptance tests:**'`)
    .with({ kind: "supported-domain-not-acceptance" }, ({ path }) =>
      `'**Supported domain:** ${path}' is not one of the acceptance files`)
    .with({ kind: "unsafe-path" }, ({ path }) =>
      `'${path}' is not a repository-relative path — a frozen path may not be absolute or contain '..'`)
    .with({ kind: "missing-statement" }, () => "no '**Statement:**' — say what consumers rely on and what is refused")
    .exhaustive();
}

const COVERED_BY_CONTRACT = "covered-by-acceptance-contract";

function renderWriterProblem(problem: ContractWriterProblem): string {
  return match(problem)
    .with({ kind: "unwritten" }, ({ path }) => `'${path}' is in no task's file_list — decompose must emit the contract task that writes it`)
    .with({ kind: "shared" }, ({ path, taskIds }) =>
      `'${path}' is in the file_list of ${taskIds.join(" and ")} — a frozen path has exactly one writer, the contract task`)
    .with({ kind: "split" }, ({ taskIds }) =>
      `frozen paths are written by ${taskIds.join(" and ")} — one contract task writes the types file and every acceptance file`)
    .exhaustive();
}

/** A declared contract whose frozen paths have exactly one writer: its contract Task. */
type ResolvedContract = Readonly<{ contract: PlanContract; contractTask: string; covered: readonly string[] }>;

/**
 * Contract checks: one contract Task writes every frozen path and nothing else
 * writes any; the contract Task claims none of the Requirements its red tests
 * decide; every covered Requirement is claimed, and every claimant waits for
 * the contract Task; no path is frozen twice; and the contract new-test waiver
 * is admitted only on a claimant of a contract it depends on.
 */
function contractErrors(contracts: readonly PlanContract[], tasks: readonly Record<string, unknown>[]): string[] {
  const records = taskRecords(tasks);
  const byId = new Map(records.map((record) => [record.id, record] as const));
  const errors: string[] = [];
  const frozenBy = new Map<string, string>();
  const resolved: ResolvedContract[] = [];
  for (const contract of contracts) {
    const label = `${contract.id} ("${contract.title}")`;
    const declaration = contract.declaration;
    if (declaration.kind === "malformed") {
      errors.push(...declaration.problems.map((problem) => `${label}: ${renderContractProblem(problem)}`));
      continue;
    }
    const paths = frozenPaths(declaration);
    for (const path of paths) {
      const key = normalizePlanPath(path);
      const earlier = frozenBy.get(key);
      if (earlier === undefined) frozenBy.set(key, contract.id);
      else errors.push(`${label}: '${key}' is frozen by ${earlier} and ${contract.id} — a frozen path belongs to one contract`);
    }
    const writer = contractWriter(paths, records.map(({ id, files }) => ({ id, file_list: files })));
    if (!writer.ok) {
      errors.push(...writer.error.map((problem) => `${label}: ${renderWriterProblem(problem)}`));
      continue;
    }
    const contractTask = writer.value;
    const covered = coveredAnchors(declaration);
    resolved.push({ contract, contractTask, covered });
    const contractRecord = byId.get(contractTask)!;
    for (const anchor of covered) {
      if (contractRecord.claims.includes(anchor)) {
        errors.push(`${label}: ${contractTask} is ${contract.id}'s contract task but claims ${anchor} in spec_anchors — its tests ` +
          "are red by design; list it in spec_contributions and let the task that turns it green claim it");
      }
      const claimants = records.filter(({ id, claims }) => id !== contractTask && claims.includes(anchor));
      if (claimants.length === 0) {
        errors.push(`${label}: ${anchor} is decided by ${contract.id}'s acceptance tests but no task claims it in spec_anchors — nothing would turn it green`);
      }
      for (const claimant of claimants) {
        if (!dependsOnAny(claimant, new Set([contractTask]), byId)) {
          errors.push(`${label}: ${claimant.id} claims ${anchor}, which ${contract.id} covers, but does not depend on its ` +
            `contract task ${contractTask}, directly or transitively`);
        }
      }
    }
  }
  for (const record of records.filter(({ newTestWaiver: reason }) => reason === COVERED_BY_CONTRACT)) {
    const covering = resolved.some(({ contractTask, covered }) =>
      record.claims.some((anchor) => covered.includes(anchor)) && dependsOnAny(record, new Set([contractTask]), byId));
    if (!covering) {
      errors.push(`${record.id} waives new tests as ${COVERED_BY_CONTRACT} but claims no Requirement a contract it depends on covers`);
    }
  }
  return errors;
}

export function validateModelBindings(
  models: PlanModels,
  tasks: readonly Record<string, unknown>[],
  deps: ModelBindingDeps,
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
          parseError = jsonParseError(e);
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
      parseError = jsonParseError(e);
    }
    if (parseError !== null) {
      errors.push(`${inv.id}: rule file '${ruleFile}' is not valid JSON: ${parseError}`);
    } else if (typeof rule !== "object" || rule === null || Array.isArray(rule) || typeof (rule as Record<string, unknown>).kind !== "string" || typeof (rule as Record<string, unknown>).name !== "string") {
      errors.push(`${inv.id}: rule file '${ruleFile}' must be a JSON object with 'kind' and 'name' (full fail-closed load happens in the linter)`);
    }
  }

  for (const inv of models.invariants) errors.push(...ownershipErrors(inv, tasks, deps));

  errors.push(...contractErrors(models.contracts, tasks));

  return errors.length === 0 ? ok() : fail(errors);
}

/**
 * Outcome of the fail-closed plan-binding check. A discriminated union
 * instead of `ValidationResult & { models?: PlanModels }`: `models` is
 * present exactly when the plan was readable enough to parse — the type
 * states it, callers never guess. `ok` doubles as the pass/fail
 * discriminant so gate callers keep their `if (!check.ok)` shape.
 */
export type PlanBindingCheck =
  /** The plan itself could not be consulted (missing path / unreadable file) — nothing was parsed. */
  | { readonly kind: "plan-unavailable"; readonly ok: false; readonly errors: readonly string[] }
  /** Models were declared and at least one binding is broken. */
  | { readonly kind: "invalid-bindings"; readonly ok: false; readonly errors: readonly string[]; readonly models: PlanModels }
  /** The plan parsed and declares no models — genuine opt-out, zero checks. */
  | { readonly kind: "opted-out"; readonly ok: true; readonly models: PlanModels }
  /** Models were declared and every binding validated. */
  | { readonly kind: "validated"; readonly ok: true; readonly models: PlanModels };

/**
 * Fail-closed entry point: read the plan, parse models, validate bindings.
 *
 * - Non-string or empty `planFile` → plan-unavailable (the graph names no plan to check)
 * - Plan file unreadable → plan-unavailable (a graph must not pass validation
 *   because its plan cannot be read — that would let a typo'd path disarm the gate)
 * - Plan readable, no models declared → opted-out (genuine opt-out)
 */
export function checkPlanModelBindings(
  planFile: unknown,
  tasks: readonly Record<string, unknown>[],
  deps: ModelBindingDeps,
): PlanBindingCheck {
  if (typeof planFile !== "string" || planFile.trim().length === 0) {
    return {
      kind: "plan-unavailable",
      ok: false,
      errors: ["plan_file must be a non-empty string path — executable-model bindings cannot be verified without the plan"],
    };
  }
  const read = deps.readFile(planFile);
  if (!read.ok) {
    return {
      kind: "plan-unavailable",
      ok: false,
      errors: [`cannot read plan_file '${planFile}': ${read.error} — executable-model bindings cannot be verified (fix the path or run from the repo root)`],
    };
  }
  const models = parsePlanModels(read.content);
  // A model-free plan still validates: a Task may not claim the contract
  // new-test waiver when no contract exists to stand in for its tests.
  const result = validateModelBindings(models, tasks, deps);
  if (!result.ok) return { kind: "invalid-bindings", ok: false, errors: result.errors, models };
  return hasModels(models) ? { kind: "validated", ok: true, models } : { kind: "opted-out", ok: true, models };
}
