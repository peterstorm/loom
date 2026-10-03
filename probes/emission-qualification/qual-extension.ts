/**
 * FR-002 qualification probe — child extension.
 *
 * Registers the four REAL emission tools (the frozen registry's exact bytes,
 * tool names, and the production constrained-sampling request shape
 * `strict: "prefer"`) and points the desktop-vllm provider at the driver's
 * recording proxy, so every wire request the child sends is captured verbatim
 * while the upstream server sees a normal request.
 *
 * Action methods run inside session_start (loading-time action calls are
 * refused by pi). The execute shell mirrors the production contract: append
 * the received arguments as an observable record, return a minimal
 * terminating acknowledgment, and THROW for refusals (returning never sets
 * isError).
 */

import { EMISSION_TOOL_SPECS, frozenPayloadSchemaParameters, type EmissionToolSpec } from "../../engine/src/core/emission-tool";

const proxyBaseUrl = process.env.QUAL_PROXY_BASE_URL ?? "";

const TOOL_DEFS: readonly { kind: keyof typeof EMISSION_TOOL_SPECS; version: string; spec: EmissionToolSpec }[] = [
  { kind: "reviewer-payload", version: "v2", spec: EMISSION_TOOL_SPECS["reviewer-payload"] },
  { kind: "reviewer-payload", version: "v3", spec: EMISSION_TOOL_SPECS["reviewer-payload"] },
  { kind: "judge-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["judge-verdict"] },
  { kind: "refutation-verdict", version: "v1", spec: EMISSION_TOOL_SPECS["refutation-verdict"] },
];

export default function (pi) {
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
      // v2 and v3 share the reviewer-payload spec, so their tool names carry
      // the version suffix; the single-version verdict kinds keep the exact
      // production tool name.
      const uniqueName = version === "v2" || version === "v3"
        ? `${spec.toolName}_${version}`
        : spec.toolName;
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
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
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
