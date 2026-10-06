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
  const policy = runReadCoverage(handle);
  if (!policy.ok) throw new Error(policy.error);
  if (request.program === "standalone-review" && policy.value !== null) {
    const recorded = await recordReadCoverageObservation(handle, request, frozenDiffReaderPages(handle, request));
    if (!recorded.ok) throw new Error(recorded.error);
  }
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
