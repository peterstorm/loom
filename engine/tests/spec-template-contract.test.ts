import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/core/parse-spec";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("structural specification identifier contract", () => {
  const template = read("references", "spec-template.md");
  const specify = read("commands", "specify.md");

  it("parses the fenced canonical template through parseSpec (executable contract)", () => {
    const fragment = /```markdown\n([\s\S]*?)```/u.exec(template)?.[1];
    expect(fragment).toBeDefined();
    const parsed = parseSpec(fragment!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frs.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["FR-001", "FR-002", "FR-003"]),
    );
    expect(parsed.value.scenarios.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["AS-001", "AS-002", "AS-003"]),
    );
    for (const entry of [...parsed.value.frs, ...parsed.value.scenarios, ...parsed.value.oos]) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    }
    // The template's placeholder glossary row (`| {domain term} | {meaning in
    // this context} |`) is its only glossary entry and mints as a data row —
    // the header and separator rows are furniture — so this smoke assertion
    // pins that parseGlossary still mints it.
    expect(parsed.value.glossary.length).toBeGreaterThan(0);
  });

  it("binds canonical identifier guidance in the template, the one owner of the spec grammar", () => {
    expect(template).toMatch(/unique canonical `AS-NNN:` ID/u);
    expect(template).toMatch(/canonical `OOS-NNN:` ID/u);
  });

  it("the specify skill defers to the template instead of restating the section grammar", () => {
    // A second copy of the grammar is a second thing to keep parseable. The
    // skill names the template and the identifier families, and carries no
    // section-grammar example of its own.
    expect(specify).toContain("references/spec-template.md");
    expect(specify).toMatch(/`FR-NNN:` \/ `AS-NNN:` \/ `OOS-NNN:`/u);
    const fences = [...specify.matchAll(/```markdown\n([\s\S]*?)```/gu)].map((match) => match[1]);
    expect(fences.filter((body) => body.startsWith("## "))).toEqual([]);
  });

  it("keeps bare Given bullets out of both guidance sources", () => {
    for (const source of [template, specify]) {
      expect(source).not.toMatch(/^\s*-\s+Given\b/gmu);
    }
  });
});
