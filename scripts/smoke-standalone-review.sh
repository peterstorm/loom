#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/engine/src/cli.ts"
TMP="$(mktemp -d)"
# Canonicalize: on macOS mktemp -d sits behind the /var → /private/var symlink,
# and the CLI's anchored primitives resolve the base once while the process CWD
# is always canonical — so the fixture must be canonical too.
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q

RUNS=".claude/reviews/review-and-fix-runs"
RUN="$RUNS/run.smoke123"
mkdir -p "$RUN/reviewers"
cat > "$RUN/reviewers/1-code-reviewer.md" <<'OUT'
### Machine Summary
CRITICAL_COUNT: 1
ADVISORY_COUNT: 1
CRITICAL: impossible failure
ADVISORY: improve the name
```findings
[{"severity":"critical","file":"src/x.ts","line":1,"claim":"impossible failure"},{"severity":"advisory","file":"src/x.ts","line":2,"claim":"improve the name"}]
```
OUT
cat > "$RUN/review-plan.json" <<OUT
{"scope":["src/x.ts"],"expected_agents":["code-reviewer"]}
OUT
cat > "$RUN/review-input.json" <<OUT
{"reviews":[{"agent":"code-reviewer","transcript":"$RUN/reviewers/1-code-reviewer.md"}]}
OUT

bun "$CLI" helper standalone-review init --runs-root "$RUNS" --run-dir "$RUN" --input "$RUN/review-plan.json" >/dev/null
bun "$CLI" helper standalone-review aggregate --runs-root "$RUNS" --run-dir "$RUN" --input "$RUN/review-input.json" >/dev/null
bun "$CLI" helper review-panel brief --runs-root "$RUNS" --run-dir "$RUN" --standalone "$RUN/aggregate.json" >/dev/null
bun "$CLI" helper review-panel manifest --runs-root "$RUNS" --run-dir "$RUN" >/dev/null

FINDING_ID="$(jq -r '.findings[0].id' "$RUN/manifest.json")"
index=0
while IFS= read -r lens; do
  index=$((index + 1))
  raw="$(jq -cn --arg lens "$lens" --arg id "$FINDING_ID" '{criterion:$lens,verdicts:[{finding_id:$id,verdict:"refuted",reasoning:("refuted through " + $lens)}]}')"
  printf '%s' "$raw" | bun "$CLI" helper review-panel verdict \
    --lens "$lens" --runs-root "$RUNS" --manifest "$RUN/manifest.json" \
    > "$RUN/verdicts/verdict-$index.json"
done < <(jq -r '.lenses[]' "$RUN/manifest.json")

bun "$CLI" helper review-panel tally --runs-root "$RUNS" --manifest "$RUN/manifest.json" >/dev/null

test ! -e .claude/state/active_task_graph.json
jq -e '.surviving_critical_findings | length == 0' "$RUN/result.json" >/dev/null
jq -e '.refuted_critical_findings | length == 1' "$RUN/result.json" >/dev/null
jq -e '.advisory_findings | length == 1' "$RUN/result.json" >/dev/null

if bun "$CLI" helper review-panel tally --runs-root "$RUNS" --manifest "$RUN/manifest.json" >/dev/null 2>&1; then
  echo "standalone tally replay unexpectedly succeeded" >&2
  exit 1
fi

echo "smoke-standalone-review: PASS"
