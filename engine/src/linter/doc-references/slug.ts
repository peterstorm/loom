/**
 * Heading anchors as GitHub renders them — the frame a backticked Markdown
 * path's `#anchor` and a Markdown link fragment are resolved in.
 *
 * GitHub slugs a heading's rendered text: inline markup is gone (code-span
 * backticks, emphasis markers, a link's target), the text is lower-cased,
 * every character that is not a letter, mark, number, connector, space or
 * hyphen is dropped, and each space becomes a hyphen. A repeated slug gets
 * `-1`, `-2`, … in document order. An HTML anchor (`<a id="x">`,
 * `<a name="x">`) defines its name verbatim.
 *
 * Pure: text in, slugs out.
 */

/** A heading's text as GitHub renders it: no code-span backticks, no emphasis markers, a link reduced to its text. */
function renderedText(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1(?!\*)/g, "$2")
    // An underscore emphasises only at a word's edge: a snake_case name keeps its underscores.
    .replace(/(^|[^\p{L}\p{N}_])(_{1,3})(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}_])/gu, "$1$3")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
}

/** The slug of one heading, before duplicates are numbered. */
export function githubSlug(heading: string): string {
  return renderedText(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The anchors of a document's headings, in order: a repeated slug numbered `-1`, `-2`, … as GitHub does. */
export function headingAnchors(headings: readonly string[]): readonly string[] {
  const taken = new Set<string>();
  return headings.map((heading) => {
    const base = githubSlug(heading);
    const free = (suffix: number): string => {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      return taken.has(candidate) ? free(suffix + 1) : candidate;
    };
    const slug = free(0);
    taken.add(slug);
    return slug;
  });
}

/** An `<a>` element's `id` or `name` attribute — the whole attribute name, not the end of a data-id. */
const HTML_ANCHOR = /<a\s[^>]*?(?<![\w-])(?:id|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** The names of the HTML anchors in a line of prose. */
export const htmlAnchors = (text: string): readonly string[] =>
  [...text.matchAll(HTML_ANCHOR)].flatMap(([, name]) => (name === undefined ? [] : [name]));
