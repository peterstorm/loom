import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunConsoleFixtureName, type BunConsoleFixtureKind } from "../../scripts/bun-console-probe";

/**
 * The recorded Bun console fixtures (ADR-0064), read by release. Every release
 * with a recorded agent console is listed, so a newly recorded release joins
 * every suite that iterates them without an edit here.
 */
const FIXTURES = fileURLToPath(new URL("./", import.meta.url));

const RECORDED = /^bun-(.+)-mixed\.console\.txt$/u;

export const RECORDED_BUN_RELEASES: readonly string[] = readdirSync(FIXTURES)
  .flatMap((name) => RECORDED.exec(name)?.slice(1, 2) ?? [])
  .sort();

/** One recording of `release`, exactly as it was written. */
export const bunFixture = (release: string, kind: BunConsoleFixtureKind): string =>
  readFileSync(join(FIXTURES, bunConsoleFixtureName(release, kind)), "utf8");

/** Whether `release` has a recording of `kind`. */
export const hasBunFixture = (release: string, kind: BunConsoleFixtureKind): boolean =>
  readdirSync(FIXTURES).includes(bunConsoleFixtureName(release, kind));
