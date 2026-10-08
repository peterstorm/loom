/**
 * Static guard for the one Git spawn seam: no engine or Pi source file may
 * spawn `git` except `utils/git-execution-policy.ts`, and no file may obtain
 * process-spawning authority at all unless it is on the justified allowlist
 * below. Each file is PARSED with the TypeScript compiler, never matched as
 * text, so the guard sees every syntactic form that obtains the child-process
 * module — named, namespace, default and `import =` imports, re-exports,
 * `require` and dynamic `import()` — and ignores what only looks like code in
 * comments and prose. A new direct spawn fails here before any behavioural
 * test has to notice that its child ran with ambient config.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_ROOTS = ["engine/src", "pi"] as const;
const SEAM = "engine/src/utils/git-execution-policy.ts";

/** Files that may hold runtime process-spawning authority, and why. Each one's
 *  own Git observations (if any) still go through the seam; what it spawns
 *  directly is never `git`. */
const SPAWN_AUTHORITY_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  [SEAM]: "the one policy-bound Git spawn",
  "engine/src/handlers/helpers/complete-wave-gate.ts": "runs the operator's authenticated `gh` CLI for issue bodies and comments",
  "engine/src/orchestration/completion-check-runner.ts":
    "runs the operator's verification-manifest project command (any executable, no shell); its Git probes use the seam",
  "pi/interactive-subagent.ts": "spawns the Pi RPC subagent child process",
});

const CHILD_PROCESS_MODULES: ReadonlySet<string> = new Set(["child_process", "node:child_process"]);
const BUN_SPAWN_MEMBERS: ReadonlySet<string> = new Set(["spawn", "spawnSync"]);
/** Process-launching functions whose command operand is their first argument. */
const EXEC_FAMILY: ReadonlySet<string> = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);

type Finding = Readonly<{ rule: "spawn-authority" | "git-executable"; line: number; form: string }>;

/** The text of a string-like literal, or null for any other expression. */
function literalText(node: ts.Node): string | null {
  return ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : null;
}

const isChildProcessSpecifier = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isStringLiteralLike(node) && CHILD_PROCESS_MODULES.has(node.text);

/** Whether an import clause binds anything at runtime (a value import). */
function importsValues(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false; // a bare side-effect import binds nothing
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true; // default import
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

/** Whether a re-export from the child-process module exposes any value. */
function reexportsValues(declaration: ts.ExportDeclaration): boolean {
  if (declaration.isTypeOnly) return false;
  const clause = declaration.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true; // `export *` / `export * as ns`
  return clause.elements.some((element) => !element.isTypeOnly);
}

/** `Bun.spawn`/`Bun.spawnSync`, by property access or element access. */
function bunSpawnMember(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Bun"
    && BUN_SPAWN_MEMBERS.has(node.name.text)) return `Bun.${node.name.text}`;
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
    const member = literalText(node.argumentExpression);
    if (member !== null && BUN_SPAWN_MEMBERS.has(member)) return `Bun["${member}"]`;
  }
  return null;
}

/** Bun's command operand: an argv array, or the `cmd` array of an options object. */
function bunCommandOperand(argument: ts.Expression | undefined): ts.Expression | undefined {
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) return argument;
  const cmd = argument.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "cmd");
  return cmd?.initializer;
}

/** The called function's own name: `spawnSync(…)`, `cp.spawnSync(…)`, `cp["spawnSync"](…)`. */
function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return literalText(expression.argumentExpression);
  return null;
}

/** Whether a launch operand names Git: the literal `git`, a command string
 *  opening with `git `, or an argv array whose first element does either. */
function namesGit(operand: ts.Expression | undefined): boolean {
  if (operand === undefined) return false;
  if (ts.isArrayLiteralExpression(operand)) return namesGit(operand.elements[0]);
  const text = literalText(operand);
  return text !== null && (text === "git" || text.startsWith("git "));
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return /\.[mc]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/** Every spawn-authority and Git-executable form in one source file. */
function findings(path: string, source: string): readonly Finding[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const found: Finding[] = [];
  const record = (rule: Finding["rule"], node: ts.Node, form: string): void => {
    found.push(Object.freeze({ rule, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, form }));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isChildProcessSpecifier(node.moduleSpecifier) && importsValues(node.importClause)) {
      record("spawn-authority", node, "child-process import");
    } else if (ts.isExportDeclaration(node) && isChildProcessSpecifier(node.moduleSpecifier) && reexportsValues(node)) {
      record("spawn-authority", node, "child-process re-export");
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      && isChildProcessSpecifier(node.moduleReference.expression)) {
      record("spawn-authority", node, "child-process import-equals");
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && isChildProcessSpecifier(node.arguments[0])) {
        record("spawn-authority", node, isRequire ? "child-process require" : "child-process dynamic import");
      }
      const bun = bunSpawnMember(node.expression);
      const launcher = bun ?? calleeName(node.expression);
      const operand = bun === null ? node.arguments[0] : bunCommandOperand(node.arguments[0]);
      if (launcher !== null && (bun !== null || EXEC_FAMILY.has(launcher)) && namesGit(operand)) {
        record("git-executable", node, `${launcher} launching git`);
      }
    } else {
      const bun = bunSpawnMember(node);
      if (bun !== null) record("spawn-authority", node, bun);
    }
    // The literal `git` anywhere in code — a constant later handed to a
    // launcher, an argv element — names the executable; comments are not nodes.
    if (ts.isStringLiteralLike(node) && node.text === "git" && !ts.isModuleDeclaration(node.parent)) {
      record("git-executable", node, "the literal \"git\"");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function spawnViolations(path: string, source: string): readonly string[] {
  const all = findings(path, source);
  const violations: string[] = [];
  const git = all.filter(({ rule }) => rule === "git-executable");
  if (path !== SEAM && git.length > 0) {
    violations.push(`${path}: names git as an executable outside ${SEAM} (${git.map(({ line, form }) => `line ${line}: ${form}`).join("; ")})`);
  }
  const authority = all.filter(({ rule }) => rule === "spawn-authority");
  if (!(path in SPAWN_AUTHORITY_ALLOWLIST) && authority.length > 0) {
    violations.push(`${path}: holds process-spawning authority but is not on the justified allowlist (${authority.map(({ line, form }) => `line ${line}: ${form}`).join("; ")})`);
  }
  return violations;
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !/\.test\.[^.]+$/.test(entry.name) ? [path] : [];
  });
}

const EXAMPLE = "engine/src/handlers/helpers/example.ts";

describe("the engine has exactly one place that spawns git", () => {
  const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(REPOSITORY_ROOT, root)))
    .map((absolute) => relative(REPOSITORY_ROOT, absolute).split("\\").join("/"));

  it("scans a non-trivial source tree that includes the seam and every allowlisted file", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const path of Object.keys(SPAWN_AUTHORITY_ALLOWLIST)) expect(files, path).toContain(path);
  });

  it("finds no direct Git spawn and no unlisted spawn authority in engine/src or pi", () => {
    const violations = files.flatMap((path) => spawnViolations(path, readFileSync(join(REPOSITORY_ROOT, path), "utf-8")));
    expect(violations).toEqual([]);
  });

  it("keeps the seam itself the one file that names git as an executable, and every allowlisted file a real spawner", () => {
    const seam = findings(SEAM, readFileSync(join(REPOSITORY_ROOT, SEAM), "utf-8"));
    expect(seam.some(({ rule }) => rule === "git-executable")).toBe(true);
    for (const path of Object.keys(SPAWN_AUTHORITY_ALLOWLIST)) {
      const authority = findings(path, readFileSync(join(REPOSITORY_ROOT, path), "utf-8")).filter(({ rule }) => rule === "spawn-authority");
      expect(authority, `${path} is allowlisted but holds no spawn authority — remove it from the allowlist`).not.toEqual([]);
    }
  });

  it.each([
    ["a named import with a direct execFileSync", 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["status"]);'],
    ["a namespace import", 'import * as cp from "node:child_process";\ncp.spawnSync("ls", []);'],
    ["a default import", 'import cp from "child_process";\ncp.spawnSync("ls", []);'],
    ["a mixed type and value import", 'import { type SpawnSyncReturns, spawnSync } from "node:child_process";'],
    ["an import-equals require", 'import cp = require("child_process");'],
    ["a named re-export", 'export { spawnSync } from "node:child_process";'],
    ["a star re-export", 'export * from "child_process";'],
    ["a namespace re-export", 'export * as cp from "node:child_process";'],
    ["a require call", 'const cp = require("node:child_process");'],
    ["a dynamic import", 'const { spawnSync } = await import("node:child_process");'],
    ["Bun's spawn API by property", 'Bun.spawnSync(["ls"]);'],
    ["Bun's spawn API by element access", 'Bun["spawn"](["ls"]);'],
  ])("flags %s outside the allowlist", (_label, source) => {
    expect(spawnViolations(EXAMPLE, source)).not.toEqual([]);
  });

  it.each([
    ["a spawnSync through a named constant", "const GIT = 'git';\nspawnSync(GIT, []);"],
    ["a shell command string", "execSync(`git rev-parse HEAD`);"],
    ["a command string with a substitution", "execSync(`git rev-parse ${revision}`);"],
    ["a member call on a namespace", 'cp.execFileSync("git", ["status"]);'],
    ["Bun's argv form", 'Bun.spawnSync(["git", "status"]);'],
    ["Bun's options form", 'Bun.spawn({ cmd: ["git", "status"] });'],
  ])("flags %s as naming git, even inside an allowlisted spawner", (_label, source) => {
    expect(findings("engine/src/orchestration/completion-check-runner.ts", source).some(({ rule }) => rule === "git-executable")).toBe(true);
    expect(spawnViolations("engine/src/orchestration/completion-check-runner.ts", source)).toEqual([
      expect.stringMatching(/^engine\/src\/orchestration\/completion-check-runner\.ts: names git as an executable outside engine\/src\/utils\/git-execution-policy\.ts \(line \d+: /),
    ]);
  });

  it.each([
    ["a type-only import", "import type { SpawnSyncReturns } from 'node:child_process';"],
    ["an import of type-only elements", "import { type SpawnSyncReturns, type SpawnSyncOptions } from 'node:child_process';"],
    ["a type-only re-export", "export type { SpawnSyncReturns } from 'node:child_process';"],
    ["prose and comments that merely mention git", '// runs git rev-parse through the seam, never spawnSync("git")\n/** `git` in a doc comment */\nconst note = "the git seam";'],
    ["a non-launching function given a git-prefixed string", 'log("git status is clean");'],
  ])("allows %s", (_label, source) => {
    expect(spawnViolations(EXAMPLE, source)).toEqual([]);
  });
});
