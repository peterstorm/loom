/**
 * The one substitution whose output the state guard can know: `cat` reading a
 * QUOTED heredoc, standing as an entire double-quoted word —
 * `gh pr create --body "$(cat <<'EOF' … EOF)"`. Before, every substitution's
 * output was the opaque wildcard, so a PR body written this way blocked under
 * a live TaskGraph (G4 slice 2 re-pilot, N9), and an apostrophe in the body
 * made the span unparseable. Every other shape keeps the fail-closed wildcard.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { guardStateFileDecision } from "../../src/core/guard-state-file";
import { findClosingParen, scanSubstitutions, staticHeredocCat } from "../../src/core/shell-substitution";
import { MODERN_BASH } from "../fixtures/modern-bash";

const decision = (command: string) => guardStateFileDecision(command).kind;

describe("staticHeredocCat (pure)", () => {
  it("reads the literal and the exact closing paren of a quoted cat heredoc", () => {
    const command = `x "$(cat <<'EOF'\nit's (a) \`body\`\nEOF\n)" y`;
    const start = command.indexOf("$(") + 2;
    const found = staticHeredocCat(command, start);
    expect(found).toEqual({ literal: "it's (a) `body`", close: command.indexOf(')"') });
    expect(findClosingParen(command, start)).toBe(found!.close);
  });

  it("strips leading tabs for <<- and accepts a double-quoted delimiter", () => {
    expect(staticHeredocCat(`$(cat <<-'D'\n\tone\n\t\ttwo\n\tD\n)`, 2)?.literal).toBe("one\ntwo");
    expect(staticHeredocCat(`$(cat <<"D"\nhi\nD\n)`, 2)?.literal).toBe("hi");
  });

  it.each([
    ["an unquoted delimiter", `$(cat <<EOF\nhi\nEOF\n)`],
    ["another command", `$(sh <<'EOF'\nhi\nEOF\n)`],
    ["a pipe on the opener line", `$(cat <<'EOF' | sh\nhi\nEOF\n)`],
    ["an argument after the delimiter", `$(cat <<'EOF' file\nhi\nEOF\n)`],
    ["no terminator", `$(cat <<'EOF'\nhi\n)`],
    ["text after the terminator", `$(cat <<'EOF'\nhi\nEOF\necho x\n)`],
    ["a partly quoted delimiter", `$(cat <<'E'OF\nhi\nEOF\n)`],
  ])("is null for %s", (_label, command) => {
    expect(staticHeredocCat(command, 2)).toBeNull();
  });

  it("reports a known word only for a quoted cat heredoc that is a whole double-quoted word", () => {
    const contexts = (command: string) => {
      const seen: string[] = [];
      scanSubstitutions(command, (_body, context) => {
        seen.push(context.kind === "known-word" ? `known:${context.literal}` : "opaque");
        return "";
      });
      return seen;
    };
    expect(contexts(`a "$(cat <<'E'\nx\nE\n)" b`)).toEqual(["known:x"]);
    expect(contexts(`a x"$(cat <<'E'\nx\nE\n)"`)).toEqual(["opaque"]);
    expect(contexts(`a "$(cat <<'E'\nx\nE\n)"/y`)).toEqual(["opaque"]);
    expect(contexts(`a $(cat <<'E'\nx\nE\n)`)).toEqual(["opaque"]);
    expect(contexts(`a "pre $(cat <<'E'\nx\nE\n)"`)).toEqual(["opaque"]);
    expect(contexts(`a "$(cat notes.md)" b`)).toEqual(["opaque"]);
    expect(contexts("a \"`cat x`\" b")).toEqual(["opaque"]);
  });

  // The recognized span and literal must be what bash itself produces. Needs
  // bash >= 4: 3.2 cannot parse a heredoc whose body holds an apostrophe
  // inside `$(…)` at all (a syntax error, so nothing runs).
  it.skipIf(MODERN_BASH === null)("agrees with real bash on the literal output", () => {
    const literal = "it's (a) `body` $(not run) \"q\"";
    const command = `printf '%s' "$(cat <<'EOF'\n${literal}\nEOF\n)"`;
    const bash = spawnSync(MODERN_BASH ?? "bash", ["-c", command], { encoding: "utf8" });
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe(literal);
    expect(staticHeredocCat(command, command.indexOf("$(") + 2)?.literal).toBe(literal);
  });
});

describe("guard decision for heredoc substitutions", () => {
  it.each([
    ["a PR body as a whole quoted word", `gh pr create --title "x" --body "$(cat <<'EOF'\nUses \`bun x.ts\` (y) and it's fine.\nEOF\n)"`],
    ["a <<- body", `gh pr create --body "$(cat <<-'EOF'\n\thello\n\tEOF\n)"`],
    ["a double-quoted delimiter", `gh pr create --body "$(cat <<"EOF"\nhello\nEOF\n)"`],
    ["a commit message", `git commit -q -m "$(cat <<'EOF'\nfix: it's done\nEOF\n)"`],
  ])("allows %s", (_label, command) => {
    expect(decision(command)).toBe("allow");
  });

  it.each([
    ["a body naming guarded state", `gh pr create --body "$(cat <<'EOF'\nsee .claude/state/active_task_graph.json\nEOF\n)"`],
    ["output completing a guarded literal before it", `rm -rf .claude/stat"$(cat <<'E'\ne\nE\n)"`],
    ["output completing a guarded literal after it", `rm -rf "$(cat <<'E'\n.claude\nE\n)"/state`],
    ["an unquoted substitution (split and globbed)", `rm -rf $(cat <<'E'\n.claude/state\nE\n)`],
    ["an unquoted delimiter (expanding body)", `foo --body "$(cat <<EOF\nhello\nEOF\n)"`],
    ["a cat of a file (unknowable output)", `foo --body "$(cat notes.md)"`],
    ["a heredoc fed to a shell", `foo "$(sh <<'E'\nrm .claude/state/active_task_graph.json\nE\n)"`],
    ["a pipe to a shell on the opener", `foo "$(cat <<'E' | sh\nrm .claude/state/x\nE\n)"`],
    ["commands after the terminator", `foo "$(cat <<'E'\nhi\nE\necho x\n)"`],
  ])("still blocks %s", (_label, command) => {
    expect(decision(command)).toBe("block");
  });
});
