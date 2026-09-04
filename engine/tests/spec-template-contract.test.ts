import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/parsers/parse-spec";

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
    expect(parsed.value.oos.map(({ id }) => id)).toEqual(["OOS-001", "OOS-002", "OOS-003", "OOS-004"]);
    expect(parsed.value.glossary.length).toBeGreaterThan(0);
    for (const entry of [...parsed.value.frs, ...parsed.value.scenarios, ...parsed.value.oos]) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("binds canonical identifier guidance in both the template and the specify skill", () => {
    for (const source of [template, specify]) {
      expect(source).toMatch(/unique canonical `AS-NNN:` ID/u);
      expect(source).toMatch(/canonical `OOS-NNN:` ID/u);
    }
  });

  it("executes the specify skill's section-grammar examples through parseSpec", () => {
    const fences = [...specify.matchAll(/```markdown\n([\s\S]*?)```/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    const grammar = fences.filter((body) => body.startsWith("## "));
    expect(grammar.length).toBe(5);
    const parsed = parseSpec(grammar.join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.scenarios.map(({ id }) => id)).toEqual(["AS-001", "AS-002", "AS-003"]);
    expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002", "FR-003", "FR-004"]);
    expect(parsed.value.oos.map(({ id }) => id)).toEqual(["OOS-001", "OOS-002", "OOS-003", "OOS-004"]);
    expect(parsed.value.glossary.length).toBeGreaterThan(0);
  });

  it("keeps bare Given bullets out of both guidance sources", () => {
    for (const source of [template, specify]) {
      expect(source).not.toMatch(/^\s*-\s+Given\b/gmu);
    }
  });
});
