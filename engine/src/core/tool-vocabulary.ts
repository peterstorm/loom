/**
 * Tool + test-runner vocabulary — pure constants built only from pure core
 * and machine vocabulary helpers.
 *
 * Lives outside config.ts so pure modules (the guarded-skill-machine core,
 * the transcript parsers) can use the vocabulary without transitively
 * importing config's node:fs / node:child_process machinery. config.ts
 * re-exports these for its existing consumers — one definition, one truth.
 */

import { GATE_WIRED_TOOLS } from "../machine/types";
import { frozenSet } from "./frozen";

/**
 * Tools that modify files — DERIVED from GATE_WIRED_TOOLS (machine/types.ts,
 * the single source of truth pinned against hooks.json by
 * tests/machine/hooks-sync.test.ts) so the two sets can never drift apart.
 */
export const FILE_MODIFYING_TOOLS: ReadonlySet<string> = frozenSet(GATE_WIRED_TOOLS);

/**
 * The path a file-modifying tool call names: `file_path` (Claude Code's
 * Edit/Write/MultiEdit), else `path`. Null when neither is a non-blank string.
 */
export function editedFilePath(toolInput: Readonly<Record<string, unknown>> | null | undefined): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const filePath = toolInput.file_path ?? toolInput.path;
  return typeof filePath === "string" && filePath.trim().length > 0 ? filePath : null;
}

/**
 * Every tool name a harness uses to SPAWN A SUBAGENT.
 *
 * This is harness vocabulary, not loom's: Claude Code calls it `Agent` (it was
 * `Task`), Pi calls it `subagent`. Loom's five spawn gates — phase order, wave
 * order/dependencies, template substitution, agent model, agent skill — are the
 * only enforcement point for wave ordering, and they are reachable ONLY through
 * whichever name the running harness emits.
 *
 * One set, two layers: hooks.json's PreToolUse matcher decides whether the hook
 * fires at all, and each handler re-checks `tool_name` before doing work, so a
 * name known to one layer and not the other is a gate that reports healthy and
 * enforces nothing. tests/machine/hooks-sync.test.ts pins the matcher to this
 * set in BOTH directions, because that exact drift already happened once and
 * cost a full session to notice — a comment would not have caught it.
 *
 * `subagent` is inert under Claude Code (it never emits that tool_name) and
 * `Task` is inert under Pi; both stay listed so the vocabulary has one home
 * rather than one per harness.
 */
export const SUBAGENT_SPAWN_TOOLS: ReadonlySet<string> = frozenSet(["Task", "Agent", "subagent"]);

/** The spawn tool names only Claude Code emits: its plugin agents resolve by namespaced name. */
export const CLAUDE_SPAWN_TOOLS: ReadonlySet<string> = frozenSet(["Task", "Agent"]);

/** Test command patterns (for bash test output parsing) */
export const TEST_COMMAND_PATTERNS: readonly string[] = [
  "mvn test", "mvn verify", "mvn -pl",
  "mvnw test", "mvnw verify",
  "./gradlew test", "./gradlew check",
  "gradle test", "gradle check",
  "npm test", "npm run test", "npm run verify",
  "npx vitest", "npx jest",
  "yarn test", "pnpm test", "bun test",
  "pytest", "python -m pytest", "python3 -m pytest",
  "cargo test", "go test", "dotnet test",
  "mix test", "make test", "make check",
] as const;

/** Commands allowed to touch guarded state paths: deny-by-default allowlist.
 *
 * This replaces a writer denylist because writer vocabulary and composition
 * are unbounded (`bun -e`, substitutions, glob paths, wrappers, and future
 * tools all create new write forms). An allowlist inverts the residual: instead
 * of enumerating writers (unbounded), it
 * enumerates readers (small, stable), so an unknown command on a guarded
 * path blocks instead of slipping through.
 *
 * Membership criterion: the command must be unable to write a file under ANY
 * flag combination. Deliberately excluded, with the flag that disqualifies
 * them: `sort` (-o), `uniq` (second file operand), `less` (-o/-O),
 * `xxd` (-r <outfile>), `base64` (macOS -o), `file` (-C compiles the
 * magic database and WRITES `<name>.mgc` into the cwd — a guarded cwd makes
 * that a state-dir write), `sed`/`awk` (-i / in-script
 * `w`/`print >`), `find` (-delete/-exec), `git` (checkout/restore rewrite the
 * work tree — a `git checkout -- <state>` is a verdict-restore forgery),
 * `touch` (mtime forgery defeats report freshness),
 * `rg` (--pre <cmd> executes an arbitrary program per input file — a
 * pre-staged script receives the guarded path and can rewrite or delete it;
 * --hostname-bin <cmd> executes one program once to resolve the hostname.
 * Arbitrary program execution under any use disqualifies it),
 * `more` (interactive shell escape via `!cmd`/`v`; non-interactive it acts
 * like cat, but membership requires no write capability under ANY use),
 * `cd` (writes nothing itself, but it RE-SCOPES path resolution:
 * `cd .claude/state && rm *.json` names the guarded dir only in the cd
 * segment while the writer names no guarded literal, so its chain is
 * skipped as out-of-scope — allowlisting cd hands every later segment an
 * unguarded relative namespace. Excluding it costs only fail-closed reads:
 * reads never need to cd INTO a guarded dir, and
 * `cd <unguarded-dir> && jq . <state>` still allows because the cd chain is
 * simply out of scope. Residual, documented: multi-hop
 * `cd .claude; cd state; rm *.json` never names a guarded literal anywhere
 * on the line and stays invisible to any raw-text gate — see
 * machines/README.md known residual limits), and
 * wrapper/executor commands that run OTHER commands (`env`, `xargs`, `sudo`,
 * `timeout`, `nohup`, `nice`, `command`, shells, interpreters) — a wrapper
 * inherits the write capability of whatever it wraps. Heads match exactly
 * (no basename resolution): `./cat` or `/tmp/evil/jq` must not inherit the
 * trust of a PATH-resolved name. */
export const READ_ONLY_STATE_COMMANDS: ReadonlySet<string> = frozenSet([
  "jq", "cat", "grep", "egrep", "fgrep",
  "head", "tail", "wc", "ls", "stat",
  "diff", "cmp", "md5sum", "sha1sum", "sha256sum",
  "cut", "tr", "nl", "od", "hexdump", "strings",
  "echo", "printf", "test", "[", "[[", "true", "false",
  "pwd", "dirname", "basename", "readlink", "realpath", "du",
]);
