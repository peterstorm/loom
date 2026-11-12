/**
 * The contract-surface lens of a Contract Task's Wave review (ADR-0069).
 *
 * A Contract Task writes its Acceptance Contract's types file, and every Task
 * claiming a covered Requirement then implements against those declarations.
 * The Wave review of the Contract Task is the last review before they do, so
 * its type-design and architecture reviewers are told, in one fixed
 * (digest-bound) packet section labelled `CONTRACT_SURFACE_SECTION`, that the
 * types they are reading are that surface and what to judge in it. Reviewer
 * guidance is frozen archived text, so the framing has to arrive in the packet.
 *
 * This module owns which contract surfaces a Task writes
 * (`reviewedContractSurfaces`) and the section's text. Pure: Wave review
 * issuance decides which packets carry the section.
 */

import type { AcceptanceContract } from "./acceptance-contract";
import type { WaveReviewRole } from "./agent-catalog-projections";
import type { NonEmpty } from "./orchestration-contract";
import type { ExportBinding } from "./skeleton/types";

/** The byte-section label of the contract surface in a Wave review packet. */
export const CONTRACT_SURFACE_SECTION = "contract-surface";

/** The reviewer roles whose packets carry the contract surface; every other role's packet is unchanged.
 *  Both are Wave review roles: `type-design-analyzer` is on every roster, and writing a contract surface
 *  is a reason for the architecture lens, whose roster appends `architecture-tech-lead`, so each role
 *  named here is actually issued. */
export const CONTRACT_SURFACE_ROLES = Object.freeze(
  ["type-design-analyzer", "architecture-tech-lead"] as const satisfies readonly WaveReviewRole[],
);

/** Whether `role` is owed the contract surface. */
export const isContractSurfaceRole = (role: string): boolean => (CONTRACT_SURFACE_ROLES as readonly string[]).includes(role);

/**
 * One Acceptance Contract's surface as its Contract Task's reviewers judge it:
 * the contract, the types file dependents import, and the export bindings the
 * plan ties to that file's aliases, in plan order. A contract that declares no
 * types file has no such surface, so `typesFile` is always a path.
 */
export type ReviewedContractSurface = Readonly<{
  contract: Readonly<Pick<AcceptanceContract, "id" | "title" | "statement">>;
  typesFile: string;
  bindings: readonly ExportBinding[];
}>;

/**
 * The contract surfaces `taskId` writes, in contract order: one per Acceptance
 * Contract whose Contract Task it is and whose types are a file. Empty for
 * every other Task, and for the Contract Task of a contract declaring
 * `**Types file:** none`, which freezes acceptance tests only.
 */
export function reviewedContractSurfaces(
  contracts: readonly AcceptanceContract[],
  bindings: readonly ExportBinding[],
  taskId: string,
): readonly ReviewedContractSurface[] {
  return Object.freeze(contracts.flatMap(({ id, title, statement, contractTask, types }): ReviewedContractSurface[] =>
    contractTask !== taskId || types.kind !== "file" ? [] : [Object.freeze({
      contract: Object.freeze({ id, title, statement }),
      typesFile: types.path,
      bindings: Object.freeze(bindings.filter((binding) => binding.contract === id)),
    })]));
}

/** What the surface's reviewers are asked to judge, fixed text. */
export const CONTRACT_SURFACE_RULE = [
  "Judge the declarations of each types file above as the surface dependents will build on, in addition to your usual review of this Task:",
  [
    "- **Illegal states.** Name each state the declared types can represent that the contract's statement forbids: " +
      "optional fields that are required together, flags that cannot all be true, a union missing its discriminant.",
    "- **Primitive obsession.** Name each `string`, `number` or `boolean` that stands for a distinct domain concept " +
      "(an id, a unit, a status) and that a caller could swap for another of the same primitive.",
    "- **Module shape and seams.** Say whether the file declares what its consumers need and no more, whether each alias " +
      "is something a consumer can implement or call without knowing another module's internals, and whether a type here " +
      "belongs to another contract or to no contract at all.",
    "- **Duplicate policy across the bound exports.** Where two bound exports must decide the same rule, say whether the " +
      "types give that rule one home or leave each export to re-decide it.",
  ].join("\n"),
  "A defect here is cheapest now. Once this Wave's gate freezes these bytes, changing them takes an operator " +
    "Contract Revision, which returns the Tasks already implemented against them to revalidation.",
  "Report each defect as a finding anchored in the types file. The existing severity rules and the Refutation Panel apply unchanged.",
].join("\n\n");

const code = (text: string): string => `\`${text}\``;

function bindingLine({ path, exports }: ExportBinding): string {
  return `- ${code(path)}: ${exports.map(({ name, alias }) => code(`${name}: ${alias}`)).join(", ")}`;
}

function surfaceBlock(planFile: string | null, { contract, typesFile, bindings }: ReviewedContractSurface): string {
  return [
    `### ${contract.id}: ${contract.title}`,
    "",
    `**Statement:** ${contract.statement}`,
    `**Types file:** ${code(typesFile)}`,
    `**Declared in:** ${planFile === null ? `the plan's ${code(contract.id)} block` : code(`${planFile}#${contract.id}`)}`,
    bindings.length === 0
      ? "**Bound exports:** none"
      : ["**Bound exports:** each is implemented by a later Task, typed by the alias after its name", ...bindings.map(bindingLine)].join("\n"),
  ].join("\n");
}

/**
 * The contract-surface section text for `surfaces`, in the order given,
 * citing `planFile` exactly as the TaskGraph records it; a TaskGraph that
 * records none is cited by contract id alone.
 */
export function renderContractSurfaceSection(planFile: string | null, surfaces: NonEmpty<ReviewedContractSurface>): string {
  return [
    "## Contract surface (engine-issued)",
    "This Task is the Contract Task of each Acceptance Contract below. The types file it writes is the surface every Task " +
      "claiming a covered Requirement implements against, and those Tasks wait for this one to complete.",
    ...surfaces.map((surface) => surfaceBlock(planFile, surface)),
    "## What to judge",
    CONTRACT_SURFACE_RULE,
  ].join("\n\n") + "\n";
}
