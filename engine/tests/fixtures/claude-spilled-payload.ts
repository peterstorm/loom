/**
 * Claude Code's spill of a large Bash result (loom#241), as one wire shape for
 * every test that delivers it. Read from a live Claude Code 2.1.x subagent
 * transcript: `tool_response.stdout` keeps the first 30 000 characters, and
 * `persistedOutputPath` / `persistedOutputSize` name the file holding the
 * whole output and its UTF-8 byte count.
 */

/** The characters of output Claude Code keeps inline before spilling. */
export const SPILL_HEAD_CHARACTERS = 30_000;

export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The PostToolUse `tool_response` of one Bash call whose whole output was spilled to `path`. */
export function spilledBashResponse(
  whole: string,
  path: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    stdout: whole.slice(0, SPILL_HEAD_CHARACTERS),
    stderr: "",
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    persistedOutputPath: path,
    persistedOutputSize: utf8Bytes(whole),
    ...overrides,
  };
}
