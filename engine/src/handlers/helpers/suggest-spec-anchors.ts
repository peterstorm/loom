/**
 * Suggest spec anchors for a task description.
 * Fuzzy-matches task keywords to FR-xxx, SC-xxx, US-x entries in spec.
 *
 * Usage: bun cli.ts helper suggest-spec-anchors "task description" [spec_file]
 * Output: JSON array of {anchor, score, text}
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler } from "../../types";

interface Suggestion {
  anchor: string;
  score: number;
  text: string;
}

const STOPWORDS = new Set("the a an to for in on with and or of is it this that be as at by".split(" "));

function extractKeywords(description: string): string[] {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .filter((v, i, a) => a.indexOf(v) === i); // unique
}

function score(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  const matches = keywords.filter((kw) => new RegExp(`\\b${kw}\\b`).test(lower)).length;
  return Number((matches / keywords.length).toFixed(2));
}

function findLatestSpec(): string | null {
  const specsDir = ".claude/specs";
  if (!existsSync(specsDir)) return null;

  try {
    const entries = readdirSync(specsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtime: statSync(join(specsDir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const dir of entries) {
      const specPath = join(specsDir, dir.name, "spec.md");
      if (existsSync(specPath)) return specPath;
    }
  } catch {}
  return null;
}

const handler: HookHandler = async (_stdin, args) => {
  const description = args[0];
  if (!description) {
    return { kind: "error", message: 'Usage: suggest-spec-anchors "task description" [spec_file]' };
  }

  const specFile = args[1] ?? findLatestSpec();
  if (!specFile || !existsSync(specFile)) {
    process.stdout.write("[]");
    return { kind: "passthrough" };
  }

  const content = readFileSync(specFile, "utf-8");
  const keywords = extractKeywords(description);
  if (keywords.length === 0) {
    process.stdout.write("[]");
    return { kind: "passthrough" };
  }

  const results: Suggestion[] = [];

  // FR entries
  for (const match of content.matchAll(/^\s*-\s*(FR-\d+)\s*:?\s*(.*)/gm)) {
    const s = score(match[2], keywords);
    if (s > 0) results.push({ anchor: match[1], score: s, text: match[2].trim() });
  }

  // SC entries
  for (const match of content.matchAll(/^\s*-\s*(SC-\d+)\s*:?\s*(.*)/gm)) {
    const s = score(match[2], keywords);
    if (s > 0) results.push({ anchor: match[1], score: s, text: match[2].trim() });
  }

  // US acceptance scenarios
  let currentUS = "";
  let usCounter = 0;
  for (const line of content.split("\n")) {
    const usMatch = line.match(/^###\s*(US\d+)/);
    if (usMatch) { currentUS = usMatch[1]; continue; }
    if (/^###/.test(line) && /\[P[123]\]/.test(line)) { currentUS = `US${++usCounter}`; continue; }

    if (currentUS && /given.*when.*then/i.test(line)) {
      const text = line.replace(/^\s*-\s*/, "").trim();
      const s = score(text, keywords);
      if (s > 0) results.push({ anchor: `${currentUS}.acceptance`, score: s, text });
    }
  }

  // Top 5 by score
  results.sort((a, b) => b.score - a.score);
  process.stdout.write(JSON.stringify(results.slice(0, 5), null, 2));

  return { kind: "passthrough" };
};

export default handler;
