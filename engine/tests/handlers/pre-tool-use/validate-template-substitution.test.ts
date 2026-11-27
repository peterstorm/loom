import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ENGINE_RENDERED_BRIEF,
  findResidualPlaceholders,
  LOOM_TEMPLATE_VARIABLES,
  parentAssembled,
  placeholderTokens,
  validateTemplateSubstitution,
} from "../../../src/core/validate-template-substitution";
import validateTemplateSubstitutionHandler, {
  createValidateTemplateSubstitutionHandler,
} from "../../../src/handlers/pre-tool-use/validate-template-substitution";
import type { ImplementationBrief, RenderTaskBrief } from "../../../src/core/implementation-brief";
import { ACCEPTANCE_RUNNER_FILES_PLACEHOLDER } from "../../../src/core/verification-manifest";

/**
 * Tests for the template substitution validation logic.
 *
 * These exercise the REAL exported `findResidualPlaceholders` — the single
 * source of truth — rather than a re-implemented copy, so the property/edge
 * assertions below cannot silently drift from the shipped detector.
 */

/** The core allow/block decision over a parent-assembled prompt. */
function validateTemplate(prompt: string): "allow" | "block" {
  return validateTemplateSubstitution(parentAssembled(prompt), true).kind === "block" ? "block" : "allow";
}

const REPO_ROOT = join(__dirname, "../../../..");
const VOCABULARY = [...LOOM_TEMPLATE_VARIABLES].sort();

describe("the vocabulary is exactly the variables Loom's prompt templates declare", () => {
  it("equals the placeholder names of commands/templates/*.md", () => {
    // A template that adopts a new variable fails here until the name joins
    // the vocabulary; a name no template uses any more fails here until it
    // leaves, so the gate never guards a dead name.
    const dir = join(REPO_ROOT, "commands", "templates");
    const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
    expect(files.length).toBeGreaterThan(8);
    const names = new Set(files.flatMap((file) => placeholderTokens(readFileSync(join(dir, file), "utf-8")).map((token) => token.slice(1, -1))));
    expect(VOCABULARY).toEqual([...names].sort());
  });
});

describe("validate-template-substitution — property tests", () => {
  const notVocabulary = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/).filter((name) => !LOOM_TEMPLATE_VARIABLES.has(name));

  it("shell ${var} patterns never trigger block", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...VOCABULARY), { minLength: 1, maxLength: 5 }),
        (varNames) => {
          const prompt = varNames.map((v) => `\${${v}}`).join(" ");
          expect(validateTemplate(prompt)).toBe("allow");
        },
      ),
    );
  });

  it("an unfilled Loom template variable always blocks", () => {
    fc.assert(
      fc.property(fc.constantFrom(...VOCABULARY), fc.constantFrom("", "Read ", "path /x/", "(", "`"), (name, before) => {
        expect(validateTemplate(`${before}{${name}} next`)).toBe("block");
      }),
    );
  });

  it("a {name} no Loom template declares never blocks: it is the prompt's own text", () => {
    fc.assert(
      fc.property(notVocabulary, (name) => {
        expect(validateTemplate(`Store under ab:outcome:{${name}} and /api/{${name}}`)).toBe("allow");
      }),
    );
  });
});

describe("validate-template-substitution — domain brace patterns are text", () => {
  it("Redis key, URL and path patterns → allow", () => {
    expect(validateTemplate("Keys: ab:outbox:noc:{key} and ab:outcome:{incidentId}")).toBe("allow");
    expect(validateTemplate("GET /users/{userId}/orders/{id}, files under infra/{system}/")).toBe("allow");
  });

  it("the names the old whitelist carried are text without one", () => {
    expect(validateTemplate("{type} {id} {name} {system} {revision} {builtAt} {hot}")).toBe("allow");
  });

  it("a domain pattern beside an unfilled Loom variable still blocks, naming only the variable", () => {
    expect(findResidualPlaceholders("write ab:outcome:{incidentId} to {plan_file_path}")).toEqual(["{plan_file_path}"]);
  });
});

describe("validate-template-substitution — identifier-glued braces are expression syntax", () => {
  it("{var} glued to a preceding identifier character never blocks (ADT field notation, struct literals)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{0,12}[A-Za-z0-9_]$/),
        fc.constantFrom(...VOCABULARY),
        (head, field) => {
          expect(validateTemplate(`ProofFailure += ${head}{${field}}`)).toBe("allow");
        },
      ),
    );
  });

  it("ADT union notation {wave}|{some T} → allow; a lone {wave} still blocks", () => {
    expect(validateTemplate("parsed to {wave}|{some NonEmpty<RepositoryRelativePath>}")).toBe("allow");
    expect(validateTemplate("a|{task_id} or {task_id}|b")).toBe("allow");
    expect(validateTemplate("parsed to {wave} here")).toBe("block");
  });

  it("spaced union notation null | {wave} and {wave} | other → allow; a pipe without a union still blocks", () => {
    expect(validateTemplate("stale null | {wave}}). task.skeleton_outcomes")).toBe("allow");
    expect(validateTemplate("stale: {wave} | null")).toBe("allow");
    expect(validateTemplate("a |\t{wave} or {wave}  | b")).toBe("allow");
    expect(validateTemplate("run | then use {task_id} here")).toBe("block");
  });

  it("intersection notation A & {wave}, A&{wave}, {wave} & C → allow; a lone & elsewhere still blocks", () => {
    expect(validateTemplate("returns FrozenSurface & {wave}. Content-addressed adoption")).toBe("allow");
    expect(validateTemplate("A&{wave} or {wave}&C or {wave} & C")).toBe("allow");
    expect(validateTemplate("build & then read {plan_file_path}")).toBe("block");
  });

  it("a placeholder after a non-identifier character still blocks: loom-{task_id}, ({wave}), /{plan_file_path}", () => {
    expect(validateTemplate("/tmp/loom-{task_id}-bun.xml")).toBe("block");
    expect(validateTemplate("Wave ({wave})")).toBe("block");
    expect(validateTemplate("Available at: /{plan_file_path}")).toBe("block");
  });

  it("a placeholder glued to a stripped shell expansion still blocks: x${done}{task_id}", () => {
    expect(validateTemplate("x${done}{task_id}")).toBe("block");
  });
});

describe("validate-template-substitution — where the prompt came from", () => {
  it("an engine-rendered brief is never judged: its template was filled before protected text was spliced in", () => {
    expect(validateTemplateSubstitution(ENGINE_RENDERED_BRIEF, true)).toEqual({ kind: "allow" });
  });

  it("keeps the core decision pure over a pre-gathered graph-existence fact", () => {
    expect(validateTemplateSubstitution(parentAssembled("Use {task_id}"), false)).toEqual({ kind: "allow" });
    expect(validateTemplateSubstitution(parentAssembled("Use {task_id}"), true)).toMatchObject({ kind: "block" });
  });
});

describe("validate-template-substitution — the Claude Code hook", () => {
  const brief = (prompt: string): ImplementationBrief => ({
    taskId: "T2",
    agent: "code-implementer-agent",
    dispatch: { kind: "initial-implementation", taskId: "T2", semanticAttempt: 1, promptAppendix: null },
    prompt,
  });
  const spawn = (prompt: string) => JSON.stringify({
    tool_name: "Agent",
    tool_input: { subagent_type: "loom:code-implementer-agent", prompt },
    session_id: "session",
  });

  function withState<T>(run: () => Promise<T>): Promise<T> {
    const temp = mkdtempSync(join(tmpdir(), "loom-template-state-"));
    const statePath = join(temp, "active_task_graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    process.env.LOOM_STATE_PATH = statePath;
    writeFileSync(statePath, "{}\n");
    return run().finally(() => {
      if (previous === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previous;
      rmSync(temp, { recursive: true, force: true });
    });
  }

  it("admits a brief marker whose rendered brief quotes any brace text, even a Loom variable's name", async () => {
    const render: RenderTaskBrief = () => ({ ok: true, value: brief("**Task ID:** T2\nab:outcome:{incidentId} at {spec_file_path}") });
    await withState(async () => {
      expect(await createValidateTemplateSubstitutionHandler(render)(spawn("LOOM_IMPLEMENTATION_BRIEF: T2"), [])).toEqual({ kind: "allow" });
    });
  });

  it("refuses a brief marker that cannot render, naming itself", async () => {
    const render: RenderTaskBrief = () => ({ ok: false, error: "Task T2 is completed" });
    await withState(async () => {
      expect(await createValidateTemplateSubstitutionHandler(render)(spawn("LOOM_IMPLEMENTATION_BRIEF: T2"), [])).toEqual({
        kind: "block",
        message: "validate-template-substitution: BLOCKED: the implementation brief marker for T2 cannot expand: Task T2 is completed",
      });
    });
  });

  it("judges a hand-assembled prompt's bytes, never rendering anything", async () => {
    const render: RenderTaskBrief = () => { throw new Error("must not render"); };
    await withState(async () => {
      const handler = createValidateTemplateSubstitutionHandler(render);
      expect(await handler(spawn("Implement at {spec_file_path}"), [])).toMatchObject({ kind: "block" });
      expect(await handler(spawn("Implement ab:outcome:{incidentId}"), [])).toEqual({ kind: "allow" });
    });
  });

  it("resolves LOOM_STATE_PATH in the shell after module import", async () => {
    const temp = mkdtempSync(join(tmpdir(), "loom-template-state-"));
    const statePath = join(temp, "active_task_graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    process.env.LOOM_STATE_PATH = statePath;
    const stdin = spawn("Use {task_id}");
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

  it("every Loom rules file passes the gate — a hand-assembled prompt may quote them", () => {
    // The rules carry diagram roots and format captures (`infra/{system}/`),
    // none of which is a Loom template variable.
    const rulesDir = join(REPO_ROOT, "rules");
    const rules = readdirSync(rulesDir).filter((file) => file.endsWith(".md"));
    expect(rules).toContain("java-patterns.md");
    for (const file of rules) {
      expect({ file, residual: findResidualPlaceholders(readFileSync(join(rulesDir, file), "utf-8")) })
        .toEqual({ file, residual: [] });
    }
  });

  it("{files} → allow — the acceptance runner's own argument placeholder is no Loom template variable", () => {
    expect(ACCEPTANCE_RUNNER_FILES_PLACEHOLDER).toBe("{files}");
    expect(LOOM_TEMPLATE_VARIABLES.has("files")).toBe(false);
    expect(validateTemplate("the argv holds each file as one argument in place of `{files}`")).toBe("allow");
    expect(validateTemplate("in place of {files} for {task_id}")).toBe("block");
  });

  it("JSON objects in prompt → allow (a quote sits between { and the key, so no {word} match)", () => {
    expect(validateTemplate('{"task_id": "value"}')).toBe("allow");
  });

  it("JSON with nested objects → allow", () => {
    expect(validateTemplate('{"outer": {"wave": "value"}}')).toBe("allow");
  });

  it("multiple unsubstituted vars → block, each named", () => {
    expect(findResidualPlaceholders("Run {task_id} with {agent_type} on {wave}")).toEqual(["{task_id}", "{agent_type}", "{wave}"]);
  });

  it("mixed shell vars and unsubstituted vars → block", () => {
    expect(validateTemplate("${HOME}/path with {task_id}")).toBe("block");
  });

  it("nested ${outer_{inner}} → shell var cleaned correctly", () => {
    expect(validateTemplate("${outer_{task_id}}")).toBe("allow");
  });

  it("nested ${foo{bar}} → allow (strip matches to the first }, leaving a lone } that matches no placeholder)", () => {
    // Pins the true nesting behavior: the non-greedy ${...} strip consumes
    // `${foo{wave}` and leaves `}` — NOT `{wave}`.
    expect(validateTemplate("${foo{wave}}")).toBe("allow");
  });

  it("adjacent ${done}{task_id} → block (the strip leaves {task_id}, a genuine residual)", () => {
    expect(validateTemplate("${done}{task_id}")).toBe("block");
  });

  it("JSX/member expression {props.title} → allow", () => {
    expect(validateTemplate("return <h1>{props.title}</h1>")).toBe("allow");
  });

  it("arithmetic expression {width-height} → allow", () => {
    expect(validateTemplate("const gap = {width-height}")).toBe("allow");
  });

  it("plain text without any braces → allow", () => {
    expect(validateTemplate("Implement the authentication feature using JWT tokens")).toBe("allow");
  });

  it("names are case-sensitive: {TASK_ID} and {Wave} are not Loom variables", () => {
    expect(validateTemplate("{TASK_ID} {Wave}")).toBe("allow");
  });

  it("numbers at start of var name → allow (regex requires letter/underscore start)", () => {
    expect(validateTemplate("{1foo}")).toBe("allow");
  });
});
