/** Exact lowercase Git object id grammar for SHA-1 and SHA-256 repositories. */
const EXACT_GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isExactGitSha(raw: unknown): raw is string {
  return typeof raw === "string" && EXACT_GIT_SHA.test(raw);
}
