/**
 * Read and parse a transcript file with retries.
 * Works around a race condition where Claude Code fires SubagentStop
 * before the transcript JSONL is fully flushed to disk.
 * Truncated JSON lines are silently skipped by parseJsonl,
 * so the final assistant message (with Machine Summary markers)
 * can be lost if the file is incomplete.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { parseTranscript } from "../parsers/parse-transcript";

const RETRY_DELAY_MS = 300;
const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read transcript with retries, waiting for file size to stabilize.
 * Returns parsed transcript text or empty string.
 */
export async function readTranscriptWithRetry(
  rawPath: string,
  markerPattern?: RegExp,
): Promise<string> {
  const path = rawPath.replace(/^~/, process.env.HOME ?? "~");
  if (!path || !existsSync(path)) return "";

  let lastSize = -1;
  let transcript = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const currentSize = statSync(path).size;
    const content = readFileSync(path, "utf-8");
    transcript = parseTranscript(content);

    // If we have a marker pattern, check if it's present
    if (markerPattern && markerPattern.test(transcript)) {
      return transcript;
    }

    // If no marker pattern, check file size stability
    if (!markerPattern && currentSize === lastSize && transcript.length > 0) {
      return transcript;
    }

    lastSize = currentSize;

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Return whatever we have after retries
  return transcript;
}
