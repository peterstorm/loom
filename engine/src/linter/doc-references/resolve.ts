/**
 * Does a doc reference name something the project has? The resolution half of
 * `no-dangling-doc-reference`.
 *
 * A path resolves in named frames, in this order, and nowhere else:
 *   1. the referring file's directory, then each directory above it up to
 *      and including the project root — a comment in
 *      `engine/src/linter/programmatic/` may name `clones/clone-detection.ts`
 *      relative to the linter it sits in;
 *   2. each configured source root (`engine/src`), in the order given — a doc
 *      under `docs/` may name `core/parse-spec.ts`.
 * In each frame a path with no extension may also name a module file, the way
 * an import specifier does: `machine/ledger` resolves to `machine/ledger.ts`.
 * There is no suffix matching: a path such as programs/legacy-panel.ts does
 * not resolve because some file somewhere ends that way — a reference must say
 * where its file is. A path that climbs out of the project resolves to nothing,
 * and an absolute path is refused as such: it names one machine's checkout.
 *
 * A link resolves as GitHub resolves it: against the referring file's
 * directory, or the root for `/…`. An anchor on a Markdown target must be one
 * of its heading slugs or HTML anchors; an anchor on any other file (`#L12`)
 * is GitHub's line link and is not judged.
 *
 * Pure: a reference and an index in, a `Resolved` or a `DanglingReason` out.
 */

import { posix } from "node:path";
import { ADR_DIRECTORY, type DanglingReason, type DocReference, type ReferenceIndex, type Resolved } from "./types";

export type Resolution =
  | Readonly<{ ok: true; value: Resolved }>
  | Readonly<{ ok: false; error: DanglingReason }>;

const resolved = (value: Resolved): Resolution => ({ ok: true, value });
const dangling = (error: DanglingReason): Resolution => ({ ok: false, error });

/** Where a reference is read from, and where its paths may be written relative to. */
export type ReferenceFrame = Readonly<{
  /** The referring file, project-relative. */
  from: string;
  sourceRoots: readonly string[];
}>;

/** A project-relative path, normalized; null when it is absolute or climbs out of the project. */
function withinProject(path: string): string | null {
  const normalized = posix.normalize(path);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "" : normalized;
}

/** A project-relative directory and each directory above it, nearest first, the root (`""`) last. */
function directoryAndAncestors(directory: string): readonly string[] {
  return directory === "." || directory === "" ? [""] : [directory, ...directoryAndAncestors(posix.dirname(directory))];
}

/** The candidate spellings of a path, one per frame, in frame order: in the project, each once. None for an absolute path. */
function candidates(path: string, { from, sourceRoots }: ReferenceFrame): readonly string[] {
  if (path.startsWith("/")) return [];
  const spellings = [...directoryAndAncestors(posix.dirname(from)), ...sourceRoots].flatMap((frame) => {
    const candidate = withinProject(posix.join(frame, path));
    return candidate === null || candidate === "" ? [] : [candidate];
  });
  return [...new Set(spellings)];
}

/** The extensions a module specifier leaves off: `machine/ledger` names `machine/ledger.ts`. */
const MODULE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** A candidate's spellings: itself, then — when it has no extension — the module file it may name. */
const spellingsOf = (candidate: string, directory: boolean): readonly string[] =>
  directory || posix.extname(candidate) !== ""
    ? [candidate]
    : [candidate, ...MODULE_EXTENSIONS.map((extension) => `${candidate}${extension}`)];

/** The first candidate, in frame order, holding the kind of entry the reference asks for. */
function located(tried: readonly string[], directory: boolean, index: ReferenceIndex): string | null {
  return tried.flatMap((candidate) => spellingsOf(candidate, directory)).find((spelling) => {
    const entry = index.entryAt(spelling);
    return directory ? entry === "directory" : entry !== null;
  }) ?? null;
}

const isMarkdown = (path: string): boolean => /\.mdx?$/i.test(path);

/** A located target, with its anchor checked when the target is a Markdown file. */
function anchored(target: string, anchor: string | null, index: ReferenceIndex): Resolution {
  if (anchor === null || !isMarkdown(target) || index.anchorsOf(target).has(anchor)) {
    return resolved({ via: "entry", path: target });
  }
  return dangling({ kind: "no-such-heading", target, anchor });
}

function resolveLink(path: string, anchor: string | null, frame: ReferenceFrame, index: ReferenceIndex): Resolution {
  const spelled = path === ""
    ? frame.from
    : withinProject(path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(frame.from), path));
  if (spelled === null || spelled === "") return dangling({ kind: "no-such-path", tried: [path] });
  const target = spelled.replace(/\/$/, "");
  return index.entryAt(target) === null
    ? dangling({ kind: "no-such-path", tried: [spelled] })
    : anchored(target, anchor, index);
}

/** The words of a token the source does not hold: none when the whole word, or every segment, is held. */
function missingSegments(text: string, segments: readonly string[], index: ReferenceIndex): readonly string[] {
  const word = text.endsWith("()") ? text.slice(0, -2) : text;
  if (index.inSource(word)) return [];
  return segments.filter((segment) => !index.inSource(segment));
}

/** Resolve one reference made from `frame.from`. */
export function resolveReference(reference: DocReference, frame: ReferenceFrame, index: ReferenceIndex): Resolution {
  switch (reference.kind) {
    case "path": {
      if (reference.path.startsWith("/")) return dangling({ kind: "absolute-path", path: reference.path });
      const tried = candidates(reference.path, frame);
      const target = located(tried, reference.directory, index);
      return target === null ? dangling({ kind: "no-such-path", tried }) : anchored(target, reference.anchor, index);
    }
    case "file-name": {
      const tried = candidates(reference.name, frame);
      const target = located(tried, false, index);
      if (target !== null) return resolved({ via: "entry", path: target });
      return index.inSource(reference.name) ? resolved({ via: "source" }) : dangling({ kind: "no-such-path", tried });
    }
    case "link":
      return resolveLink(reference.path, reference.anchor, frame, index);
    case "token": {
      const missing = missingSegments(reference.text, reference.segments, index);
      return missing.length === 0 ? resolved({ via: "source" }) : dangling({ kind: "not-in-source", missing });
    }
    case "spec": {
      if (reference.path.startsWith("/")) return dangling({ kind: "absolute-path", path: reference.path });
      const tried = candidates(reference.path, frame);
      const spec = located(tried, false, index);
      if (spec === null) return dangling({ kind: "spec-missing", tried });
      const ids = index.specOf(spec);
      switch (ids.kind) {
        case "missing":
          return dangling({ kind: "spec-missing", tried });
        case "unreadable":
          return dangling({ kind: "spec-unreadable", spec, detail: ids.detail });
        case "read":
          return resolved({ via: "spec", spec });
        default:
          return assertNever(ids);
      }
    }
    case "spec-id": {
      const spec = located(candidates(reference.spec, frame), false, index);
      const ids = spec === null ? null : index.specOf(spec);
      if (spec === null || ids === null || ids.kind !== "read") return resolved({ via: "spec-unavailable", spec: reference.spec });
      return ids.ids.has(reference.text) ? resolved({ via: "spec", spec }) : dangling({ kind: "id-not-in-spec", spec });
    }
    case "adr":
      return index.adrIds().has(reference.text) ? resolved({ via: "adr" }) : dangling({ kind: "no-such-adr", directory: ADR_DIRECTORY });
    default:
      return assertNever(reference);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable reference: ${JSON.stringify(value)}`);
}
