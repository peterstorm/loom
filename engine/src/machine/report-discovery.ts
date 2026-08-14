/**
 * Report discovery — the imperative shell around test-report.ts.
 *
 * Finds machine-readable report artifacts on disk (explicit Vitest/Jest or
 * Bun JUnit output files, JSON on stdout, conventional JUnit dirs) and hands
 * their contents to the pure parsers. All node:fs usage of the report pipeline
 * lives HERE, keeping test-report.ts (and its reducer consumers) pure.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
export function literalShellWords(command: string): readonly LiteralShellWord[] | null {
  const words: LiteralShellWord[] = [];
  let word = "";
  let wordStarted = false;
  let optionEligible = false;
  let quote: "'" | '"' | null = null;
  const startWord = (literalUnquoted: boolean): void => {
    if (!wordStarted) optionEligible = literalUnquoted;
    wordStarted = true;
  };
  const pushWord = (): void => {
    words.push({ value: word, optionEligible: optionEligible && word.startsWith("--") });
    word = "";
    wordStarted = false;
    optionEligible = false;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      startWord(false);
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        const next = command[i + 1];
        if (next === undefined) return null;
        if ('$`"\\\n'.includes(next)) {
          if (next !== "\n") word += next;
          i++;
        } else {
          word += char;
        }
      } else if (char === "$" || char === "`") {
        return null;
      } else {
        word += char;
      }
      startWord(false);
      continue;
    }
    if (char === "'" || char === '"') {
      startWord(false);
      quote = char;
      continue;
    }
    if (char === "$" || char === "`") return null;
    if (char === "\\") {
      const next = command[i + 1];
      if (next === undefined) return null;
      startWord(false);
      if (next !== "\n") word += next;
      i++;
      continue;
    }
    if (/\s/.test(char)) {
      if (wordStarted) pushWord();
      continue;
    }
    startWord(true);
    word += char;
  }

  if (quote !== null) return null;
  if (wordStarted) pushWord();
  return words;
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
  if (!existsSync(dir)) return [];
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
    } else if (!existsSync(path)) {
      process.stderr.write(`findReport: Bun JUnit report '${path}' does not exist\n`);
    } else if (isFresh(path, nowMs, callStartMs)) {
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
    } else if (existsSync(path) && isFresh(path, nowMs, callStartMs)) {
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
    } else if (!existsSync(path)) {
      // Sibling sources log the missing-artifact class loudly; the explicit
      // --outputFile branch must not be the one silent member of the family
      // (a typo'd or never-written report looks identical to no report).
      process.stderr.write(`findReport: --outputFile report '${path}' does not exist\n`);
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
  if (!JVM_RUNNER_PREFIXES.some((p) => lower.startsWith(p))) return null;

  if (callStartMs === null) {
    noStamp("JUnit report dirs");
    return null;
  }
  const junit = [
    ...JUNIT_REPORT_DIRS.flatMap((d) => readJunitDir(resolve(cwd, d), nowMs, callStartMs)),
    ...moduleDirs(cwd).flatMap((m) =>
      JUNIT_REPORT_DIRS.flatMap((d) => readJunitDir(join(m, d), nowMs, callStartMs)),
    ),
  ];
  return mergeSummaries(junit);
}
