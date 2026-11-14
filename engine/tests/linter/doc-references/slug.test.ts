/**
 * Heading anchors must match the ones GitHub renders, or a link that works on
 * GitHub is flagged and one that is broken there passes. The table is
 * GitHub's own output for each heading.
 */

import { describe, expect, it } from "vitest";
import { githubSlug, headingAnchors, htmlAnchors } from "../../../src/linter/doc-references/slug";

describe("githubSlug", () => {
  it.each([
    ["Known residual limits", "known-residual-limits"],
    ["Browser session attack classes (`subagent_type: general`)", "browser-session-attack-classes-subagent_type-general"],
    ["The `no-wire-cast` rule", "the-no-wire-cast-rule"],
    ["**Bold** and *emphasis* and ***both***", "bold-and-emphasis-and-both"],
    ["_emphasis_ keeps snake_case_name", "emphasis-keeps-snake_case_name"],
    ["~~struck~~ text", "struck-text"],
    ["A [link](https://x.dev) in it", "a-link-in-it"],
    ["Inline <code>html</code>", "inline-html"],
    ["What's next? (v2.0)", "whats-next-v20"],
    ["  Spaced  out  ", "spaced--out"],
    ["Ünïcödé — dash", "ünïcödé--dash"],
    ["1. Numbered", "1-numbered"],
  ])("%s → %s", (heading, slug) => {
    expect(githubSlug(heading)).toBe(slug);
  });
});

describe("headingAnchors", () => {
  it("numbers a repeated slug -1, -2 in document order", () => {
    expect(headingAnchors(["Setup", "Usage", "Setup", "Setup"])).toEqual(["setup", "usage", "setup-1", "setup-2"]);
  });

  it("skips a number a literal heading already took", () => {
    expect(headingAnchors(["Setup-1", "Setup", "Setup"])).toEqual(["setup-1", "setup", "setup-2"]);
  });
});

describe("htmlAnchors", () => {
  it("reads id and name anchors verbatim, in either quote", () => {
    expect(htmlAnchors(`<a id="Exact_Case"></a> and <a class="x" name='other'>`)).toEqual(["Exact_Case", "other"]);
  });

  it("reads no anchor from another element or an attribute that merely ends in id", () => {
    expect(htmlAnchors(`<span id="x"></span> <a data-id="y">`)).toEqual([]);
  });
});
