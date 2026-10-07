/**
 * Issued emission fixtures shared by the emission-capability, spawn-admission,
 * reviewer-retry and Pi emission suites: the ONE binding mint, the frozen
 * registry cells as minted bindings, issued producer claims and routes, the
 * independently issued request reader, and engine-issued spawn task text. One
 * construction per concept, so a registry or descriptor change is one edit
 * here, never several suite-local copies drifting apart.
 */
import {
  issueEmissionBinding,
  type IssuedEmissionBinding,
  type IssuedEmissionBindingOf,
  type IssuedEmissionRequest,
} from "../../src/core/emission-tool";
import {
  renderEmissionDescriptor,
  type IssuedProducerClaim,
  type IssuedSpawnEmissionRoute,
  type IssuedSpawnRequestReader,
} from "../../src/core/issued-emission-capability";
import { AGENT_REQUIRED_SKILLS } from "../../src/core/orchestration-contract";
import { parseContextDigest, type ContextDigest } from "../../src/core/orchestration-contract/identity";
import type { LoomAgentName, PayloadProducerKindName, PiSpawnItem } from "../../src/core/model-profiles";

/** Fixture unwrapping: a refused parse is a fixture bug, thrown loudly. */
export function fixtureValue<T, E>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>): T {
  if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result.error)}`);
  return result.value;
}

/**
 * The ONE binding mint every fixture uses: the registry-certified issued
 * binding for the claims, through `issueEmissionBinding`. The kind parameter
 * carries through, so a reviewer claim mints the path-refined reviewer binding
 * the capture observation takes, with no cast.
 */
export function mintEmissionBinding<K extends PayloadProducerKindName>(
  issued: IssuedEmissionRequest & Readonly<{ kind: K }>,
): IssuedEmissionBindingOf<K> {
  const minted = issueEmissionBinding(issued);
  if (!minted.ok) throw new Error(`fixture binding refused: ${minted.error.code} — ${minted.error.message}`);
  return minted.value;
}

export const CONTEXT_DIGEST: ContextDigest = fixtureValue(parseContextDigest("c0ffee".padEnd(64, "0")));
export const OTHER_CONTEXT_DIGEST: ContextDigest = fixtureValue(parseContextDigest("deadbeef".padEnd(64, "0")));

export const REVIEWER_V2 = mintEmissionBinding({ requestId: "request:emission-v2", kind: "reviewer-payload", version: "v2" });
export const REVIEWER_V3 = mintEmissionBinding({ requestId: "request:emission-v3", kind: "reviewer-payload", version: "v3" });
export const JUDGE_V1 = mintEmissionBinding({ requestId: "request:emission-judge", kind: "judge-verdict", version: "v1" });
export const REFUTATION_V1 = mintEmissionBinding({ requestId: "request:emission-refutation", kind: "refutation-verdict", version: "v1" });

/** Every frozen registry cell, as one minted binding each. */
export const REGISTRY_CELLS: readonly IssuedEmissionBinding[] = [REVIEWER_V2, REVIEWER_V3, JUDGE_V1, REFUTATION_V1];

export const emissionRouteFor = (
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): IssuedSpawnEmissionRoute => Object.freeze({ kind: "emission", binding, contextDigest });

/** Legal issued-claim construction follows the production ADT: v1 carries no
 *  digest; v2/v3 require the binding's frozen digest. */
export const claimOf = (
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): IssuedProducerClaim => {
  const authority = {
    requestId: binding.requestId,
    contextDigest,
    producerKind: binding.kind.kind,
  };
  return binding.version === "v1"
    ? Object.freeze({ ...authority, version: "v1" as const })
    : Object.freeze({ ...authority, version: binding.version, schemaDigest: binding.schemaDigest });
};

/** The reader for a Run Directory holding no independently issued request. */
export const missingIssuedRequest: IssuedSpawnRequestReader = () => ({
  ok: false, error: { message: "no independently issued request in this fixture" },
});

/** The reader for a Run Directory holding exactly one issued request. */
export const issuedFor = (
  agent: LoomAgentName,
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
  route: IssuedSpawnEmissionRoute = emissionRouteFor(binding, contextDigest),
): IssuedSpawnRequestReader => (requestId, digest, role) =>
  requestId === binding.requestId && digest === contextDigest && role === agent
    ? { ok: true, value: { role: agent, claim: claimOf(binding, contextDigest), route } }
    : { ok: false, error: { message: "the fixture's issued authority belongs to another request" } };

/** One spawn item whose task names the role's required Skill. */
export const spawnItem = (agent: LoomAgentName, task?: string): PiSpawnItem => ({
  agent,
  task: task ?? `LOOM_REQUIRED_SKILL: ${AGENT_REQUIRED_SKILLS[agent] ?? ""}\ndo the work`,
});

/** One engine-issued task carrying exact request identity markers, with the
 *  role's required-Skill line intact. */
export const issuedTask = (
  agent: LoomAgentName,
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): string =>
  `LOOM_REQUEST_ID: ${binding.requestId}\n` +
  `LOOM_CONTEXT_DIGEST: ${contextDigest}\n` +
  `LOOM_CONTEXT_PATH: /run/contexts/${contextDigest}.json\n` +
  `LOOM_REQUIRED_SKILL: ${AGENT_REQUIRED_SKILLS[agent] ?? ""}\n` +
  "review the frozen scope";

/** The same issued identity plus its untrusted descriptor projection. */
export const emissionTask = (
  agent: LoomAgentName,
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): string => issuedTask(agent, binding, contextDigest).replace(
  "review the frozen scope",
  `${renderEmissionDescriptor(binding, contextDigest)}review the frozen scope`,
);

export const emissionItem = (
  agent: LoomAgentName,
  binding: IssuedEmissionBinding,
  contextDigest: ContextDigest = CONTEXT_DIGEST,
): PiSpawnItem => spawnItem(agent, emissionTask(agent, binding, contextDigest));
