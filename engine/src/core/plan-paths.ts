/**
 * The roles a Task's `file_list` plays in an owned invariant family (owner,
 * sibling entry point, matrix test), matched with the one path rule in
 * `plan-path-match.ts` that plan-binding validation, the Wave Gate's lifecycle
 * artifact check and the implementation brief all share — so a path the
 * validator accepted is the same path the brief tells a Task it changes.
 */

import type { InvariantOwnership, SiblingEntryPoint } from "../types";
import { pathsMatch } from "./plan-path-match";

export type OwnedInvariant = Extract<InvariantOwnership, { kind: "owned" }>;

/** The roles one Task's `file_list` plays in an owned invariant family. */
export type InvariantRoles = Readonly<{
  owner: boolean;
  /** The sibling entry points the file list changes, in declared order. */
  siblings: readonly SiblingEntryPoint[];
  matrixTest: boolean;
}>;

/**
 * Which roles a file list plays in one owned invariant family. Plan
 * validation and the implementation brief both classify through here, so a
 * Task the validator holds to the owner-first rule is the Task the brief
 * calls a sibling.
 */
export function invariantRoles(fileList: readonly string[], ownership: OwnedInvariant): InvariantRoles {
  const changes = (path: string): boolean => fileList.some((file) => pathsMatch(file, path));
  return {
    owner: changes(ownership.owner),
    siblings: ownership.siblings.filter(({ path }) => changes(path)),
    matrixTest: changes(ownership.matrixTest),
  };
}

/** Whether the roles change the family's rule: its owner or a sibling. */
export function changesFamily(roles: InvariantRoles): boolean {
  return roles.owner || roles.siblings.length > 0;
}
