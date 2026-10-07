/**
 * Pi's JSON event stream (`pi --mode json`) — PURE: what one stdout line means,
 * what a stream as a whole yields, and the text a message carries. The one
 * place that knows Pi's event and message-content shape, shared by the historical corpus core (`corpus-calibration.ts`) and the
 * AD-11 pilot's extraction arm (`grammar-constrained-decoding/pilot-dispatch.ts`).
 *
 * Every `message_end` event's message is kept, in stream order; every other
 * event is ignored. Any malformed line — not JSON, or JSON that is not an event
 * object — refuses the whole stream: a dropped event could be the answer. What
 * a refused stream means is the caller's domain (the corpus core records the
 * case as not executed; the pilot records an infrastructure failure).
 *
 * A streaming caller decodes each line as it arrives (`readPiJsonLine`) and
 * keeps only what it yields, so it never holds Pi's high-volume update events;
 * a caller holding the whole stdout folds it at once (`foldPiJsonStream`).
 */

import { err, ok, type Result } from "./kernel";

/** A message carried by a `message_end` event, as Pi wrote it. */
export type PiMessage = Readonly<Record<string, unknown>>;

/** What one stream line contributes. */
export type PiJsonLine =
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "message"; message: PiMessage }>
  | Readonly<{ kind: "malformed"; detail: string }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const IGNORED: PiJsonLine = Object.freeze({ kind: "ignored" as const });

/** Decode one stream line; `lineNumber` (1-based) names it in a refusal. */
export function readPiJsonLine(line: string, lineNumber: number): PiJsonLine {
  if (!line.trim()) return IGNORED;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch (error) {
    return Object.freeze({ kind: "malformed" as const, detail: `line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!isRecord(event)) return Object.freeze({ kind: "malformed" as const, detail: `line ${lineNumber}: not a JSON event object` });
  return event["type"] === "message_end" && isRecord(event["message"])
    ? Object.freeze({ kind: "message" as const, message: event["message"] })
    : IGNORED;
}

/** The stream's `message_end` messages in order, or the refusal naming every malformed line. */
export function settlePiJsonStream(lines: readonly PiJsonLine[]): Result<readonly PiMessage[], string> {
  const malformed = lines.flatMap((line) => (line.kind === "malformed" ? [line.detail] : []));
  if (malformed.length > 0) return err(`Pi JSON stream contained ${malformed.length} malformed line(s): ${malformed.join("; ")}`);
  return ok(Object.freeze(lines.flatMap((line) => (line.kind === "message" ? [line.message] : []))));
}

/** A whole stdout, decoded and settled. */
export function foldPiJsonStream(stdout: string): Result<readonly PiMessage[], string> {
  return settlePiJsonStream(stdout.split("\n").map((line, index) => readPiJsonLine(line, index + 1)));
}

/** The text of a Pi message's `content`: a plain string, or the concatenated
 *  `text` blocks of a block list; anything else carries no text. */
export function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).filter((block) => block["type"] === "text").map((block) => String(block["text"] ?? "")).join("");
}
