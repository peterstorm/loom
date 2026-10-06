/**
 * FR-002 qualification probe — child extension.
 *
 * Registers the four REAL emission tools — the frozen registry's exact schema
 * bytes and the production constrained-sampling request shape
 * `strict: "prefer"` — and points the desktop-vllm provider at the driver's
 * recording proxy, so every wire request the child sends is captured verbatim
 * while the upstream server sees a normal request. Tool NAMES follow
 * `probeRegisteredToolName`: the single-version verdict kinds keep their
 * production names, while reviewer v2/v3 (which share one production name)
 * carry a version suffix so both can register at once.
 *
 * Action methods run inside session_start (loading-time action calls are
 * refused by pi). The execute shell mirrors the production contract: append
 * the received arguments as an observable record, return a minimal
 * terminating acknowledgment, and THROW for refusals (returning never sets
 * isError).
 */

import { EMISSION_TOOL_SPECS, frozenPayloadSchemaParameters, type EmissionSchemaVersion, type EmissionToolSpec } from "../../engine/src/core/emission-tool";

/**
 * The name the child registers one registry cell under — the single source
 * the committed manifest (`fixture-manifest.mts`) derives its
 * `registeredToolName` from, so the driver can never look for a tool the
 * child did not register.
 */
export const probeRegisteredToolName = (spec: EmissionToolSpec, version: EmissionSchemaVersion): string =>
  version === "v2" || version === "v3" ? `${spec.toolName}_${version}` : spec.toolName;

/** The part of Pi's extension API this child uses: one narrow port, faked by the manifest test. */
export type QualProbePi = Readonly<{
  on: (event: "session_start", handler: () => Promise<void>) => void;
  registerProvider: (name: string, config: Readonly<{ baseUrl: string }>) => void;
  registerTool: (tool: Readonly<{
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: readonly string[];
    parameters: unknown;
    constrainedSampling: Readonly<{ type: "json_schema"; strict: "prefer" }>;
    execute: (toolCallId: string, params: unknown, ...rest: readonly unknown[]) => Promise<unknown>;
  }>) => void;
  appendEntry: (customType: string, data: unknown) => void;
}>;

const proxyBaseUrl = process.env.QUAL_PROXY_BASE_URL ?? "";

const TOOL_DEFS: readonly { kind: keyof typeof EMISSION_TOOL_SPECS; version: EmissionSchemaVersion; spec: EmissionToolSpec }[] = [
  { kind: "reviewer-payload", version: "v2", spec: EMISSION_TOOL_SPECS["reviewer-payload"] },
  { kind: "reviewer-payload", version: "v3", spec: EMISSION_TOOL_SPECS["reviewer-payload"] },
  { kind: "judge-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["judge-verdict"] },
  { kind: "refutation-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["refutation-verdict"] },
];

export default function (pi: QualProbePi): void {
  pi.on("session_start", async () => {
    // Route override ONLY — the models catalog (incl. the served v14 id and
    // its compat flags) stays exactly as configured.
    pi.registerProvider("desktop-vllm", { baseUrl: proxyBaseUrl });

    for (const { kind, version, spec } of TOOL_DEFS) {
      const schemaVersion = spec.schemaVersions[version];
      if (!schemaVersion) {
        // A silently dropped tool looks identical to a route that never ran;
        // the driver's stderr capture (report.stderr) carries the reason.
        process.stderr.write(`loom(emission-qual): skipping ${kind} ${version} — the frozen registry carries no such schema version\n`);
        continue;
      }
      const uniqueName = probeRegisteredToolName(spec, version);
      pi.registerTool({
        name: uniqueName,
        label: `Emission ${kind} ${version}`,
        description: `Emit the frozen ${kind} ${version} payload. Parameters ARE the frozen schema.`,
        promptSnippet: `Emit the structured ${kind} (${version}) payload via ${uniqueName}.`,
        promptGuidelines: [
          `Use ${uniqueName} when asked to emit the ${kind} ${version} payload; emit exactly one tool call with the requested JSON as arguments.`,
        ],
        parameters: frozenPayloadSchemaParameters(schemaVersion.schemaBytes),
        constrainedSampling: { type: "json_schema", strict: "prefer" },
        async execute(_toolCallId, params) {
          pi.appendEntry("loom-emission-qual-args", { tool: uniqueName, kind, version, args: params });
          return {
            content: [{ type: "text", text: "payload acknowledged" }],
            details: {},
            terminate: true,
          };
        },
      });
    }
  });
}
