/**
 * Requirement Coverage Projection — the pure join of one Spec Index against the
 * frozen current-Wave Task roster.
 *
 * Every verdict here is decided by structure alone: an identifier is in the
 * Spec Index or it is not, a Task declared artifacts or it did not, a recorded
 * content hash equals the current one or it does not. None of it needs a model,
 * so none of it is prose. What survives as `candidate-pass` is exactly the
 * residue that genuinely requires reading code — the model's job shrinks to
 * behaviour, and `/spec-check` stops re-deriving the graph it was already
 * handed.
 *
 * The projection is derived join input, never a second source of truth: the
 * Spec Index owns Requirement identity, the protected TaskGraph owns the
 * Task→Requirement edges, and this module owns neither.
 */

import { match } from "ts-pattern";
import type {
  NonEmpty,
  ParsedSpec,
  SpecContentHash,
  SpecEntry,
  SpecEntryId,
  SpecGlossaryEntry,
  SpecParseError,
} from "./parse-spec";
import { specParseErrorMessage } from "./parse-spec";

/**
 * The families a Task may legitimately claim to have completed. `OOS` is
 * absent by construction: claiming to complete an excluded item is a category
 * error, and the branded families make that unrepresentable rather than
 * merely unlikely.
 */
export type CompletableEntry = SpecEntry<"FR"> | SpecEntry<"AS">;

/**
 * Whether the Requirement text still says what it said when the Task claimed
 * it. Orthogonal to whether the claim is implemented, so it travels beside the
 * verdict rather than collapsing into it.
 */
export type DriftFact =
  | Readonly<{ kind: "unverifiable" }>
  | Readonly<{ kind: "stable"; hash: SpecContentHash }>
  | Readonly<{ kind: "drifted"; recorded: SpecContentHash; current: SpecContentHash }>;

/**
 * One Requirement Completion Claim's structural outcome.
 *
 * `candidate-pass` is the only verdict that hands work to a model; the other
 * three are decided here and are not the model's to overturn.
 */
export type ClaimVerdict =
  | Readonly<{ kind: "unknown-requirement" }>
  | Readonly<{ kind: "excluded-requirement"; entry: SpecEntry<"OOS"> }>
  | Readonly<{ kind: "not-declared"; entry: CompletableEntry }>
  | Readonly<{ kind: "not-implemented"; entry: CompletableEntry }>
  | Readonly<{ kind: "candidate-pass"; entry: CompletableEntry; drift: DriftFact }>;

export type CoverageRow = Readonly<{
  taskId: string;
  claim: string;
  verdict: ClaimVerdict;
}>;

/**
 * Why no Spec Index was available. An absent projection is an honest absence
 * with a stated reason — never a pass, and never silence.
 *
 * `unreadable` arises only where a missing spec is not itself a failure — at
 * decompose, where recording Requirement hashes is an enhancement. The Wave
 * Gate's own observation refuses outright instead, because gate evidence must
 * name exact bytes.
 */
export type SpecIndexUnavailable =
  | Readonly<{ kind: "no-spec-file" }>
  | Readonly<{ kind: "unreadable"; path: string; reason: string }>
  | Readonly<{ kind: "unparsed"; path: string; errors: NonEmpty<SpecParseError> }>;

/** A Spec Index observation: the projection of the exact observed bytes. */
export type SpecIndexAvailability =
  | Readonly<{ kind: "indexed"; path: string; index: ParsedSpec }>
  | Readonly<{ kind: "unavailable"; reason: SpecIndexUnavailable }>;

/**
 * One Task's join input. `inCurrentWave` rides on the Task rather than arriving
 * as a separate id list: a roster and a list of ids can disagree, a flag on the
 * row cannot.
 */
export type CoverageTask = Readonly<{
  id: string;
  inCurrentWave: boolean;
  completionAnchors: readonly string[];
  declaredFiles: readonly string[];
  modifiedFiles: readonly string[];
  /** Hashes recorded when the Task→Requirement edge was created; `null` on
   * graphs decomposed before Requirement hashes were engine-derived. */
  anchorHashes: ReadonlyMap<string, SpecContentHash> | null;
}>;

export type RequirementCoverage =
  | Readonly<{ kind: "unavailable"; reason: SpecIndexUnavailable }>
  | Readonly<{
      kind: "projected";
      /** One row per current-Wave Requirement Completion Claim, in roster order. */
      rows: readonly CoverageRow[];
      /** Functional Requirements no Task in the whole graph claims — planned by
       * nobody, at any Wave. Wave-independent, so it is honest at every gate. */
      unclaimed: readonly SpecEntryId<"FR">[];
      /** The typed exclusion list, replacing a grep of the Out of Scope section. */
      exclusions: NonEmpty<SpecEntry<"OOS">>;
      /** The typed glossary, replacing a grep of the Appendix table. */
      glossary: NonEmpty<SpecGlossaryEntry>;
    }>;

/**
 * An entry as the join sees it. The family is decided once, at insertion, from
 * the collection the entry came out of — so nothing downstream re-derives it by
 * sniffing the identifier's prefix, which is exactly the drift the branded
 * families exist to prevent.
 */
type IndexedEntry =
  | Readonly<{ family: "completable"; entry: CompletableEntry }>
  | Readonly<{ family: "excluded"; entry: SpecEntry<"OOS"> }>;

const entryById = (index: ParsedSpec): ReadonlyMap<string, IndexedEntry> => {
  const byId = new Map<string, IndexedEntry>();
  for (const entry of [...index.frs, ...index.scenarios]) byId.set(entry.id, { family: "completable", entry });
  for (const entry of index.oos) byId.set(entry.id, { family: "excluded", entry });
  return byId;
};

/**
 * The recorded-vs-current comparison, as the only place a hash equality is
 * decided. A Task with no recorded hash yields `unverifiable`, which is a
 * different fact from `stable` and must never be rendered as one.
 */
function driftOf(
  anchorHashes: CoverageTask["anchorHashes"],
  claim: string,
  entry: CompletableEntry,
): DriftFact {
  const recorded = anchorHashes?.get(claim);
  if (recorded === undefined) return Object.freeze({ kind: "unverifiable" });
  return recorded === entry.contentHash
    ? Object.freeze({ kind: "stable", hash: entry.contentHash })
    : Object.freeze({ kind: "drifted", recorded, current: entry.contentHash });
}

/**
 * The single classification. Order is the point: an identifier that names
 * nothing cannot be assessed, an excluded identifier must not be assessed, and
 * a Requirement with no artifacts behind it has nothing to read — only what
 * survives all three earns a model's attention.
 */
function classify(
  task: CoverageTask,
  claim: string,
  byId: ReadonlyMap<string, IndexedEntry>,
): ClaimVerdict {
  const indexed = byId.get(claim);
  if (indexed === undefined) return Object.freeze({ kind: "unknown-requirement" });
  if (indexed.family === "excluded") {
    return Object.freeze({ kind: "excluded-requirement", entry: indexed.entry });
  }
  const entry = indexed.entry;
  if (task.declaredFiles.length === 0) return Object.freeze({ kind: "not-declared", entry });
  if (task.modifiedFiles.length === 0) return Object.freeze({ kind: "not-implemented", entry });
  return Object.freeze({ kind: "candidate-pass", entry, drift: driftOf(task.anchorHashes, claim, entry) });
}

/**
 * The sole Requirement Coverage Projection derivation.
 *
 * Total and deterministic: the same Spec Index and roster always produce the
 * same rows in the same order, so the projection can be hashed into request
 * authority like any other frozen input.
 */
export function projectRequirementCoverage(
  specIndex: SpecIndexAvailability,
  tasks: readonly CoverageTask[],
): RequirementCoverage {
  if (specIndex.kind === "unavailable") {
    return Object.freeze({ kind: "unavailable", reason: specIndex.reason });
  }
  const byId = entryById(specIndex.index);
  const rows: CoverageRow[] = [];
  const claimedAnywhere = new Set<string>();
  for (const task of tasks) {
    for (const claim of task.completionAnchors) {
      claimedAnywhere.add(claim);
      if (!task.inCurrentWave) continue;
      rows.push(Object.freeze({ taskId: task.id, claim, verdict: classify(task, claim, byId) }));
    }
  }
  return Object.freeze({
    kind: "projected",
    rows: Object.freeze(rows),
    unclaimed: Object.freeze(specIndex.index.frs.filter(({ id }) => !claimedAnywhere.has(id)).map(({ id }) => id)),
    exclusions: specIndex.index.oos,
    glossary: specIndex.index.glossary,
  });
}

/**
 * The total renderer for every `SpecIndexUnavailable`. Exhaustive by
 * construction: a new reason cannot reach an operator without text.
 */
export function specIndexUnavailableMessage(reason: SpecIndexUnavailable): string {
  return match(reason)
    .with({ kind: "no-spec-file" }, () => "the TaskGraph records no spec_file, so no Spec Index exists to join against")
    .with({ kind: "unreadable" }, ({ path, reason: cause }) => `spec file ${path} could not be read: ${cause}`)
    .with({ kind: "unparsed" }, ({ path, errors }) =>
      `spec file ${path} is not a canonical specification: ${errors.map(specParseErrorMessage).join("; ")}`)
    .exhaustive();
}

/**
 * The severity a settled verdict carries into the spec-check findings contract.
 * Decided here rather than in the command prose, so an Agent cannot soften a
 * structural refutation by describing it differently.
 */
export type ClaimSeverity = "CRITICAL" | "MEDIUM" | "CANDIDATE";

export function claimSeverity(verdict: ClaimVerdict): ClaimSeverity {
  return match(verdict)
    .with({ kind: "unknown-requirement" }, () => "CRITICAL" as const)
    .with({ kind: "excluded-requirement" }, () => "CRITICAL" as const)
    .with({ kind: "not-declared" }, () => "CRITICAL" as const)
    .with({ kind: "not-implemented" }, () => "CRITICAL" as const)
    .with({ kind: "candidate-pass" }, ({ drift }) => drift.kind === "drifted" ? "MEDIUM" as const : "CANDIDATE" as const)
    .exhaustive();
}

/**
 * The total renderer for every `ClaimVerdict`. Owning the prose in one place is
 * what lets every caller discriminate on `kind` instead of matching text.
 */
export function claimVerdictMessage(verdict: ClaimVerdict): string {
  return match(verdict)
    .with({ kind: "unknown-requirement" }, () =>
      "names no entry in the Spec Index — a Completion Claim that the specification does not define")
    .with({ kind: "excluded-requirement" }, ({ entry }) =>
      `claims completion of the explicitly excluded ${entry.id} — an Out-of-Scope item cannot be completed`)
    .with({ kind: "not-declared" }, ({ entry }) =>
      `claims ${entry.id} but the Task declared no artifacts, so nothing can satisfy it`)
    .with({ kind: "not-implemented" }, ({ entry }) =>
      `claims ${entry.id} but the Task modified no files`)
    .with({ kind: "candidate-pass" }, ({ entry, drift }) => match(drift)
      .with({ kind: "unverifiable" }, () =>
        `${entry.id} is structurally covered; drift is unverifiable because no hash was recorded when the claim was made`)
      .with({ kind: "stable" }, () => `${entry.id} is structurally covered and its text is unchanged since the claim`)
      .with({ kind: "drifted" }, ({ recorded, current }) =>
        `${entry.id} is structurally covered but its text changed since the claim (recorded ${recorded.slice(0, 12)}, now ${current.slice(0, 12)})`)
      .exhaustive())
    .exhaustive();
}

/**
 * The Requirement Coverage Projection as the spec-check Agent reads it.
 *
 * Deterministic text: the same projection always renders the same bytes, so the
 * rendering contributes to Context Packet identity like any other frozen input.
 * Settled rows are copied into the report verbatim; only `CANDIDATE` rows are
 * the Agent's to decide.
 */
export function renderRequirementCoverage(coverage: RequirementCoverage): string {
  if (coverage.kind === "unavailable") {
    return [
      "## Requirement Coverage Projection — UNAVAILABLE",
      "",
      `No structural projection was possible: ${specIndexUnavailableMessage(coverage.reason)}`,
      "",
      "Every Requirement Completion Claim below must be assessed by reading the specification and the code.",
      "An unavailable projection is an absence of evidence, never a pass.",
    ].join("\n");
  }
  const rows = coverage.rows.map((row) =>
    `| ${row.taskId} | ${row.claim} | ${claimSeverity(row.verdict)} | ${claimVerdictMessage(row.verdict)} |`);
  return [
    "## Requirement Coverage Projection",
    "",
    "Engine-derived structural verdicts. `CRITICAL` and `MEDIUM` rows are settled — copy them",
    "into the report verbatim; they are not yours to overturn. Assess only `CANDIDATE` rows.",
    "",
    "| Task | Claim | Verdict | Detail |",
    "|---|---|---|---|",
    ...(rows.length === 0 ? ["| — | — | — | this Wave's Tasks make no Requirement Completion Claims |"] : rows),
    "",
    "### Functional Requirements claimed by no Task, at any Wave",
    "",
    ...(coverage.unclaimed.length === 0
      ? ["Every Functional Requirement in the Spec Index is claimed by some Task."]
      : coverage.unclaimed.map((id) => `- ${id} — CRITICAL: no Task in the graph claims it`)),
    "",
    "### Out of Scope (typed exclusion list)",
    "",
    ...coverage.exclusions.map(({ id, content }) => `- ${id}: ${content}`),
    "",
    "### Glossary (typed terms)",
    "",
    ...coverage.glossary.map(({ term, definition }) => `- ${term}: ${definition}`),
  ].join("\n");
}

/**
 * The Spec Index content hash for every claim the Task can be joined to, as the
 * specification stands at the moment the Task→Requirement edge is created.
 *
 * The inverse of the drift comparison above, and the reason `driftOf` can ever
 * answer anything but `unverifiable`. Hashes are taken from the entries
 * themselves, never recomputed: an entry's hash is derived from its own
 * canonical content by the parser's smart constructor, so re-deriving it here
 * would introduce a second canonicalization that could disagree with the first.
 *
 * Unknown identifiers are omitted rather than stamped with a placeholder. A
 * recorded hash asserts "the Requirement said this when the edge was made", and
 * there is nothing to assert about an identifier the specification does not
 * define — the projection reports that separately, as `unknown-requirement`.
 */
export function recordedAnchorHashes(
  index: ParsedSpec,
  completionAnchors: readonly string[],
): Readonly<Record<string, string>> {
  const byId = entryById(index);
  const hashes: Record<string, string> = {};
  for (const claim of completionAnchors) {
    const indexed = byId.get(claim);
    if (indexed !== undefined) hashes[claim] = indexed.entry.contentHash;
  }
  return Object.freeze(hashes);
}

/**
 * The spec file an observation was taken from, whichever way it turned out.
 *
 * Total accessor owned by the type, so a caller proving the observation names
 * the protected `spec_file` does not have to re-derive the path from each
 * variant — and a new variant cannot silently answer `null`.
 */
export function specIndexPath(availability: SpecIndexAvailability): string | null {
  return match(availability)
    .with({ kind: "indexed" }, ({ path }) => path as string | null)
    .with({ kind: "unavailable", reason: { kind: "no-spec-file" } }, () => null)
    .with({ kind: "unavailable", reason: { kind: "unreadable" } }, ({ reason }) => reason.path as string | null)
    .with({ kind: "unavailable", reason: { kind: "unparsed" } }, ({ reason }) => reason.path as string | null)
    .exhaustive();
}
