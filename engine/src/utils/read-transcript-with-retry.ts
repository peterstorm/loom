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

/** The settled read: the exact content the retry policy stopped on, beside its
 *  parsed legacy text — so a consumer that also projects the raw lines reads
 *  the file ONCE and both views describe the same bytes. */
export type SettledTranscript =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "read"; content: string; text: string }>;

/** One read of the transcript file; a failure (oversize, unreadable) throws. */
export type TranscriptFileReader = (path: string) => string;

const unboundedUtf8Read: TranscriptFileReader = (path) => readFileSync(path, "utf-8");

/**
 * Read a transcript with retries, waiting for the marker (or, without one,
 * for the file size to stabilize). `read` performs each attempt: the default
 * is the historical unbounded UTF-8 read; a caller that must bound the bytes
 * it decodes supplies its own reader, whose failure propagates.
 */
export async function readSettledTranscript(
  rawPath: string,
  markerPattern?: RegExp,
  read: TranscriptFileReader = unboundedUtf8Read,
): Promise<SettledTranscript> {
  const path = rawPath.replace(/^~/, process.env.HOME ?? "~");
  if (!path || !existsSync(path)) {
    process.stderr.write(`[loom] read-transcript: path missing or not found: ${rawPath || "<unset>"}\n`);
    return Object.freeze({ kind: "missing" });
  }
  let lastSize = -1;
  let content = "";
  let transcript = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const currentSize = statSync(path).size;
    content = read(path);
    transcript = parseTranscript(content);

    // If we have a marker pattern, check if it's present
    if (markerPattern && markerPattern.test(transcript)) {
      return Object.freeze({ kind: "read", content, text: transcript });
    }

    // If no marker pattern, check file size stability
    if (!markerPattern && currentSize === lastSize && transcript.length > 0) {
      return Object.freeze({ kind: "read", content, text: transcript });
    }

    lastSize = currentSize;

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  if (markerPattern) {
    process.stderr.write(`[loom] read-transcript: marker not found after ${MAX_RETRIES} retries: ${path}\n`);
  }
  return Object.freeze({ kind: "read", content, text: transcript });
}

/**
 * Read transcript with retries, waiting for file size to stabilize.
 * Returns parsed transcript text or empty string.
 */
export async function readTranscriptWithRetry(
  rawPath: string,
  markerPattern?: RegExp,
): Promise<string> {
  const settled = await readSettledTranscript(rawPath, markerPattern);
  return settled.kind === "read" ? settled.text : "";
}
