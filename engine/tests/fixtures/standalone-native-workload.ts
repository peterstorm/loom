import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Representative production-source workload, not dependency closure or review scope authority.
 * Read these exact paths from any source tree (including a non-Git directory): no
 * status, index, ancestry, glob expansion, generated padding, or stored source snapshot.
 * Keep the measured aggregate near 1.5 MiB; the integration test reports actual bytes.
 */
const paths = Object.freeze([
  "engine/src/cli.ts",
  "engine/src/core/context-packet-projection.ts",
  "engine/src/core/context-packets.ts",
  "engine/src/core/defect-family-accounting.ts",
  "engine/src/core/harness-capture.ts",
  "engine/src/core/orchestration-contract/actions.ts",
  "engine/src/core/orchestration-contract/artifacts.ts",
  "engine/src/core/orchestration-contract/bytes.ts",
  "engine/src/core/orchestration-contract/completion.ts",
  "engine/src/core/orchestration-contract/diagnostics.ts",
  "engine/src/core/orchestration-contract/effects.ts",
  "engine/src/core/orchestration-contract/errors.ts",
  "engine/src/core/orchestration-contract/identity.ts",
  "engine/src/core/orchestration-contract/index.ts",
  "engine/src/core/orchestration-contract/publication.ts",
  "engine/src/core/orchestration-contract/roster.ts",
  "engine/src/core/panel-program.ts",
  "engine/src/core/remediation-machine.ts",
  "engine/src/core/review-packet.ts",
  "engine/src/core/reviewer-contract.ts",
  "engine/src/core/reviewer-protocol.ts",
  "engine/src/core/standalone-disposition-machine.ts",
  "engine/src/core/standalone-lineage-contract.ts",
  "engine/src/core/standalone-lineage.ts",
  "engine/src/core/standalone-review-machine.ts",
  "engine/src/core/standalone-review.ts",
  "engine/src/core/standalone-successor-reviewer.ts",
  "engine/src/handlers/helpers/programs/helpers.ts",
  "engine/src/handlers/helpers/programs/program-result.ts",
  "engine/src/handlers/helpers/programs/remediation.ts",
  "engine/src/handlers/helpers/programs/standalone-disposition-source.ts",
  "engine/src/handlers/helpers/programs/standalone-disposition.ts",
  "engine/src/handlers/helpers/programs/standalone-evidence.ts",
  "engine/src/handlers/helpers/programs/standalone-source.ts",
  "engine/src/handlers/helpers/programs/standalone-successor-registration.ts",
  "engine/src/handlers/helpers/programs/standalone-successor-source.ts",
  "engine/src/handlers/helpers/programs/standalone.ts",
  "engine/src/orchestration/harness-capture-runtime.ts",
  "engine/src/orchestration/no-follow-fs.ts",
  "engine/src/orchestration/remediation-candidate.ts",
  "engine/src/orchestration/run-directory-handle.ts",
  "engine/src/orchestration/session-run-bindings.ts",
  "engine/src/orchestration/standalone-panel-context.ts",
  "pi/extension.ts",
  "pi/transcript-adapter.ts",
  "scripts/read-context-packet.ts",
]);

export function representativeNativeWorkload(sourceRoot: string) {
  return Object.freeze(paths.map(path => Object.freeze({ path, bytes: readFileSync(join(sourceRoot, path)) })));
}
