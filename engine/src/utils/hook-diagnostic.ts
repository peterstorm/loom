/**
 * The one way a hook reports something the operator must see while still
 * letting the tool call proceed.
 *
 * `passthrough` exits 0, and an exit-0 hook's stderr is not surfaced outside
 * `--debug` — so every handler that wrote a diagnostic to stderr and then
 * returned `passthrough` wrote it to nobody. A reviewer whose findings were
 * discarded then looks exactly like a reviewer that found nothing, which is
 * the confusion `evidence_capture_failed` exists to prevent.
 *
 * This writes BOTH channels from one call: stderr, which still carries the
 * line under `--debug` and on harnesses that read a handler's stderr directly,
 * and the `systemMessage` the harness actually surfaces from an exit-0 hook's
 * JSON stdout. Two writes never drift because there is one message.
 */

import { type HookResult, passthroughResult } from "../types";

export function passthroughDiagnostic(diagnostic: string): HookResult {
  process.stderr.write(diagnostic.endsWith("\n") ? diagnostic : `${diagnostic}\n`);
  return passthroughResult(diagnostic.replace(/\n+$/, ""));
}
