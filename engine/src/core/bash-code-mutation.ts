/**
 * Pure recognizer for Bash commands that mutate implementation-code files.
 *
 * Functional core: string in, path out. The rules gate uses it so a Bash
 * redirect cannot slip past a gate that only watches Edit/Write.
 *
 * Known limit (documented, not silent): recognition is a path heuristic over
 * redirects, tee, cp, mv, sed -i, patch, rsync and install. Exotic mutations
 * (an interpreter opening the file for write, `git apply`) are not recognized.
 */

import { extname } from "node:path";

/** Extensions treated as implementation code by the rules gate. */
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".java", ".rs", ".kt", ".scala", ".py", ".go", ".rb", ".php",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".cs", ".swift",
  ".sh", ".zsh", ".bash", ".vue", ".svelte",
]);

const MUTATOR_COMMANDS: ReadonlySet<string> = new Set(["cp", "mv", "patch", "rsync", "install", "tee"]);
/** Mutators whose destination is the LAST code-path argument. */
const DESTINATION_LAST: ReadonlySet<string> = new Set(["cp", "mv", "rsync", "install", "sed"]);
const CHAIN_BOUNDARY = /&&|\|\||;|\n/;
const TOKEN = /"[^"]*"|'[^']*'|[^\s]+/g;
const REDIRECT_TARGET = /(?:^|\s)(?:\d*)>>?\s*("[^"]+"|'[^']+'|[^\s|;&>]+)/g;

const normalizeToken = (raw: string): string =>
  raw.replace(/^["'`]+|["'`,]+$/g, "").replace(/[)]*$/g, "");

const isCodePath = (token: string): boolean =>
  CODE_EXTENSIONS.has(extname(normalizeToken(token)).toLowerCase());

const tokensOf = (segment: string): readonly string[] =>
  [...segment.matchAll(TOKEN)].map((match) => normalizeToken(match[0])).filter(Boolean);

const commandName = (token: string): string => {
  const normalized = normalizeToken(token);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

const redirectionTarget = (segment: string): string | null => {
  for (const match of segment.matchAll(REDIRECT_TARGET)) {
    const target = normalizeToken(match[1] ?? "");
    if (isCodePath(target)) return target;
  }
  return null;
};

const mutatorTarget = (segment: string): string | null => {
  const tokens = tokensOf(segment);
  const mutatorIndex = tokens.findIndex((token, index) => {
    const name = commandName(token);
    if (MUTATOR_COMMANDS.has(name)) return true;
    return name === "sed" && tokens.slice(index + 1).some((candidate) => /^-[^-]*i/.test(candidate));
  });
  if (mutatorIndex < 0) return null;

  const codeArguments = tokens.slice(mutatorIndex + 1).filter(isCodePath);
  if (codeArguments.length === 0) return null;

  const mutator = commandName(tokens[mutatorIndex] ?? "");
  return DESTINATION_LAST.has(mutator) ? (codeArguments.at(-1) ?? null) : (codeArguments[0] ?? null);
};

/**
 * First code path targeted by a recognized Bash mutation, or null.
 *
 * Mutation evidence is chain-local: a mutator in one `&&`/`||`/`;` command
 * cannot borrow a `.ts` argument from a later read-only command. Pipes stay
 * within one segment so `cat patch.diff | patch src/file.ts` is still caught.
 */
export function firstBashCodeMutationTarget(command: string): string | null {
  for (const segment of command.split(CHAIN_BOUNDARY)) {
    const redirected = redirectionTarget(segment);
    if (redirected !== null) return redirected;
    const mutated = mutatorTarget(segment);
    if (mutated !== null) return mutated;
  }
  return null;
}
