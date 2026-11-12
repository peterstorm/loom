/**
 * The Standalone Review kind and reviewer-role grammars: the closed sets and
 * their one parsers. A leaf: `standalone-review-scope` (scope and roster
 * policy) and `plan-design-review` (the plan design kind's rules) both read
 * these names, and neither may import the other's module to get them.
 */
import type { LoomAgentName } from "./model-profiles";

/** The Standalone Review kind that reviews an architecture plan's design before decompose (ADR-0070). */
export const PLAN_DESIGN_REVIEW_KIND = "plan-design";

export const STANDALONE_REVIEWER_ROLES = Object.freeze([
  "code-reviewer",
  "silent-failure-hunter",
  "pr-test-analyzer",
  "type-design-analyzer",
  "comment-analyzer",
  "architecture-tech-lead",
  "code-simplifier",
] as const satisfies readonly LoomAgentName[]);
export type StandaloneReviewerRole = (typeof STANDALONE_REVIEWER_ROLES)[number];

/** The one Standalone Review reviewer-role grammar: a role read from stored bytes is one of the seven, or nothing. */
export function parseStandaloneReviewerRole(raw: unknown): StandaloneReviewerRole | null {
  return STANDALONE_REVIEWER_ROLES.find((role) => role === raw) ?? null;
}

const STANDALONE_REVIEW_KINDS = Object.freeze([
  "code", "errors", "tests", "types", "comments", "architecture", "simplify", "all", PLAN_DESIGN_REVIEW_KIND,
] as const);
export type StandaloneReviewKind = (typeof STANDALONE_REVIEW_KINDS)[number];

/** The one review-kind grammar every start input and stored record parses through. */
export function parseStandaloneReviewKind(raw: unknown): StandaloneReviewKind | null {
  return STANDALONE_REVIEW_KINDS.find((kind) => kind === raw) ?? null;
}
