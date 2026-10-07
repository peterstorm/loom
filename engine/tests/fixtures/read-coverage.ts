/**
 * Read-coverage fixtures (ADR-0022): the exact stdout lines the Context Packet
 * reader prints when a reviewer pages EVERY unit of its request's frozen diff.
 * Each delivery fixture feeds these lines through its own real seam, never by
 * writing the observation artifact directly: the CLI capture fixture through
 * the engine's `recordReadCoverageObservation`, the native fixtures as
 * transcript tool results, CLI `submit` through `--tool-outputs`.
 */
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { FROZEN_DIFF_PAGE_UNITS, frozenDiffPage } from "../../src/core/standalone-read-coverage";
import { recordReadCoverageObservation, requestFrozenDiff, runReadCoverage } from "../../src/orchestration/standalone-read-coverage-evidence";

/** Every reader page of the request's frozen diff, or [] when the Run has no read obligation. */
export function frozenDiffReaderPages(handle: RunDirHandle, request: AgentRequestAuthority): readonly string[] {
  if (request.program !== "standalone-review") return [];
  const policy = runReadCoverage(handle);
  if (!policy.ok) throw new Error(policy.error);
  if (policy.value === null) return [];
  const diff = requestFrozenDiff(handle, request);
  if (!diff.ok) throw new Error(diff.error);
  const lines: string[] = [];
  for (const file of diff.value.files) {
    if (file.kind !== "text-diff") continue;
    let offset: number | null = 0;
    while (offset !== null) {
      const page = frozenDiffPage(diff.value, file.path, offset, FROZEN_DIFF_PAGE_UNITS);
      if (!page.ok) throw new Error(page.error);
      lines.push(JSON.stringify(page.value));
      offset = page.value.nextOffset;
    }
  }
  return lines;
}

/** The reader command and `read-N` tool-call ids every scripted native transcript uses. */
const READER_COMMAND = "read-context-packet --diff";

/** Pi `toolCall`/`toolResult` message pairs for a scripted reviewer that printed `pages`. */
export function piReadMessages(pages: readonly string[]): readonly Record<string, unknown>[] {
  return pages.flatMap((text, read) => [
    { role: "assistant", content: [{ type: "toolCall", id: `read-${read}`, name: "bash", arguments: { command: READER_COMMAND } }] },
    { role: "toolResult", toolCallId: `read-${read}`, toolName: "bash", isError: false, content: [{ type: "text", text }] },
  ]);
}

/** Claude `tool_use`/`tool_result` JSONL lines for a scripted reviewer that printed `pages`. */
export function claudeReadLines(pages: readonly string[]): readonly string[] {
  return pages.flatMap((text, read) => [
    JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: `read-${read}`, name: "Bash", input: { command: READER_COMMAND } }] } }),
    JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: `read-${read}`, content: text }] } }),
  ]);
}

/**
 * Record what a scripted reviewer read through the engine's own observation
 * recorder: by default every frozen diff page, or the explicit `pages` a test
 * supplies to script a partial (`[...]`) or absent (`null`) read. A no-op for
 * requests without a read obligation; throws when the engine refuses.
 */
export async function recordReviewedReads(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  pages: readonly string[] | null = frozenDiffReaderPages(handle, request),
): Promise<void> {
  const policy = runReadCoverage(handle);
  if (!policy.ok) throw new Error(policy.error);
  if (request.program !== "standalone-review" || policy.value === null) return;
  const recorded = await recordReadCoverageObservation(handle, request, pages);
  if (!recorded.ok) throw new Error(recorded.error);
}

/**
 * `handle.captureTranscript` for a scripted reviewer who read its whole frozen
 * diff: the observation is recorded first, through the engine's own recorder
 * (the same write-ahead order native capture uses), then the transcript. A
 * no-op addition for requests without a read obligation (panels, Wave Gate,
 * pre-coverage runs), so it is a drop-in for every direct capture.
 */
export async function captureReviewedTranscript(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  bytes: readonly number[],
): ReturnType<RunDirHandle["captureTranscript"]> {
  await recordReviewedReads(handle, request);
  return handle.captureTranscript(request, bytes);
}

/**
 * The `submit --tool-outputs PATH` flags a non-capturing harness passes for a
 * reviewer who read every frozen diff page (ADR-0022), or [] when the attempt
 * carries no read obligation. The pages are written beside the run.
 */
export function readCoverageSubmitArgs(runsRoot: string, run: string, request: AgentRequestAuthority): readonly string[] {
  const opened = openRunDirectory(runsRoot, join(runsRoot, run));
  if (!opened.ok) throw new Error(opened.error.message);
  const pages = frozenDiffReaderPages(opened.value, request);
  if (pages.length === 0) return [];
  const path = join(runsRoot, `${run}.tool-outputs.${request.requestId.slice(-16)}.json`);
  writeFileSync(path, JSON.stringify(pages));
  return ["--tool-outputs", path];
}
