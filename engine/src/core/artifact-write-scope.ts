/**
 * Artifact write policy for non-implementation loom-owned agents — one policy,
 * two harnesses.
 *
 * Pure policy: which non-implementation loom-owned spawns may WRITE, and which
 * artifact directories they may target — the spec and plan trees, plus the
 * lint-rule dirs for architecture.
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
 * The decision functions perform no I/O, clock, or randomness, and importing
 * this module is side-effect-free: `PHASE_AGENT_MAP` comes from the pure
 * model-profiles leaf (the catalog-derived projections), not from `config.ts`
 * — whose initialization resolves the Task Graph through filesystem and Git
 * probes. Runtime discovery still lives in config, exactly where this module
 * never reaches.
 */

import { PHASE_AGENT_MAP } from "./model-profiles";
import { stripNamespace } from "../utils/strip-namespace";
import type { LoomAgentName } from "./model-profiles";
import type { Phase } from "../types";

/**
 * `.claude/specs/…` / `.claude/plans/…` path tokens in a phase prompt
 * (template variables are substituted before spawn, so these are concrete
 * artifact paths). A token ending in a filename scopes to its directory; a
 * trailing slash already denotes a directory; a bare `.claude/specs` or
 * `.claude/plans` mention scopes the whole artifact dir (fallback
 * granularity). `deriveArtifactWriteScope` confines mentions to the role's
 * roots, so a read-only mention can add an in-root dir but never escape them.
 */
const ARTIFACT_PATH_TOKEN = /(?:^|[^A-Za-z0-9_./{}-])((?:\.\.\/)*\.claude\/(?:specs|plans)(?:\/[A-Za-z0-9._/{}:-]*)?)/g;

/** Repo-relative artifact roots. Every spec-phase and panel-run artifact
 *  lives under the spec tree (`.claude/specs/<slug>/`, including the
 *  panel-runs subtree the interview digest and designer candidates occupy);
 *  architecture's plan lives under the plan tree. */
const SPEC_ARTIFACT_ROOT = ".claude/specs";
const PLAN_ARTIFACT_ROOT = ".claude/plans";

/** A writing phase's role roots: every dir its template promises it writes
 *  (commands/templates/phase-*.md). ONE representation of the phase-writer
 *  policy: the KEYS are exactly the artifact-writing phases, so the writer set
 *  and its roots can never diverge, and a phase absent from the map is a
 *  non-writer (decompose is read-only and receives no grant even when its
 *  prompt names artifact paths). Architecture writes the plan, may write under
 *  the spec tree (`{slug}/`, and panel-run dirs in finalize), and writes
 *  checkable-invariant lint rules into the harness's rules dir
 *  (`.claude/linter/rules/`, or `.pi/linter/rules/` under Pi). Every other
 *  writing phase writes only into the spec tree — plan-alignment's report goes
 *  to `{spec_dir}`. */
const PHASE_ARTIFACT_ROOTS: Readonly<Partial<Record<Phase, readonly string[]>>> = Object.freeze({
  brainstorm: Object.freeze([SPEC_ARTIFACT_ROOT]),
  specify: Object.freeze([SPEC_ARTIFACT_ROOT]),
  clarify: Object.freeze([SPEC_ARTIFACT_ROOT]),
  "plan-alignment": Object.freeze([SPEC_ARTIFACT_ROOT]),
  architecture: Object.freeze([PLAN_ARTIFACT_ROOT, SPEC_ARTIFACT_ROOT, ".claude/linter/rules", ".pi/linter/rules"]),
});

/** The panel agents whose run contract includes writing an artifact — the
 *  WAVE_REVIEW_AGENTS pattern: a literal roster typed against the catalog, so a
 *  renamed or typo'd agent name fails compilation instead of silently emptying
 *  both harnesses' panel admission. Judges are deliberately absent: their
 *  prompts name candidate paths to READ, and write capability would let a
 *  compromised judge rewrite candidate files the finalizer reads verbatim.
 *  Tested against UNTRUSTED agent names, hence the string-keyed set. */
const PANEL_ARTIFACT_WRITERS: ReadonlySet<string> = new Set([
  "arch-interviewer-agent",
  "arch-designer-agent",
] as const satisfies readonly LoomAgentName[]);

/** Panel writers' role-wide root: every panel run lives under the spec tree. */
const PANEL_ARTIFACT_ROOTS: readonly string[] = Object.freeze([SPEC_ARTIFACT_ROOT]);

/** Why an agent may write artifacts at all, carrying its role roots. Not a
 *  writer → `null`. */
type ArtifactWriterRole =
  | Readonly<{ kind: "phase"; roots: readonly string[] }>
  | Readonly<{ kind: "panel"; roots: readonly string[] }>;

/** The one role classifier both harnesses' policies go through. A phase
 *  writer wins over a panel writer (no agent is both today). */
function artifactWriterRole(agent: string): ArtifactWriterRole | null {
  const name = stripNamespace(agent);
  const phase = PHASE_AGENT_MAP[name];
  const phaseRoots = phase === undefined ? undefined : PHASE_ARTIFACT_ROOTS[phase];
  if (phaseRoots !== undefined) return { kind: "phase", roots: phaseRoots };
  return PANEL_ARTIFACT_WRITERS.has(name) ? { kind: "panel", roots: PANEL_ARTIFACT_ROOTS } : null;
}

const isWithin = (root: string, dir: string): boolean => dir === root || dir.startsWith(`${root}/`);

/** Roots the prompt-token grammar (`.claude/specs|plans` only) can never name:
 *  prompt mentions cannot refine them, so a refined scope keeps them whole. */
const promptNameable = (root: string): boolean => /^\.claude\/(?:specs|plans)$/.test(root);

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
 * (PHASE_ARTIFACT_ROOTS phase agents, PANEL_ARTIFACT_WRITERS panel
 * agents) may receive a grant — a read-only agent (judge, verifier,
 * reviewer, decompose, spec-check) gets null even when its prompt names
 * artifact paths. For writers, prompt path tokens refine the scope WITHIN the
 * role's roots — a token outside them (plan-alignment READING the plan) is
 * dropped, so a mention can only narrow, never widen. A bare
 * `.claude/specs`/`.claude/plans` mention is only a granularity fallback
 * and is dropped when the prompt also names a dir beneath that same root.
 * Roots the token grammar cannot name (lint-rule dirs) are kept whole. With no
 * usable token, phase writers get their full roots and panel writers get
 * nothing (their prompts always carry a run-scoped path).
 */
export function deriveArtifactWriteScope(
  agent: string,
  task: string,
): readonly string[] | null {
  const role = artifactWriterRole(agent);
  if (role === null) return null;
  const { roots } = role;

  const derived = scopeFromPathTokens(task).filter((dir) => roots.some((root) => isWithin(root, dir)));
  if (derived.length > 0) {
    // Drop any derived dir that is a strict prefix of another derived dir:
    // `.claude/specs/` in "the panel-run dir under `.claude/specs/`" must
    // not admit every other spec tree.
    const specific = derived.filter((dir) => !derived.some((other) => other !== dir && other.startsWith(`${dir}/`)));
    return [...(specific.length > 0 ? specific : derived), ...roots.filter((root) => !promptNameable(root))];
  }
  return role.kind === "phase" ? roots : null;
}

/**
 * Role-only artifact roots (project-relative dirs) an agent type may write
 * into, or null when the role is not an artifact writer. No prompt refinement:
 * this is the Claude Code policy, where the caller is known only by its
 * recorded agent type. Phase writers get their phase's roots
 * (`PHASE_ARTIFACT_ROOTS` — also Pi's no-token fallback); panel writers get
 * `.claude/specs`.
 */
export function artifactWriteRoots(agent: string): readonly string[] | null {
  return artifactWriterRole(agent)?.roots ?? null;
}
