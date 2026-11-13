import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "./fixtures/canonical-temp-dir";

const bash = execFileSync("bash", ["--noprofile", "--norc", "-c", "command -v bash"], {
  encoding: "utf8", env: { PATH: process.env.PATH ?? "" },
}).trim();
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function preflight(file: string, section: string): string {
  const markdown = readFileSync(new URL(`../../commands/${file}`, import.meta.url), "utf8");
  const start = markdown.indexOf(section);
  expect(start, `missing preflight section in ${file}`).toBeGreaterThanOrEqual(0);
  const snippet = /```bash\n([\s\S]*?)\n```/.exec(markdown.slice(start))?.[1];
  if (snippet === undefined) throw new Error(`missing Bash preflight in ${file}`);
  // Only the prerequisite boundary, never bootstrap, package installation, or the engine CLI.
  expect(snippet).not.toMatch(/\b(?:install|curl|wget|bunx|npm|npx|helper|init-state)\b/);
  return snippet;
}

function fixture(bunAvailable: boolean) {
  const directory = canonicalTempDir("loom-command-preflight-");
  directories.push(directory);
  const bin = join(directory, "bin");
  const packagePath = join(directory, "package with spaces");
  mkdirSync(bin);
  for (const command of [...(bunAvailable ? ["bun"] : []), "npm", "npx", "bunx", "curl", "wget", "nix", "git"]) {
    writeFileSync(join(bin, command), `#!${bash}\nprintf 'UNSAFE: unexpected execution of ${command}\\n' >&2\nexit 97\n`, { mode: 0o755 });
  }
  return { directory, bin, packagePath };
}

function execute(snippet: string, sandbox: ReturnType<typeof fixture>) {
  const result = spawnSync(bash, ["--noprofile", "--norc", "-c", snippet], {
    cwd: sandbox.directory,
    encoding: "utf8",
    timeout: 5_000,
    // No inherited BASH_ENV, exported functions, harness selectors, or real executable fallback.
    env: { PATH: sandbox.bin, HOME: sandbox.directory, CLAUDE_PLUGIN_ROOT: sandbox.packagePath },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).not.toContain("UNSAFE:");
  return result;
}

describe("documented command preflights execute fail-closed", () => {
  it("missing Bun exits nonzero with the actionable dev-shell diagnostic on stderr", () => {
    const result = execute(preflight("loom.md", "## Setup"), fixture(false));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FATAL: bun not found");
    expect(result.stderr).toContain("nix develop ./.claude");
    expect(result.stdout).toBe("");
  });

  it("available Bun passes discovery without executing or installing it", () => {
    const sandbox = fixture(true);
    const result = execute(preflight("loom.md", "## Setup"), sandbox);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(sandbox.bin, "bun"));
    expect(result.stderr).toBe("");
  });

  it.each(["absent", "incomplete"] as const)("%s resolved Loom package exits nonzero with actionable stderr", (kind) => {
    const sandbox = fixture(false);
    if (kind === "incomplete") mkdirSync(sandbox.packagePath);
    const result = execute(preflight("wave-gate.md", "Resolve the active Loom package once:"), sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FATAL: active Loom package is incomplete");
    expect(result.stderr).toContain(sandbox.packagePath);
    expect(result.stderr).toContain("reinstall");
    expect(result.stdout).toBe("");
  });

  it("a package containing the required CLI path passes without invoking the CLI", () => {
    const sandbox = fixture(false);
    mkdirSync(join(sandbox.packagePath, "engine/src"), { recursive: true });
    writeFileSync(join(sandbox.packagePath, "engine/src/cli.ts"), "throw new Error('preflight must not execute CLI');\n");
    const result = execute(preflight("wave-gate.md", "Resolve the active Loom package once:"), sandbox);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
