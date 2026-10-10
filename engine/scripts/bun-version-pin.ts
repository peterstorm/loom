/**
 * The Bun version pin guard. The repository-root `.bun-version` is the one
 * source of truth for the Bun that runs Loom: CI installs it
 * (`oven-sh/setup-bun` `bun-version-file`) and its Required-tools step
 * compares `bun --version` to it, and `npm run verify`'s preflight runs this
 * script so a mismatched local Bun stops verification before the suite does.
 * Bun's behavior differs between releases in ways the suite can observe
 * (`fs.closeSync(1)` is a silent no-op on 1.3.13), so a run on another Bun
 * proves nothing about the pinned one.
 *
 * The comparison is pure and total; the shell below only reads the pin file,
 * asks the `bun` on PATH for its version, and maps a refusal to stderr and a
 * non-zero exit.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const BUN_VERSION: unique symbol;

/** A Bun release as `bun --version` prints it: `MAJOR.MINOR.PATCH`, optionally with a pre-release or build suffix. */
export type BunVersion = string & { readonly [BUN_VERSION]: true };

/** Why the local Bun does not satisfy the pin. */
export type BunVersionRefusal =
  | Readonly<{ kind: "malformed-pin"; raw: string }>
  | Readonly<{ kind: "malformed-local"; raw: string }>
  | Readonly<{ kind: "mismatch"; pinned: BunVersion; local: BunVersion }>;

export type BunVersionCheck =
  | Readonly<{ ok: true; value: BunVersion }>
  | Readonly<{ ok: false; error: BunVersionRefusal }>;

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.+-]+)?$/;

/** Parse one version line. A single trailing newline (a file's or a CLI's) is not part of the version. */
function parseBunVersion(raw: string): BunVersion | null {
  const line = raw.replace(/\r?\n$/, "");
  return VERSION.test(line) ? (line as BunVersion) : null;
}

/** Compare the pin file's contents to the local `bun --version` output. Exact equality: the pin names one release. */
export function checkBunVersion(pinRaw: string, localRaw: string): BunVersionCheck {
  const pinned = parseBunVersion(pinRaw);
  if (pinned === null) return { ok: false, error: { kind: "malformed-pin", raw: pinRaw } };
  const local = parseBunVersion(localRaw);
  if (local === null) return { ok: false, error: { kind: "malformed-local", raw: localRaw } };
  return pinned === local ? { ok: true, value: pinned } : { ok: false, error: { kind: "mismatch", pinned, local } };
}

/** The operator-facing line for a refusal. */
export function describeBunVersionRefusal(refusal: BunVersionRefusal): string {
  switch (refusal.kind) {
    case "malformed-pin":
      return `Verification blocked: .bun-version must hold exactly one Bun version (e.g. 1.4.2), got ${JSON.stringify(refusal.raw)}`;
    case "malformed-local":
      return `Verification blocked: \`bun --version\` printed ${JSON.stringify(refusal.raw)}, not a Bun version`;
    case "mismatch":
      return `Verification blocked: local Bun is ${refusal.local} but .bun-version pins ${refusal.pinned}; CI runs ${refusal.pinned}, so install that Bun (or update .bun-version deliberately) before verifying`;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pinPath = fileURLToPath(new URL("../../.bun-version", import.meta.url));
  const readPin = (): string | Error => {
    try {
      return readFileSync(pinPath, "utf8");
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
  };
  const pin = readPin();
  const local = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (pin instanceof Error) {
    process.stderr.write(`Verification blocked: cannot read the Bun pin ${pinPath}: ${pin.message}\n`);
    process.exitCode = 2;
  } else if (local.error !== undefined || local.status !== 0) {
    process.stderr.write(`Verification blocked: \`bun --version\` failed: ${local.error?.message ?? `exit ${local.status}`}\n`);
    process.exitCode = 2;
  } else {
    const result = checkBunVersion(pin, local.stdout);
    if (!result.ok) process.stderr.write(`${describeBunVersionRefusal(result.error)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
