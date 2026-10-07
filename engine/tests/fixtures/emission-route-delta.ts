/**
 * Comparing the emission-route and extraction-route renderings of one issued
 * task: the route delta is exactly the descriptor line and the appended
 * tool-primary instruction, and run roots differ per fixture project.
 */
import { emissionToolPrimaryInstruction, renderEmissionDescriptor } from "../../src/core/issued-emission-capability";

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
