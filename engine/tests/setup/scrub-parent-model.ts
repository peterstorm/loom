/**
 * Vitest setup file (registered in `vitest.config.ts`): before every test
 * file, clear this worker's ambient parent model (PI_PROVIDER, PI_MODEL,
 * PI_REASONING_LEVEL). Spawn-time routing reads the parent model from them
 * (`parentModelRefFromEnv`), and fixture Pi sessions spread process.env into
 * every CLI child, so a wrapper Pi session running the suite would otherwise
 * leak its own model into whichever suites happen to spawn. Suites set a
 * parent model explicitly with `withEnvOverlay`
 * (tests/fixtures/env-overlay.ts).
 */
import { scrubAmbientParentModel } from "../fixtures/env-overlay";

scrubAmbientParentModel();
