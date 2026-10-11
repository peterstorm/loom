#!/bin/bash
# PostToolUse advisory type diagnostics — after Edit/Write/MultiEdit on a
# TypeScript source, run the project's incremental tsc and hand the model what
# no longer typechecks. Fail-OPEN by design: this is context, never a gate.
# Its own shim (not lint-file.sh) because a cold incremental build can take
# tens of seconds; hooks.json gives it a longer timeout than the 5s lint tier.

stdin="$(cat)"

# Fast paths that skip a bun spawn: switched off, or not a TypeScript source
# (declaration files excluded). The engine re-checks both; this prefilter only
# saves the spawn, and a contract test keeps it equal to the core's
# isTypeScriptSource.
if [[ "${LOOM_TYPE_DIAGNOSTICS:-}" == "off" ]]; then
  exit 0
fi
path_key='"(file_path|path)"[[:space:]]*:[[:space:]]*"[^"]*'
if ! grep -Eq "${path_key}\.(ts|tsx|mts|cts)\"" <<<"${stdin}" || grep -Eq "${path_key}\.d\.(ts|mts|cts)\"" <<<"${stdin}"; then
  exit 0
fi

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]] || ! command -v bun &>/dev/null; then
  echo '{"systemMessage":"Loom type diagnostics skipped: runtime unavailable (CLAUDE_PLUGIN_ROOT unset or bun not on PATH)"}'
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use type-diagnostics <<<"${stdin}"
