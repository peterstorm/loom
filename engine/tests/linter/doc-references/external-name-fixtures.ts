/**
 * External names for the tests, minted only through the production parsers
 * (`parseExternalName`, `externalNameIndex`): a fixture the config would
 * refuse throws here instead of reaching the code under test.
 */

import { externalNameIndex, parseExternalName } from "../../../src/linter/doc-references/external-names";
import type { ExternalName, ExternalNameGroup, ExternalNameIndex } from "../../../src/linter/doc-references/types";

/** A name the production parse accepts. */
export function externalName(raw: string): ExternalName {
  const parsed = parseExternalName(raw);
  if (!parsed.ok) throw new Error(`not an external name: ${raw}`);
  return parsed.value;
}

/** A group of names the production parse accepts, with its reason. */
export function externalNameGroup(reason: string, ...names: [string, ...string[]]): ExternalNameGroup {
  const [first, ...rest] = names;
  return { names: [externalName(first), ...rest.map(externalName)], reason };
}

/** The index of groups the production indexing accepts. */
export function indexedNames(...groups: readonly ExternalNameGroup[]): ExternalNameIndex {
  const indexed = externalNameIndex(groups);
  if (!indexed.ok) throw new Error(`not an external-name index: '${indexed.error.name}' listed twice`);
  return indexed.value;
}
