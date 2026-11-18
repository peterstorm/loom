import type { Finding } from "../../src/types";
import { findingId } from "./finding-id";

/**
 * A stored code-reviewer Finding with id `id`, anchored to `file` (line 1, or
 * no line when it names no file). Its id is minted through `parseFindingId`,
 * so a malformed fixture id throws.
 */
export function findingFixture(id: string, severity: Finding["severity"], file: string | null = "src/t1.ts"): Finding {
  return { id: findingId(id), agent: "code-reviewer", severity, file, line: file === null ? null : 1, claim: `${id} claim` };
}
