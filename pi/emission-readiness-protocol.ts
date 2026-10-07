/**
 * The launcher↔child emission readiness protocol (AD-4 / FR-008 / ADR-0014):
 * the ONE owner of everything that crosses between the emission-enabled child
 * (`pi/emission-tool.ts` builds the report, `pi/emission-readiness.ts`
 * registers the command and appends the entry) and the parent launcher
 * (`pi/emission-launch-bridge.ts` discovers and invokes the command,
 * `pi/emission-readiness-gate.ts` parses the report).
 *
 * Three things cross, and only these: the readiness command name, the custom
 * entry type its report travels under, and the report's wire shape. Both sides
 * import them from here, so a rename or a field change is a compile error at
 * the seam — never a runtime `malformed-readiness` refusal discovered by a
 * live launcher. The child mints the report from its honest observations; the
 * gate parses it with the production identity parsers (whose branded result
 * is derived from `EmissionReadinessReport` field by field) and decides.
 *
 * Pure, dependency-free: no Pi import, no engine import, no I/O.
 */

/** The readiness command the launcher discovers and invokes via the RPC
 *  prompt command — extension commands execute without a model request. The
 *  name is the settled barrier protocol's (`probes/emission-readiness`, the
 *  wave-2 acceptance suite): renaming it is a launcher-visible contract
 *  change, not a refactor. */
export const EMISSION_READINESS_COMMAND = "loom-emission-readiness";

/** The custom-entry type the bound readiness payload travels under. The
 *  launcher's gate waits for `entry_appended` events of this type; the
 *  payload shape is `EmissionReadinessReport`, and the barrier parses it with
 *  the production identity parsers. */
export const EMISSION_READINESS_ENTRY_TYPE = "loom-emission-readiness";

/**
 * The bound readiness report on the wire — exactly the ten contract fields the
 * barrier parses (request id, context digest, producer kind, schema version,
 * exact tool name, schema digest, revision, active, child pid, registered
 * tools). The child fills the binding fields from its MINTED binding and the
 * observation fields from its own honest facts; on the launcher side every
 * field is untrusted until the gate's parse.
 */
export type EmissionReadinessReport = Readonly<{
  requestId: string;
  contextDigest: string;
  kind: string;
  version: string;
  toolName: string;
  schemaDigest: string;
  revision: string;
  active: boolean;
  childPid: number;
  registeredTools: readonly string[];
}>;
