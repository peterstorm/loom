import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializePiResources } from "../../pi/resources";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { packageRoot: string; cacheRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "loom-pi-resources-test-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const cacheRoot = join(root, "cache");
  mkdirSync(join(packageRoot, "skills", "demo"), { recursive: true });
  mkdirSync(join(packageRoot, "commands", "templates"), { recursive: true });
  mkdirSync(join(packageRoot, "commands", "vercel-react-best-practices"), { recursive: true });
  mkdirSync(join(packageRoot, "references"), { recursive: true });
  mkdirSync(join(packageRoot, "rules"), { recursive: true });
  writeFileSync(join(packageRoot, "skills", "demo", "SKILL.md"), "Read ${CLAUDE_PLUGIN_ROOT}/rules/a.md\n");
  writeFileSync(join(packageRoot, "skills", "demo", "asset.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(packageRoot, "commands", "demo.md"), "Run ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts\n");
  writeFileSync(join(packageRoot, "commands", "templates", "nested.md"), "${CLAUDE_PLUGIN_ROOT}/nested\n");
  writeFileSync(join(packageRoot, "commands", "vercel-react-best-practices", "SKILL.md"), "portable\n");
  writeFileSync(join(packageRoot, "references", "guide.md"), "${CLAUDE_PLUGIN_ROOT}/guide\n");
  writeFileSync(join(packageRoot, "rules", "a.md"), "rule\n");
  return { packageRoot, cacheRoot };
}

describe("Pi resource materialization", () => {
  it("renders every markdown file and preserves non-markdown assets", () => {
    const { packageRoot, cacheRoot } = fixture();
    const resources = materializePiResources(packageRoot, cacheRoot);

    expect(readFileSync(join(resources.root, "skills", "demo", "SKILL.md"), "utf-8"))
      .toBe(`Read ${packageRoot}/rules/a.md\n`);
    expect(readFileSync(join(resources.root, "commands", "templates", "nested.md"), "utf-8"))
      .toBe(`${packageRoot}/nested\n`);
    expect([...readFileSync(join(resources.root, "skills", "demo", "asset.bin"))]).toEqual([0, 1, 2]);
    expect(resources.promptPaths).toEqual([join(resources.root, "commands")]);
    expect(resources.skillPaths).toContain(join(resources.root, "skills"));
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.isFrozen(resources.promptPaths)).toBe(true);
    expect(Object.isFrozen(resources.skillPaths)).toBe(true);
  });

  it("is content-addressed and reuses an intact render", () => {
    const { packageRoot, cacheRoot } = fixture();
    const first = materializePiResources(packageRoot, cacheRoot);
    const second = materializePiResources(packageRoot, cacheRoot);
    expect(second).toEqual(first);

    writeFileSync(join(packageRoot, "commands", "demo.md"), "changed\n");
    const changed = materializePiResources(packageRoot, cacheRoot);
    expect(changed.root).not.toBe(first.root);
  });

  it("detects and repairs edited, deleted, extra, and symlinked cache entries", () => {
    const { packageRoot, cacheRoot } = fixture();
    const expected = `Run ${packageRoot}/engine/src/cli.ts\n`;

    for (const corrupt of [
      (root: string) => writeFileSync(join(root, "commands", "demo.md"), "tampered\n"),
      (root: string) => rmSync(join(root, "commands", "demo.md")),
      (root: string) => writeFileSync(join(root, "unexpected.md"), "extra\n"),
      (root: string) => {
        rmSync(join(root, "commands", "demo.md"));
        symlinkSync(join(packageRoot, "commands", "demo.md"), join(root, "commands", "demo.md"));
      },
    ]) {
      const resources = materializePiResources(packageRoot, cacheRoot);
      corrupt(resources.root);
      const repaired = materializePiResources(packageRoot, cacheRoot);
      expect(repaired.root).toBe(resources.root);
      expect(readFileSync(join(repaired.root, "commands", "demo.md"), "utf-8")).toBe(expected);
      expect(() => readFileSync(join(repaired.root, "unexpected.md"))).toThrow();
    }
  });

  it("repairs dangling digest symlinks and permission drift", () => {
    const { packageRoot, cacheRoot } = fixture();
    const resources = materializePiResources(packageRoot, cacheRoot);
    const command = join(resources.root, "commands", "demo.md");
    chmodSync(command, 0o777);
    materializePiResources(packageRoot, cacheRoot);
    expect(lstatSync(command).mode & 0o777).toBe(0o600);

    rmSync(resources.root, { recursive: true });
    symlinkSync(join(cacheRoot, "missing-target"), resources.root);
    const repaired = materializePiResources(packageRoot, cacheRoot);
    expect(lstatSync(repaired.root).isDirectory()).toBe(true);
    expect(lstatSync(repaired.root).isSymbolicLink()).toBe(false);
  });

  it("rejects a symlinked top-level source tree", () => {
    const { packageRoot, cacheRoot } = fixture();
    const external = join(dirname(packageRoot), "external-skills");
    renameSync(join(packageRoot, "skills"), external);
    symlinkSync(external, join(packageRoot, "skills"));
    expect(() => materializePiResources(packageRoot, cacheRoot)).toThrow(/regular directory/);
  });

  it.each(["first publication", "corrupt-cache repair"])(
    "publishes one valid cache under concurrent Pi processes: %s",
    async (scenario) => {
      const { packageRoot, cacheRoot } = fixture();
      if (scenario === "corrupt-cache repair") {
        const seeded = materializePiResources(packageRoot, cacheRoot);
        writeFileSync(join(seeded.root, "commands", "demo.md"), "corrupt\n");
      }
      const modulePath = fileURLToPath(new URL("../../pi/resources.ts", import.meta.url));
      const program = [
        `import { materializePiResources } from ${JSON.stringify(modulePath)};`,
        `process.stdout.write(materializePiResources(process.env.PACKAGE_ROOT!, process.env.CACHE_ROOT!).root);`,
      ].join("\n");
      const runs = await Promise.all(new Array(6).fill(null).map(() => execFileAsync("bun", ["-e", program], {
        env: { ...process.env, PACKAGE_ROOT: packageRoot, CACHE_ROOT: cacheRoot },
      })));
      const published = new Set(runs.map(({ stdout }) => stdout));
      expect(published.size).toBe(1);
      const [root] = [...published];
      expect(readFileSync(join(root!, "commands", "demo.md"), "utf-8"))
        .toBe(`Run ${packageRoot}/engine/src/cli.ts\n`);
      expect(materializePiResources(packageRoot, cacheRoot).root).toBe(root);
    },
  );
});
