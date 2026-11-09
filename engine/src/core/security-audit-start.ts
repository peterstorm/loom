/**
 * Starting a security-audit run: the `start` payload, parsed, and everything a
 * run derives from it — identity, scope and lens selection — in one pure step.
 *
 * Its own volume because it JOINS three others: the contract (run metadata and
 * the wire kit), the lens selector (`StackSignals`, the selection) and the
 * coverage volume (the seeded ledger's status). The selector and the coverage
 * volume both import the contract, so the contract cannot import either back —
 * not even a type — without closing a cycle the source-domain graph forbids.
 * Nothing imports this module except the shell.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { compareStrings } from "./ordering";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import {
  SECURITY_PROFILE_LENSES,
  isWireRecord,
  wireStringList,
  wireViolation,
  type SecurityProfile,
  type SecurityRunMetadata,
  type SecurityScope,
  type WireViolation,
} from "./security-audit-contract";
import { runStatusOf, type CoverageLedger } from "./security-coverage";
import { selectSecurityLenses, type LensSelection, type StackSignals } from "./security-lens-select";

// --- The `start` payload ---

/** What a run's scope is over, before its paths are derived from the seeds. */
export type SecurityStartScope = Readonly<{
  kind: SecurityScope["kind"];
  baseRef: string | null;
  headRef: string | null;
}>;

/** The `start` input, parsed: the seed units (parsed next by the coverage
 *  volume, which owns them), the scope, and the stack signals. An absent scope
 *  is a tree scope; absent signals are no signals. */
export type SecurityAuditStart = Readonly<{
  units: readonly unknown[];
  scope: SecurityStartScope;
  signals: StackSignals;
}>;

export type SecurityAuditStartError = Readonly<{
  kind: "invalid-security-audit-start";
  violations: readonly WireViolation[];
}>;

const START_KEYS: readonly string[] = ["units", "scope", "signals"];
const SCOPE_KEYS: readonly string[] = ["kind", "baseRef", "headRef"];

/** Every stack signal and the wire shape it takes. Keyed by the type, so a
 *  signal added to `StackSignals` is a compile error here until the parser
 *  knows its shape — the one list the parser reads. */
const STACK_SIGNAL_SHAPES: Readonly<{ [K in keyof StackSignals]: StackSignals[K] extends boolean ? "boolean" : "string-list" }> = {
  languages: "string-list",
  manifests: "string-list",
  servesHttp: "boolean",
  rendersClientSide: "boolean",
  drivesModelsOrTools: "boolean",
  usesQueuesOrRpc: "boolean",
  isolatesTenants: "boolean",
  deploysInfrastructure: "boolean",
  hasNativeMemory: "boolean",
  hasAppOrLocalIpc: "boolean",
  hasReleasePipelines: "boolean",
  hasSharedResourcePressure: "boolean",
};

const unknownKeys = (record: Readonly<Record<string, unknown>>, allowed: readonly string[], path: string): readonly WireViolation[] =>
  Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .sort(compareStrings)
    .map((key) => wireViolation(`${path}.${key}`, "unknown field"));

function parseStartScope(raw: unknown, violations: WireViolation[]): SecurityStartScope {
  const tree: SecurityStartScope = { kind: "tree", baseRef: null, headRef: null };
  if (raw === undefined) return tree;
  if (!isWireRecord(raw)) {
    violations.push(wireViolation("scope", "expected an object with kind tree or diff"));
    return tree;
  }
  violations.push(...unknownKeys(raw, SCOPE_KEYS, "scope"));
  if (raw.kind !== "tree" && raw.kind !== "diff") violations.push(wireViolation("scope.kind", "expected tree or diff"));
  const ref = (key: "baseRef" | "headRef"): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    violations.push(wireViolation(`scope.${key}`, "expected a string or null"));
    return null;
  };
  return { kind: raw.kind === "diff" ? "diff" : "tree", baseRef: ref("baseRef"), headRef: ref("headRef") };
}

/** Stack signals: absent, or an object drawing ONLY from the known signals with
 *  each one's own type. A signal the payload omits is not present (`[]` or
 *  `false`), which is what "no signal" means to the selector; a misspelled or
 *  mistyped signal is a violation, because silently dropping it changes which
 *  lenses the run selects while the payload still parses. */
function parseStackSignals(raw: unknown, violations: WireViolation[]): StackSignals {
  const record = raw === undefined ? {} : raw;
  if (!isWireRecord(record)) {
    violations.push(wireViolation("signals", "expected an object of stack signals"));
  } else {
    violations.push(...unknownKeys(record, Object.keys(STACK_SIGNAL_SHAPES), "signals"));
    for (const [key, shape] of Object.entries(STACK_SIGNAL_SHAPES)) {
      const value = record[key];
      if (value === undefined) continue;
      if (shape === "boolean" && typeof value !== "boolean") violations.push(wireViolation(`signals.${key}`, "expected a boolean"));
      if (shape === "string-list") wireStringList(value, `signals.${key}`, violations);
    }
  }
  // Read back only what the checks above admitted: a refused field reads as
  // absent here, and its violation already fails the parse.
  const fields = isWireRecord(record) ? record : {};
  const list = (key: "languages" | "manifests"): readonly string[] => wireStringList(fields[key], `signals.${key}`, []);
  const flag = (key: keyof StackSignals): boolean => fields[key] === true;
  return {
    languages: list("languages"),
    manifests: list("manifests"),
    servesHttp: flag("servesHttp"),
    rendersClientSide: flag("rendersClientSide"),
    drivesModelsOrTools: flag("drivesModelsOrTools"),
    usesQueuesOrRpc: flag("usesQueuesOrRpc"),
    isolatesTenants: flag("isolatesTenants"),
    deploysInfrastructure: flag("deploysInfrastructure"),
    hasNativeMemory: flag("hasNativeMemory"),
    hasAppOrLocalIpc: flag("hasAppOrLocalIpc"),
    hasReleasePipelines: flag("hasReleasePipelines"),
    hasSharedResourcePressure: flag("hasSharedResourcePressure"),
  };
}

/**
 * Parse the `start` payload. Strict, and every violation at once: a `units`
 * array is required, unknown keys are refused at every level, `scope.kind` is
 * `tree` or `diff`, and each stack signal has its own type.
 *
 * Strict because every field here CHANGES the run: an unknown `scope.kind`
 * coerced to `tree`, or a mistyped signal spread into the selector, would start
 * a run over a different scope or with different lenses than the caller asked
 * for, and nothing downstream could tell.
 */
export function parseSecurityAuditStart(raw: unknown): DomainResult<SecurityAuditStart, SecurityAuditStartError> {
  const refuse = (violations: readonly WireViolation[]) =>
    failure({ kind: "invalid-security-audit-start" as const, violations });
  if (!isWireRecord(raw)) return refuse([wireViolation("$", "start input must be an object")]);
  const violations: WireViolation[] = [...unknownKeys(raw, START_KEYS, "$")];
  const units = raw.units;
  if (!Array.isArray(units)) violations.push(wireViolation("units", "start input requires a `units` array"));
  const scope = parseStartScope(raw.scope, violations);
  const signals = parseStackSignals(raw.signals, violations);
  if (violations.length > 0 || !Array.isArray(units)) return refuse(violations);
  return success({ units: [...units], scope, signals });
}

// --- What a start derives ---

export type RunStartFacts = Readonly<{
  /** The run directory's own name: the default run id is minted from it. */
  directoryName: string;
  repo: string;
  /** The caller's `--run-id`, or null for the default. */
  runId: string | null;
  profile: SecurityProfile;
  budget: number | null;
  sourceRef: SecurityRunMetadata["sourceRef"];
}>;

/**
 * Everything `start` derives — run identity, scope, lens selection — in one
 * pure step, so the shell's job is only: read the payload, write files. The
 * scope's paths are the seeds' starting paths, the lens cap is the profile's,
 * and the run's status comes from `runStatusOf` — the same derivation `publish`
 * and `status` read.
 */
export function startMetadata(
  facts: RunStartFacts,
  payload: SecurityAuditStart,
  ledger: CoverageLedger,
): Readonly<{ metadata: SecurityRunMetadata; selection: LensSelection }> {
  const scopePaths = [...new Set(ledger.flatMap((unit) => unit.starting_paths))].sort(compareStrings);
  const selection = selectSecurityLenses(payload.signals, { maxLenses: SECURITY_PROFILE_LENSES[facts.profile] });
  return {
    selection,
    metadata: {
      schemaVersion: 1,
      runId: facts.runId ?? `${facts.directoryName}-${facts.sourceRef.commit.slice(0, 12)}`,
      repo: facts.repo,
      target: facts.repo,
      profile: facts.profile,
      scope: { paths: scopePaths, ...payload.scope },
      scopePaths,
      sourceRef: facts.sourceRef,
      budget: facts.budget,
      executionPolicy: "sandboxed-source-and-local-only",
      selectedCompanions: selection.included.map((entry) => entry.lens),
      priorRuns: [],
      ...runStatusOf(ledger),
      published: false,
    },
  };
}
