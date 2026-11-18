/**
 * Change Class (ADR-0094): what changed in a reviewed Task since the review
 * its re-review is judged against (its Review Basis), and the reviewer roles
 * that change needs.
 *
 * - `classifyReviewChange` compares a before/after view the shell assembled:
 *   the reviewed files' bytes and the Task context a reviewer packet presents.
 * - `selectReviewRoles` maps the change to the roles of the derived roster it
 *   needs, by the operator's role table.
 *
 * Conservative throughout: anything this module cannot read with certainty is
 * a code change, and a code change is reviewed by the whole roster.
 *
 * Pure: no I/O, no clock, no randomness.
 */
import {
  narrowedWaveReviewRoster,
  type NarrowedWaveReviewRoster,
  type WaveReviewRole,
  type WaveReviewRoster,
} from "./agent-catalog-projections";
import { commentStrippedSource } from "./comment-lexer";
import { NARROWING_CHANGE_CLASSES, type NarrowingChangeClass } from "./findings-shape";
import { canonicalStructuralEquals, isNonEmpty, type NonEmpty } from "./orchestration-contract";
import { isTestFileBySuffixes } from "./test-file-classification";

/** The kinds of change one reviewed file can show, in report order. */
export const CHANGE_CLASSES = Object.freeze([...NARROWING_CHANGE_CLASSES, "code"] as const);

/** One kind of change: comment-only, doc-only, test-only or code. */
export type ChangeClass = NarrowingChangeClass | "code";

/** A reviewed file's content as the view holds it. */
export type ReviewFileContent =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "binary"; base64: string }>;

/** One reviewed file. */
export type ReviewedFile = Readonly<{ path: string; content: ReviewFileContent }>;

/**
 * One packet section as a basis presents it: observed (its rendered text, or
 * null when the packet carried none), or not observable from the basis.
 */
export type SectionFact = Readonly<{ kind: "observed"; text: string | null }> | Readonly<{ kind: "unobserved" }>;

/** Everything a reviewer packet presents of a Task besides its bytes and Findings. */
export type ReviewContextFacts = Readonly<{
  description: string;
  agent: string;
  planContext: string | null;
  specAnchors: readonly string[];
  specContributions: readonly string[];
  declaredFiles: readonly string[];
  planFile: string | null;
  ownerMap: SectionFact;
  contractSurface: SectionFact;
}>;

/** One side of the comparison: the reviewed files and the presented context. */
export type ReviewChangeSide = Readonly<{ files: readonly ReviewedFile[]; context: ReviewContextFacts }>;

/**
 * What changed between the basis and now:
 * - `unchanged`: the same bytes and context, so nothing names the roles a
 *   re-review needs;
 * - `scope-changed`: a reviewed path was added or removed;
 * - `context-changed`: the presented context differs, or the basis cannot show it;
 * - `changed`: the classes of the changed files, distinct, in `CHANGE_CLASSES` order.
 */
export type ReviewChange =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "scope-changed" }>
  | Readonly<{ kind: "context-changed" }>
  | Readonly<{ kind: "changed"; classes: NonEmpty<ChangeClass> }>;

/** Documentation files: a change to one is a doc change. */
const DOC_SUFFIXES = Object.freeze([".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"]);

/**
 * Sources whose comments `commentStrippedSource` (core/comment-lexer.ts) reads: C-family comment
 * syntax with JavaScript's strings, templates and regular expressions, or
 * Java's strings. JSX and TSX are not here: `//` in JSX text is text.
 */
const COMMENT_LEXED_SUFFIXES = Object.freeze([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".java"]);

const endsWithAny = (path: string, suffixes: readonly string[]): boolean => {
  const lower = path.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
};

/** The class of one file's change, or null when its content is unchanged. */
function fileChangeClass(
  path: string,
  before: ReviewFileContent,
  after: ReviewFileContent,
  testFileSuffixes: readonly string[],
): ChangeClass | null {
  if (canonicalStructuralEquals(before, after)) return null;
  if (isTestFileBySuffixes(path, testFileSuffixes)) return "test";
  if (endsWithAny(path, DOC_SUFFIXES)) return "doc";
  if (before.kind !== "text" || after.kind !== "text" || !endsWithAny(path, COMMENT_LEXED_SUFFIXES)) return "code";
  const stripped = commentStrippedSource(before.text);
  return stripped !== null && stripped === commentStrippedSource(after.text) ? "comment" : "code";
}

const sameContext = (before: ReviewContextFacts, after: ReviewContextFacts): boolean =>
  before.ownerMap.kind === "observed" && before.contractSurface.kind === "observed" &&
  after.ownerMap.kind === "observed" && after.contractSurface.kind === "observed" &&
  canonicalStructuralEquals(before, after);

/** The paths of `files`, sorted. */
const pathsOf = (files: readonly ReviewedFile[]): readonly string[] => files.map(({ path }) => path).sort();

/**
 * What changed from `before` to `after`. A path added or removed is a scope
 * change; a differing or unobservable context is a context change; otherwise
 * each changed file contributes its class.
 */
export function classifyReviewChange(
  before: ReviewChangeSide,
  after: ReviewChangeSide,
  testFileSuffixes: readonly string[],
): ReviewChange {
  const paths = pathsOf(after.files);
  if (!canonicalStructuralEquals(pathsOf(before.files), paths) || new Set(paths).size !== paths.length) {
    return Object.freeze({ kind: "scope-changed" });
  }
  if (!sameContext(before.context, after.context)) return Object.freeze({ kind: "context-changed" });
  const found = new Set<ChangeClass>();
  for (const { path, content } of after.files) {
    const previous = before.files.find((file) => file.path === path);
    const changed = previous === undefined ? "code" : fileChangeClass(path, previous.content, content, testFileSuffixes);
    if (changed !== null) found.add(changed);
  }
  const classes = CHANGE_CLASSES.filter((changeClass) => found.has(changeClass));
  return isNonEmpty(classes)
    ? Object.freeze({ kind: "changed", classes: Object.freeze(classes) })
    : Object.freeze({ kind: "unchanged" });
}

/** The roles each narrowing change class needs (the operator's role table). */
const ROLES_FOR: Readonly<Record<NarrowingChangeClass, readonly WaveReviewRole[]>> = Object.freeze({
  comment: ["comment-analyzer"],
  doc: ["comment-analyzer"],
  test: ["code-reviewer", "pr-test-analyzer"],
});

/**
 * The change classes of `change` that narrow a roster, or null when the
 * change needs the whole roster: unchanged, a scope or context change, or any
 * code.
 */
function narrowingClassesOf(change: ReviewChange): NonEmpty<NarrowingChangeClass> | null {
  if (change.kind !== "changed") return null;
  const narrowing = change.classes.flatMap((changeClass) => (changeClass === "code" ? [] : [changeClass]));
  return narrowing.length === change.classes.length && isNonEmpty(narrowing) ? narrowing : null;
}

/**
 * The roles a re-review of `change` is issued from a derived roster:
 * - `whole`: the change needs the whole roster, or the roles it needs cover it;
 * - `narrowed`: the roles its classes need together with every role of the
 *   derived roster in `priorOwners` (the owners of the prior Findings the run
 *   is issued), in roster order, with the classes that chose them.
 */
export type ReviewRoleSelection =
  | Readonly<{ kind: "whole" }>
  | Readonly<{ kind: "narrowed"; roster: NarrowedWaveReviewRoster; change: NonEmpty<NarrowingChangeClass> }>;

const WHOLE_SELECTION: ReviewRoleSelection = Object.freeze({ kind: "whole" });

/** The operator's role table applied to `change` over `derived`. */
export function selectReviewRoles(
  derived: WaveReviewRoster,
  change: ReviewChange,
  priorOwners: readonly string[],
): ReviewRoleSelection {
  const classes = narrowingClassesOf(change);
  const roster = classes === null
    ? null
    : narrowedWaveReviewRoster(derived, [...classes.flatMap((changeClass) => ROLES_FOR[changeClass]), ...priorOwners]);
  return classes === null || roster === null ? WHOLE_SELECTION : Object.freeze({ kind: "narrowed", roster, change: classes });
}

