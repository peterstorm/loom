/**
 * Extract task ID from prompt text with flexible pattern matching
 * Port of helpers/extract-task-id.sh
 */

const PATTERNS: Array<{ re: RegExp; extract: (m: RegExpMatchArray) => string }> = [
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

export function extractTaskId(prompt: string): string | null {
  for (const { re, extract } of PATTERNS) {
    const m = prompt.match(re);
    if (m) return extract(m);
  }
  return null;
}

export function isCanonicalFormat(prompt: string): boolean {
  return /\*\*Task ID:\*\* ?T\d+/.test(prompt);
}
