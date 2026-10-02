import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_AGENT_TOOLS,
  lowerAgentToolsForPi,
  lowerToolsForPi,
  parseDeclaredTools,
  type ClaudeAgentTool,
} from "../../src/core/agent-tools";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const agent = (toolsField: string, eol = "\n") =>
  ["---", "name: demo", "model: opus", toolsField, "skills:", "  - specify", "---", "Body", ""].join(eol);

/** Unwrap a lowering the test asserts must succeed. */
const lowered = (content: string): string => {
  const result = lowerAgentToolsForPi(content);
  if (!result.ok) throw new Error(`expected a lowering, got refusal: ${result.error.message}`);
  return result.value;
};

const PI_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Which Pi built-ins each Claude capability needs, restated independently of the module. */
const REQUIRED: Readonly<Record<ClaudeAgentTool, readonly string[]>> = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  MultiEdit: ["edit"],
  Bash: ["bash"],
  Grep: ["grep"],
  Glob: ["find", "ls"],
};

describe("declared agent tools", () => {
  it("parses block, flow, and comma-string forms identically", () => {
    const expected = { kind: "tools", names: ["Read", "Glob", "Grep"] };
    expect(parseDeclaredTools(agent("tools:\n  - Read\n  - Glob\n  - Grep"))).toEqual(expected);
    expect(parseDeclaredTools(agent("tools: [Read, Glob, Grep]"))).toEqual(expected);
    expect(parseDeclaredTools(agent("tools: Read, Glob, Grep"))).toEqual(expected);
    expect(parseDeclaredTools(agent(`tools: ["Read", 'Glob', Grep]`))).toEqual(expected);
  });

  it("reports none when the field or the frontmatter is absent", () => {
    expect(parseDeclaredTools(agent("color: cyan"))).toEqual({ kind: "none" });
    expect(parseDeclaredTools("no frontmatter at all")).toEqual({ kind: "none" });
  });

  it("dedupes repeated declarations in declaration order", () => {
    expect(parseDeclaredTools(agent("tools: Grep, Read, Grep, Read"))).toEqual({
      kind: "tools",
      names: ["Grep", "Read"],
    });
  });

  it("rejects Pi names written in the source, naming each offender and the fix", () => {
    // The original bug: Pi's lowercase names in the source made Claude Code
    // refuse to spawn the agent with zero recognised tools.
    const parsed = parseDeclaredTools(agent("tools: read, bash, edit, write, grep, find, ls"));
    expect(parsed.kind).toBe("unreadable");
    if (parsed.kind !== "unreadable") return;
    expect(parsed.reason).toContain("read, bash, edit, write, grep, find, ls");
    expect(parsed.reason).toContain("declare Claude Code tool names");
  });

  it.each([
    ["an unknown name beside a known one", "tools:\n  - Read\n  - WebFetch", "unsupported tool(s): WebFetch;"],
    ["an empty block", "tools:", "is empty"],
    ["an empty flow list", "tools: []", "is empty"],
    ["only separators", "tools: ,", "is empty"],
    ["an unterminated flow list", "tools: [Read, Grep", "not closed"],
    ["a duplicate key", "tools: Read\ntools: Grep", "more than once"],
  ])("rejects %s", (_case, field, reason) => {
    expect(parseDeclaredTools(agent(field))).toEqual({ kind: "unreadable", reason: expect.stringContaining(reason) });
  });

  it("is total for arbitrary markdown", () => {
    fc.assert(fc.property(fc.string(), (markdown) => {
      expect(() => parseDeclaredTools(markdown)).not.toThrow();
      expect(() => lowerAgentToolsForPi(markdown)).not.toThrow();
    }));
  });
});

describe("lowering declared tools for Pi", () => {
  it("expands Glob to find and ls and collapses MultiEdit with Edit", () => {
    expect(lowerToolsForPi(["Read", "Glob", "Grep"])).toEqual(["read", "find", "ls", "grep"]);
    expect(lowerToolsForPi(["MultiEdit", "Edit", "Write"])).toEqual(["edit", "write"]);
  });

  it("rewrites a block list into one comma-string line and leaves every other byte alone", () => {
    const source = agent("tools:\n  - Read\n  - Glob\n  - Grep");
    expect(lowered(source)).toBe(agent("tools: read, find, ls, grep"));
  });

  it("preserves CRLF line endings outside the rewritten field", () => {
    const source = agent("tools:\r\n  - Bash\r\n  - MultiEdit\r\n  - Edit", "\r\n");
    expect(lowered(source)).toBe(agent("tools: bash, edit", "\r\n"));
  });

  it("returns the content unchanged when no tools field is declared", () => {
    const source = agent("color: cyan");
    expect(lowered(source)).toBe(source);
  });

  it("refuses an unreadable field as a value carrying its reason", () => {
    const refused = lowerAgentToolsForPi(agent("tools: read"));
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: "agent-tools-unreadable", message: expect.stringContaining("read") },
    });
  });

  it("lowers every non-empty declaration, in any form, to one line of exactly the required Pi capabilities", () => {
    const declaration = fc.uniqueArray(fc.constantFrom(...CLAUDE_AGENT_TOOLS), { minLength: 1 })
      .chain((names) => fc.tuple(
        fc.constant(names),
        fc.shuffledSubarray(names).map((repeats) => [...names, ...repeats]),
        fc.constantFrom("block", "flow", "comma"),
        fc.constantFrom("\n", "\r\n"),
      ));
    fc.assert(fc.property(declaration, ([names, withRepeats, form, eol]) => {
      const field = form === "block"
        ? ["tools:", ...withRepeats.map((name) => `  - ${name}`)].join(eol)
        : form === "flow" ? `tools: [${withRepeats.join(", ")}]` : `tools: ${withRepeats.join(", ")}`;
      const output = lowered(agent(field, eol));

      const toolLines = output.split(eol).filter((line) => line.startsWith("tools:"));
      expect(toolLines).toHaveLength(1);
      // Read the line the way Pi's comma-string consumers do.
      const piTools = toolLines[0]!.slice("tools:".length).split(",").map((tool) => tool.trim());
      expect(piTools.every((tool) => PI_NAMES.has(tool))).toBe(true);
      expect(new Set(piTools).size).toBe(piTools.length);
      expect(new Set(piTools)).toEqual(new Set(names.flatMap((name) => REQUIRED[name])));
      expect(output).toBe(agent(`tools: ${piTools.join(", ")}`, eol));
      // Order of declaration, not of repetition, decides the output; and a
      // second lowering is refused rather than passing Pi names through.
      expect(piTools).toEqual(lowerToolsForPi(names));
      expect(lowerAgentToolsForPi(output).ok).toBe(false);
    }));
  });
});

describe("repository agent definitions", () => {
  const agentFiles = readdirSync(join(ROOT, "agents"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name);

  it("finds the agent definitions it guards", () => {
    expect(agentFiles).toContain("specify-agent.md");
    expect(agentFiles).toContain("arch-judge-agent.md");
  });

  it.each(agentFiles)("%s declares tools both harnesses can read", (file) => {
    const declared = parseDeclaredTools(readFileSync(join(ROOT, "agents", file), "utf-8"));
    expect(declared.kind === "unreadable" ? declared.reason : declared.kind).toMatch(/^(none|tools)$/);
  });
});
