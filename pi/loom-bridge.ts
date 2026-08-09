/**
 * Legacy compatibility entry point.
 *
 * The native package adapter is pi/extension.ts. The old bridge translated a
 * subset of Pi subagent results into Claude Code hook payloads, which could
 * silently omit review/spec evidence. Keeping partial dispatch is less safe
 * than refusing it, so this module is now an explicit fail-closed diagnostic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MESSAGE =
  "[loom-bridge] unsupported legacy adapter: load the Loom package's pi/extension.ts; " +
  "no subagent result will be dispatched through the partial bridge.";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    process.stderr.write(MESSAGE + "\n");
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent") return;
    process.stderr.write(MESSAGE + "\n");
    return {
      content: [{ type: "text" as const, text: MESSAGE }],
      isError: true,
    };
  });
}
