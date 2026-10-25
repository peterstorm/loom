/**
 * The engine-issued owner map and second-copy rule (plan AD-9; FR-022..FR-026).
 *
 * A Wave review packet for a Task that touches an owned Invariant's family
 * carries, as one fixed (digest-bound) section labelled `OWNER_MAP_SECTION`,
 * each touched Invariant's id, title, statement, owner module, sibling entry
 * points and matrix test, the `<plan file>#INV-N` contract a second copy
 * violates, and the fixed `SECOND_COPY_RULE`. Reviewer guidance is frozen
 * archived text, so this obligation has to arrive in the packet itself.
 *
 * Pure: which obligations a Task touches is decided by `obligations.ts`
 * (INV-3's owner); this module only renders the ones it is given.
 */

import type { WaveReviewRole } from "../agent-catalog-projections";
import type { NonEmpty } from "../orchestration-contract";
import type { OwnerObligation } from "./types";

/** The byte-section label of the owner map in a Wave review packet. */
export const OWNER_MAP_SECTION = "owner-map";

/** The reviewer roles whose packets carry the owner map (FR-022); every other role's packet is unchanged.
 *  Both are Wave review roles: `code-reviewer` is on every roster, and an owner-mapped Task's roster
 *  appends `architecture-tech-lead` (ADR-0047), so each role named here is actually issued. */
export const OWNER_MAP_ROLES = Object.freeze(["code-reviewer", "architecture-tech-lead"] as const satisfies readonly WaveReviewRole[]);

/** Whether `role` is owed the owner map. */
export const isOwnerMapRole = (role: string): boolean => (OWNER_MAP_ROLES as readonly string[]).includes(role);

/**
 * The second-copy rule, fixed text (FR-025, FR-026). `<plan file>#INV-N` is
 * spelled out per Invariant in the map above it.
 */
export const SECOND_COPY_RULE = [
  "A diff that implements a declared-owned Invariant's predicate outside its owner module is a second copy, and a finding. " +
    "Cite `<plan file>#INV-N` — the contract line listed for that Invariant above — as the violated contract.",
  "Rate it critical when the copy's behavior diverges from the owner's on some input: name that diverging input as the consequence.",
  "Rate it advisory when the copy is behaviorally identical to the owner: it is still a second copy, to be replaced by a call to the owner module.",
  "The existing severity rules and the Refutation Panel apply unchanged to second-copy findings.",
].join("\n\n");

const code = (path: string): string => `\`${path}\``;

function invariantBlock(planFile: string, obligation: OwnerObligation): string {
  const { invariant, title, statement, owner, siblings, matrixTest } = obligation;
  return [
    `### ${invariant}: ${title}`,
    "",
    `**Statement:** ${statement ?? "none declared"}`,
    `**Owner module:** ${code(owner)}`,
    siblings.length === 0
      ? "**Sibling entry points:** none"
      : ["**Sibling entry points:**", ...siblings.map(({ path, note }) => `- ${code(path)}${note === null ? "" : ` — ${note}`}`)].join("\n"),
    `**Matrix test:** ${code(matrixTest)}`,
    `**Contract a second copy violates:** ${code(`${planFile}#${invariant}`)}`,
  ].join("\n");
}

/**
 * The owner-map section text for `obligations`, in the order given, citing
 * `planFile` exactly as the TaskGraph records it.
 */
export function renderOwnerMapSection(planFile: string, obligations: NonEmpty<OwnerObligation>): string {
  return [
    "## Owner map (engine-issued)",
    `The plan ${code(planFile)} gives each Invariant below one owner module. This Task touches each one's family: ` +
      "the rule is implemented once, in the owner module, and every sibling entry point calls it.",
    ...obligations.map((obligation) => invariantBlock(planFile, obligation)),
    "## Second-copy rule",
    SECOND_COPY_RULE,
  ].join("\n\n") + "\n";
}
