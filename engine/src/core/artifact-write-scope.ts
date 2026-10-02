/**
 * Artifact write policy for non-implementation loom-owned agents — one policy,
 * two harnesses.
 *
 * Pure policy: which non-implementation loom-owned spawns may WRITE, and which
 * `.claude/specs` / `.claude/plans` directories they may target.
 *   - Pi: `deriveArtifactWriteScope` refines the scope from the spawn prompt;
 *     the capability is ISSUED by `pi/write-grant.ts` and ENFORCED per write by
 *     the pi extension.
 *   - Claude Code: `artifactWriteRoots` gives the role-only roots, which
 *     `shouldBlockDirectEdit` enforces against the CALLING subagent's recorded
 *     role (Claude has no prompt-bound grant to refine them).
 * Both answer "may this role write at all?" through one classifier
 * (`artifactWriterRole`), so the harnesses cannot disagree about who writes.
 *
 * Role-driven, not path-driven: an agent's run contract decides whether it
 * may write at all — a judge whose prompt names candidate paths is READING
 * them and receives nothing. Path mentions only REFINE a writer's scope.
 *
 * The decision functions perform no I/O, clock, or randomness. Importing this
 * module is not currently side-effect-free: `PHASE_AGENT_MAP` comes from
 * `config.ts`, whose initialization resolves the Task Graph through filesystem
 * and Git probes. Splitting runtime discovery from Agent policy is tracked as
 * a separate configuration-seam deepening.
 */

import { PHASE_AGENT_MAP } from "../config";
import { stripNamespace } from "../utils/strip-namespace";

/**
 * `.claude/specs/…` / `.claude/plans/…` path tokens in a phase prompt
 * (template variables are substituted before spawn, so these are concrete
 * artifact paths). A token ending in a filename scopes to its directory; a
 * trailing slash already denotes a directory; a bare `.claude/specs` or
 * `.claude/plans` mention scopes the whole artifact dir (fallback
 * granularity). Read-only mentions widen the scope harmlessly.
 */
const ARTIFACT_PATH_TOKEN = /(?:^|[^A-Za-z0-9_./{}-])((?:\.\.\/)*\.claude\/(?:specs|plans)(?:\/[A-Za-z0-9._/{}:-]*)?)/g;

/** Phase agents whose run contract includes writing an artifact. Everything
 *  else PHASE_AGENT_MAP knows (decompose) is read-only and receives no grant
 *  even when its prompt names artifact paths. */
const ARTIFACT_WRITING_PHASES: ReadonlySet<string> = new Set([
  "brainstorm",
  "specify",
  "clarify",
  "plan-alignment",
  "architecture",
]);

/** Panel agents whose run contract includes writing an artifact. They are
 *  not in PHASE_AGENT_MAP, so the phase branch cannot admit them — this set
 *  is the only door for `role: "panel"` agents. Judges are deliberately
 *  absent: their prompts name candidate paths to READ, and a scoped write
 *  grant would let a compromised judge rewrite candidate files the finalizer
 *  reads verbatim. */
const PANEL_ARTIFACT_WRITERS: ReadonlySet<string> = new Set([
  "arch-interviewer-agent",
  "arch-designer-agent",
]);

/** Panel writers' role-wide root: every panel run lives under the spec tree. */
const PANEL_ARTIFACT_ROOTS: readonly string[] = [".claude/specs"];

/** Why an agent may write artifacts at all. Not a writer → `null`. */
type ArtifactWriterRole =
  | Readonly<{ kind: "phase"; phase: string }>
  | Readonly<{ kind: "panel" }>;

/** The one role classifier both harnesses' policies go through. A phase
 *  writer wins over a panel writer (no agent is both today). */
function artifactWriterRole(agent: string): ArtifactWriterRole | null {
  const name = stripNamespace(agent);
  const phase = PHASE_AGENT_MAP[name];
  if (phase !== undefined && ARTIFACT_WRITING_PHASES.has(phase)) return { kind: "phase", phase };
  return PANEL_ARTIFACT_WRITERS.has(name) ? { kind: "panel" } : null;
}

/** Phase-aware fallback when a prompt carries no artifact path: the phase's
 *  canonical artifact dir. Writers without explicit paths get the phase-wide
 *  dir; panel writers without explicit paths get nothing (their prompts
 *  always carry a run-scoped path). */
function phaseFallbackScope(phase: string): readonly string[] | null {
  switch (phase) {
    case "brainstorm":
    case "specify":
    case "clarify":
    case "plan-alignment":
      return [".claude/specs"];
    case "architecture":
      return [".claude/plans"];
    default:
      return null;
  }
}

/** Path tokens → candidate scope dirs: a token ending in a filename scopes
 *  to its directory; trailing slashes are trimmed; duplicates removed. */
function scopeFromPathTokens(task: string): readonly string[] {
  const derived: string[] = [];
  for (const m of task.matchAll(ARTIFACT_PATH_TOKEN)) {
    let token = m[1]!;
    // A `..` segment would let the resolved scope escape its `.claude/specs|plans`
    // confinement into a non-guarded sibling. Legitimate artifact paths never
    // traverse upward, so drop any token that does before it becomes a scope.
    if (token.split("/").includes("..")) continue;
    const lastSlash = token.lastIndexOf("/");
    const name = lastSlash === -1 ? token : token.slice(lastSlash + 1);
    if (name !== "" && !name.endsWith("/") && /\.[A-Za-z0-9]+$/.test(name)) {
      // `spec.md`, `brainstorm.md`, `{date_slug}.md` … → its directory.
      token = lastSlash === -1 ? token : token.slice(0, lastSlash);
    }
    if (token.endsWith("/")) token = token.slice(0, -1);
    if (token !== "" && !derived.includes(token)) derived.push(token);
  }
  return derived;
}

/**
 * Derive the artifact write scope for a non-implementation loom-owned spawn
 * (phase agents and panel writers), or null when the agent should receive no
 * write grant. Scope dirs are resolved against the spawn's cwd at issue
 * time; a scoped grant admits Edit/Write only inside them.
 *
 * Role first: only agents whose contract includes writing an artifact
 * (ARTIFACT_WRITING_PHASES phase agents, PANEL_ARTIFACT_WRITERS panel
 * agents) may receive a grant — a read-only agent (judge, verifier,
 * reviewer, decompose, spec-check) gets null even when its prompt names
 * artifact paths. For writers, prompt path tokens refine the scope; a bare
 * `.claude/specs`/`.claude/plans` mention is only a granularity fallback
 * and is dropped when the prompt also names a specific dir (a wide mention
 * must not widen the grant beyond what the template promises).
 */
export function deriveArtifactWriteScope(
  agent: string,
  task: string,
): readonly string[] | null {
  const role = artifactWriterRole(agent);
  if (role === null) return null;

  const derived = scopeFromPathTokens(task);
  if (derived.length > 0) {
    // Drop any derived dir that is a strict prefix of another derived dir:
    // `.claude/specs/` in "the panel-run dir under `.claude/specs/`" must
    // not admit every other spec tree.
    const specific = derived.filter((dir) => !derived.some((other) => other !== dir && other.startsWith(`${dir}/`)));
    return specific.length > 0 ? specific : derived;
  }
  return role.kind === "phase" ? phaseFallbackScope(role.phase) : null;
}

/**
 * Role-only artifact roots (project-relative dirs) an agent type may write
 * into, or null when the role is not an artifact writer. No prompt refinement:
 * this is the Claude Code policy, where the caller is known only by its
 * recorded agent type. Phase writers get their phase's canonical dir
 * (`.claude/specs` for brainstorm/specify/clarify/plan-alignment,
 * `.claude/plans` for architecture); panel writers get `.claude/specs`.
 */
export function artifactWriteRoots(agent: string): readonly string[] | null {
  const role = artifactWriterRole(agent);
  if (role === null) return null;
  return role.kind === "phase" ? phaseFallbackScope(role.phase) : PANEL_ARTIFACT_ROOTS;
}
