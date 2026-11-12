# `/loom` Phase 4: Decompose Runbook

Read by the `/loom` orchestrator when it reaches Phase 4, before it spawns the decompose agent. `{LOOM_DIR}` and `{date_slug}` mean what `commands/loom.md` Setup defines. Run every command from the repository root (the worktree root for a worktree orchestration): the plan's relative `**Rule file:**` paths resolve against the process cwd.

## Spawn the decompose agent

Fill `{LOOM_DIR}/commands/templates/phase-decompose.md` with `{feature_description}`, and with `{spec_file_path}` and `{plan_file_path}` as absolute paths (the agent copies them into its output). Replace every occurrence, including those inside examples. Spawn `decompose-agent` with the result. Its reply is a single line of pure JSON: the task graph. Keep it verbatim as `$DECOMPOSE_OUTPUT`.

The decompose agent's completion does not advance the phase. `current_phase` stays `decompose` until `populate-task-graph` (4d) installs the Tasks and moves it to `execute` in one write. If the agent returns no usable output, or the user rejects the plan at 4c, re-spawn it. If `/loom --status` reports `execute` with no Tasks, follow the recovery it prints.

## 4a. Validate the output

```bash
echo "$DECOMPOSE_OUTPUT" | bun {LOOM_DIR}/engine/src/cli.ts helper validate-task-graph --decompose-payload -
```

The validator checks the graph's schema and, when the plan declares executable models (`## Lifecycles`, `## Pipeline`, `## Invariants`, `## Contracts`, `**Export bindings:**`), their bindings against the graph. `populate-task-graph` (4d) runs the same checks again and refuses on failure, so they cannot be skipped. A plan with contracts also needs `.loom/verification-manifest.json` to carry a project check that writes a JUnit report before population.

**Routing validation failures: read the error text.**

- Errors about the *task graph* (unknown agent, wave ordering, or an LC machine file "not in any task's file_list") → **re-spawn decompose-agent** with the error details. Decompose can fix these.
- Errors about the *plan or its artifacts* (missing `**Machine file:**` / `**Tier:**` / `**Rule file:**` lines, "Model declaration problem" / near-miss headings, AuthoredDag or rule file missing or malformed, plan_file unreadable) → decompose can never fix these; re-spawning it just loops. **Loop back to Phase 3** with the same mechanics as the plan-alignment loop-back:
  ```bash
  bun {LOOM_DIR}/engine/src/cli.ts helper set-phase --phase architecture --clear-artifact plan-alignment
  rm -f .claude/specs/{date_slug}/plan-alignment.md
  ```
  Re-spawn architecture-agent with the validator errors appended as additional context.

## 4b. Confirm Requirement trace ownership

The output declares `spec_trace_version: 2`, and every Task carries both `spec_contributions` (partial traceability) and `spec_anchors` (Requirement Completion Claims). If the decompose agent left out a likely Requirement, ask the helper for suggestions:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper suggest-spec-anchors "task description" .claude/specs/{date_slug}/spec.md
```

It prints suggested anchors with confidence scores:

<!-- wire-example: none — abbreviated output of `helper suggest-spec-anchors`, which nothing parses back in -->
```json
[{"anchor":"FR-003","score":0.85,"text":"System MUST validate email format"},...]
```

Assign partial work to `spec_contributions`, and each Requirement to `spec_anchors` only on its culminating Task and Wave. The validator refuses overlap, duplicate entries, more than one completion Wave, a Requirement with no completion owner, and a Contribution after completion.

Once Tasks are populated, correct a wrong Completion Claim or Contribution with `helper amend-spec-trace` (`docs/reference/recovery.md`, "Amending a v2 Requirement trace"), never by re-running `populate-task-graph --force`.

## 4c. User approval

Present the plan summary: spec path, plan path, the task breakdown with agents, the wave schedule, and that a GitHub Issue will be created. Ask: "Proceed with this plan?"

## 4d. Create the artifacts

**Verification manifest first.** Completion authority is the operator's and must be in place before Tasks are populated. If the project needs whole-program commands beyond Loom's reserved full-tier lint, build the schema from `docs/workflows.md` in an unguarded temporary file and install it through the validating helper:

<!-- wire-example: verification-manifest -->
```bash
cat > /tmp/loom-verification-manifest.json <<'JSON'
{
  "schemaVersion": 1,
  "kind": "loom-verification-manifest",
  "checks": []
}
JSON
bun {LOOM_DIR}/engine/src/cli.ts helper write-verification-manifest < /tmp/loom-verification-manifest.json
```

- The empty `checks` array configures **no project verification**. It is not a passing test, build or typecheck setup. Replace it with the operator-approved fixed executable and argument arrays. Never copy a model-authored shell string into the manifest.
- Keep an existing operator manifest; do not replace it with this example.
- Direct Bash, Edit and Write access to `.loom/verification-manifest.json` is blocked once the State File is active. The helper is the only way to install it. It needs the empty TaskGraph that `init-state` created.
- An installed manifest that differs only in formatting is accepted unchanged. When the plan needs a different manifest (a schema-2 `affectedRunner` for an owned invariant, say), get the user's approval and re-run the helper with `--replace`; without the flag it refuses and names the flag. Never ask the user to copy a file over the protected path.
- The manifest is immutable once Tasks are populated, `--replace` included ([ADR-0065](../../docs/adr/ADR-0065-manifest-helper-compares-authority-and-replaces-before-population.md)). With no manifest installed, population freezes the engine default, which holds only the reserved checks.

**A. GitHub Issue:**

```bash
gh issue create --title "Plan: {title}" --body "$(cat .claude/plans/{date_slug}.md)"
```

**B. State File:** populate `.claude/state/active_task_graph.json` with the Tasks through the helper:

```bash
echo "$DECOMPOSE_OUTPUT" | bun {LOOM_DIR}/engine/src/cli.ts helper populate-task-graph --issue ISSUE_NUMBER --repo OWNER/REPO
```

It validates again, freezes the verification manifest, installs the Tasks and Waves with `github_issue`, `spec_file`, `plan_file` and `current_wave: 1`, and moves `current_phase` from `decompose` to `execute` in the same write. It refuses any phase other than `decompose` (first population) or `execute` (re-population). Relay the Project Verification Coverage it reports: `configured` with its check ids, or `not-configured` (`engine-default` or `empty-operator-manifest`).

The helper leaves the State File read-only (mode 444). Do not run `chmod` yourself; the state guard blocks it.

## 4e. Context checkpoint

Every planning artifact is now on disk, and execution does not need the planning conversation. Suggest:

> "Planning complete. All artifacts on disk. Run `/clear` to shed planning context before execution, or continue in current context."

If the user runs `/clear`, the SessionStart hook restores the execution context; continue from Phase 5. Otherwise go on to Phase 5 directly.
