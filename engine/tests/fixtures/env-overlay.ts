/**
 * The suites' process-environment overlay scope, and the ambient parent model
 * the Vitest setup file clears with it.
 *
 * Reviewer issuance does not read the parent's model: every catalog profile
 * lowers its Pi binding to the one local route. What stays ambient-sensitive
 * is spawn-time routing: the parent model
 * `utils/model-routing-context.ts parentModelRefFromEnv` reads from
 * PI_PROVIDER/PI_MODEL (with the PI_REASONING_LEVEL that accompanies them in a
 * Pi handshake), and every facade-parent environment (./facade-parent) spreads
 * process.env into its CLI child. The ONE place that ambient parent model is
 * cleared is the Vitest setup file (`tests/setup/scrub-parent-model.ts`,
 * registered in `vitest.config.ts`), before every test file — so a wrapper Pi
 * session running the suite never leaks its own model into a test. A suite
 * that wants a parent model sets it explicitly with `withEnvOverlay`.
 *
 * `withEnvOverlay` is the suites' ONE process-environment overlay scope (the
 * parent model, run-directory roots, the Pi agent marker, `HOME`, `PATH`,
 * any other variable): one apply/restore-in-finally implementation, so no
 * suite keeps its own. `withEnvOverlaySync` is the same scope for a
 * synchronous operation whose result the caller reads without awaiting.
 *
 * Dependency-free on purpose: the setup file imports it before every test
 * file, so it must load no engine module a suite might later `vi.mock`.
 */

/** A process-environment overlay: `undefined` unsets the variable for the operation. */
export type EnvironmentOverlay = Readonly<Record<string, string | undefined>>;

/** No parent model: every variable a Pi handshake names its model by, unset. */
export const NO_PARENT_MODEL_ENV: EnvironmentOverlay = Object.freeze({
  PI_PROVIDER: undefined, PI_MODEL: undefined, PI_REASONING_LEVEL: undefined,
});

function applyOverlay(overlay: EnvironmentOverlay): void {
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Clear the worker's ambient parent model — the setup file's one call,
 *  before any suite body runs. */
export function scrubAmbientParentModel(): void {
  applyOverlay(NO_PARENT_MODEL_ENV);
}

/** The current value of every variable `overlay` touches: the overlay that
 *  restores them, with a variable unset now recorded as `undefined`. */
function restoringOverlay(overlay: EnvironmentOverlay): EnvironmentOverlay {
  return Object.freeze(Object.fromEntries(Object.keys(overlay).map((key) => [key, process.env[key]])));
}

/** Run `operation` under any process-environment `overlay`, restoring every
 *  touched variable afterwards — a variable that was unset before is deleted
 *  again. */
export async function withEnvOverlay<T>(overlay: EnvironmentOverlay, operation: () => T | Promise<T>): Promise<T> {
  const previous = restoringOverlay(overlay);
  try {
    applyOverlay(overlay);
    return await operation();
  } finally {
    applyOverlay(previous);
  }
}

/** `withEnvOverlay` for a synchronous `operation`: its result is returned
 *  as is, and the overlay is lifted before the call returns. */
export function withEnvOverlaySync<T>(overlay: EnvironmentOverlay, operation: () => T): T {
  const previous = restoringOverlay(overlay);
  try {
    applyOverlay(overlay);
    return operation();
  } finally {
    applyOverlay(previous);
  }
}
