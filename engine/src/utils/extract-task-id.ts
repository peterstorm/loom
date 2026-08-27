/**
 * Extract a canonical Task ID from legacy prompt phrasings.
 */

import { parseTaskId, type TaskId } from "../core/task-id";

const PATTERNS: Array<{ re: RegExp; extract: (m: RegExpMatchArray) => string | undefined }> = [
  // 1. **Task ID:** T1
  { re: /\*\*Task ID:\*\* ?(T\d+)/, extract: (m) => m[1] },
  // 2. Task ID: T1
  { re: /Task ID:? ?(T\d+)/i, extract: (m) => m[1] },
  // 3. Task: T1
  { re: /Task:? ?(T\d+)/i, extract: (m) => m[1] },
  // 4. T1: or T1 - at start
  { re: /^(T\d+)[: -]/, extract: (m) => m[1] },
  // 5. verb + T1
  { re: /(?:implement|fix|complete|execute|run|start|do|work on|working on) (T\d+)/i, extract: (m) => m[1] },
  // 6. T1 followed by description
  { re: /(T\d+) [A-Z]/, extract: (m) => m[1] },
  // 7. Standalone T1 (last resort)
  { re: /\b(T\d+)\b/, extract: (m) => m[1] },
];

export function extractTaskId(prompt: string): TaskId | null {
  for (const { re, extract } of PATTERNS) {
    const match = prompt.match(re);
    if (match === null) continue;
    const parsed = parseTaskId(extract(match), "extractedTaskId");
    if (parsed.ok) return parsed.value;
  }
  return null;
}

export function isCanonicalFormat(prompt: string): boolean {
  const match = prompt.match(/\*\*Task ID:\*\* ?(T\d+)/);
  return match !== null && parseTaskId(match[1], "canonicalTaskId").ok;
}
