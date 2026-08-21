export type DeclaredSkills =
  | { readonly kind: "none" }
  | { readonly kind: "skills"; readonly names: readonly string[] }
  | { readonly kind: "unreadable"; readonly reason: string };

export type AgentSkillPromptCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly missing: readonly string[] };

/** Parse block- or flow-style skills from already-read agent markdown. */
export function parseDeclaredSkills(content: string): DeclaredSkills {
  const normalized = content.replace(/\r\n/g, "\n");
  const fm = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { kind: "unreadable", reason: "agent definition has no YAML frontmatter block" };

  const flow = fm[1]!.match(/^skills:[ \t]*\[([^\]]*)\][ \t]*$/m);
  if (flow) {
    const names = flow[1]!
      .split(",")
      .map((name) => name.trim().replace(/^["']|["']$/g, ""))
      .filter((name) => name !== "");
    return names.length === 0 ? { kind: "none" } : { kind: "skills", names };
  }

  const block = fm[1]!.match(/^skills:[ \t]*\n((?:[ \t]+-[ \t]+.+\n?)*)/m);
  if (!block) return { kind: "none" };
  const names = [...block[1]!.matchAll(/^[ \t]+-[ \t]+(.+)$/gm)]
    .map((match) => match[1]!.trim())
    .filter((name) => name !== "");
  return names.length === 0 ? { kind: "none" } : { kind: "skills", names };
}

export function promptReferencesSkill(prompt: string, skill: string): boolean {
  return prompt.toLowerCase().includes(skill.toLowerCase());
}

/** Validate one spawn prompt against its owning source agent definition. */
export function checkAgentSkillPrompt(agentMarkdown: string, prompt: string): AgentSkillPromptCheck {
  const declared = parseDeclaredSkills(agentMarkdown);
  if (declared.kind === "unreadable") {
    return { ok: false, error: declared.reason, missing: [] };
  }
  if (declared.kind === "none") return { ok: true };
  if (prompt.trim() === "") {
    return {
      ok: false,
      error: `spawn prompt is empty; required skills: ${declared.names.join(", ")}`,
      missing: declared.names,
    };
  }
  const missing = declared.names.filter((skill) => !promptReferencesSkill(prompt, skill));
  return missing.length === 0
    ? { ok: true }
    : {
        ok: false,
        error: `spawn prompt omits required skill(s): ${missing.join(", ")}`,
        missing,
      };
}
