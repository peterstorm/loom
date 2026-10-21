/**
 * A bash >= 4 for differential tests against the real shell, or null when the
 * machine has none. macOS still ships bash 3.2 as `/bin/bash`, which lacks
 * syntax the guard models (brace increments, zero-padded sequences) and
 * mis-parses a here-document inside `$(…)`: it scans the substitution for its
 * closing paren with quote tracking, so an apostrophe in the heredoc body is a
 * syntax error. Pinning against 3.2 would assert those gaps as the contract,
 * so a newer bash is preferred and differential blocks skip when none exists.
 */

import { execFileSync } from "node:child_process";

function modernBashPath(): string | null {
  for (const candidate of ["bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"]) {
    try {
      const major = Number(
        execFileSync(candidate, ["-c", 'printf %s "${BASH_VERSINFO[0]}"'], { encoding: "utf-8" }).trim(),
      );
      if (Number.isInteger(major) && major >= 4) return candidate;
    } catch {
      // Candidate absent or not executable — try the next one.
    }
  }
  return null;
}

export const MODERN_BASH = modernBashPath();
