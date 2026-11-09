import { PLAN_BINDINGS_AGREE, type FrozenSignaturesInput } from "../../src/core/implementation-brief";
import type { TaskGraph } from "../../src/types";

/**
 * A Frozen Signatures input over `graph` with nothing observed at any path,
 * no frozen surface read, no unresolved binding, and a plan that agrees with
 * the stamp: what a brief test supplies when its subject is another section.
 * On an unstamped graph the section renders `NO_EXPORT_BINDING_STAMP`, and
 * every typed contract leaves its stubs to the contract Task.
 */
export const unobservedSkeletons = (graph: TaskGraph): FrozenSignaturesInput => Object.freeze({
  graph,
  observations: new Map(),
  surfaces: new Map(),
  unresolved: [],
  planBindings: PLAN_BINDINGS_AGREE,
});
