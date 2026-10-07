/**
 * The test-side oracle for the accepted bare Git revision grammar: a lowercase
 * 40-hex (SHA-1) or 64-hex (SHA-256) object id, nothing else. The revision
 * parser properties (review-authority receipt, proof-boundary observation,
 * standalone review scope) share this ONE definition, so a change to the
 * accepted grammar is one edit here. It is deliberately written independently
 * of the production predicate (`src/core/git-sha.ts`), so the properties pin
 * each parser against the grammar rather than against itself.
 */
const BARE_GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Whether `revision` is a bare 40- or 64-hex lowercase Git object id. */
export const isBareGitSha = (revision: string): boolean => BARE_GIT_SHA.test(revision);
