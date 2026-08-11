#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOM_DIR="$(dirname "$SCRIPT_DIR")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v pi >/dev/null || { echo "FATAL: pi not found" >&2; exit 1; }

{ sleep 3; printf '%s\n' '{"type":"get_commands"}'; } \
  | PI_CODING_AGENT_DIR="$TMP/agent" PI_OFFLINE=1 timeout 20 \
      pi --approve --mode rpc --no-session --no-context-files -e "$LOOM_DIR/pi/extension.ts" \
      > "$TMP/commands.jsonl" 2> "$TMP/commands.stderr"

# Pi attaches its RPC stdin consumer after extension/resource initialization;
# delay the request so a cold cache cannot race and drop the first JSONL record.
{ sleep 3; printf '%s\n' '{"id":"root","type":"bash","command":"printf %s \"$LOOM_PLUGIN_ROOT\""}'; sleep 2; } \
  | PI_CODING_AGENT_DIR="$TMP/agent" PI_OFFLINE=1 timeout 20 \
      pi --approve --mode rpc --no-session --no-context-files -e "$LOOM_DIR/pi/extension.ts" \
      > "$TMP/root.jsonl" 2> "$TMP/root.stderr"

cat "$TMP/commands.jsonl" "$TMP/root.jsonl" > "$TMP/rpc.jsonl"

node - "$TMP/rpc.jsonl" "$LOOM_DIR" <<'NODE'
const fs = require("node:fs");
const [file, loomDir] = process.argv.slice(2);
const messages = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
const commandResponse = messages.find((entry) => entry.type === "response" && entry.command === "get_commands");
if (!commandResponse?.success) throw new Error("get_commands response absent");
const commands = commandResponse.data.commands;
for (const name of ["loom", "review-and-fix", "wave-gate", "skill:code-implementer", "skill:review-and-fix"]) {
  const command = commands.find((entry) => entry.name === name);
  const path = command?.sourceInfo?.path;
  if (!path) throw new Error(`missing rendered command ${name}`);
  if (!path.includes("/cache/loom-resources/")) throw new Error(`${name} loaded outside rendered cache: ${path}`);
  const content = fs.readFileSync(path, "utf-8");
  if (/\$\{?CLAUDE_PLUGIN_ROOT\}?/.test(content)) throw new Error(`${name} retained CLAUDE_PLUGIN_ROOT`);
}
const rootResponse = messages.find((entry) => entry.type === "response" && entry.command === "bash" && entry.id === "root");
if (!rootResponse?.success) throw new Error("LOOM_PLUGIN_ROOT bash response absent");
if (rootResponse.data.output !== loomDir) {
  throw new Error(`LOOM_PLUGIN_ROOT mismatch: expected ${loomDir}, got ${JSON.stringify(rootResponse.data.output)}`);
}
NODE

test ! -s "$TMP/commands.stderr" || { cat "$TMP/commands.stderr" >&2; exit 1; }
test ! -s "$TMP/root.stderr" || { cat "$TMP/root.stderr" >&2; exit 1; }
printf 'Pi resource discovery smoke test passed.\n'
