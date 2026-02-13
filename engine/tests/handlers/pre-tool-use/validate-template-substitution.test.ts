import { describe, it, expect } from "vitest";
import fc from "fast-check";

/**
 * Tests for the template substitution validation logic.
 * We test the pure regex/filtering logic extracted from the handler.
 */

const FALSE_POSITIVES = new Set(["{type}", "{id}", "{name}"]);

/** Simulate the core template validation decision */
function validateTemplate(prompt: string): "allow" | "block" {
  if (!prompt) return "allow";

  // Remove shell ${var} expansions
  const cleaned = prompt.replace(/\$\{[^}]*\}/g, "");

  // Find {word} patterns
  const matches = cleaned.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? [];
  const realIssues = matches.filter((v) => !FALSE_POSITIVES.has(v));

  return realIssues.length === 0 ? "allow" : "block";
}

describe("validate-template-substitution — property tests", () => {
  it("shell ${var} patterns never trigger block", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/), { minLength: 1, maxLength: 5 }),
        (varNames) => {
          const prompt = varNames.map((v) => `\${${v}}`).join(" ");
          expect(validateTemplate(prompt)).toBe("allow");
        },
      ),
    );
  });

  it("unsubstituted {var} patterns always trigger block (except false positives)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_]{3,15}$/).filter(
          (s) => !["type", "id", "name"].includes(s),
        ),
        (varName) => {
          const prompt = `Do something with {${varName}}`;
          expect(validateTemplate(prompt)).toBe("block");
        },
      ),
    );
  });
});

describe("validate-template-substitution — edge cases", () => {
  it("empty prompt → allow", () => {
    expect(validateTemplate("")).toBe("allow");
  });

  it("whitelisted false positives → allow", () => {
    expect(validateTemplate("Use {type} and {id} and {name}")).toBe("allow");
  });

  it("JSON objects in prompt → allow (keys not single-word patterns)", () => {
    // JSON like {"key": "value"} → cleaned, the {key} pattern doesn't match
    // because : is after key but the regex only looks for {word}
    // Actually {"key": "value"} would match {key} if not careful...
    // Let's test: "key" would match as a false positive? No — {key} is not in FALSE_POSITIVES
    // But the actual JSON '{"key": "value"}' — the regex matches \{[a-zA-Z_]...\}
    // However, JSON keys are usually followed by colon, making the match include more than {word}
    // The regex is /\{[a-zA-Z_][a-zA-Z0-9_]*\}/ — this requires } immediately after the word
    // In '{"key": "value"}', the pattern is {"key" — no closing } after "key"
    expect(validateTemplate('{"key": "value"}')).toBe("allow");
  });

  it("JSON with nested objects → allow", () => {
    expect(validateTemplate('{"outer": {"inner": "value"}}')).toBe("allow");
  });

  it("multiple unsubstituted vars → block", () => {
    expect(validateTemplate("Run {task_id} with {agent_name} on {wave}")).toBe("block");
  });

  it("mixed shell vars and unsubstituted vars → block", () => {
    expect(validateTemplate("${HOME}/path with {task_id}")).toBe("block");
  });

  it("nested ${outer_{inner}} → shell var cleaned correctly", () => {
    // The outer ${...} should be removed, leaving the inner content
    expect(validateTemplate("${outer_{inner}}")).toBe("allow");
  });

  it("plain text without any braces → allow", () => {
    expect(validateTemplate("Implement the authentication feature using JWT tokens")).toBe("allow");
  });

  it("single false positive among real issues → block", () => {
    expect(validateTemplate("Use {type} for {task_id}")).toBe("block");
  });

  it("underscore-prefixed vars → block", () => {
    expect(validateTemplate("Use {_private_var}")).toBe("block");
  });

  it("single char var (not in false positives) → block", () => {
    expect(validateTemplate("Use {x}")).toBe("block");
  });

  it("numbers at start of var name → allow (regex requires letter/underscore start)", () => {
    // {1foo} doesn't match [a-zA-Z_] at start
    expect(validateTemplate("{1foo}")).toBe("allow");
  });
});
