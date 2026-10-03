/**
 * Report discovery — the imperative shell around test-report.ts.
 *
 * Finds machine-readable report artifacts on disk (explicit Vitest/Jest or
 * Bun JUnit output files, JSON on stdout, conventional JUnit dirs) and hands
 * their contents to the pure parsers. All node:fs usage of the report pipeline
 * lives HERE, keeping test-report.ts (and its reducer consumers) pure.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { TestReportSummary } from "./types";
import { mergeSummaries, parseJunitXml, parseVitestJson } from "./test-report";

/** Extract an explicit report path from the command itself (vitest/jest --outputFile). */
export function outputFileFromCommand(command: string): string | null {
  const m = command.match(/--outputFile[=\s]+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * Split the already-classified simple command into literal shell words.
 * Dynamic expansions are deliberately rejected: report discovery cannot know
 * their runtime value, and guessing a trust-bearing artifact path would fail
 * open. Quoting and backslash escapes are normalized only far enough to
 * support Bun's explicit reporter options.
 */
type LiteralShellWord = Readonly<{
  value: string;
  /** The leading `-` was literal and unquoted, so this may be a CLI option. */
  optionEligible: boolean;
}>;

/**
 * Literal words of a command: quote-collapsed, backslash-escapes resolved,
 * `\`-line-continuation dropped — with NO parameter/command/process expansion
 * and NO globbing. Returns null when the command carries a construct that is
 * NOT statically literal: `$…`, backticks, an unterminated quote, or a
 * trailing backslash. A caller can therefore only ever use a positive,
 * fully-literal parse to NAME a report path; anything dynamic is refused.
 *
 * EXPORTED for direct branch coverage (the `outputFileFromCommand` alias
 * would otherwise fold every refusal into a single null). The refusal
 * branches are contract: a command that names its report through a variable
 * or substitution must never mint an artifact path for trust.
 */
type LiteralWordState = {
  words: LiteralShellWord[];
  word: string;
  wordStarted: boolean;
  optionEligible: boolean;
  quote: "'" | '"' | null;
};

const startWord = (state: LiteralWordState, literalUnquoted: boolean): void => {
  if (!state.wordStarted) state.optionEligible = literalUnquoted;
  state.wordStarted = true;
};

const pushWord = (state: LiteralWordState): void => {
  state.words.push({ value: state.word, optionEligible: state.optionEligible && state.word.startsWith("--") });
  state.word = "";
  state.wordStarted = false;
  state.optionEligible = false;
};

/** Consume one character inside a double-quoted section. Returns the next
 *  index, or -1 to refuse (a `$`/backtick inside double quotes, or a trailing
 *  backslash). */
function consumeDoubleQuotedChar(state: LiteralWordState, command: string, index: number): number {
  const char = command[index]!;
  if (char === '"') {
    state.quote = null;
  } else if (char === "\\") {
    const next = command[index + 1];
    if (next === undefined) return -1;
    if ('$`"\\\n'.includes(next)) {
      if (next !== "\n") state.word += next;
      return index + 2;
    }
    state.word += char;
    return index + 1;
  } else if (char === "$" || char === "`") {
    return -1;
  } else {
    state.word += char;
  }
  startWord(state, false);
  return index + 1;
}

/** Consume one character outside any quote. Returns the next index, or -1 to
 *  refuse (a dynamic expansion, or a trailing backslash). */
function consumeUnquotedChar(state: LiteralWordState, command: string, index: number): number {
  const char = command[index]!;
  if (char === "'" || char === '"') {
    startWord(state, false);
    state.quote = char;
    return index + 1;
  }
  if (char === "$" || char === "`") return -1;
  if (char === "\\") {
    const next = command[index + 1];
    if (next === undefined) return -1;
    startWord(state, false);
    if (next !== "\n") state.word += next;
    return index + 2;
  }
  if (/\s/.test(char)) {
    if (state.wordStarted) pushWord(state);
    return index + 1;
  }
  startWord(state, true);
  state.word += char;
  return index + 1;
}

export function literalShellWords(command: string): readonly LiteralShellWord[] | null {
  const state: LiteralWordState = { words: [], word: "", wordStarted: false, optionEligible: false, quote: null };
  for (let i = 0; i < command.length;) {
    if (state.quote === "'") {
      const char = command[i]!;
      if (char === "'") state.quote = null;
      else state.word += char;
      startWord(state, false);
      i += 1;
      continue;
    }
    const next = state.quote === '"'
      ? consumeDoubleQuotedChar(state, command, i)
      : consumeUnquotedChar(state, command, i);
    if (next === -1) return null;
    i = next;
  }
  if (state.quote !== null) return null;
  if (state.wordStarted) pushWord(state);
  return state.words;
}

function optionValues(words: readonly LiteralShellWord[], option: string): readonly string[] {
  const values: string[] = [];
  for (let i = 2; i < words.length; i++) {
    const word = words[i];
    if (word.value === "--") break;
    if (!word.optionEligible) continue;
    if (word.value === option) {
      const value = words[i + 1];
      if (value !== undefined && !(value.optionEligible && value.value.startsWith("--"))) {
        values.push(value.value);
        i++;
      }
    } else if (word.value.startsWith(`${option}=`)) {
      values.push(word.value.slice(option.length + 1));
    }
  }
  return values;
}

/**
 * Parse the only Bun artifact shape Loom trusts: an exact `bun test`
 * invocation with an explicit JUnit reporter and one explicit output path.
 * Requiring both options prevents an unrelated file from vouching for a Bun
 * run whose output format is unknown.
 */
export function bunJunitOutputFileFromCommand(command: string): string | null {
  const words = literalShellWords(command);
  if (words === null || words[0]?.value !== "bun" || words[1]?.value !== "test") return null;

  const reporters = optionValues(words, "--reporter");
  const outfiles = optionValues(words, "--reporter-outfile");
  if (!reporters.includes("junit") || outfiles.length !== 1 || outfiles[0] === "") return null;
  return outfiles[0];
}

const JUNIT_REPORT_DIRS = [
  "target/surefire-reports",
  "target/failsafe-reports",
  "build/test-results/test",
];

/** Loom's pinned completion-suite artifact location: the engine's `test:unit`
 *  writes its Vitest JUnit report here (relative to the checkout root). This
 *  directory is scanned for JS-runner segments ONLY — family scoping keeps a
 *  JVM build's surefire artifact unable to vouch for an npm/vitest command. */
const LOOM_COMPLETION_REPORT_DIR = [".loom", "completion-reports"] as const;

/**
 * Upper freshness bound: reports older than this are ignored regardless of
 * ordering. The ORDERING check below (mtime at/after the call start) is
 * what scopes an artifact to the current tool call; this window remains as
 * a belt-and-braces cap on clock-skewed or replayed stamps.
 */
const FRESHNESS_MS = 15 * 60 * 1000;

/**
 * Slack subtracted from the call-start stamp when comparing against an
 * artifact's mtime — filesystem mtimes can be coarser than the stamp clock
 * (1s granularity on some filesystems), and the stamp is taken a moment
 * after the shell actually forks.
 */
export const CALL_START_SLACK_MS = 2000;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function explicitReportExists(path: string, label: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(`findReport: ${label} '${path}' does not exist\n`);
    } else {
      process.stderr.write(`findReport: cannot inspect ${label} '${path}': ${errMessage(error)}\n`);
    }
    return false;
  }
}

/**
 * Ordered freshness: the artifact must postdate the START of the current
 * tool call (within CALL_START_SLACK_MS) AND fall inside the recency
 * window. Ordering is the load-bearing half — a window alone BOUNDS but
 * does not ORDER, so a stale sibling artifact minutes old could be
 * re-vouched by a later command that ran no tests.
 */
function isFresh(path: string, nowMs: number, callStartMs: number): boolean {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (mtimeMs < callStartMs - CALL_START_SLACK_MS) {
      process.stderr.write(
        `findReport: stale report '${path}' — artifact predates this tool call\n`,
      );
      return false;
    }
    if (nowMs - mtimeMs > FRESHNESS_MS) {
      process.stderr.write(
        `findReport: stale report '${path}' — artifact exceeds the freshness window\n`,
      );
      return false;
    }
    return true;
  } catch (e) {
    // Unstatable report → treated as stale (fail closed), but say so: a
    // silently-ignored artifact looks identical to "no report was written".
    process.stderr.write(`findReport: cannot stat report '${path}': ${errMessage(e)}\n`);
    return false;
  }
}

function readJunitDir(dir: string, nowMs: number, callStartMs: number): TestReportSummary[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".xml"))
      .map((f) => join(dir, f))
      .filter((p) => isFresh(p, nowMs, callStartMs))
      .map((p) => {
        const parsed = parseJunitXml(readFileSync(p, "utf-8"));
        if (parsed === null) {
          // A malformed report is indistinguishable from no report unless it
          // is named — the trust verdict stays untrusted either way, but the
          // operator gets the lead this file's doctrine promises.
          process.stderr.write(`findReport: malformed JUnit report '${p}' (ignored for trust)\n`);
        }
        return parsed;
      })
      .filter((s): s is TestReportSummary => s !== null);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    // Unreadable report dir → no reports (fail closed), logged so a
    // permissions/race problem is distinguishable from an empty dir.
    process.stderr.write(`findReport: cannot read JUnit dir '${dir}': ${errMessage(e)}\n`);
    return [];
  }
}

/** Walk one level of subdirectories for multi-module builds (bounded, no recursion). */
function moduleDirs(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => join(cwd, d.name));
  } catch (e) {
    // Unlistable cwd → no module dirs (fail closed), logged loudly.
    process.stderr.write(`findReport: cannot list module dirs under '${cwd}': ${errMessage(e)}\n`);
    return [];
  }
}

/** Runners whose reports are JUnit XML in conventional build dirs. */
const JVM_RUNNER_PREFIXES = ["mvn", "mvnw", "./mvnw", "gradle", "./gradlew"];

/**
 * Find a machine-readable report artifact for a classified test command
 * SEGMENT (the head-matched simple command from classifyTestCommand — never
 * the whole prose command line). Sources, scoped to the runner family so an
 * artifact can't vouch for an unrelated command:
 * 1. Explicit Bun `--reporter=junit --reporter-outfile=<path>` JUnit XML
 * 2. Explicit `--outputFile` path on the segment (vitest/jest JSON) —
 *    explicit paths are rejected when `vetoExplicitPath` says the agent wrote
 *    them earlier this epoch (an agent-authored artifact must not mint a pass)
 * 3. JSON on stdout when the segment asked for a JSON reporter
 * 4. Fresh JUnit XML in conventional dirs — JVM runners only
 *
 * `times` is a named-args object on purpose: `nowMs` and `callStartMs` are
 * two same-typed epoch-ms values whose positional swap would silently
 * invert the freshness check — the field names make the call sites
 * compiler-checked.
 *
 * `times.callStartMs` is the PreToolUse call-start stamp for THIS tool call.
 * Artifact-backed sources (1, 2, and 4) require it: an on-disk artifact may
 * vouch only when its mtime is at/after the call start, so a command that
 * ran no tests cannot re-vouch a stale sibling artifact still inside the
 * recency window. When null (no stamp: missing tool_use_id, stamp hook not
 * wired, stamp pruned) the artifact sources are REJECTED loudly — fail
 * closed, matching the trust-minting doctrine. Source 3 (stdout JSON) is
 * inherently call-scoped (the command printed it during THIS call) and
 * stays allowed without a stamp.
 */
export function findReport(
  segment: string,
  cwd: string,
  stdout: string,
  times: { readonly nowMs: number; readonly callStartMs: number | null },
  vetoExplicitPath: (absolutePath: string) => boolean = () => false,
): TestReportSummary | null {
  const { nowMs, callStartMs } = times;
  const noStamp = (source: string): void => {
    process.stderr.write(
      `findReport: no call-start stamp for this tool call — ${source} cannot vouch (disk artifacts require proof they postdate the call; failing closed)\n`,
    );
  };

  const bunJunit = bunJunitOutputFileFromCommand(segment);
  if (bunJunit) {
    const path = isAbsolute(bunJunit) ? bunJunit : resolve(cwd, bunJunit);
    if (vetoExplicitPath(path)) {
      process.stderr.write(
        `findReport: rejecting --reporter-outfile '${path}' — the path was written by the agent this epoch; an agent-authored artifact cannot vouch as a report\n`,
      );
    } else if (callStartMs === null) {
      noStamp(`--reporter-outfile '${path}'`);
    } else if (explicitReportExists(path, "Bun JUnit report") && isFresh(path, nowMs, callStartMs)) {
      try {
        const parsed = parseJunitXml(readFileSync(path, "utf-8"));
        if (parsed) return parsed;
        process.stderr.write(`findReport: malformed Bun JUnit report '${path}'\n`);
      } catch (e) {
        process.stderr.write(
          `findReport: cannot read Bun JUnit report '${path}': ${errMessage(e)}\n`,
        );
      }
    }
  }

  const explicit = outputFileFromCommand(segment);
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (vetoExplicitPath(path)) {
      // Loud rejection: silently ignoring the artifact would look identical
      // to "no report was written". The run keeps report: null (untrusted).
      process.stderr.write(
        `findReport: rejecting --outputFile '${path}' — the path was written by the agent this epoch; an agent-authored artifact cannot vouch as a report\n`,
      );
    } else if (callStartMs === null) {
      noStamp(`--outputFile '${path}'`);
    } else if (explicitReportExists(path, "--outputFile report") && isFresh(path, nowMs, callStartMs)) {
      try {
        const parsed = parseVitestJson(readFileSync(path, "utf-8"));
        if (parsed) return parsed;
        process.stderr.write(`findReport: malformed --outputFile report '${path}'\n`);
      } catch (e) {
        // Unreadable explicit report (permissions, race, path is a dir):
        // fall through to the next report source — the TestRun fact must
        // survive with report: null instead of crashing the recorder.
        process.stderr.write(`findReport: cannot read --outputFile '${path}': ${errMessage(e)}\n`);
      }
    }
  }

  if (/--reporter[= ]json|--json\b/.test(segment)) {
    const parsed = parseVitestJson(stdout.trim());
    if (parsed) return parsed;
    process.stderr.write(
      "findReport: --reporter=json requested but stdout carried no parseable summary\n",
    );
  }

  const lower = segment.toLowerCase();
  const isJvmRunner = JVM_RUNNER_PREFIXES.some((p) => lower.startsWith(p));
  // JS test runners (npm/npx/pnpm/yarn script invocations, vitest, jest, bun
  // test) write their report through the runner's own configuration — Loom's
  // pinned completion-suite location among them — so they reach the SAME
  // freshness-gated dir scan, but scoped to the Loom directory only: a fresh
  // surefire artifact must not vouch for an npm command (family scoping), and
  // a runner that wrote no report still finds nothing because every candidate
  // must postdate the call start.
  const isJsTestRunner = /(^|[\s;&])(npm|npx|pnpm|yarn)([\s]|$)/.test(lower) ||
    /\b(vitest|jest)\b/.test(lower) || /\bbun\s+test\b/.test(lower);
  if (!isJvmRunner && !isJsTestRunner) return null;

  if (callStartMs === null) {
    noStamp("JUnit report dirs");
    return null;
  }
  if (!isJvmRunner) {
    return mergeSummaries(
      readJunitDir(resolve(cwd, ...LOOM_COMPLETION_REPORT_DIR), nowMs, callStartMs),
    );
  }
  const junit = [
    ...JUNIT_REPORT_DIRS.flatMap((d) => readJunitDir(resolve(cwd, d), nowMs, callStartMs)),
    ...moduleDirs(cwd).flatMap((m) =>
      JUNIT_REPORT_DIRS.flatMap((d) => readJunitDir(join(m, d), nowMs, callStartMs)),
    ),
  ];
  return mergeSummaries(junit);
}
