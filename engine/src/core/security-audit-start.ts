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
  SCOPE_REF_PATTERN,
  SECURITY_PROFILE_LENSES,
  isWireRecord,
  unknownFieldViolations,
  wireStringList,
  wireViolation,
  type SecurityProfile,
  type SecurityRunMetadata,

  type WireViolation,
} from "./security-audit-contract";
import { runStatusOf, type CoverageLedger } from "./security-coverage";
import {
  NO_STACK_SIGNALS,
  STACK_SIGNAL_NAMES,
  STACK_SIGNAL_SHAPES,
  selectSecurityLenses,
  type LensSelection,
  type StackSignals,
} from "./security-lens-select";

// --- The `start` payload ---

/** What a run's scope is over, before its paths are derived from the seeds: a
 *  `tree` names no refs, a `diff` names both — the metadata's own scope union
 *  without its paths. */
export type SecurityStartScope =
  | Readonly<{ kind: "tree"; baseRef: null; headRef: null }>
  | Readonly<{ kind: "diff"; baseRef: string; headRef: string }>;

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
const TREE_SCOPE: SecurityStartScope = Object.freeze({ kind: "tree", baseRef: null, headRef: null });

/** The scope, with its refs paired to its kind: a `diff` names BOTH refs, each a
 *  commit object id, and a `tree` names neither. A diff with a missing ref
 *  identifies no diff (the report would print `?..?`), and refs on a tree
 *  would be kept in the metadata with nothing reading them. */
function parseStartScope(raw: unknown, violations: WireViolation[]): SecurityStartScope {
  if (raw === undefined) return TREE_SCOPE;
  if (!isWireRecord(raw)) {
    violations.push(wireViolation("scope", "expected an object with kind tree or diff"));
    return TREE_SCOPE;
  }
  violations.push(...unknownFieldViolations(raw, SCOPE_KEYS, "scope", "sorted"));
  const kind = raw.kind === "tree" || raw.kind === "diff" ? raw.kind : null;
  if (kind === null) violations.push(wireViolation("scope.kind", "expected tree or diff"));
  const ref = (key: "baseRef" | "headRef"): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    violations.push(wireViolation(`scope.${key}`, "expected a string or null"));
    return null;
  };
  const baseRef = ref("baseRef");
  const headRef = ref("headRef");
  if (kind === null) return TREE_SCOPE;
  if (kind === "tree") {
    if (baseRef !== null) violations.push(wireViolation("scope.baseRef", "a tree scope names no refs"));
    if (headRef !== null) violations.push(wireViolation("scope.headRef", "a tree scope names no refs"));
    return TREE_SCOPE;
  }
  const commit = (key: "baseRef" | "headRef", value: string | null): string => {
    if (value === null) {
      // A present-but-mistyped ref was already named above; only an absent one is reported here.
      if (raw[key] === undefined || raw[key] === null) violations.push(wireViolation(`scope.${key}`, "a diff scope names both refs"));
      return "";
    }
    if (!SCOPE_REF_PATTERN.test(value)) violations.push(wireViolation(`scope.${key}`, "expected a 40- or 64-hex commit id"));
    return value;
  };
  return { kind: "diff", baseRef: commit("baseRef", baseRef), headRef: commit("headRef", headRef) };
}

/** Stack signals: absent, or an object drawing ONLY from the known signals with
 *  each one's own type. A signal the payload omits is not present (`[]` or
 *  `false`), which is what "no signal" means to the selector; a misspelled or
 *  mistyped signal is a violation, because silently dropping it changes which
 *  lenses the run selects while the payload still parses. The known signals
 *  and their shapes are the selector's own table (`STACK_SIGNAL_SHAPES`). */
function parseStackSignals(raw: unknown, violations: WireViolation[]): StackSignals {
  if (raw === undefined) return NO_STACK_SIGNALS;
  if (!isWireRecord(raw)) {
    violations.push(wireViolation("signals", "expected an object of stack signals"));
    return NO_STACK_SIGNALS;
  }
  violations.push(...unknownFieldViolations(raw, STACK_SIGNAL_NAMES, "signals", "sorted"));
  for (const key of STACK_SIGNAL_NAMES) {
    const value = raw[key];
    if (value === undefined) continue;
    if (STACK_SIGNAL_SHAPES[key] === "boolean" && typeof value !== "boolean") violations.push(wireViolation(`signals.${key}`, "expected a boolean"));
    if (STACK_SIGNAL_SHAPES[key] === "string-list") wireStringList(value, `signals.${key}`, violations);
  }
  // Read back only what the checks above admitted: a refused field reads as
  // absent here, and its violation already fails the parse.
  const list = (key: "languages" | "manifests"): readonly string[] => wireStringList(raw[key], `signals.${key}`, []);
  const flag = (key: keyof StackSignals): boolean => raw[key] === true;
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
 * `tree` or `diff` with exactly the refs that kind names, and each stack
 * signal has its own type.
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
  const violations: WireViolation[] = [...unknownFieldViolations(raw, START_KEYS, "$", "sorted")];
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
