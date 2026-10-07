/**
 * Reviewer issue-route election environment. Route election is ambient-env
 * sensitive: observedReviewerIssueRoute() reads this process's
 * PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL, and fixturePiEnvironment spreads
 * process.env into every CLI child. The ONE place the ambient route is pinned
 * is the Vitest setup file (`tests/setup/catalog-issue-route.ts`, registered in
 * `vitest.config.ts`), which scrubs it to the catalog route before every test
 * file — so no suite depends on importing a fixture first, and an ambient Pi
 * handshake (a wrapper session running the suite under the qualified-local
 * model) never flips the election. A suite opts into another route explicitly
 * with `withRouteEnv`.
 *
 * Dependency-free on purpose: the setup file imports it before every test
 * file, so it must load no engine module a suite might later `vi.mock`.
 */

/** A process-environment overlay: `undefined` unsets the variable for the operation. */
export type EnvironmentOverlay = Readonly<Record<string, string | undefined>>;

/** The catalog issue route: every election variable unset. */
export const CATALOG_ROUTE_ENV: EnvironmentOverlay = Object.freeze({
  PI_PROVIDER: undefined, PI_MODEL: undefined, PI_REASONING_LEVEL: undefined,
});

/** The qualified-local issue route, which issues emission descriptors. */
export const QUALIFIED_ROUTE_ENV: EnvironmentOverlay = Object.freeze({
  PI_PROVIDER: "desktop-vllm", PI_MODEL: "glm-5.3-flash-spark-tp2-v14", PI_REASONING_LEVEL: "high",
});

function applyOverlay(overlay: EnvironmentOverlay): void {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Pin the worker's ambient state to the catalog route — the setup file's one
 *  call, before any suite body runs. */
export function scrubAmbientIssueRoute(): void {
  applyOverlay(CATALOG_ROUTE_ENV);
}

/** Run `operation` under `overlay`, restoring every touched variable afterwards. */
export async function withRouteEnv<T>(overlay: EnvironmentOverlay, operation: () => T | Promise<T>): Promise<T> {
  const previous: EnvironmentOverlay = Object.fromEntries(Object.keys(overlay).map((key) => [key, process.env[key]]));
  try {
    applyOverlay(overlay);
    return await operation();
  } finally {
    applyOverlay(previous);
  }
}
