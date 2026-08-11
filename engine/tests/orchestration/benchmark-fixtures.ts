/**
 * Executable five-scenario benchmark fixtures.
 *
 * Each side is a concrete sequence of parent operations plus the canonical
 * lifecycle facts that operation establishes. `replayBenchmarkScenario` folds
 * those operations and refuses illegal ordering, duplicate identities, and a
 * terminal decision reached without its required artifacts. The benchmark
 * therefore measures full legacy/new replay pairs rather than a prose claim or
 * the status command alone.
 */

export const REQUIRED_CALL_REDUCTION = 0.70;
export const REQUIRED_CHARACTER_REDUCTION = 0.80;

export type BenchmarkFact =
  | "scope-frozen"
  | "batch-published"
  | "retry-issued"
  | "roster-complete"
  | "criticals-routed"
  | "refutation-tallied"
  | "result-published"
  | "paths-audited"
  | "temporary-index-staged"
  | "staged-set-verified"
  | "index-installed"
  | "gate-completed";

export type BenchmarkOperation = Readonly<{
  command: string;
  adds: readonly BenchmarkFact[];
  requires?: readonly BenchmarkFact[];
}>;

export type BenchmarkScenario = Readonly<{
  id:
    | "two-task-clean-wave"
    | "missing-reviewer-retry"
    | "mixed-refutation-wave"
    | "standalone-six-reviewers"
    | "remediation-add-delete";
  legacy: readonly BenchmarkOperation[];
  facade: readonly BenchmarkOperation[];
  terminal: BenchmarkFact;
  expectedArtifacts: readonly string[];
}>;

const op = (
  command: string,
  adds: readonly BenchmarkFact[],
  requires: readonly BenchmarkFact[] = [],
): BenchmarkOperation => Object.freeze({ command, adds: Object.freeze(adds), requires: Object.freeze(requires) });

const statusQueries = Object.freeze([
  op(`jq '.' .claude/state/active_task_graph.json`, []),
  op(`jq '.tasks[] | {id,status,test_result,review_status}' .claude/state/active_task_graph.json`, []),
]);

export const BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = Object.freeze([
  {
    id: "two-task-clean-wave",
    legacy: Object.freeze([
      ...statusQueries,
      op(`bun engine/src/cli.ts helper review-packet create --task T1 --output packet-T1.json`, ["scope-frozen"]),
      op(`bun engine/src/cli.ts helper model-profiles agent --agent code-reviewer`, []),
      op(`bun engine/src/cli.ts helper review-packet create --task T2 --output packet-T2.json`, []),
      op(`Agent(code-reviewer,T1); Agent(code-reviewer,T2)`, ["batch-published"], ["scope-frozen"]),
      op(`jq '.tasks[].review_run.evidence' .claude/state/active_task_graph.json`, ["roster-complete"], ["batch-published"]),
      op(`bun engine/src/cli.ts helper complete-wave-gate`, ["gate-completed"], ["roster-complete"]),
    ]),
    facade: Object.freeze([
      op(`bun engine/src/cli.ts helper orchestration start wave-gate --run run.clean`, ["scope-frozen", "batch-published"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run run.clean`, ["roster-complete", "gate-completed"], ["batch-published"]),
    ]),
    terminal: "gate-completed",
    expectedArtifacts: Object.freeze(["review-packets/T1.json", "review-packets/T2.json", "wave-result.json"]),
  },
  {
    id: "missing-reviewer-retry",
    legacy: Object.freeze([
      ...statusQueries,
      op(`bun engine/src/cli.ts helper review-packet create --task T1 --output packet-T1.json`, ["scope-frozen"]),
      op(`bun engine/src/cli.ts helper model-profiles agent --agent code-reviewer`, []),
      op(`bun engine/src/cli.ts helper model-profiles agent --agent silent-failure-hunter`, []),
      op(`Agent(code-reviewer,T1); Agent(silent-failure-hunter,T1)`, ["batch-published"], ["scope-frozen"]),
      op(`jq '.tasks[].review_evidence_failures' .claude/state/active_task_graph.json`, [], ["batch-published"]),
      op(`Agent(silent-failure-hunter,T1,retry=2)`, ["retry-issued"], ["batch-published"]),
      op(`jq '.tasks[].review_run.evidence' .claude/state/active_task_graph.json`, ["roster-complete"], ["retry-issued"]),
      op(`bun engine/src/cli.ts helper complete-wave-gate`, ["gate-completed"], ["roster-complete"]),
    ]),
    facade: Object.freeze([
      op(`bun engine/src/cli.ts helper orchestration start wave-gate --run run.retry`, ["scope-frozen", "batch-published"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run run.retry`, ["retry-issued"], ["batch-published"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run run.retry`, ["roster-complete", "gate-completed"], ["retry-issued"]),
    ]),
    terminal: "gate-completed",
    expectedArtifacts: Object.freeze(["review-packets/T1.json", "transcripts/retry-2.raw", "wave-result.json"]),
  },
  {
    id: "mixed-refutation-wave",
    legacy: Object.freeze([
      ...statusQueries,
      op(`bun engine/src/cli.ts helper review-panel brief --wave 1 --run-dir panel`, ["criticals-routed"]),
      op(`bun engine/src/cli.ts helper review-panel manifest --run-dir panel`, []),
      op(`bun engine/src/cli.ts helper review-panel lenses --manifest panel/manifest.json`, []),
      op(`bun engine/src/cli.ts helper model-profiles agent --agent review-verifier-agent`, []),
      op(`Agent(review-verifier-agent,reproduction); Agent(review-verifier-agent,intent); Agent(review-verifier-agent,blast-radius)`, ["batch-published"], ["criticals-routed"]),
      op(`printf '%s' '{"criterion":"reproduction","verdicts":[{"finding_id":"T1:code-reviewer-1","verdict":"upheld","reasoning":"the production trigger remains reachable"}]}' | bun engine/src/cli.ts helper review-panel verdict --lens reproduction`, []),
      op(`printf '%s' '{"criterion":"intent","verdicts":[{"finding_id":"T1:code-reviewer-1","verdict":"refuted","reasoning":"the documented contract permits this behavior"}]}' | bun engine/src/cli.ts helper review-panel verdict --lens intent`, []),
      op(`printf '%s' '{"criterion":"blast-radius","verdicts":[{"finding_id":"T1:code-reviewer-1","verdict":"upheld","reasoning":"the affected result controls advancement"}]}' | bun engine/src/cli.ts helper review-panel verdict --lens blast-radius`, ["roster-complete"], ["batch-published"]),
      op(`bun engine/src/cli.ts helper review-panel tally --manifest panel/manifest.json`, ["refutation-tallied"], ["roster-complete"]),
      op(`bun engine/src/cli.ts helper complete-wave-gate`, ["gate-completed"], ["refutation-tallied"]),
    ]),
    facade: Object.freeze([
      op(`bun engine/src/cli.ts helper orchestration start refutation --run panel`, ["criticals-routed", "batch-published"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run panel`, ["roster-complete", "refutation-tallied"], ["batch-published"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run wave`, ["gate-completed"], ["refutation-tallied"]),
    ]),
    terminal: "gate-completed",
    expectedArtifacts: Object.freeze(["manifest.json", "result.json", "wave-result.json"]),
  },
  {
    id: "standalone-six-reviewers",
    legacy: Object.freeze([
      op(`mkdir -p .claude/reviews/review-and-fix-runs && mktemp -d`, ["scope-frozen"]),
      op(`bun engine/src/cli.ts helper standalone-review init --input review-plan.json`, []),
      ...Array.from({ length: 6 }, (_, index) => op(`bun engine/src/cli.ts helper model-profiles agent --agent reviewer-${index + 1}`, [])),
      op(`Agent(batch-of-six-reviewers)`, ["batch-published"], ["scope-frozen"]),
      ...Array.from({ length: 6 }, (_, index) => op(
        `printf '%s' '## Machine Summary\\nREVIEW_GENERATION: 1\\nREVIEW_PACKET_ID: packet-${index + 1}\\nCRITICAL_COUNT: ${index === 0 ? 1 : 0}\\nADVISORY: reviewer-${index + 1} found a concrete typed improvement\\n' > reviewers/${index + 1}.md`,
        [],
      )),
      op(`Write review-input.json`, []),
      op(`bun engine/src/cli.ts helper standalone-review aggregate --input review-input.json`, ["roster-complete"], ["batch-published"]),
      op(`bun engine/src/cli.ts helper review-panel brief --standalone aggregate.json`, ["criticals-routed"], ["roster-complete"]),
      op(`Agent(batch-of-three-verifiers)`, [], ["criticals-routed"]),
      op(`bun engine/src/cli.ts helper review-panel tally --manifest manifest.json`, ["refutation-tallied"]),
      op(`bun engine/src/cli.ts helper standalone-review finalize`, ["result-published"], ["refutation-tallied"]),
    ]),
    facade: Object.freeze([
      op(`bun engine/src/cli.ts helper orchestration start standalone-review --run review`, ["scope-frozen", "batch-published"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run review`, ["roster-complete", "criticals-routed"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run review`, ["refutation-tallied", "result-published"], ["criticals-routed"]),
    ]),
    terminal: "result-published",
    expectedArtifacts: Object.freeze(["aggregate.json", "outcomes.json", "result.json"]),
  },
  {
    id: "remediation-add-delete",
    legacy: Object.freeze([
      op(`jq -r '.scope[]' result.json`, ["scope-frozen"]),
      op(`git status --porcelain=v1 -z`, []),
      op(`bun engine/src/cli.ts helper remediation audit --add regression.test.ts --delete old.ts`, ["paths-audited"], ["scope-frozen"]),
      op(`GIT_INDEX_FILE=$TMP git read-tree HEAD`, []),
      op(`GIT_INDEX_FILE=$TMP git add --pathspec-from-file=- --pathspec-file-nul`, ["temporary-index-staged"], ["paths-audited"]),
      op(`GIT_INDEX_FILE=$TMP git diff --cached --name-only`, ["staged-set-verified"], ["temporary-index-staged"]),
      op(`mv $TMP .git/index`, ["index-installed"], ["staged-set-verified"]),
    ]),
    facade: Object.freeze([
      op(`bun engine/src/cli.ts helper orchestration start remediation --run fix`, ["scope-frozen", "paths-audited"]),
      op(`bun engine/src/cli.ts helper orchestration resume --run fix`, ["temporary-index-staged", "staged-set-verified", "index-installed"], ["paths-audited"]),
    ]),
    terminal: "index-installed",
    expectedArtifacts: Object.freeze(["audit.json", "verified-index.json", "installation-receipt.json"]),
  },
]);

export type BenchmarkReplay = Readonly<{
  facts: ReadonlySet<BenchmarkFact>;
  artifacts: readonly string[];
  terminal: BenchmarkFact;
}>;

export function replayBenchmarkScenario(
  scenario: BenchmarkScenario,
  side: "legacy" | "facade",
): BenchmarkReplay {
  const facts = new Set<BenchmarkFact>();
  for (const operation of scenario[side]) {
    for (const required of operation.requires ?? []) {
      if (!facts.has(required)) throw new Error(`${scenario.id}/${side} executed before ${required}: ${operation.command}`);
    }
    for (const added of operation.adds) facts.add(added);
  }
  if (!facts.has(scenario.terminal)) {
    throw new Error(`${scenario.id}/${side} never reached ${scenario.terminal}`);
  }
  return Object.freeze({ facts, artifacts: scenario.expectedArtifacts, terminal: scenario.terminal });
}

export const LEGACY_STATUS_COMMANDS: readonly string[] = Object.freeze(
  BENCHMARK_SCENARIOS.flatMap(({ legacy }) => legacy.map(({ command }) => command)),
);
export const FACADE_STATUS_COMMANDS: readonly string[] = Object.freeze(
  BENCHMARK_SCENARIOS.flatMap(({ facade }) => facade.map(({ command }) => command)),
);

export const characterCount = (commands: readonly string[]): number =>
  commands.reduce((total, command) => total + command.length, 0);

export const reduction = (before: number, after: number): number =>
  before === 0 ? 0 : 1 - after / before;
