/**
 * no-dangling-doc-reference — every reference a governed document or code
 * comment makes resolves against the project, or is named in the baseline.
 *
 * A doc that names a file, heading, symbol, spec id or ADR the project does
 * not have tells its reader something false, and the commonest way it starts
 * to is an edit to ANOTHER file: a rename, a deleted export, a moved doc. So
 * the rule runs on every edit of a governed file and again over the whole tree
 * at the Wave Gate and in `lint-project`, where the unedited doc is read
 * against the edited code.
 *
 * What is governed is the project's own choice (`docReferences` in its
 * `config.json`); absent, the rule governs nothing. A Markdown file under
 * `govern` is read in full, a source file under it for its comments, and a
 * Markdown file under `plans` for its spec header, spec ids and ADR ids only —
 * a plan names files that do not exist yet.
 *
 * A mention of something deliberately gone is prose, not a reference: write
 * it without backticks, or baseline it with its reason. The rule does not
 * guess which backticked names are history.
 *
 * Pure given its index: the decision is the extractor's and the resolver's;
 * the index is the shell (`doc-references/project-snapshot.ts`).
 */

import { extname } from "node:path";
import { makeViolation, type Violation } from "../types";
import { isUnderEntry } from "../project-scope";
import { extractDocReferences } from "../doc-references/extract";
import { C_FAMILY_EXTENSIONS } from "../doc-references/reference-index";
import { resolveReference } from "../doc-references/resolve";
import type { DanglingReason, DocReading, DocReference, DocReferenceScope, ReferenceIndex } from "../doc-references/types";
import { baselineCounter, baselineKey, projectRelative, type Baseline, type BaselineKey } from "./baseline";

export const RULE_NAME = "no-dangling-doc-reference";

export const FIX_HINT =
  "Name what exists: a path from this file's directory, the project root or a source root; a symbol or string the " +
  "source holds; a heading the target has; an id its spec or docs/adr defines. A mention of something deliberately " +
  "gone is prose — drop the backticks. Pre-existing references: `lint-project --write-baseline`.";

/** The files the rule reads: Markdown documents and plans, and source files for their comments. */
export const DOC_REFERENCE_EXTENSIONS: readonly string[] = Object.freeze([".md", ...C_FAMILY_EXTENSIONS]);

export type DocReferenceOptions = Readonly<{
  /** The governed scope, or null when the project governs nothing. */
  scope: DocReferenceScope | null;
  /** Grandfathered `path::reference` keys, one occurrence each. */
  baseline: Baseline;
  /** The project root the scope and baseline keys are relative to, or null with no project. */
  projectRoot: string | null;
  index: ReferenceIndex;
}>;

/** How a project file is read, or null when the scope does not govern it. */
export function readingOf(path: string, scope: DocReferenceScope | null): DocReading | null {
  if (scope === null) return null;
  const under = (entries: DocReferenceScope["govern" | "plans" | "exclude"]): boolean =>
    entries.some((entry) => isUnderEntry(path, entry.path));
  if (under(scope.exclude)) return null;
  const markdown = extname(path) === ".md";
  if (markdown && under(scope.plans)) return "plan";
  if (!under(scope.govern)) return null;
  return markdown ? "document" : "source-comments";
}

/** One reference that resolves to nothing, or a document whose references cannot be read. */
type Finding = Readonly<{ line: number; key: string; message: string }>;

const list = (paths: readonly string[]): string => paths.map((path) => `\`${path}\``).join(", ");

/** Where a path was looked for: each frame's spelling, or none when it climbs out of the project from every frame. */
const triedIn = (tried: readonly string[]): string =>
  tried.length === 0 ? "it leads out of the project from every frame" : `tried ${list(tried)}`;

/** One sentence: what the reference names, and why nothing answers to it. */
export function describeDangling(reference: DocReference, reason: DanglingReason): string {
  const quoted = `\`${reference.text}\``;
  switch (reason.kind) {
    case "absolute-path":
      return `${quoted} is an absolute path, which names one machine's checkout: name it relative to this file, the project root or a source root`;
    case "no-such-path":
      return reference.kind === "file-name"
        ? `${quoted} names no file in ${list(reason.tried)} and no text the source holds`
        : `${quoted} names nothing in the project (${triedIn(reason.tried)})`;
    case "no-such-heading":
      return `${quoted}: \`${reason.target}\` has no heading or anchor \`#${reason.anchor}\``;
    case "not-in-source":
      return `${quoted}: the source holds no ${list(reason.missing)}`;
    case "spec-missing":
      return `the spec header names ${quoted}, which does not exist (${triedIn(reason.tried)})`;
    case "spec-unreadable":
      return `the spec ${quoted} does not parse, so its ids cannot be checked: ${reason.detail}`;
    case "id-not-in-spec":
      return `${quoted} is not defined in \`${reason.spec}\``;
    case "no-such-adr":
      return `${quoted} names no ADR in \`${reason.directory}/\``;
    default:
      return assertNever(reason);
  }
}

function findings(content: string, path: string, options: DocReferenceOptions): readonly Finding[] {
  const reading = readingOf(path, options.scope);
  if (reading === null || options.scope === null) return [];
  const extraction = extractDocReferences(content, reading);
  if (!extraction.ok) {
    const { line } = extraction.error;
    return [{ line, key: "(unclosed fence)", message: `the code fence opened on line ${line} is never closed, so nothing after it is read` }];
  }
  const frame = { from: path, sourceRoots: options.scope.sourceRoots };
  return extraction.value.flatMap((reference) => {
    const resolution = resolveReference(reference, frame, options.index);
    return resolution.ok
      ? []
      : [{ line: reference.line, key: reference.text, message: describeDangling(reference, resolution.error) }];
  });
}

/** The keys of every reference the rule would flag absent its baseline. */
export function detectedDocReferenceKeys(content: string, filePath: string, options: DocReferenceOptions): readonly BaselineKey[] {
  const path = projectRelative(filePath, options.projectRoot);
  return findings(content, path, options).map(({ key }) => baselineKey(path, key));
}

export function handler(content: string, filePath: string, options: DocReferenceOptions): readonly Violation[] {
  const path = projectRelative(filePath, options.projectRoot);
  const baseline = baselineCounter(options.baseline);
  return findings(content, path, options)
    .filter(({ key }) => !baseline.consume(baselineKey(path, key)))
    .map(({ line, message }) => makeViolation(RULE_NAME, filePath, line, message, FIX_HINT));
}

function assertNever(value: never): never {
  throw new Error(`unreachable dangling reason: ${JSON.stringify(value)}`);
}
