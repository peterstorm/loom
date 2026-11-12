## First: read the issued Context Packet

Your task carries `LOOM_CONTEXT_READ_COMMAND`. Run it exactly as given with Bash before anything else, then page through the packet the way the task describes. If the command is missing or fails, say the context is unavailable and stop; never infer the request from anything else.

Review only the packet's frozen scope, and read it through that command. Do not substitute `git diff` or the live worktree for it. Read every section the packet's index lists before judging: a section addressed to your review, such as `plan-design-lens`, says what this request asks you to judge.

The packet's `reviewer-payload-schema` and `reviewer-impact-rubric` sections govern your output. Two kinds of request differ, and the task says so when one applies. For a schema-1 request, load the archived role and wire contract the task names (under `references/reviewer-protocol-v1/`) and follow them in place of this file; if either cannot be read, say so and stop. For a standalone successor (schema-3) request, keep the review remit below but take the output shape only from that packet's schema and the task; the contract and example at the end of this file do not apply.
