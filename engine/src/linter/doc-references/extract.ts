/**
 * The references a governed file makes — the extraction half of
 * `no-dangling-doc-reference`.
 *
 * A reference is something an author marked as naming the project: a code
 * span (backticks), a Markdown link, a plan's `**Spec:**` header and the spec
 * ids it cites, and an `ADR-NNNN` id. Prose is never read as a reference — the
 * rule is a resolver, not a prose classifier — and the shapes a code span may
 * take are fixed, so a fragment of code inside backticks is not one:
 *
 * - a path: it holds a `/`, or it is a bare file name with a known extension
 *   (`ledger.json`), optionally with a `#anchor` or a `:line` suffix;
 * - a word, `[A-Za-z_$][A-Za-z0-9_$.-]*`, optionally called (`name()`); a
 *   dotted word (`a.b.c`) is one reference whose every segment must resolve;
 * - anything else — a space, an operator, a quote — is a fragment, never a
 *   reference.
 *
 * Never a reference, whatever its shape: placeholder grammar (`NNN`, `xxx`,
 * `YYYY`, a `-N`, `<…>`, `{…}`, `[…]`, `*`, `...`), a hex run of 7 or more
 * characters (a commit), a URL or any `scheme:` (`node:fs`), a path rooted
 * outside the project (`/`, `~`, `/**
 * The references a governed file makes — the extraction half of
 * `no-dangling-doc-reference`.
 *
 * A reference is something an author marked as naming the project: a code
 * span (backticks), a Markdown link, a plan's `**Spec:**` header and the spec
 * ids it cites, and an `ADR-NNNN` id. Prose is never read as a reference — the
 * rule is a resolver, not a prose classifier — and the shapes a code span may
 * take are fixed, so a fragment of code inside backticks is not one:
 *
 * - a path: it holds a `/`, or it is a bare file name with a known extension
 *   (`ledger.json`), optionally with a `#anchor` or a `:line` suffix;
 * - a word, `[A-Za-z_$][A-Za-z0-9_$.-]*`, optionally called (`name()`); a
 *   dotted word (`a.b.c`) is one reference whose every segment must resolve;
 * - anything else — a space, an operator, a quote — is a fragment, never a
 *   reference.
 *
 * Never a reference, whatever its shape: placeholder grammar (`NNN`, `xxx`,
 * `YYYY`, a `-N`, `<…>`, `{…}`, `[…]`, `*`, `...`), a hex run of 7 or more
 * characters (a commit), a URL or any `scheme:` (`node:fs`), a path rooted
), a flag (`--x`), a package scope
 * (`@x/y`), a media type (`text/plain`) and a document id (`FR-007`, `T1`, `AD-2`), which names a line of
 * some other document, not the project.
 *
 * Fenced code is never read, so a fence's example is not a reference. An
 * unclosed fence is refused: everything after it would silently go unread.
 *
 * Pure: text in, references out.
 */

import { markdown, scanMarkdown, type ProseLine } from "../markdown";
import { sourceSegments } from "../source-segments";
import type { DocReading, DocReference } from "./types";

/** Why a governed file's references cannot be read. */
export type ExtractError = Readonly<{ kind: "unclosed-fence"; line: number }>;

export type Extraction =
  | Readonly<{ ok: true; value: readonly DocReference[] }>
  | Readonly<{ ok: false; error: ExtractError }>;

// --- Code spans --------------------------------------------------------------

/** One code span of a line: its content, trimmed, and where its backticks start and end. */
type CodeSpan = Readonly<{ content: string; start: number; end: number }>;

/** The length of the run of backticks starting at `index`. */
const backtickRun = (text: string, index: number): number => {
  const end = (at: number): number => (text[at] === "`" ? end(at + 1) : at);
  return end(index) - index;
};

/**
 * The code spans of one line, as CommonMark reads them: a run of N backticks
 * opens a span that the next run of exactly N backticks closes. A run with no
 * partner on the line is literal text. A span split across lines is not read.
 */
export function codeSpans(text: string): readonly CodeSpan[] {
  const spans: CodeSpan[] = [];
  let index = text.indexOf("`");
  while (index !== -1) {
    const width = backtickRun(text, index);
    const close = closingRun(text, index + width, width);
    if (close === -1) {
      index = text.indexOf("`", index + width);
      continue;
    }
    spans.push({ content: text.slice(index + width, close).trim(), start: index, end: close + width });
    index = text.indexOf("`", close + width);
  }
  return spans;
}

/** The start of the next run of exactly `width` backticks at or after `from`, or -1. */
function closingRun(text: string, from: number, width: number): number {
  const next = text.indexOf("`", from);
  if (next === -1) return -1;
  const run = backtickRun(text, next);
  return run === width ? next : closingRun(text, next + run, width);
}

/** The line with every code span blanked to spaces, so a link inside one is not read. */
const withoutSpans = (text: string, spans: readonly CodeSpan[]): string =>
  spans.reduce((blanked, { start, end }) => blanked.slice(0, start) + " ".repeat(end - start) + blanked.slice(end), text);

// --- One code span -------------------------------------------------------------

/** Extensions a bare file name is read by: the files a project's docs name. */
const FILE_EXTENSION =
  /\.(?:md|mdx|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|jsonl|sh|bash|zsh|yml|yaml|toml|txt|java|kt|kts|scala|rs|py|go|html|css|scss|sql|xml|gradle|lock|nix|csv|svg|png)$/i;

/** A `scheme:` prefix: a URL, `node:fs`, `mailto:`. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Placeholder grammar: the span stands for a value, it does not name one. */
const PLACEHOLDER = /[<>{}[\]*|…]|\.\.\.|NNN|XXX|xxx|YYYY|(?:^|[-_.])N(?:$|[-_.])|^n\/a$/i;

/** Rooted outside the project, or not a name at all: an absolute or home path, a variable, a flag, a package scope. */
const NOT_A_PROJECT_NAME = /^[~$@/\\-]/;

/**
 * A media type: one of the registered top-level types, a slash and a subtype.
 * A subtype ending in a file extension is a path under a directory of that
 * name, never a media type.
 */
const MEDIA_TYPE = /^(?:application|audio|font|image|message|model|multipart|text|video)\/[A-Za-z0-9][\w.-]*$/;

/** A commit or digest. */
const HEX_RUN = /^[0-9a-f]{7,64}$/;

/** A line of some other document: `FR-007`, `ADR-0042`, `T1`, `AD-2`, `INV-2`, `G5b`. ADR ids are read by `adrReferences`. */
const DOCUMENT_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z]+)?-?\d+[a-z]?$/;

/** The characters a path may hold. */
const PATH_CHARACTERS = /^[A-Za-z0-9_.@/#-]+$/;

/** A word, as the token grammar reads it. */
const WORD = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;

/** A trailing `:12` or `:12-30` on a path: the line, not part of the name. */
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;

type Located = Readonly<{ line: number; text: string }>;

/** A path-shaped span as a reference, or null when it is not one. */
function pathReference({ line, text }: Located, located: string): DocReference | null {
  if (!PATH_CHARACTERS.test(located)) return null;
  const hash = located.indexOf("#");
  const path = hash === -1 ? located : located.slice(0, hash);
  const anchor = hash === -1 ? null : located.slice(hash + 1);
  if (path === "" || anchor === "" || path.includes("//")) return null;
  if (!path.includes("/") && anchor === null) {
    // A bare name starting with a dot is a suffix (`.test.ts`, `.d.ts`), not a file.
    return path.startsWith(".") ? null : { kind: "file-name", line, text, name: path };
  }
  const directory = path.endsWith("/");
  return { kind: "path", line, text, path: directory ? path.slice(0, -1) : path, directory, anchor };
}

/** A word-shaped span as a reference, or null when it is not one. */
function tokenReference({ line, text }: Located): DocReference | null {
  const word = text.endsWith("()") ? text.slice(0, -2) : text;
  if (!WORD.test(word) || /[.-]$/.test(word)) return null;
  const [first, ...rest] = word.split(".");
  if (first === undefined || first === "" || rest.some((segment) => segment === "")) return null;
  return { kind: "token", line, text, segments: [first, ...rest] };
}

/** One code span as a reference, or null when its content is a fragment, a placeholder or names nothing in the project. */
export function spanReference(located: Located): DocReference | null {
  const { text } = located;
  if (text === "" || /\s/.test(text) || SCHEME.test(text) || PLACEHOLDER.test(text)) return null;
  if (NOT_A_PROJECT_NAME.test(text) || HEX_RUN.test(text) || DOCUMENT_ID.test(text)) return null;
  if (MEDIA_TYPE.test(text) && !FILE_EXTENSION.test(text)) return null;
  const withoutLine = text.replace(LINE_SUFFIX, "");
  const pathShaped = withoutLine.includes("/") || withoutLine.includes("#") || FILE_EXTENSION.test(withoutLine);
  return pathShaped ? pathReference(located, withoutLine) : tokenReference(located);
}

// --- Links, ADR ids, spec ids ------------------------------------------------------

/** An inline link or image target, with an optional title. */
const INLINE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]*)>?(?:\s+["'(][^)]*)?\)/g;

/** A link reference definition: `[label]: target`. */
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;

/** One link target as a reference, or null when it leaves the project (a URL, `mailto:`). */
function linkReference(line: number, target: string): DocReference | null {
  if (target === "" || SCHEME.test(target) || target.startsWith("//")) return null;
  const hash = target.indexOf("#");
  const rawPath = (hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, "");
  const anchor = hash === -1 ? null : target.slice(hash + 1);
  if (anchor === "") return null;
  const path = safeDecode(rawPath);
  return path === null ? null : { kind: "link", line, text: target, path, anchor };
}

const safeDecode = (raw: string): string | null => {
  try {
    return decodeURI(raw);
  } catch {
    return null;
  }
};

function linkReferences(line: number, text: string): readonly DocReference[] {
  const definition = LINK_DEFINITION.exec(text)?.[1];
  const targets = [
    ...[...text.matchAll(INLINE_LINK)].flatMap(([, target]) => (target === undefined ? [] : [target])),
    ...(definition === undefined ? [] : [definition]),
  ];
  return targets.flatMap((target) => {
    const reference = linkReference(line, target);
    return reference === null ? [] : [reference];
  });
}

/** An ADR id standing on its own: not inside a path or file name (`docs/adr/ADR-0042-the-typescript-compiler-api-enters-through-two-pure-seams.md` is the path's to resolve). */
const ADR_ID = /(?<![\w/-])ADR-\d{4}(?![\w-])/g;

const adrReferences = (line: number, text: string): readonly DocReference[] =>
  [...text.matchAll(ADR_ID)].map(([id]) => ({ kind: "adr", line, text: id }));

/** A plan's spec header: `**Spec:** path`, optionally a list item, the path optionally backticked. */
const SPEC_HEADER = /^\s*(?:[-*]\s+)?\*\*Spec:\*\*\s*`?([^`\s]+)`?/;

/** The canonical spec ids (`parse-spec.ts`'s entry grammars), standing on their own. */
const SPEC_ID = /(?<![\w-])(?:FR|AS|OOS)-\d{3}(?![\w-])/g;

// --- Markdown -----------------------------------------------------------------

/** Prose lines with HTML comments blanked: a commented-out template is not read. */
function withoutHtmlComments(prose: readonly ProseLine[]): readonly ProseLine[] {
  let open = false;
  return prose.map(({ line, text }) => {
    let visible = "";
    let rest = text;
    while (rest.length > 0) {
      if (open) {
        const close = rest.indexOf("-->");
        if (close === -1) return { line, text: visible };
        open = false;
        rest = rest.slice(close + 3);
        continue;
      }
      const start = rest.indexOf("<!--");
      if (start === -1) return { line, text: visible + rest };
      visible += rest.slice(0, start);
      open = true;
      rest = rest.slice(start + 4);
    }
    return { line, text: visible };
  });
}

/** Every reference on one prose line of a document: its code spans, its links and its ADR ids. */
function documentLineReferences({ line, text }: ProseLine): readonly DocReference[] {
  const spans = codeSpans(text);
  return [
    ...spans.flatMap(({ content }) => {
      const reference = spanReference({ line, text: content });
      return reference === null ? [] : [reference];
    }),
    ...linkReferences(line, withoutSpans(text, spans)),
    ...adrReferences(line, text),
  ];
}

/** A plan's references: its spec header, the spec ids it cites when it has one, and its ADR ids. */
function planReferences(prose: readonly ProseLine[]): readonly DocReference[] {
  const header = prose.flatMap(({ line, text }) => {
    const path = SPEC_HEADER.exec(text)?.[1];
    return path === undefined ? [] : [{ line, path }];
  })[0];
  const specIds = header === undefined
    ? []
    : prose.flatMap(({ line, text }) =>
      [...text.matchAll(SPEC_ID)].map(([id]): DocReference => ({ kind: "spec-id", line, text: id, spec: header.path })));
  return [
    ...(header === undefined ? [] : [{ kind: "spec", line: header.line, text: header.path, path: header.path } as const]),
    ...specIds,
    ...prose.flatMap(({ line, text }) => adrReferences(line, text)),
  ];
}

// --- Source comments ------------------------------------------------------------

/** The 1-based line of every offset, read in ascending order. */
function lineOfOffsets(content: string): (offset: number) => number {
  let line = 1;
  let scanned = 0;
  return (offset) => {
    for (; scanned < offset; scanned += 1) if (content[scanned] === "\n") line += 1;
    return line;
  };
}

/** The references in a source file's comments: their code spans and their ADR ids. */
function commentReferences(content: string): readonly DocReference[] {
  const lineAt = lineOfOffsets(content);
  return sourceSegments(content)
    .filter(({ kind }) => kind === "comment")
    .flatMap(({ start, end }) => {
      const first = lineAt(start);
      return content.slice(start, end).split("\n").flatMap((text, index) => {
        const line = first + index;
        return [
          ...codeSpans(text).flatMap(({ content: span }) => {
            const reference = spanReference({ line, text: span });
            return reference === null ? [] : [reference];
          }),
          ...adrReferences(line, text),
        ];
      });
    });
}

/**
 * Every reference a governed file makes, read as `reading` says. A Markdown
 * document or plan with an unclosed fence is refused: the references after
 * the fence would go unread.
 */
export function extractDocReferences(text: string, reading: DocReading): Extraction {
  if (reading === "source-comments") return { ok: true, value: commentReferences(text) };
  const scanned = scanMarkdown(markdown("document", text));
  if (!scanned.ok) return { ok: false, error: { kind: "unclosed-fence", line: scanned.error.line } };
  const prose = withoutHtmlComments(scanned.value.prose);
  return {
    ok: true,
    value: reading === "plan" ? planReferences(prose) : prose.flatMap(documentLineReferences),
  };
}
