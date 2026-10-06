# ADR-0022: Admit a standalone reviewer only after the engine observed it read the whole frozen diff

## Status

Accepted.

## Context

A registered standalone review on PR #66 reported 0 criticals. The reviewer
transcripts showed why that verdict was weak. Seven reviewers finished in 20–60
seconds after 5–10 tool calls. A re-review over 26 smaller slices (about 220 KB
of diff each) measured what each reviewer was actually shown: between 5 KB and
81 KB of tool output, against slices of 219–230 KB. That is typically 2–15% of
the diff and at most about a third. The engine admitted every result anyway.

Nothing in the engine measured reading. Admission checked only the final
payload's shape and that its findings pointed inside the frozen scope. Several
facts made skimming the easy path:

- The Context Packet held whole frozen files and no diff hunks, so "what changed"
  was not even in the packet.
- The reader paged at most 4,096 units per call. Reading a 230 KB slice took
  about 60 calls.
- Two agent shims still said "review unstaged changes from `git diff`", which
  contradicts the frozen scope.
- Each issued task said only "read the packet and emit the result".

Smaller slices did not help. Reviewers given less diff skimmed less of it.
Prompt wording alone cannot be an obligation, because nothing would enforce it.
The evidence that enforcement needs was already present at capture: on Claude
the subagent JSONL with every tool call and result, on Pi the full
`result.messages`. Only the final payload bytes were kept.

## Decision

Every fresh standalone review registers a read obligation. This is "Reviewer
Protocol v4": the unchanged v2 payload schema and rubric, plus the
`loom-standalone-read-coverage` v1 policy. The engine admits a reviewer's
result only after it has itself observed that the reviewer received every unit
of the scope's frozen diff.

**The obligation is frozen at start.** A new `standalone-frozen-diff` Context
Packet section holds one deterministic unified diff per scoped file (pure Myers
line diff, `core/unified-diff.ts`). Its base side is the blob at the review
baseline (`base_revision ?? head_revision`, the same baseline the added-line
count uses). Its head side is the exact frozen bytes the `standalone-frozen-source`
section froze. Unchanged and binary files oblige nothing. The section is inside
every request's context digest, so the obligation cannot drift.

**Reading uses one mode.** `read-context-packet.ts --diff EXACT_SOURCE_PATH`
prints one page as a JSON record (`loom-frozen-diff-page`) carrying path, diff
digest, offset, `nextOffset` and text. Pages are up to 12,000 UTF-16 units, so for
ordinary source and diff text a JSON-escaped page stays under Claude Code's
30,000-character Bash output limit. The reader bounds units, not encoded size: a
page dense in control characters (each escaped as six-character `\u00XX`) could
exceed that limit.
Every other selection keeps its unchanged 4,096-unit page. Section browsing
shows the diff index (paths, digests, unit counts) but not the diff text.

**The observation is engine-verified, never self-reported.** At capture, each
harness adapter projects the tool results its transcript records as delivered
(Claude `tool_result`, Pi `toolResult`; error results excluded). One
`observeToolOutputs` hook carries them into the shared capture runtime. A line
of tool output counts only if it parses as a reader page AND its text is
byte-for-byte the frozen diff text at that page's range. Prose, an echoed
command, a filtered or truncated page, or a page of another file proves nothing.
The verified ranges are published write-ahead, before the transcript, as
`artifacts/read-coverage/<requestId>.json`. Publication is immutable: the first
observation of an attempt is kept.

**The decision is pure and sits at one admission seam.**
`admitStandaloneReviewerResult` runs payload admission and then coverage
admission, and every resume and checkpoint-independent replay path crosses it.
A result whose verified ranges leave any unit unread is a semantic rejection. It
takes the existing bounded retry, and the attempt-2 task names every unread file
and range. Coverage is per attempt: the retry is a fresh Agent and earlier
attempts' reads are not credited to it, so the diagnostic says the named ranges
only explain the refusal and the whole obligation must be read again. (A live
retry that read only the named ranges was refused terminally before that sentence
existed.) A second failure terminal-blocks the slot exactly as before. Coverage
evidence that is missing for an attempt, or from a harness that supplied no tool
outputs, refuses: coverage that was not observed is not coverage. Unreadable
evidence is infrastructure failure and consumes no attempt. A scope without any
text diff obliges nothing.

**The obligation must be satisfiable.** A scope whose frozen diff exceeds
240,000 units is refused at start, before anything is registered or issued. The
operator must partition it into smaller explicit `--files` runs.

**Non-capturing harnesses.** `submit --tool-outputs PATH` accepts the delivered
tool outputs as a JSON array of strings and runs the same page verification
before the transcript capture effect. It grants no credit that native capture
would not.

**The issued task states the obligation.** Read-coverage requests carry
`LOOM_READ_COVERAGE: every-frozen-diff-unit`, the exact paging procedure, and
the obligated files with unit and page counts taken from the request's own
frozen diff. All seven current reviewer shims carry the same rule and no longer
default to `git diff` for engine-issued requests.

## Why a registration policy, not a new payload descriptor

The v4 payload is byte-identical to v2: same schema, rubric, Finding decoding,
IDs and result bytes. Bumping `ReviewerProtocolDescriptor.version` would have
forced a v4 twin into every decoder that branches on `version === 2`, and each
twin would do nothing different. The policy instead lives in the standalone
registration (`schemaVersion: 2` plus an exact `readCoverage` value), which
start, task rendering and resume admission already receive.

ADR-0009's conservation rule holds. A registration without `readCoverage` is an
issued v2 run and keeps its exact admission. A malformed or misplaced policy
refuses rather than silently disabling coverage. Successor v3 and Wave Gate are
unchanged.

## Consequences

- A standalone verdict now implies its reviewers were shown the whole diff. It
  still does not imply they understood it. A reviewer can page everything and
  judge badly, so findings quality remains a separate concern (model profile and
  rubric, not this ADR).
- Reviews take longer and cost more per reviewer: about one reader call per
  12,000 units of diff. The 240,000-unit budget caps one reviewer's reading at
  roughly 20 pages.
- Large PRs must be partitioned. That was already true in practice (the 16 MiB
  packet bound), and is now refused up front with an actionable message.
- A reviewer that pipes or filters reader output loses credit for that page and
  is retried. The task text says so explicitly.
- Wave Gate reviewers still have no read obligation. Applying this policy to
  Wave packets (which carry `wave-frozen-source`, not a diff) is a separate
  decision.
