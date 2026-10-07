/**
 * Reviewer issue-route election fixtures. Route election is ambient-env
 * sensitive: observedReviewerIssueRoute() reads this process's
 * PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL, and fixturePiEnvironment spreads
 * process.env into every CLI child. Importing ./pi-session pins the ambient
 * route to the catalog route for the whole worker; a suite that never imports
 * it but reads the election in-process calls `scrubAmbientIssueRoute` itself,
 * and any suite opts into another route explicitly with `withRouteEnv`. So an
 * ambient Pi handshake (a wrapper session running the suite under the
 * qualified-local model) never flips the election.
 */
import { emissionToolPrimaryInstruction, renderEmissionDescriptor } from "../../src/core/spawn-admission";

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

/** Pin the worker's ambient state to the catalog route. ./pi-session calls it
 *  on import; a suite that does not import that fixture calls it once at
 *  module top. */
export function scrubAmbientIssueRoute(): void {
  applyOverlay(CATALOG_ROUTE_ENV);
}

/** Run `operation` under `overlay`, restoring every touched variable afterwards. */
export async function withRouteEnv<T>(overlay: EnvironmentOverlay, operation: () => Promise<T>): Promise<T> {
  const previous: EnvironmentOverlay = Object.fromEntries(Object.keys(overlay).map((key) => [key, process.env[key]]));
  try {
    applyOverlay(overlay);
    return await operation();
  } finally {
    applyOverlay(previous);
  }
}

/** A task with its project-local run root replaced by one placeholder, comparable across fixture projects. */
export const normalizeRunRoot = (task: string, root: string): string => task.split(root).join("<RUN_ROOT>");

/**
 * The emission-route task minus exactly the route delta: the descriptor line
 * and the appended tool-primary instruction. Equal to the extraction-route
 * task when the route changes nothing else. `normalizeDescriptor` applies the
 * caller's own identity normalization to the rendered descriptor.
 */
export function withoutEmissionRouteDelta(
  emissionTask: string,
  binding: Parameters<typeof renderEmissionDescriptor>[0],
  contextDigest: Parameters<typeof renderEmissionDescriptor>[1],
  normalizeDescriptor: (descriptor: string) => string = (descriptor) => descriptor,
): string {
  return emissionTask
    .replace(normalizeDescriptor(renderEmissionDescriptor(binding, contextDigest)), "")
    .replace(`\n${emissionToolPrimaryInstruction(binding)}`, "");
}
