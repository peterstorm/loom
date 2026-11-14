import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunConsoleFixtureName, type BunConsoleFixtureKind } from "../../scripts/bun-console-probe";
import { parseBunVersion, type BunVersion } from "../../scripts/bun-version-pin";

/**
 * The recorded Bun console fixtures (ADR-0064), read by release. Every release
 * with a recorded agent console is listed, so a newly recorded release joins
 * every suite that iterates them without an edit here.
 */
const FIXTURES = fileURLToPath(new URL("./", import.meta.url));

/** The directory's file names, read once: recordings are written by the probe, never by a test. */
const LISTING: ReadonlySet<string> = new Set(readdirSync(FIXTURES));

const RECORDED = /^bun-(.+)-mixed\.console\.txt$/u;

/** A recorded file name that names no Bun release is a mistake in the fixtures, not a release to skip. */
const releaseOf = (name: string): readonly BunVersion[] => {
  const spelled = RECORDED.exec(name)?.[1];
  if (spelled === undefined) return [];
  const release = parseBunVersion(spelled);
  if (release === null) throw new Error(`fixture ${name} names no Bun release`);
  return [release];
};

export const RECORDED_BUN_RELEASES: readonly BunVersion[] = [...LISTING].flatMap(releaseOf).sort();

/** One recording of `release`, exactly as it was written. Throws when it was never recorded. */
export const bunFixture = (release: BunVersion, kind: BunConsoleFixtureKind): string =>
  readFileSync(join(FIXTURES, bunConsoleFixtureName(release, kind)), "utf8");

/** One recording of `release`, or null when that release has none of `kind`. */
export const optionalBunFixture = (release: BunVersion, kind: BunConsoleFixtureKind): string | null =>
  LISTING.has(bunConsoleFixtureName(release, kind)) ? bunFixture(release, kind) : null;
