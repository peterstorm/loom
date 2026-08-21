import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { expandBraces, guardStateFileDecision } from "../../src/core/guard-state-file";

const guardDecision = (command: string): "allow" | "block" =>
  guardStateFileDecision(command).kind === "block" ? "block" : "allow";

const GUARDED = ".claude/state/active_task_graph.json";

/**
 * `busyboxExecutesStdin` — the applet classifier inside the heredoc guard.
 *
 * `busybox` is in `HEREDOC_SCRIPT_HEADS`, but unlike every other head there it
 * is a MULTIPLEXER: whether its heredoc body is a script or data depends on the
 * applet name that follows. `busybox sh` executes stdin; `busybox cat` does not.
 * The token `busybox` appeared nowhere in the test suite, so that dispatch —
 * the only thing standing between a busybox-shell heredoc and an unjudged body
 * — was entirely unexercised, while every sibling head in the list carried a
 * dedicated bypass regression.
 */
describe("guard-state-file — busybox applet dispatch decides script vs data", () => {
  it.each([
    ["busybox sh", `busybox sh << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox ash", `busybox ash << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox bash", `busybox bash << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["bare busybox (interactive shell reading stdin)", `busybox << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox sh -s", `busybox sh -s << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["an absolute busybox path", `/bin/busybox sh << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox behind an env prefix", `env X=y busybox sh << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox fed through a pipe", `cat << 'EOF' | busybox sh\nrm ${GUARDED}\nEOF`],
  ])("%s executes its heredoc body as a script → block", (_label, command) => {
    expect(guardDecision(command)).toBe("block");
  });

  it.each([
    ["busybox cat", `busybox cat << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox awk", `busybox awk << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox grep", `busybox grep -f - << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["busybox sed", `busybox sed << 'EOF'\nrm ${GUARDED}\nEOF`],
  ])("%s reads its heredoc body as data → allow", (_label, command) => {
    expect(guardDecision(command)).toBe("allow");
  });

  it("a busybox SHELL applet given an inline program does not read stdin as a script", () => {
    // `-c` supplies the whole program, so the heredoc body is data for it.
    expect(guardDecision(`busybox sh -c 'true' << 'EOF'\nrm ${GUARDED}\nEOF`)).toBe("allow");
    // ...but the inline program itself is still judged.
    expect(guardDecision(`busybox sh -c 'rm ${GUARDED}'`)).toBe("block");
  });
});

/**
 * `MODULE_CONTINUE_FLAGS` — flags that PRELOAD a module and then keep looking
 * for the real program source.
 *
 * `node -r ./x.js` has not yet said where the program comes from, so a bare
 * `node -r ./x.js << EOF` still reads stdin as a script. If these flags were
 * misclassified as program-supplying (like `-e`/`-m`), the body would be scored
 * as inert data and a guarded write inside it would pass. No test named any of
 * them.
 */
describe("guard-state-file — module-preload flags keep stdin as the program source", () => {
  it.each([
    ["perl -M", `perl -MData::Dumper << 'EOF'\nsystem("rm ${GUARDED}")\nEOF`],
    ["perl -m", `perl -mstrict << 'EOF'\nsystem("rm ${GUARDED}")\nEOF`],
    ["node -r", `node -r ./setup.js << 'EOF'\nrequire('fs').rmSync('${GUARDED}')\nEOF`],
    ["node --require", `node --require ./setup.js << 'EOF'\nrequire('fs').rmSync('${GUARDED}')\nEOF`],
    ["node --import", `node --import ./setup.mjs << 'EOF'\nrequire('fs').rmSync('${GUARDED}')\nEOF`],
    ["bun -r", `bun -r ./setup.ts << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["bun --preload", `bun --preload ./setup.ts << 'EOF'\nrm ${GUARDED}\nEOF`],
    ["lua -l", `lua -lmodule << 'EOF'\nos.remove("${GUARDED}")\nEOF`],
    ["luajit -l", `luajit -lmodule << 'EOF'\nos.remove("${GUARDED}")\nEOF`],
    ["tclsh -encoding", `tclsh -encoding utf-8 << 'EOF'\nrm ${GUARDED}\nEOF`],
  ])("%s still executes its heredoc body → block", (_label, command) => {
    expect(guardDecision(command)).toBe("block");
  });

  it("a flag that DOES supply the program makes the body data", () => {
    // The contrast case: -e/-m consume the program, so stdin is input.
    expect(guardDecision(`perl -e 'print 1' << 'EOF'\nrm ${GUARDED}\nEOF`)).toBe("allow");
    expect(guardDecision(`python3 -m json.tool << 'EOF'\nrm ${GUARDED}\nEOF`)).toBe("allow");
  });
});

/**
 * Brace SEQUENCE expansion, differentially pinned against real bash.
 *
 * `sequenceOptions`' zero-padding arithmetic claims in its own comment to be
 * "verified against real bash", but the only padded fixture in the suite was
 * `ls src/file{01..100..3}.ts` asserted as ALLOW — an assertion that holds
 * whether or not the padding is right, because digits can never match an
 * alphabetic guarded literal. So the padding math had no test that could fail.
 *
 * These run the real shell and compare. A guarded literal is reassembled from
 * brace syntax in at least one produced view, so an expansion that differs from
 * bash's is exactly an expansion that misses a real command.
 */
/**
 * The differential pin needs bash >= 4. Brace INCREMENTS (`{a..z..N}`) and
 * zero-padded sequence semantics BOTH arrived in bash 4.0, and macOS still
 * ships 3.2 as `/bin/bash`. Pinning against 3.2 would assert its
 * NON-expansion as the contract — inverting exactly what these fixtures
 * prove — so a newer bash is preferred, and when none exists the differential
 * block is skipped rather than run against a shell that cannot express the
 * syntax under test. The guard's own decisions stay covered unconditionally
 * in the block below.
 */
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

const MODERN_BASH = modernBashPath();

const bashExpand = (pattern: string): string[] =>
  execFileSync(MODERN_BASH ?? "bash", ["-c", `printf '%s\\n' ${pattern}`], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line !== "");

describe.skipIf(MODERN_BASH === null)("guard-state-file — brace sequence expansion matches real bash", () => {
  it.each([
    // Zero-padded ascending/descending, the case the comment claims and nothing checked.
    "{01..10}",
    "{001..010}",
    "{01..100..7}",
    "{10..01}",
    "{010..001..3}",
    // A lone `0` endpoint is NOT a padded form.
    "{0..0}",
    "{0..5}",
    "{0..10}",
    // Signed endpoints: the pad width includes the sign.
    "{-5..-01}",
    "{-05..5}",
    "{-1..-10..3}",
    // Unpadded numerics and steps, including the sign-ignoring and zero-step rules.
    "{1..10}",
    "{1..10..3}",
    "{10..1..3}",
    "{1..5..-1}",
    "{1..5..0}",
    "{+1..+5}",
    // Alphabetic sequences and steps.
    "{a..e}",
    "{a..y..4}",
    "{y..a..4}",
    "{A..F..2}",
    // Comma groups and nesting, so the sequence path is checked in context.
    "{a,b,c}",
    "x{a,b}y",
    "{a,b}{1,2}",
  ])("expands %s exactly as bash does", (pattern) => {
    expect(expandBraces(pattern)?.slice().sort()).toEqual(bashExpand(pattern).slice().sort());
  });

  it.each([
    // Mixed-type endpoints stay literal in bash — no expansion at all.
    "{a..10..2}",
    "{1..z..2}",
    // A brace with neither comma nor sequence is literal.
    "{foo}",
  ])("leaves %s literal, exactly as bash does", (pattern) => {
    expect(expandBraces(pattern)).toEqual(bashExpand(pattern));
  });

  it("pins the padded expansion the guard depends on against real bash", () => {
    // Padding is not decorative: bash expands `{08..10}` to `08 09 10`, so
    // such a line names a real `.claude/state/08` … `10` sweep. Rendering it
    // unpadded (`8 9 10`) would produce views that match nothing under the
    // guarded directory prefix and the write would be allowed.
    expect(bashExpand("{08..10}")).toEqual(["08", "09", "10"]);
  });
});

/**
 * The guard's OWN decisions over the same padded syntax. These assert the
 * blocking behaviour rather than bash's output, so they run on every shell —
 * including macOS's bash 3.2, where the differential block above is skipped.
 */
describe("guard-state-file — padded sequences reach guarded paths", () => {
  it("a zero-padded sequence that REACHES a guarded path is blocked", () => {
    expect(guardDecision("rm -rf .claude/state/backup-{08..10}")).toBe("block");
    expect(guardDecision("rm -rf .claude/state/backup-{008..010..2}")).toBe("block");
  });

  it("padding does not manufacture a match that bash would not produce", () => {
    // The reverse direction: an unrelated padded sweep stays allowed, so the
    // padding rule cannot be satisfied by over-blocking everything numeric.
    expect(guardDecision("rm -rf /tmp/backup-{08..10}")).toBe("allow");
    expect(guardDecision("ls src/file{01..100..3}.ts")).toBe("allow");
  });
});
