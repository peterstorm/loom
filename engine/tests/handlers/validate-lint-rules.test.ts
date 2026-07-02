import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import handler from "../../src/handlers/helpers/validate-lint-rules";

const GOOD_RULE = {
  kind: "regex",
  name: "inv-1-no-raw-order-states",
  description: "Order state literals only in the machine file",
  extensions: [".ts"],
  pattern: "\"(draft|submitted|paid)\"",
  flags: "",
  fixHint: "Import OrderState from the order machine instead",
  enabled: true,
};

let dirs: string[] = [];

function tempRulesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-rules-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("validate-lint-rules helper", () => {
  it("passes when default rules load and no project dir exists", async () => {
    const result = await handler("", ["/nonexistent/rules/dir"]);
    expect(result.kind).toBe("passthrough");
  });

  it("passes with a well-formed project rule", async () => {
    const dir = tempRulesDir();
    writeFileSync(join(dir, "inv-1.json"), JSON.stringify(GOOD_RULE));
    const result = await handler("", [dir]);
    expect(result.kind).toBe("passthrough");
  });

  it("fails closed on malformed JSON in a project rule", async () => {
    const dir = tempRulesDir();
    writeFileSync(join(dir, "broken.json"), "{not json");
    const result = await handler("", [dir]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("Lint rule validation FAILED");
  });

  it("fails closed on a rule missing required fields", async () => {
    const dir = tempRulesDir();
    writeFileSync(join(dir, "incomplete.json"), JSON.stringify({ kind: "regex", name: "x" }));
    const result = await handler("", [dir]);
    expect(result.kind).toBe("error");
  });

  it("fails closed on an unsafe regex pattern", async () => {
    const dir = tempRulesDir();
    writeFileSync(join(dir, "redos.json"), JSON.stringify({ ...GOOD_RULE, name: "redos", pattern: "(a+)+$" }));
    const result = await handler("", [dir]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message.toLowerCase()).toContain("unsafe");
  });
});
