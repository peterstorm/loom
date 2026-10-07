/**
 * The one bounded read of a Claude subagent transcript file.
 *
 * Request-bound capture (`capture-orchestration-result`) and spec-check report
 * storage (`store-spec-check-findings`) read the same harness artifact, so they
 * share one bound and one decode policy here: no path component is followed, at
 * most `CLAUDE_TRANSCRIPT_MAX_BYTES` are read, and the bytes are decoded as
 * fatal UTF-8. The next change to either policy therefore cannot make the two
 * capture paths diverge.
 */
import { readRunBytesNoFollow } from "./no-follow-fs";

/** The bound every Claude transcript read observes before decoding (16 MiB). */
export const CLAUDE_TRANSCRIPT_MAX_BYTES = 16_777_216;

/**
 * The transcript's text, read without following any path component and
 * decoded as strict UTF-8. Oversize, unreadable, vanished (ENOENT) and
 * non-UTF-8 transcripts all throw: once a locator selected this path, every
 * read failure is filesystem evidence for the caller to surface.
 */
export function readClaudeTranscriptText(path: string, maximumBytes: number = CLAUDE_TRANSCRIPT_MAX_BYTES): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readRunBytesNoFollow(path, maximumBytes));
}
