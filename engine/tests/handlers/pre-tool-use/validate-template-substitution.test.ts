import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  findResidualPlaceholders,
  validateTemplateSubstitution,
} from "../../../src/core/validate-template-substitution";
import validateTemplateSubstitutionHandler from "../../../src/handlers/pre-tool-use/validate-template-substitution";

/**
 * Tests for the template substitution validation logic.
 *
 * These exercise the REAL exported `findResidualPlaceholders` — the single
 * source of truth — rather than a re-implemented copy, so the property/edge
 * assertions below cannot silently drift from the shipped detector.
 */

/** The core allow/block decision, driven by the real placeholder detector. */
function validateTemplate(prompt: string): "allow" | "block" {
  if (!prompt) return "allow";
  return findResidualPlaceholders(prompt).length === 0 ? "allow" : "block";
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

describe("validate-template-substitution — active graph boundary", () => {
  it("keeps the core decision pure over a pre-gathered graph-existence fact", () => {
    expect(validateTemplateSubstitution("Use {task_id}", false)).toEqual({ kind: "allow" });
    expect(validateTemplateSubstitution("Use {task_id}", true)).toMatchObject({ kind: "block" });
  });

  it("resolves LOOM_STATE_PATH in the shell after module import", async () => {
    const temp = mkdtempSync(join(tmpdir(), "loom-template-state-"));
    const statePath = join(temp, "active_task_graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    process.env.LOOM_STATE_PATH = statePath;
    const stdin = JSON.stringify({
      tool_name: "Agent",
      tool_input: { prompt: "Use {task_id}" },
      session_id: "session",
    });
    try {
      expect(await validateTemplateSubstitutionHandler(stdin, [])).toEqual({ kind: "allow" });
      writeFileSync(statePath, "{}\n");
      expect(await validateTemplateSubstitutionHandler(stdin, [])).toMatchObject({ kind: "block" });
    } finally {
      if (previous === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previous;
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("validate-template-substitution — edge cases", () => {
  it("empty prompt → allow", () => {
    expect(validateTemplate("")).toBe("allow");
  });

  it("whitelisted false positives → allow", () => {
    expect(validateTemplate("Use {type} and {id} and {name}")).toBe("allow");
  });

  it("JSON objects in prompt → allow (a quote sits between { and the key, so no {word} match)", () => {
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

  it("nested ${foo{bar}} → allow (strip matches to the first }, leaving a lone } that matches no placeholder)", () => {
    // Pins the true nesting behavior: the non-greedy ${...} strip consumes
    // `${foo{bar}` and leaves `}` — NOT `{bar}`. Allowing a genuine nested shell
    // expansion is correct; this guards against a "fix" that broke it.
    expect(validateTemplate("${foo{bar}}")).toBe("allow");
  });

  it("adjacent ${done}{leftover} → block (the strip leaves {leftover}, a genuine residual)", () => {
    // The one case the ${...} strip DOES leave a residual placeholder — and it
    // should, because {leftover} is an unsubstituted variable, not part of the
    // shell expansion.
    expect(validateTemplate("${done}{leftover}")).toBe("block");
  });

  it("JSX/member expression {props.title} → allow", () => {
    expect(validateTemplate("return <h1>{props.title}</h1>")).toBe("allow");
  });

  it("arithmetic expression {width-height} → allow", () => {
    expect(validateTemplate("const gap = {width-height}")).toBe("allow");
  });

  it("underscore template names remain blocked", () => {
    expect(validateTemplate("Read {plan_file}")).toBe("block");
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
