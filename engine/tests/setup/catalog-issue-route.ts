/**
 * Vitest setup file (registered in `vitest.config.ts`): before every test
 * file, pin this worker's ambient reviewer issue route to the catalog route.
 * An ambient Pi handshake (a wrapper session running the suite under the
 * qualified-local model) therefore never reaches an in-process route election
 * or a CLI child's spread environment, whichever fixtures a suite imports and
 * in whatever order. Suites opt into another route explicitly with
 * `withRouteEnv` (tests/fixtures/issue-route-env.ts).
 */
import { scrubAmbientIssueRoute } from "../fixtures/issue-route-env";

scrubAmbientIssueRoute();
