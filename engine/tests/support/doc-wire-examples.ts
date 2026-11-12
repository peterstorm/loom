/**
 * Documented wire examples, read out of the prose that teaches them.
 *
 * An agent doc, command, skill or operations doc that shows a wire shape is the
 * contract a model or operator copies. This module finds every such example in
 * the governed docs and hands it to the suite as data, so the suite can put the
 * example ITSELF through the production parser (`doc-wire-shapes.ts`).
 *
 * A doc declares an example with a marker line directly above its fence:
 *
 *   <!-- wire-example: <shape-id> -->          the fence documents that shape
 *   <!-- wire-example: none — <reason> -->     the fence is not a wire example
 *
 * A `json` fence is one example. A shell fence is one example per heredoc whose
 * body is JSON, and the marker sits above the shell fence. Any other fence is an
 * example only when a shape marker says so; its body is then the example text.
 *
 * Everything except `readGovernedDocs` is pure.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_CONTRACT_END, WIRE_CONTRACT_START } from "../../src/core/wire-contract";

export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

// --- Markers ---

/** What a `wire-example` marker line says. `malformed` is a line that claims
 *  the channel and says nothing the suite can act on; it is kept as data so the
 *  completeness check can name it instead of the scan silently skipping it. */
export type WireMarker =
  | Readonly<{ kind: "shape"; shapeId: string }>
  | Readonly<{ kind: "none"; reason: string }>
  | Readonly<{ kind: "malformed"; text: string }>;

const MARKER_LINE = /^<!--\s*wire-example:(.*)-->$/;
const SHAPE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPT_OUT = /^none\s+—\s+(\S.*)$/;

/** The marker a line carries, or null when the line is not a marker. */
export function parseWireMarker(line: string): WireMarker | null {
  const claimed = MARKER_LINE.exec(line.trim())?.[1];
  if (claimed === undefined) return null;
  const text = claimed.trim();
  const reason = OPT_OUT.exec(text)?.[1];
  if (reason !== undefined) return { kind: "none", reason: reason.trim() };
  return SHAPE_ID.test(text) && text !== "none" ? { kind: "shape", shapeId: text } : { kind: "malformed", text };
}

export const renderShapeMarker = (shapeId: string): string => `<!-- wire-example: ${shapeId} -->`;
export const renderOptOutMarker = (reason: string): string => `<!-- wire-example: none — ${reason} -->`;

// --- Fences ---

/** One fenced block of a doc. `line` is the 1-based line of its opening fence;
 *  `marker` is the marker on the nearest non-blank line above it, if any. */
export type DocFence = Readonly<{
  file: string;
  line: number;
  language: string;
  body: string;
  marker: WireMarker | null;
}>;

/** A doc's hand-written fences, and the marker lines that sit above no fence. */
export type DocScan = Readonly<{
  fences: readonly DocFence[];
  danglingMarkerLines: readonly number[];
}>;

const FENCE_OPEN = /^\s*(`{3,})\s*([A-Za-z0-9_+-]*)\s*$/;

/**
 * Scan one doc. A stamped wire-contract region is skipped whole: its fences are
 * rendered from the executable reviewer codec and compared byte for byte by the
 * stamp check, so a marker there would be a second, weaker statement of the same
 * fact.
 */
export function scanDoc(file: string, source: string): DocScan {
  const lines = source.split("\n");
  const fences: DocFence[] = [];
  const danglingMarkerLines: number[] = [];
  let pending: Readonly<{ marker: WireMarker; line: number }> | null = null;
  let stamped = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (stamped) {
      stamped = line.trim() !== WIRE_CONTRACT_END;
      continue;
    }
    if (line.trim() === WIRE_CONTRACT_START) {
      stamped = true;
      continue;
    }
    if (line.trim() === "") continue;

    const opened = FENCE_OPEN.exec(line);
    if (opened !== null) {
      const [, ticks, language] = opened;
      const closing = lines.findIndex((candidate, at) => at > index && candidate.trim() === ticks);
      const end = closing === -1 ? lines.length : closing;
      fences.push({
        file,
        line: index + 1,
        language: language.toLowerCase(),
        body: lines.slice(index + 1, end).join("\n"),
        marker: pending?.marker ?? null,
      });
      pending = null;
      index = end;
      continue;
    }

    if (pending !== null) danglingMarkerLines.push(pending.line);
    const marker = parseWireMarker(line);
    pending = marker === null ? null : { marker, line: index + 1 };
  }
  if (pending !== null) danglingMarkerLines.push(pending.line);
  return { fences, danglingMarkerLines };
}

// --- Examples ---

const JSON_LANGUAGES: readonly string[] = ["json", "jsonc"];
const SHELL_LANGUAGES: readonly string[] = ["bash", "sh", "shell", "zsh", "console"];
const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/;

/** The body of every heredoc a shell block opens, in order. An unterminated
 *  heredoc runs to the end of the block, as it would in a shell. */
export function heredocBodies(shell: string): readonly string[] {
  const lines = shell.split("\n");
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const tag = HEREDOC_OPEN.exec(lines[index])?.[2];
    if (tag === undefined) continue;
    const closing = lines.findIndex((candidate, at) => at > index && candidate.trim() === tag);
    const end = closing === -1 ? lines.length : closing;
    bodies.push(lines.slice(index + 1, end).join("\n"));
    index = end;
  }
  return bodies;
}

const looksLikeJson = (text: string): boolean => /^[{[]/.test(text.trimStart());

/** The JSON a fence shows, whatever a marker says: the body of a `json` fence,
 *  or each JSON heredoc of a shell fence. A fence with any is a wire candidate
 *  and must carry a marker. */
export function jsonTextsOf(fence: DocFence): readonly string[] {
  if (JSON_LANGUAGES.includes(fence.language)) return [fence.body];
  return SHELL_LANGUAGES.includes(fence.language) ? heredocBodies(fence.body).filter(looksLikeJson) : [];
}

/** One documented example bound to the shape its marker names. */
export type DocExample = Readonly<{
  file: string;
  line: number;
  shapeId: string;
  text: string;
}>;

/** The examples a fence contributes: none without a shape marker; the fence's
 *  JSON texts when it shows JSON; otherwise the marked fence's own body. */
export function examplesOf(fence: DocFence): readonly DocExample[] {
  if (fence.marker?.kind !== "shape") return [];
  const { shapeId } = fence.marker;
  const json = jsonTextsOf(fence);
  return (json.length > 0 ? json : [fence.body]).map((text) => ({ file: fence.file, line: fence.line, shapeId, text }));
}

/** Why a doc's markers are incomplete or unusable, one line per defect. `knownShapeIds`
 *  is the registry's id list, so a marker naming no registered shape is a defect here. */
export function markerDefects(scan: DocScan, file: string, knownShapeIds: readonly string[]): readonly string[] {
  const dangling = scan.danglingMarkerLines.map((line) => `${file}:${line} wire-example marker is not directly above a fence`);
  const fenced = scan.fences.flatMap((fence) => {
    const at = `${file}:${fence.line}`;
    if (fence.marker === null) {
      return jsonTextsOf(fence).length > 0 ? [`${at} documents JSON with no wire-example marker above the fence`] : [];
    }
    if (fence.marker.kind === "malformed") {
      return [`${at} wire-example marker is neither a shape id nor "none — <reason>": ${JSON.stringify(fence.marker.text)}`];
    }
    if (fence.marker.kind === "shape" && !knownShapeIds.includes(fence.marker.shapeId)) {
      return [`${at} wire-example marker names an unregistered shape: ${fence.marker.shapeId}`];
    }
    return [];
  });
  return [...dangling, ...fenced];
}

// --- Reading an example as data ---

const JSON_STRING = /"(?:[^"\\]|\\.)*"/;

/** Replace every match of `pattern` that lies outside a JSON string literal.
 *  `pattern` must not be able to match text that starts with a double quote. */
const replaceOutsideStrings = (text: string, pattern: RegExp, replacement: string): string =>
  text.replace(new RegExp(`${JSON_STRING.source}|${pattern.source}`, "g"), (match) =>
    match.startsWith('"') ? match : replacement);

/**
 * Parse a documented JSON example. Docs are prose first, so an example may
 * carry a block comment beside its keys, elide a list as `[ … ]`, or leave a
 * dangling comma; those three are repaired, outside string literals only, and
 * nothing else is.
 */
export function parseDocJson(text: string): unknown {
  const uncommented = replaceOutsideStrings(text, /\/\*[\s\S]*?\*\//, "");
  const unelided = replaceOutsideStrings(uncommented, /\[\s*…\s*\]/, "[]");
  return JSON.parse(replaceOutsideStrings(unelided, /,(?=\s*[}\]])/, ""));
}

const SEQUENCE: unique symbol = Symbol("placeholder sequence");

/** Distinct values for the entries of one placeholder list, for a parser that
 *  refuses a repeated entry. Entry `n` takes value `n`. */
export type PlaceholderSequence = Readonly<{ [SEQUENCE]: readonly unknown[] }>;
export const sequence = (...values: readonly unknown[]): PlaceholderSequence => ({ [SEQUENCE]: values });

const isSequence = (value: unknown): value is PlaceholderSequence =>
  typeof value === "object" && value !== null && SEQUENCE in value;

/** A value the parser accepts for each placeholder-carrying key a doc uses.
 *  Keyed by the FIELD, not by the placeholder's prose, so a doc may reword its
 *  hints freely. */
export type PlaceholderTable = Readonly<Record<string, unknown>>;

/**
 * Resolve a documented example into a concrete document, generically:
 * - `"a | b | c"` is a documented choice, resolved to its first option;
 * - a `<...>` placeholder whose hint allows `null` resolves to `null`;
 * - any other `<...>` placeholder resolves through `placeholders` by the key it
 *   sits under (an array's entries inherit the array's key; a `sequence` gives
 *   each entry its own value). A placeholder key with no entry fails loudly
 *   rather than slipping through unresolved.
 * Literal values the doc commits to (`"agentId": "security-hunter-agent"`,
 * `"wave": 1`) are kept exactly as written — they are part of the contract.
 */
export function resolvePlaceholders(value: unknown, placeholders: PlaceholderTable, key = "$", position = 0): unknown {
  if (Array.isArray(value as unknown)) {
    return (value as readonly unknown[]).map((entry, index) => resolvePlaceholders(entry, placeholders, key, index));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([field, entry]) => [field, resolvePlaceholders(entry, placeholders, field)]),
    );
  }
  if (typeof value !== "string") return value;
  if (!value.includes("<")) return value.includes(" | ") ? value.split(" | ")[0] : value;
  if (/\bnull\b/.test(value)) return null;
  if (!Object.hasOwn(placeholders, key)) {
    throw new Error(`no resolution for the placeholder under ${JSON.stringify(key)}: ${value}`);
  }
  const resolution = placeholders[key];
  if (!isSequence(resolution)) return resolution;
  const entries = resolution[SEQUENCE];
  if (position >= entries.length) {
    throw new Error(`the placeholder sequence under ${JSON.stringify(key)} has no entry ${position}: ${value}`);
  }
  return entries[position];
}

/** The keys a documented object names. An array is read through its first
 *  element, which is how the docs show a list's item shape. */
export const keysOf = (value: unknown): readonly string[] => {
  if (Array.isArray(value as unknown)) return keysOf((value as readonly unknown[])[0]);
  return value !== null && typeof value === "object" ? Object.keys(value) : [];
};

// --- The governed docs ---

/** The directories whose Markdown teaches Loom's wire shapes. */
export const GOVERNED_ROOTS: readonly string[] = ["agents", "commands", "skills", "docs", "references", "lint-rules"];

/** Paths under the governed roots that are not held to the marker rule, and why. */
export const UNGOVERNED: readonly Readonly<{ path: string; reason: string }>[] = [
  { path: "docs/adr/", reason: "decision records: they describe a shape at the time of the decision and are never edited to follow it" },
  { path: "references/reviewer-protocol-v1/", reason: "archived reviewer protocol, byte-frozen" },
  { path: "references/reviewer-wire/wire-contract.md", reason: "rendered whole from the reviewer codec; the stamp check compares its bytes" },
  { path: "skills/security-expert/", reason: "teaches third-party formats (JWT, Keycloak, OWASP), none of them a Loom wire" },
  { path: "skills/nextjs-frontend-design/", reason: "teaches third-party formats (tsconfig), none of them a Loom wire" },
];

/** Whether the marker rule applies to a repo-relative Markdown path. */
export function isGoverned(path: string): boolean {
  return path.endsWith(".md") &&
    GOVERNED_ROOTS.some((root) => path.startsWith(`${root}/`)) &&
    !UNGOVERNED.some((entry) => (entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path));
}

export type GovernedDoc = Readonly<{ file: string; scan: DocScan }>;

/** Read and scan every governed doc of the repository, in path order. */
export function readGovernedDocs(repoRoot: string = REPO_ROOT): readonly GovernedDoc[] {
  return GOVERNED_ROOTS
    .flatMap((root) => readdirSync(join(repoRoot, root), { recursive: true, encoding: "utf8" })
      .map((entry) => `${root}/${entry.split("\\").join("/")}`))
    .filter(isGoverned)
    .sort()
    .map((file) => ({ file, scan: scanDoc(file, readFileSync(join(repoRoot, file), "utf8")) }));
}

/** Every marked example of the governed docs. */
export const governedExamples = (docs: readonly GovernedDoc[]): readonly DocExample[] =>
  docs.flatMap((doc) => doc.scan.fences.flatMap(examplesOf));

/** The one example of `shapeId` a doc carries, parsed as JSON. A doc with none,
 *  or with several, fails here by name. */
export function documentedJson(docs: readonly GovernedDoc[], file: string, shapeId: string): unknown {
  const examples = governedExamples(docs).filter((example) => example.file === file && example.shapeId === shapeId);
  if (examples.length !== 1) throw new Error(`${file} documents ${examples.length} ${shapeId} examples, expected exactly one`);
  return parseDocJson(examples[0].text);
}
