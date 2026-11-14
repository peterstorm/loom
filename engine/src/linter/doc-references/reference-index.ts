/**
 * The reference index — what a doc reference is resolved against, read from a
 * `ProjectSnapshot` and remembered.
 *
 * - **Entries:** whatever is at a path, straight from the snapshot.
 * - **Anchors:** a Markdown file's heading slugs (`slug.ts`) and HTML anchors.
 * - **The source text:** the words of the project's source, so a backticked
 *   symbol, string constant or wire field resolves by one check. The corpus
 *   is the non-comment text of every script, JVM, JSON, shell, YAML and TOML
 *   file outside tests and fixtures — minus comments, so a doc cannot be kept
 *   alive by another comment that names the same deleted thing — plus the names test
 *   code DECLARES (`export const TYPESCRIPT_COMPILER_API_SEAMS`), so a doc may
 *   describe a test helper, while a name a test merely uses (a refused
 *   voteReason key in an assertion) keeps nothing alive; plus every path
 *   segment and file stem of the project, so `distill` names the skill
 *   directory and `lint-project` the script.
 * - **Specs:** a spec file's FR / AS / OOS ids, through the engine's one spec
 *   parser (`core/parse-spec.ts`); a spec it refuses is unreadable, with the
 *   parser's first reason.
 * - **ADR ids:** the `ADR-NNNN` every file in `docs/adr/` is named for, in
 *   either numbering: a name that opens with ADR and the number, or adr-tools'
 *   bare four-digit number.
 *
 * A word is held when it occurs in the corpus bounded by anything that is not
 * a word character: `ledger.json` is held by `"coverage-ledger.json"`, and
 * a name such as voteReason is not held by voteReasons. Deliberately lenient: a word
 * that occurs anywhere resolves, even when it is not the symbol a doc means.
 *
 * Pure given its snapshot: every member is computed on first use and kept.
 */

import { extname, posix } from "node:path";
import { DEFAULT_TEST_FILE_SUFFIXES, isTestFileBySuffixes } from "../../core/test-file-classification";
import { parseSpec, specParseErrorMessage } from "../../core/parse-spec";
import { headingsOf, markdown, scanMarkdown } from "../markdown";
import { sourceSegments } from "../source-segments";
import { headingAnchors, htmlAnchors } from "./slug";
import { ADR_DIRECTORY, type ProjectSnapshot, type ReferenceIndex, type SpecIds } from "./types";

/** Source the C-family segmenter reads: its comments are dropped from the corpus, and are what a governed source file is read for. */
export const C_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".java", ".kt", ".scala",
]);

/** Text whose comments are whole lines opening with `#`: scripts, CI workflows, manifests. A JSON file has no comments. */
const HASH_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set([".sh", ".yml", ".yaml", ".toml"]);

/** A test or fixture tree: nothing in it keeps a doc reference alive. */
const TEST_OR_FIXTURE_DIRECTORY = /(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures?|__fixtures__|testdata)\//;

/** A dependency lockfile names the registry's packages, not the project's code. */
const LOCKFILES: ReadonlySet<string> = new Set(["package-lock.json", "npm-shrinkwrap.json"]);

/** How a project file feeds the source corpus. */
export type CorpusRole =
  /** Source: every word of its non-comment text. */
  | "source"
  /** Test code: only the names it declares. */
  | "test-declarations"
  /** Nothing: not source, test data, or a lockfile. */
  | "none";

/** How a project file feeds the source corpus. */
export function corpusRoleOf(path: string): CorpusRole {
  const extension = extname(path);
  const cFamily = C_FAMILY_EXTENSIONS.has(extension);
  if (!cFamily && extension !== ".json" && !HASH_COMMENT_EXTENSIONS.has(extension)) return "none";
  if (LOCKFILES.has(posix.basename(path))) return "none";
  const test = TEST_OR_FIXTURE_DIRECTORY.test(path) || isTestFileBySuffixes(path, DEFAULT_TEST_FILE_SUFFIXES);
  if (!test) return "source";
  return cFamily ? "test-declarations" : "none";
}

/**
 * A declaration's name, on a line that begins with the declaration:
 * `export const X`, `function X`, `public record X`, `data class X`, …
 *
 * Anchored to the line start so a comment cannot declare anything — a line
 * comment starts with its slashes, a block comment's lines with their stars, and
 * prose that merely says "the type of" is mid-line — without segmenting the
 * file: test code is the largest text the index reads.
 */
const DECLARATION =
  /^[ \t]*(?:(?:export|default|declare|async|abstract|public|private|protected|internal|static|final|sealed|open|data|override)[ \t]+)*(?:function\*?|class|interface|type|enum|const|let|var|val|fun|record|object)[ \t]+([A-Za-z_$][\w$]*)/gm;

/** The names a test file declares at the start of a line. */
export const declaredNames = (content: string): readonly string[] =>
  [...content.matchAll(DECLARATION)].flatMap(([, name]) => (name === undefined ? [] : [name]));

/** A source file's text without its comments; a JSON file has none. */
export function codeText(path: string, content: string): string {
  const extension = extname(path);
  if (HASH_COMMENT_EXTENSIONS.has(extension)) {
    return content.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  }
  if (!C_FAMILY_EXTENSIONS.has(extension)) return content;
  return sourceSegments(content)
    .filter(({ kind }) => kind !== "comment")
    .map(({ start, end }) => content.slice(start, end))
    .join(" ");
}

/** A run of word characters, dots and hyphens: one place a word can occur. */
const RUN = /[A-Za-z0-9_$][A-Za-z0-9_$.-]*/g;

/** How many dot- or hyphen-separated segments one remembered word may span. */
const MAX_SEGMENTS = 8;

const isSeparator = (character: string | undefined): boolean => character === "." || character === "-";

/**
 * Add every word a text holds to `words`: each run of word characters, dots
 * and hyphens, and each stretch of it that starts and ends at a `.` or `-`
 * boundary, up to `MAX_SEGMENTS` segments.
 *
 * A loop that fills one set, not a chain of arrays: the corpus is every source
 * file of the project, built on the edit hook's clock (ADR-0074 has the numbers).
 */
function collectWords(text: string, words: Set<string>): void {
  for (const [match] of text.matchAll(RUN)) {
    let end = match.length;
    while (end > 0 && isSeparator(match[end - 1])) end -= 1;
    const run = match.slice(0, end);
    const separators: number[] = [];
    for (let at = 0; at < run.length; at += 1) if (isSeparator(run[at])) separators.push(at);
    if (separators.length === 0) {
      words.add(run);
      continue;
    }
    // Segment i runs from starts[i] to ends[i]; a word is starts[i]..ends[j] with j - i < MAX_SEGMENTS.
    const starts = [0, ...separators.map((at) => at + 1)];
    const ends = [...separators, run.length];
    for (let first = 0; first < starts.length; first += 1) {
      const last = Math.min(ends.length, first + MAX_SEGMENTS);
      for (let through = first; through < last; through += 1) {
        const word = run.slice(starts[first], ends[through]);
        if (word !== "") words.add(word);
      }
    }
  }
}

/** Every word a text holds (`collectWords`). */
export function wordsOf(text: string): ReadonlySet<string> {
  const words = new Set<string>();
  collectWords(text, words);
  return words;
}

/** The words a project path names: each segment, and each file's stem. */
const pathWords = (path: string): readonly string[] => {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return [...segments, stem];
};

/**
 * An ADR file's number: after an ADR prefix in either case, or adr-tools' bare
 * four digits and a hyphen. Bare digits followed by a two-digit month and a
 * hyphen are a dated note's year, not an ADR number.
 */
const ADR_FILE = new RegExp(`^${ADR_DIRECTORY}/(?:ADR-(\\d{4})[-.]|(\\d{4})-(?!\\d{2}-))`, "i");

/** The `ADR-NNNN` id a path in the ADR directory is named for, or null. */
function adrIdOf(path: string): string | null {
  const found = ADR_FILE.exec(path);
  const number = found?.[1] ?? found?.[2];
  return number === undefined ? null : `ADR-${number}`;
}

/** Remember a function's answer per argument. */
function remembered<T>(compute: (key: string) => T): (key: string) => T {
  const known = new Map<string, Readonly<{ value: T }>>();
  return (key) => {
    const hit = known.get(key);
    if (hit !== undefined) return hit.value;
    const value = compute(key);
    known.set(key, { value });
    return value;
  };
}

/** Compute once, on first use. */
function once<T>(compute: () => T): () => T {
  let value: { readonly current: T } | undefined;
  return () => (value ??= { current: compute() }).current;
}

/** The index of one project snapshot. */
export function referenceIndex(snapshot: ProjectSnapshot): ReferenceIndex {
  const words = once((): ReadonlySet<string> => {
    const corpus = new Set<string>();
    for (const path of snapshot.files()) {
      for (const word of pathWords(path)) corpus.add(word);
      const role = corpusRoleOf(path);
      const content = role === "none" ? null : snapshot.read(path);
      if (content === null) continue;
      if (role === "source") collectWords(codeText(path, content), corpus);
      else for (const name of declaredNames(content)) corpus.add(name);
    }
    return corpus;
  });

  const anchorsOf = remembered((path): ReadonlySet<string> => {
    const content = snapshot.read(path);
    if (content === null) return new Set();
    const scanned = scanMarkdown(markdown(path, content));
    if (!scanned.ok) return new Set();
    const { prose } = scanned.value;
    return new Set([
      ...headingAnchors(headingsOf(prose).map(({ text }) => text)),
      ...prose.flatMap(({ text }) => htmlAnchors(text)),
    ]);
  });

  const specOf = remembered((path): SpecIds => {
    const content = snapshot.entryAt(path) === "file" ? snapshot.read(path) : null;
    if (content === null) return { kind: "missing" };
    const parsed = parseSpec(content);
    if (!parsed.ok) return { kind: "unreadable", detail: specParseErrorMessage(parsed.errors[0]) };
    const { frs, scenarios, oos } = parsed.value;
    return { kind: "read", ids: new Set<string>([...frs, ...scenarios, ...oos].map(({ id }) => id)) };
  });

  const adrIds = once((): ReadonlySet<string> =>
    new Set(snapshot.files().flatMap((path) => {
      const id = adrIdOf(path);
      return id === null ? [] : [id];
    })));

  return Object.freeze({
    entryAt: remembered(snapshot.entryAt),
    anchorsOf,
    inSource: (word: string) => words().has(word),
    specOf,
    adrIds,
  });
}

/** The index of no project: nothing exists, the source holds nothing. */
export const EMPTY_REFERENCE_INDEX: ReferenceIndex = referenceIndex({
  files: () => [],
  entryAt: () => null,
  read: () => null,
});
