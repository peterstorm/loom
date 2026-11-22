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

import { z } from "zod/v4";
import { compareStrings } from "./ordering";
import { failure, type DomainResult } from "./orchestration-contract/identity";
import {
  SECURITY_PROFILE_LENSES,
  commitIdSchema,
  expecting,
  parseWire,
  stringListSchema,
  type CommitId,
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
} from "./security-lens-select";

// --- The `start` payload ---

/** What a run's scope is over, before its paths are derived from the seeds: a
 *  `tree` names no refs, a `diff` names both commits — the metadata's own
 *  scope union without its paths. */
export type SecurityStartScope =
  | Readonly<{ kind: "tree"; baseRef: null; headRef: null }>
  | Readonly<{ kind: "diff"; baseRef: CommitId; headRef: CommitId }>;

const TREE_SCOPE: SecurityStartScope = Object.freeze({ kind: "tree", baseRef: null, headRef: null });

const scopeRef = z.string(expecting("expected a string or null")).nullable().optional();
const SCOPE_REFS = ["baseRef", "headRef"] as const;

/**
 * The scope, with its refs paired to its kind: a `diff` names BOTH refs, each a
 * commit object id, and a `tree` names neither. A diff with a missing ref
 * identifies no diff (the report would print `?..?`), and refs on a tree would
 * be kept in the metadata with nothing reading them. The shape is read first,
 * whatever the kind, so an unknown key or a mistyped ref is named even beside
 * an unknown kind; the pairing is the one pass that follows.
 */
const startScopeSchema = z
  .strictObject(
    { kind: z.enum(["tree", "diff"], expecting("expected tree or diff")), baseRef: scopeRef, headRef: scopeRef },
    { error: (issue) => (issue.code === "invalid_type" ? "expected an object with kind tree or diff" : undefined) },
  )
  .transform((scope, ctx): SecurityStartScope => {
    const refuse = (ref: (typeof SCOPE_REFS)[number], message: string) => ctx.addIssue({ code: "custom", path: [ref], message });
    if (scope.kind === "tree") {
      for (const ref of SCOPE_REFS) if (scope[ref] != null) refuse(ref, "a tree scope names no refs");
      return TREE_SCOPE;
    }
    const commitOf = (ref: (typeof SCOPE_REFS)[number]): CommitId | null => {
      const value = scope[ref];
      if (value == null) {
        refuse(ref, "a diff scope names both refs");
        return null;
      }
      const commit = commitIdSchema.safeParse(value);
      if (!commit.success) refuse(ref, "expected a 40- or 64-hex commit id");
      return commit.success ? commit.data : null;
    };
    const baseRef = commitOf("baseRef");
    const headRef = commitOf("headRef");
    return baseRef === null || headRef === null ? z.NEVER : { kind: "diff", baseRef, headRef };
  });

const listSignal = stringListSchema.default([]);
const flagSignal = z.boolean(expecting("expected a boolean")).default(false);

/** The schema each stack-signal wire shape is parsed by. */
const SIGNAL_SCHEMA = { boolean: flagSignal, "string-list": listSignal } as const;

/** Each signal's schema, read off the lens selector's one signal table. */
type SignalSchemas = { readonly [Signal in keyof typeof STACK_SIGNAL_SHAPES]: (typeof SIGNAL_SCHEMA)[(typeof STACK_SIGNAL_SHAPES)[Signal]] };

// The entries are built from the typed table key by key; `fromEntries` only
// forgets the per-key pairing the mapped type restates.
const SIGNAL_SCHEMAS = Object.fromEntries(
  STACK_SIGNAL_NAMES.map((name) => [name, SIGNAL_SCHEMA[STACK_SIGNAL_SHAPES[name]]]),
) as SignalSchemas;

/** Stack signals: an object drawing ONLY from the known signals, each with its
 *  own type. A signal the payload omits is not present (`[]` or `false`), which
 *  is what "no signal" means to the selector; a misspelled or mistyped signal
 *  is a violation, because silently dropping it changes which lenses the run
 *  selects while the payload still parses. The fields are derived from the
 *  selector's `STACK_SIGNAL_SHAPES` table, so a signal the selector adds is
 *  parsed here with no second list to keep in step. */
const stackSignalsSchema = z.strictObject(
  SIGNAL_SCHEMAS,
  { error: (issue) => (issue.code === "invalid_type" ? "expected an object of stack signals" : undefined) },
).readonly();

/**
 * The `start` payload. Strict, and every violation at once: a `units` array is
 * required, unknown keys are refused at every level, `scope.kind` is `tree` or
 * `diff` with exactly the refs that kind names, and each stack signal has its
 * own type. An absent scope is a tree scope; absent signals are no signals.
 *
 * Strict because every field here CHANGES the run: an unknown `scope.kind`
 * coerced to `tree`, or a mistyped signal spread into the selector, would start
 * a run over a different scope or with different lenses than the caller asked
 * for, and nothing downstream could tell. The seed units are parsed next, by
 * the coverage volume, which owns them.
 */
const securityAuditStartSchema = z
  .strictObject(
    {
      units: z.array(z.unknown(), { error: () => "start input requires a `units` array" }).readonly(),
      scope: startScopeSchema.default(TREE_SCOPE),
      signals: stackSignalsSchema.default(NO_STACK_SIGNALS),
    },
    { error: (issue) => (issue.code === "invalid_type" ? "start input must be an object" : undefined) },
  )
  .readonly();

export type SecurityAuditStart = z.output<typeof securityAuditStartSchema>;

export type SecurityAuditStartError = Readonly<{
  kind: "invalid-security-audit-start";
  violations: readonly WireViolation[];
}>;

/** Parse the `start` payload, or every violation it carries. */
export function parseSecurityAuditStart(raw: unknown): DomainResult<SecurityAuditStart, SecurityAuditStartError> {
  const parsed = parseWire(securityAuditStartSchema, raw, "");
  return parsed.ok ? parsed : failure({ kind: "invalid-security-audit-start" as const, violations: parsed.error });
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
