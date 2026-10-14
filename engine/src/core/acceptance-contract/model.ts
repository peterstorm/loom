/**
 * The Acceptance Contract's shapes: what a plan's `## Contracts` declares and
 * what the TaskGraph persists. Owned here, re-exported by types.ts beside the
 * other plan shapes; nothing here imports types.ts, so the schema root can
 * name `AcceptanceContract` without a cycle.
 */

import type { ArtifactDigest, NonEmpty } from "../orchestration-contract";

/** One `- path — FR-n, AS-n` line of a contract's `**Acceptance tests:**` list:
 *  a dedicated acceptance test file and the Requirements it decides. */
export type ContractAcceptanceFile = Readonly<{ path: string; anchors: NonEmpty<string> }>;

/** The shared surface a contract freezes: one declarations-only file, or none
 *  with the reason the feature slice needs no shared surface. */
export type ContractTypes =
  | Readonly<{ kind: "file"; path: string }>
  | Readonly<{ kind: "none"; reason: string }>;

/** Why a contract declaration is malformed. Each names exactly one way the plan
 *  text failed the grammar, so validation can say which. */
export type ContractProblem =
  | Readonly<{ kind: "missing-types" }>
  | Readonly<{ kind: "none-without-reason" }>
  | Readonly<{ kind: "reason-with-types-file" }>
  | Readonly<{ kind: "missing-acceptance" }>
  | Readonly<{ kind: "malformed-acceptance"; line: string }>
  | Readonly<{ kind: "invalid-anchor"; path: string; anchor: string }>
  | Readonly<{ kind: "duplicate-acceptance"; path: string }>
  | Readonly<{ kind: "duplicate-anchor"; path: string; anchor: string }>
  | Readonly<{ kind: "supported-domain-not-acceptance"; path: string }>
  | Readonly<{ kind: "unsafe-path"; path: string }>
  | Readonly<{ kind: "entry-point-frozen"; path: string }>
  | Readonly<{ kind: "missing-statement" }>;

/**
 * What a contract declares: the frozen types surface, the acceptance files and
 * the Requirements each decides, the file holding the supported/unsupported
 * table (when there is one), the production entry point the acceptance tests
 * drive (when the plan names one), and the observable behavior consumers rely on. A
 * declaration that is not complete and consistent is `malformed`, carrying at
 * least one problem — never a half-filled declared value.
 */
export type ContractDeclaration =
  | Readonly<{
      kind: "declared";
      types: ContractTypes;
      acceptance: NonEmpty<ContractAcceptanceFile>;
      supportedDomain: string | null;
      /** The production file the acceptance tests reach the code through. Plan
       *  binding only: every claimant must write it or wait for a Task that
       *  does. Never persisted, because the freeze does not depend on it. */
      entryPoint: string | null;
      statement: string;
    }>
  | Readonly<{ kind: "malformed"; problems: NonEmpty<ContractProblem> }>;

export interface PlanContract {
  /** e.g. "CT-1" */
  readonly id: string;
  readonly title: string;
  readonly declaration: ContractDeclaration;
}

/** A testcase the freeze names: its acceptance file, its JUnit name, and the
 *  covered Requirements its name decides. */
export type AcceptanceTestcase = Readonly<{ file: string; name: string; anchors: NonEmpty<string> }>;

/** One frozen path and the digest of the bytes observed red. */
export type FrozenPathDigest = Readonly<{ path: string; sha256: ArtifactDigest }>;

/**
 * The Acceptance Freeze. `awaiting-red` until the contract Wave's gate observes
 * RED; `frozen` with the observed bytes and roster from then on; `revised`
 * after an operator Contract Revision re-stamped the bytes, until the next
 * gate re-records the roster green.
 */
export type AcceptanceFreeze =
  | Readonly<{ state: "awaiting-red" }>
  | Readonly<{ state: "frozen"; wave: number; paths: NonEmpty<FrozenPathDigest>; roster: NonEmpty<AcceptanceTestcase> }>
  | Readonly<{ state: "revised"; paths: NonEmpty<FrozenPathDigest> }>;

/** One operator Contract Revision: why, the bytes before and after, and the
 *  claimant Tasks it returned to revalidation. */
export type ContractRevision = Readonly<{
  revision: number;
  reason: string;
  previous: NonEmpty<FrozenPathDigest>;
  paths: NonEmpty<FrozenPathDigest>;
  revalidatedTaskIds: readonly string[];
}>;

export type AcceptanceContract = Readonly<{
  schemaVersion: 1;
  id: string;
  title: string;
  statement: string;
  /** The one Task that writes every frozen path. */
  contractTask: string;
  types: ContractTypes;
  acceptance: NonEmpty<ContractAcceptanceFile>;
  supportedDomain: string | null;
  freeze: AcceptanceFreeze;
  revisions: readonly ContractRevision[];
}>;

/** The Task fields contract derivation reads. */
export type ContractTaskView = Readonly<{
  id: string;
  wave: number;
  file_list?: readonly string[];
  spec_anchors?: readonly string[];
}>;

/** The Requirement ids a contract may cover — only a functional Requirement or
 *  an Acceptance Scenario can be decided by a test, never an Out-of-Scope
 *  entry. The one grammar the plan parser and the persisted parser both read. */
export const COVERABLE_ANCHOR = /^(?:FR|AS)-\d+$/;

/** The id grammar of a plan contract. */
export const CONTRACT_ID = /^CT-\d+$/;
