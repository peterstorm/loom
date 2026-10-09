/**
 * Comparing the emission-route and extraction-route issuance of one program:
 * issuance itself is parent-independent, the route delta of each issued task
 * is exactly the descriptor line and the appended tool-primary instruction,
 * and run roots differ per fixture project.
 */
import { expect } from "vitest";
import { emissionToolPrimaryInstruction, renderEmissionDescriptor } from "../../src/core/issued-emission-capability";
import { resolveAgentPolicy } from "../../src/core/model-profiles";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { value } from "./parse-result";

type IssuedRequests = readonly Readonly<{ authority: AgentRequestAuthority }>[];

const issuance = ({ authority }: Readonly<{ authority: AgentRequestAuthority }>) => ({ role: authority.role,
  modelProfile: authority.modelProfile, harnessBinding: authority.harnessBinding, requiredSkill: authority.requiredSkill });

/**
 * Issuance is parent-independent: the same program started from a Pi parent
 * (emission) and a Claude Code parent (extraction-only) issues every reviewer
 * the same role, catalog profile, frozen harness binding and required skill,
 * and each profile is the role's catalog policy.
 */
export function expectParentIndependentIssuance(emissionRequests: IssuedRequests, extractionRequests: IssuedRequests): void {
  expect(emissionRequests.map(issuance)).toEqual(extractionRequests.map(issuance));
  for (const { authority } of emissionRequests) {
    expect(authority.modelProfile).toBe(value(resolveAgentPolicy(authority.role)).profile);
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
