/**
 * Lint coverage: which of a project's opt-in rule families are on.
 *
 * Four config keys each turn a rule family on and check nothing while absent
 * (`OPT_IN_CONFIG_KEYS`). Leaving one out used to be silent, so a project could
 * forget a family for good. Coverage makes the decision explicit: every family
 * is configured, or declined with a reason (`declined` in `config.json`), or it
 * is a gap. `lint-project` fails on a gap, and the session-start reminder names
 * gaps — and a project with no lint setup at all — until they are decided.
 *
 * Pure: the shell (`handlers/lint-coverage-shell.ts`) reads the config, the
 * filesystem and the user's list of repositories to leave alone
 * (`core/lint-coverage-ignore.ts`).
 */

import { OPT_IN_CONFIG_KEYS, type OptInConfigKey, type ProgrammaticConfig } from "./programmatic/config";

export type FamilyCoverage =
  | Readonly<{ key: OptInConfigKey; kind: "configured" }>
  | Readonly<{ key: OptInConfigKey; kind: "declined"; reason: string }>
  | Readonly<{ key: OptInConfigKey; kind: "gap" }>;

/** A project with no rules directory runs the shipped rules only; a set-up
 *  project has a coverage answer for every opt-in family. */
export type LintCoverage =
  | Readonly<{ kind: "no-setup" }>
  | Readonly<{ kind: "set-up"; families: readonly FamilyCoverage[] }>;

/** What each family checks, in the words a gap line and a reminder use. */
export const FAMILY_PURPOSE: Readonly<Record<OptInConfigKey, string>> = Object.freeze({
  boundaries: "import boundaries between layers (no-cross-boundary-imports)",
  pureModules: "a functional core held free of I/O (no-io-in-pure-modules)",
  requireGovernance: "every file under a root belonging to some boundary",
  docReferences: "doc and comment references that resolve (no-dangling-doc-reference)",
});

/** Whether the config turns each family on. An empty list checks nothing, so
 *  it is no more "on" than an absent one. */
const IS_ON: Readonly<Record<OptInConfigKey, (config: ProgrammaticConfig) => boolean>> = Object.freeze({
  boundaries: (config) => (config.boundaries?.length ?? 0) > 0,
  pureModules: (config) => (config.pureModules?.length ?? 0) > 0,
  requireGovernance: (config) => config.requireGovernance !== undefined,
  docReferences: (config) => config.docReferences !== undefined,
});

function familyCoverage(config: ProgrammaticConfig, key: OptInConfigKey): FamilyCoverage {
  if (IS_ON[key](config)) return Object.freeze({ key, kind: "configured" });
  const declined = config.declined?.find((entry) => entry.key === key);
  return declined === undefined
    ? Object.freeze({ key, kind: "gap" })
    : Object.freeze({ key, kind: "declined", reason: declined.reason });
}

/** The coverage of a project's config; null when it has no rules directory. */
export function lintCoverage(config: ProgrammaticConfig | null): LintCoverage {
  if (config === null) return Object.freeze({ kind: "no-setup" });
  return Object.freeze({ kind: "set-up", families: Object.freeze(OPT_IN_CONFIG_KEYS.map((key) => familyCoverage(config, key))) });
}

/** The families a set-up project has neither configured nor declined. */
export const coverageGaps = (coverage: LintCoverage): readonly OptInConfigKey[] =>
  coverage.kind === "no-setup" ? [] : coverage.families.flatMap((family) => family.kind === "gap" ? [family.key] : []);

/** The `lint-project` line for one gap: what is off, and both ways to decide it. */
export const coverageGapLine = (key: OptInConfigKey): string =>
  `coverage: '${key}' is off, so ${FAMILY_PURPOSE[key]} checks nothing — configure it ` +
  `(lint-project --init infers what it can) or add { "key": "${key}", "reason": "…" } to 'declined'`;

// --- The session reminder ---

/** The commands a reminder offers, spelled for the running Loom installation. */
export type CoverageCommands = Readonly<{ init: string; ignore: string }>;

/** A reminder has two audiences: the model, which can act on it, and the user. */
export type CoverageReminder = Readonly<{ forModel: string; forOperator: string }>;

const familyList = (keys: readonly OptInConfigKey[]): string => keys.map((key) => `\`${key}\``).join(", ");

/**
 * The session-start reminder for a project whose coverage is incomplete, or
 * null when every family is configured or declined. It tells the model what is
 * off, the one command that turns on what can be inferred, how a family is
 * left off on purpose, and how the user silences it for a repository they do
 * not want Loom in.
 */
export function coverageReminder(projectRoot: string, coverage: LintCoverage, commands: CoverageCommands): CoverageReminder | null {
  const gaps = coverageGaps(coverage);
  if (coverage.kind === "set-up" && gaps.length === 0) return null;
  const state = coverage.kind === "no-setup"
    ? "has no Loom lint setup: only the shipped rules run, and import boundaries, the pure core, governance and doc references check nothing"
    : `has rule families that are off with no reason recorded: ${familyList(gaps)}`;
  const forModel = [
    "<!-- LOOM LINT COVERAGE -->",
    `Loom's linter is not fully on in this project: \`${projectRoot}\` ${state}.`,
    ...(coverage.kind === "set-up" ? gaps.map((key) => `- \`${key}\`: ${FAMILY_PURPOSE[key]}`) : []),
    "At a natural point in this session, tell the user and offer to turn everything on:",
    `- \`${commands.init}\` infers boundaries, the pure core, governance and doc references from the project's layout, fills only what is missing, and baselines the debt the baselined rules already flag. Whatever it cannot infer stays listed for a decision; run lint-project afterwards and fix or decline what it still reports.`,
    "- A family the project should not have is declined in the rules directory's `config.json`: `\"declined\": [{ \"key\": \"<key>\", \"reason\": \"<why>\" }]`.",
    `- For a repository the user does not want Loom in (one they do not own), \`${commands.ignore}\` silences this reminder there; nothing is written to the repository.`,
    "<!-- END LOOM LINT COVERAGE -->",
  ].join("\n");
  const forOperator = coverage.kind === "no-setup"
    ? `Loom lint: ${projectRoot} has no lint setup — ask Claude to turn it on, or silence this for the repository.`
    : `Loom lint: ${gaps.length} rule famil${gaps.length === 1 ? "y is" : "ies are"} off in ${projectRoot} (${gaps.join(", ")}).`;
  return Object.freeze({ forModel, forOperator });
}
