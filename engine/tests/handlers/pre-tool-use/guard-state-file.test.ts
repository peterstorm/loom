import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { WHITELISTED_HELPERS, SUBAGENT_DIR, MACHINES_DIR } from "../../../src/config";
import { guardStateFileDecision } from "../../../src/core/guard-state-file";
import { runGuardStateFile, stampCallStart } from "../../../src/handlers/pre-tool-use/guard-state-file";
import { parseSessionId, type SessionRegistry } from "../../../src/machine/evidence";
import { inMemorySessionRegistry } from "../../machine/fake-session-registry";
import type { HookResult } from "../../../src/types";

/**
 * Test the REAL pure guard decision (guardStateFileDecision) — the handler
 * only wraps the task-graph-exists FS check around it.
 */
function guardDecision(command: string): "allow" | "block" {
  return guardStateFileDecision(command).kind === "block" ? "block" : "allow";
}

describe("guard-state-file — property tests", () => {
  it("write operations on state files → block (deny-by-default head check)", () => {
    const writeOps = [
      "> active_task_graph.json",
      ">> active_task_graph.json",
      "mv active_task_graph.json /tmp/",
      "cp active_task_graph.json /tmp/backup",
      "tee active_task_graph.json",
      "sed -i 's/a/b/' active_task_graph.json",
      "perl -i -pe 's/a/b/' active_task_graph.json",
      "dd if=/dev/zero of=active_task_graph.json",
      "sponge active_task_graph.json",
      "chmod 777 active_task_graph.json",
      'python3 -c "open(\'active_task_graph.json\',\'w\')"',
      'python -c "open(\'active_task_graph.json\',\'write\')"',
      'node -e "require(\'fs\').writeFileSync(\'active_task_graph.json\')"',
      'node -e "fs.writeFileSync(\'active_task_graph.json\')"',
    ];

    for (const cmd of writeOps) {
      expect(guardDecision(cmd)).toBe("block");
    }
  });

  it("read commands on state file → allow", () => {
    const readOps = [
      "jq '.tasks' active_task_graph.json",
      "cat active_task_graph.json",
      "head -20 active_task_graph.json",
      "tail -5 active_task_graph.json",
      "wc -l active_task_graph.json",
      "grep 'T1' active_task_graph.json",
      "jq '.current_wave' active_task_graph.json",
    ];

    for (const cmd of readOps) {
      expect(guardDecision(cmd)).toBe("allow");
    }
  });

  it("commands not referencing state files → always allow", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter(
          (s) => !s.includes("active_task_graph") && !s.includes("review-invocations") && !s.includes(SUBAGENT_DIR) && !s.includes(MACHINES_DIR),
        ),
        (cmd) => {
          expect(guardDecision(cmd)).toBe("allow");
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("guard-state-file — edge cases", () => {
  it("empty command → allow", () => {
    expect(guardDecision("")).toBe("allow");
  });

  it("whitelisted helpers bypass guard even with write patterns", () => {
    for (const helper of WHITELISTED_HELPERS) {
      expect(guardDecision(`bun cli.ts helper ${helper} > active_task_graph.json`)).toBe("allow");
      expect(
        guardDecision(`bun \${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts helper ${helper} --wave 2`),
      ).toBe("allow");
    }
  });

  it("a helper name in an echo argument does NOT bypass the guard (substring spoof)", () => {
    expect(guardDecision('echo cleanup-state; echo forged >> active_task_graph.json')).toBe("block");
    expect(guardDecision('echo "complete-wave-gate" >> active_task_graph.json')).toBe("block");
    expect(guardDecision(`echo set-phase && echo forged >> ${SUBAGENT_DIR}/s.evidence.jsonl`)).toBe(
      "block",
    );
  });

  it("a helper name in a comment does NOT bypass the guard", () => {
    expect(guardDecision('echo x >> active_task_graph.json # cleanup-state')).toBe("block");
    expect(guardDecision('# set-phase\necho x >> active_task_graph.json')).toBe("block");
  });

  it("a helper name in a file path does NOT bypass the guard", () => {
    expect(guardDecision("cat /tmp/cleanup-state.txt > active_task_graph.json")).toBe("block");
    expect(guardDecision(`cp /tmp/mark-tests-passed ${SUBAGENT_DIR}/s.machine`)).toBe("block");
  });

  it("a REAL helper invocation on the same line as a forged ledger append still blocks (protected dirs checked first)", () => {
    expect(
      guardDecision(
        `bun cli.ts helper set-phase execute; echo forged >> ${SUBAGENT_DIR}/s.evidence.jsonl`,
      ),
    ).toBe("block");
    expect(
      guardDecision(`bun cli.ts helper cleanup-state && rm -rf ${MACHINES_DIR}`),
    ).toBe("block");
  });

  it("a REAL helper invocation cannot vouch for a task-graph write in ANOTHER segment (segment-scoped allow)", () => {
    // The round-11 fix covered SUBAGENT_DIR/MACHINES_DIR; these pin the
    // task-graph / review-invocations variant of the same smuggle.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase execute && chmod 644 .claude/state/active_task_graph.json && cp /tmp/forged.json .claude/state/active_task_graph.json",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper cleanup-state && sed -i 's/trusted-fail/trusted-pass/' .claude/state/active_task_graph.json",
      ),
    ).toBe("block");
    expect(
      guardDecision('bun cli.ts helper set-phase execute; echo forged > active_task_graph.json'),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper mark-tests-passed T1; jq '.verdict=\"PASSED\"' review-invocations.json | sponge review-invocations.json",
      ),
    ).toBe("block");
    // Non-write helper companions stay allowed — the scoping only bites on
    // write-bearing non-helper segments.
    expect(
      guardDecision("bun cli.ts helper set-phase execute && cat active_task_graph.json"),
    ).toBe("allow");
    expect(
      guardDecision("bun cli.ts helper complete-wave-gate --wave 2 && echo done"),
    ).toBe("allow");
  });

  it("a REAL helper invocation cannot vouch for a command-substitution write (round-13 bypass)", () => {
    // `$(…)` / backticks embed an independently-executed command; the segment
    // is a legitimate helper invocation, so segment-scoping alone missed the
    // smuggled write. Both forms, both state files, must block.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase \"$(sed -i s/trusted-fail/trusted-pass/ .claude/state/active_task_graph.json)\"",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper set-phase `sed -i s/a/b/ active_task_graph.json`",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper cleanup-state \"$(sponge review-invocations.json < /tmp/forged.json)\"",
      ),
    ).toBe("block");
    // A READ substitution (no write pattern) stays allowed — the guard only
    // bites when a write co-occurs with the substitution.
    expect(
      guardDecision("bun cli.ts helper set-phase \"$(jq .current_wave active_task_graph.json)\""),
    ).toBe("allow");
  });

  it("a REAL helper invocation cannot vouch for a variable-indirected write (round-13 bypass)", () => {
    // The state-file literal and the write live in DIFFERENT non-helper
    // segments, so no single segment matches both patterns; the write in a
    // non-helper segment plus a line-wide state-file reference must block.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase && F=active_task_graph.json && sed -i s/x/y/ .claude/state/$F",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper cleanup-state; G=review-invocations.json; sponge .claude/state/$G < /tmp/forged.json",
      ),
    ).toBe("block");
  });

  it("ln / truncate / install on a state file → block (round-13 WRITE_PATTERNS gap)", () => {
    expect(guardDecision("truncate -s0 .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("ln -sf /tmp/forged.json .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("install -m644 /tmp/forged.json .claude/state/active_task_graph.json")).toBe("block");
    // The same tokens smuggled behind a helper prefix also block.
    expect(
      guardDecision("bun cli.ts helper set-phase && truncate -s0 active_task_graph.json"),
    ).toBe("block");
    // Precision (round-14): the anchored/package-manager-excluded tokens no
    // longer over-block a dependency install co-located with a state-file READ.
    expect(guardDecision("npm install && jq .tasks active_task_graph.json")).toBe("allow");
    expect(guardDecision("bun install && cat active_task_graph.json")).toBe("allow");
  });

  it("a REAL helper invocation cannot vouch for a PROCESS-substitution write (round-14 bypass)", () => {
    // `<(…)` / `>(…)` execute their body independently, exactly like `$(…)`,
    // and land inside the helper segment — opaque to segment scoping. The
    // live-verified probe: set-phase with a smuggled sed -i in `<(…)`.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase execute <(sed -i s/trusted-fail/trusted-pass/ .claude/state/active_task_graph.json)",
      ),
    ).toBe("block");
    expect(
      guardDecision(
        "bun cli.ts helper cleanup-state >(tee .claude/state/review-invocations.json)",
      ),
    ).toBe("block");
    // READ-only process substitution stays allowed — the escape only bites
    // when a state-file write co-occurs (same polarity as the `$(…)` read
    // row in the round-13 test above).
    expect(
      guardDecision("bun cli.ts helper set-phase <(jq .current_wave active_task_graph.json)"),
    ).toBe("allow");
    expect(guardDecision("cat <(jq . .claude/state/active_task_graph.json)")).toBe("allow");
  });

  it("bun / perl / ruby eval-writes on state files → block (round-14 WRITE_PATTERNS gap)", () => {
    // The live-verified probes: bun is the one interpreter guaranteed present.
    expect(
      guardDecision("bun -e \"await Bun.write('.claude/state/active_task_graph.json', '{}')\""),
    ).toBe("block");
    expect(
      guardDecision("bun -e \"require('fs').appendFileSync('active_task_graph.json', 'forged')\""),
    ).toBe("block");
    expect(
      guardDecision("bun --eval \"Bun.write('review-invocations.json', '{}')\""),
    ).toBe("block");
    expect(
      guardDecision("perl -e 'open(F, \">active_task_graph.json\"); print F \"{}\"'"),
    ).toBe("block");
    // Flag clusters (`-we`) must not slip past the eval match.
    expect(
      guardDecision("perl -we 'open(F, \">.claude/state/active_task_graph.json\")'"),
    ).toBe("block");
    expect(
      guardDecision("ruby -e 'File.write(\"active_task_graph.json\", \"{}\")'"),
    ).toBe("block");
    // Precision: helper invocations start with `bun ` and must NOT trip the
    // bun eval-write pattern, and a plain `bun test` beside a state-file
    // READ stays allowed (no line-wide false positive).
    expect(guardDecision("bun cli.ts helper set-phase execute")).toBe("allow");
    expect(guardDecision("bun test && jq .current_wave active_task_graph.json")).toBe("allow");
  });

  it("glob / brace state-file paths are caught by the state-DIR guard (round-14 bypass)", () => {
    // The file literal never appears — only the directory does; the dir
    // pattern (derived from the task-graph path's dirname, mirroring the
    // SUBAGENT_DIR/MACHINES_DIR dir guards) must catch the write.
    expect(guardDecision("sed -i s/x/y/ .claude/state/active_task*.json")).toBe("block");
    expect(guardDecision("truncate -s0 .claude/state/*.json")).toBe("block");
    expect(
      guardDecision("cp /tmp/forged.json .claude/state/active_task_{graph,x}.json"),
    ).toBe("block");
    expect(
      guardDecision("sponge .claude/state/review-invocations*.json < /tmp/forged.json"),
    ).toBe("block");
    // Helper-prefixed variant: the glob write lives in a non-helper segment.
    expect(
      guardDecision(
        "bun cli.ts helper set-phase execute && sed -i s/x/y/ .claude/state/active_task*.json",
      ),
    ).toBe("block");
    // Reads through the directory stay allowed.
    expect(guardDecision("ls .claude/state/")).toBe("allow");
    expect(guardDecision("jq .tasks .claude/state/*.json")).toBe("allow");
    expect(guardDecision("cat .claude/state/active_task*.json")).toBe("allow");
  });

  it("UNENUMERATED writers block — the allowlist inversion's whole point", () => {
    // None of these ever appeared in the retired WRITE_PATTERNS denylist;
    // rounds 11-14 each shipped a critical for a writer nobody had listed.
    // Deny-by-default makes the class unrepresentable.
    expect(guardDecision("patch .claude/state/active_task_graph.json < /tmp/evil.diff")).toBe("block");
    expect(guardDecision("rsync /tmp/forged.json .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("shred -u review-invocations.json")).toBe("block");
    expect(guardDecision("awk -i inplace '{gsub(/trusted-fail/,\"trusted-pass\")}1' active_task_graph.json")).toBe("block");
    expect(guardDecision("ex -sc '%s/trusted-fail/trusted-pass/g|x' active_task_graph.json")).toBe("block");
    expect(guardDecision("touch -d '1 hour ago' .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("frobnicate active_task_graph.json")).toBe("block");
    // git restores are verdict forgeries: checkout -- rewrites the work tree.
    expect(guardDecision("git checkout -- .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("git restore .claude/state/active_task_graph.json")).toBe("block");
  });

  it("write-capable 'readers' are NOT allowlisted (flag-level write channels)", () => {
    // Each of these reads by default but owns a file-writing flag/operand:
    // sort -o, uniq <in> <out>, less -o, xxd -r <out>. Membership requires
    // NO write capability under any flags, so they block even in read shape
    // (fail-closed over-block, documented in config.ts).
    expect(guardDecision("sort -o active_task_graph.json active_task_graph.json")).toBe("block");
    expect(guardDecision("sort active_task_graph.json")).toBe("block");
    expect(guardDecision("uniq /tmp/forged.json active_task_graph.json")).toBe("block");
    expect(guardDecision("less -o active_task_graph.json /tmp/forged.json")).toBe("block");
    expect(guardDecision("less active_task_graph.json")).toBe("block");
    expect(guardDecision("xxd -r /tmp/forged.hex .claude/state/active_task_graph.json")).toBe("block");
  });

  it("wrapper/executor commands cannot launder a write (they inherit what they wrap)", () => {
    expect(guardDecision("env sed -i s/trusted-fail/trusted-pass/ active_task_graph.json")).toBe("block");
    expect(guardDecision("timeout 5 sed -i s/x/y/ .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("sudo tee active_task_graph.json < /tmp/forged.json")).toBe("block");
    expect(guardDecision("nohup cp /tmp/forged.json active_task_graph.json")).toBe("block");
    // Exact-head matching: a path-qualified or relative binary never inherits
    // the trust of its PATH-resolved basename.
    expect(guardDecision("./cat active_task_graph.json")).toBe("block");
    expect(guardDecision("/tmp/evil/jq . active_task_graph.json")).toBe("block");
  });

  it("pipe-chains are one trust unit: a guarded token cannot flow into an executor", () => {
    // The path travels through the pipe as DATA and comes out as a write
    // argument (xargs) or a command (sh) — segment-scoped checks alone would
    // miss it because the writing segment is token-free.
    expect(
      guardDecision("echo .claude/state/active_task_graph.json | xargs sed -i s/trusted-fail/trusted-pass/"),
    ).toBe("block");
    expect(
      guardDecision('echo "sed -i s/x/y/ active_task_graph.json" | sh'),
    ).toBe("block");
    expect(
      guardDecision('printf \'Bun.write(".claude/state/active_task_graph.json","{}")\' | bun -'),
    ).toBe("block");
    expect(guardDecision("cat active_task_graph.json | tee /tmp/copy.json")).toBe("block");
    // Read-only chains stay read-only: every segment allowlisted → allow.
    expect(guardDecision("cat active_task_graph.json | jq .tasks")).toBe("allow");
    expect(guardDecision("jq . .claude/state/active_task_graph.json | grep T1 | head -3")).toBe("allow");
    // Chains WITHOUT a guarded token are out of scope even on a guarded line.
    expect(guardDecision("npm install | tee /tmp/log && jq .tasks active_task_graph.json")).toBe("allow");
  });

  it("all output-redirect forms count as writes; fd-dups and quoted '>' do not", () => {
    // `&>`, `3>`, and `>|` slipped past the whitespace-anchored denylist.
    expect(guardDecision("echo forged &> active_task_graph.json")).toBe("block");
    expect(guardDecision("echo forged 3> .claude/state/active_task_graph.json")).toBe("block");
    expect(guardDecision("echo forged >| active_task_graph.json")).toBe("block");
    // fd-dup is not a file write; quoted `>` is argument text. Both were
    // over-blocked by the retired denylist (`jq 'select(.x > 1)'` used to
    // trip the redirect pattern) — the quote-aware check is MORE precise.
    expect(guardDecision("cat active_task_graph.json 2>&1")).toBe("allow");
    expect(guardDecision("jq 'select(.count > 1)' active_task_graph.json")).toBe("allow");
  });

  it("`>&file` redirects stdout+stderr TO THE FILE — not an fd dup (round-15 bypass)", () => {
    // Bash `>&word` where word is not a digit/`-` writes the file; the old
    // check exempted EVERY `>` followed by `&`, so these forged state.
    expect(guardDecision("echo forged >& active_task_graph.json")).toBe("block");
    expect(guardDecision("echo forged >&.claude/state/active_task_graph.json")).toBe("block");
    // The helper vouch never covers a protected-dir `>&` write either — the
    // ledger-forgery variant defeats both hasOutputRedirect call sites.
    expect(
      guardDecision(`bun cli.ts helper set-phase execute >& ${SUBAGENT_DIR}/s.evidence.jsonl`),
    ).toBe("block");
    // Precision: real fd dups stay allowed.
    expect(guardDecision("cat active_task_graph.json >&2")).toBe("allow");
    expect(guardDecision("cat active_task_graph.json 2>&1")).toBe("allow");
  });

  it("`cd` is NOT allowlisted — cwd relocation launders relative writes (round-16 bypass)", () => {
    // `cd <guarded-dir>` re-scopes path resolution: the follow-on writer
    // names no guarded literal (relative names after the cwd moved), so its
    // chain is skipped as out-of-scope. Removing cd from the read-only
    // allowlist blocks the relocation itself.
    expect(guardDecision("cd .claude/state && rm *.json")).toBe("block");
    expect(guardDecision("cd .claude/state && cp /tmp/forged.json active_task*.json")).toBe("block");
    expect(guardDecision("cd .claude/state; sed -i 's/trusted-fail/trusted-pass/' *.json")).toBe("block");
    expect(guardDecision(`cd ${SUBAGENT_DIR} && rm -rf .`)).toBe("block");
    expect(guardDecision("cd .claude/state && n=active_task_; printf FORGED > ${n}graph.json")).toBe("block");
    expect(guardDecision(`cd ${SUBAGENT_DIR} && printf '{}' > sess.evidence.jsonl`)).toBe("block");
    // Precision: cd into an UNGUARDED dir beside a guarded READ stays
    // allowed — the cd chain is out of scope, the read chain is judged
    // normally (reads never need to cd INTO a guarded dir).
    expect(guardDecision("cd /repo && jq . .claude/state/active_task_graph.json")).toBe("allow");
    expect(guardDecision("cd src && grep -r foo .")).toBe("allow");
  });

  it("quote-split literals collapse before pattern tests — quoting cannot launder a guarded name (round-16 bypass)", () => {
    // Bash concatenates adjacent quoted word parts, so the raw text never
    // contains the guarded literal contiguously; pattern tests run against
    // a quote-collapsed view (matching only — fail-closed by construction).
    expect(guardDecision("echo FORGED > .cl'aude'/state/active_'task_graph'.json")).toBe("block");
    expect(guardDecision('rm .cl""aude/state/active_task_gr""aph.json')).toBe("block");
    expect(guardDecision("sed -i 's/x/y/' .cl'aude'/state/active_'task_graph'.json")).toBe("block");
    // Precision: a quoted argument MENTIONING a guarded name is judged (not
    // skipped) and read heads still read.
    expect(guardDecision("jq '.tasks' active_task_graph.json")).toBe("allow");
    expect(guardDecision('grep "active_task_graph" README.md')).toBe("allow");
  });

  it("backslash escapes collapse before pattern tests — `\\x` cannot launder a guarded name (round-17 bypass)", () => {
    // Bash removes an unquoted backslash before an ordinary char (`\a`→`a`),
    // so `.cl\aude` executes against the guarded path. The matching view
    // drops the backslash too (reveal-monotonic, fail-closed).
    expect(guardDecision("echo x > .claude/st\\ate/active_task_graph.json")).toBe("block");
    expect(guardDecision("rm .claude/st\\ate/active_task_gr\\aph.json")).toBe("block");
    expect(guardDecision(`printf '{}' > /tmp/claude-sub\\agents/sess.evidence.jsonl`)).toBe("block");
    expect(guardDecision("cp /tmp/f.json .claude/st\\ate/active_task_graph.json")).toBe("block");
  });

  it("ANSI-C `$'…'` and locale `$\"…\"` quoting decode before pattern tests (round-17 bypass)", () => {
    // Bash decodes `$'\xHH'`/`$'\NNN'` at the shell level, so an escape-encoded
    // guarded path executes against the real file. The matching view decodes
    // it too. Hex encoding of `.claude/state/active_task_graph.json`:
    const hexPath =
      "$'\\x2e\\x63\\x6c\\x61\\x75\\x64\\x65\\x2f\\x73\\x74\\x61\\x74\\x65\\x2f" +
      "\\x61\\x63\\x74\\x69\\x76\\x65\\x5f\\x74\\x61\\x73\\x6b\\x5f\\x67\\x72\\x61\\x70\\x68\\x2e\\x6a\\x73\\x6f\\x6e'";
    expect(guardDecision(`echo FORGED > ${hexPath}`)).toBe("block");
    // Octal encoding of `/tmp/claude-subagents` (evidence-ledger dir):
    const octDir =
      "$'\\57\\164\\155\\160\\57\\143\\154\\141\\165\\144\\145\\55\\163\\165\\142\\141\\147\\145\\156\\164\\163'";
    expect(guardDecision(`printf '{}' > ${octDir}/sess.evidence.jsonl`)).toBe("block");
    // Locale-quoted form `$"…"` is `"…"` with the same literal content.
    expect(guardDecision('echo x > $".claude/state/active_task_graph.json"')).toBe("block");
    // Precision: plain `$'…'` with no escape sequences still resolves to the
    // literal and a read head still reads.
    expect(guardDecision("jq '.tasks' $'active_task_graph.json'")).toBe("allow");
  });

  it("ANSI-C `\\u`/`\\U` hex decode before pattern tests (round-18 coverage — was untested)", () => {
    // The `\u`/`\U` branch of decodeAnsiC had zero coverage: deleting it
    // flipped block→allow with the suite green. Unicode-escaped guarded paths
    // must decode and block, mirroring the hex/octal rows.
    const uPath =
      "$'\\u002e\\u0063\\u006c\\u0061\\u0075\\u0064\\u0065\\u002f\\u0073\\u0074\\u0061\\u0074\\u0065\\u002f" +
      "\\u0061\\u0063\\u0074\\u0069\\u0076\\u0065\\u005f\\u0074\\u0061\\u0073\\u006b\\u005f\\u0067\\u0072\\u0061\\u0070\\u0068\\u002e\\u006a\\u0073\\u006f\\u006e'";
    expect(guardDecision(`echo FORGED > ${uPath}`)).toBe("block");
    const UDir =
      "$'\\U0000002f\\U00000074\\U0000006d\\U00000070\\U0000002f\\U00000063\\U0000006c\\U00000061\\U00000075\\U00000064\\U00000065\\U0000002d\\U00000073\\U00000075\\U00000062\\U00000061\\U00000067\\U00000065\\U0000006e\\U00000074\\U00000073'";
    expect(guardDecision(`printf '{}' > ${UDir}/sess.evidence.jsonl`)).toBe("block");
  });

  it("ANSI-C NUL is dropped, not emitted — `$'\\x00'` cannot split a guarded literal (round-18 bypass)", () => {
    // Bash truncates NUL out of ANSI-C expansion, so `.claude/st$'\\x00'ate`
    // executes against `.claude/state`. decodeAnsiC used to emit a real NUL,
    // inserting a char between the literal's halves and CONCEALING it (live:
    // ALLOW + real forge). All NUL spellings must decode to nothing.
    for (const nul of ["\\x00", "\\0", "\\000", "\\u0000", "\\U00000000"]) {
      expect(guardDecision(`echo FORGED > .claude/st$'${nul}'ate/active_task_graph.json`)).toBe("block");
      expect(guardDecision(`printf '{}' > /tmp/claude-subagent$'${nul}'s/sess.evidence.jsonl`)).toBe("block");
    }
    // NUL TRUNCATES the rest of its OWN body (`$'state\000junk'` → `state`),
    // so trailing junk cannot de-target a guarded path — one row per escape
    // family (a drop-and-continue mutant in any branch would keep `junk`).
    expect(guardDecision("rm $'.claude/state\\000junk'/active_task_graph.json")).toBe("block");
    expect(guardDecision("echo FORGED > $'.claude/state\\x00junk'/active_task_graph.json")).toBe("block");
    expect(guardDecision("printf '{}' > $'/tmp/claude-subagents\\u0000junk'/sess.evidence.jsonl")).toBe("block");
    // Precision: a NUL between non-guarded chars still collapses harmlessly.
    expect(guardDecision("echo hi$'\\x00'there")).toBe("allow");
  });

  it("backslash-newline is line continuation — bash rejoins the token (round-18 bypass)", () => {
    // Bash removes `\`+newline entirely, reassembling a split token. The
    // matching view used to KEEP the newline, splitting the guarded literal
    // (live: ALLOW + real forge/delete). Both unquoted and double-quoted.
    expect(guardDecision("echo FORGED > active_task_grap\\\nh.json")).toBe("block");
    expect(guardDecision('echo FORGED > "active_task_grap\\\nh.json"')).toBe("block");
    expect(guardDecision("rm .claude/stat\\\ne/active_task_graph.json")).toBe("block");
    expect(guardDecision(`cp /tmp/f.json /tmp/claude-subagent\\\ns/sess.evidence.jsonl`)).toBe("block");
    // A legit multi-line command that never names guarded state stays allowed.
    expect(guardDecision("echo hello \\\n  world")).toBe("allow");
  });

  it("brace / single-char-class fragmentation of the guarded DIR launders past the front gate (round-18 bypass)", () => {
    // collapseQuotes reproduced quote/backslash/ANSI-C normalization but not
    // brace expansion or globbing. Fragmenting the DIRECTORY token defeats the
    // dir substring match (fragmenting only the filename was already caught).
    // Live-verified delete/forge/gate-disarm:
    expect(guardDecision("rm .claude/st{a,a}te/active_task_grap{h,h}.json")).toBe("block");
    expect(guardDecision("cp /tmp/f.json .claude/st{a,a}te/active_task_graph.json")).toBe("block");
    expect(guardDecision("rm .claude/st[a]te/active_task_grap[h].json")).toBe("block");
    expect(guardDecision(`rm -rf /tmp/claude-sub{agents,agents}/x.machine`)).toBe("block");
    // SEQUENCE brace expansion (`{r..s}`, `{d..e}`, `{1..3}`) — the sequenceOptions
    // branch: bash expands the range, and one variant reveals the guarded dir.
    // `{r..s}` → …subagentr / …subagentS, the `s` variant IS the subagent dir:
    expect(guardDecision(`rm -rf /tmp/claude-subagent{r..s}/x.machine`)).toBe("block");
    // `{d..e}` → …statd/… / …state/…, the `e` variant IS the guarded state dir:
    expect(guardDecision("echo X > .claude/stat{d..e}/active_task_graph.json")).toBe("block");
    // Allow-precision: a numeric sequence that never reaches a guarded dir stays allowed.
    expect(guardDecision("ls src/file{1..3}.ts")).toBe("allow");
    // Residual `*`/`?` glob on the dir token reaches INTO a guarded dir:
    expect(guardDecision("rm .claude/stat*/active_task_graph.json")).toBe("block");
    expect(guardDecision("rm -rf /tmp/claude-sub*/")).toBe("block");
    expect(guardDecision("rm /tmp/*")).toBe("block"); // would delete the subagent dir
    // `?` glob (segmentGlobMatches `?` branch): the single `?` matches the one
    // trailing char, so `/tmp/claude-subagent?` reaches the guarded subagent dir.
    expect(guardDecision("rm -rf /tmp/claude-subagent?")).toBe("block");
    // Redundant slashes collapse (bash treats `//` as `/`) so a doubled slash
    // can't hide the guarded dir literal:
    expect(guardDecision(`rm -rf /tmp//claude-subagents`)).toBe("block");
    expect(guardDecision("rm .claude//state/active_task_graph.json")).toBe("block");
    // Baselines: brace/glob writes whose dir stays literal were already caught,
    // and must stay caught.
    expect(guardDecision("rm .claude/state/active_task_grap{h,h}.json")).toBe("block");
    // Legit brace/glob commands that never reach a guarded dir stay allowed.
    expect(guardDecision("ls src/{a,b}.ts")).toBe("allow");
    expect(guardDecision("rm /tmp/other-{a,b}.txt")).toBe("allow");
    expect(guardDecision("cat build/*.o")).toBe("allow");
    // A read THROUGH a fragmented guarded dir is in scope but read-only → allow.
    expect(guardDecision("cat .claude/st{a,a}te/active_task_graph.json")).toBe("allow");
  });

  it("parameter expansion `$x`/`${x}` deletes to its unset→empty value, reassembling a fragmented guarded literal (round-19 bypass)", () => {
    // normalizeShellSpan modeled quotes/backslash/ANSI-C but passed a bare
    // `$x`/`${x}` through as a literal `$`/`{`/`}` run, so fragmenting BOTH the
    // guarded dir and filename with an (unset→empty) expansion produced a view
    // matching neither `.claude/state` nor `active_task_graph` — the front gate
    // short-circuited to ALLOW. Live-verified: real bash deleted the real state
    // file and the hook returned EXIT=0. An unset var expands to empty, so
    // deletion is the only bash-accurate view (leaving `$x` literal is a string
    // bash never produces) and it rejoins the split literal.
    expect(guardDecision("rm .claude/stat${x}e/active_task_grap${x}h.json")).toBe("block");
    expect(guardDecision("rm .claude/stat$xe/active_task_grap${x}h.json")).toBe("block");
    expect(guardDecision("echo FORGED > .claude/stat${x}e/active_task_graph.json")).toBe("block");
    expect(guardDecision("cp evil .claude/state/active_task_grap${x}h.json")).toBe("block");
    // Ledger forge via a fragmented protected dir:
    expect(guardDecision("echo x > /tmp/claude-subagent${s}s/s.evidence.jsonl")).toBe("block");
    expect(guardDecision("printf '{}' > /tmp/claude-subagent${s}s/sess.evidence.jsonl")).toBe("block");
    // Double-quoted expansion also expands (and deletes); single-quoted does NOT
    // (bash keeps `$w` literal inside `'…'`, so this jq read stays allowed).
    expect(guardDecision('cp evil ".claude/stat${x}e/active_task_graph.json"')).toBe("block");
    expect(guardDecision("jq '.current_wave as $w | .tasks' .claude/state/active_task_graph.json")).toBe("allow");
    // Legit commands using real variables never synthesize a guarded literal.
    expect(guardDecision("rm $HOME/tmp/foo.txt")).toBe("allow");
    expect(guardDecision("ls src/file${x}.ts")).toBe("allow");
    expect(guardDecision("echo ${PATH} && cat build/${name}.o")).toBe("allow");
  });

  it("default/assign-default expansion `${x:-w}` reveals its WORD — deleting it concealed a guarded literal (round-20 bypass)", () => {
    // Round-19 modeled EVERY `${…}` as delete-to-unset-empty. Bash emits the
    // WORD for `${x:-w}`/`${x-w}`/`${x:=w}`/`${x=w}` when x is unset, so
    // deleting the span CONCEALED a guarded literal carried in the word
    // (live-verified: guard ALLOWed while real bash deleted the real state
    // file). All four operators, both guarded families:
    expect(guardDecision("rm .claude/stat${x:-e}/active_task_grap${x:-h}.json")).toBe("block");
    expect(guardDecision("rm .claude/stat${x-e}/active_task_grap${x-h}.json")).toBe("block");
    expect(guardDecision("rm .claude/stat${x:=e}/active_task_grap${x:=h}.json")).toBe("block");
    expect(guardDecision("rm .claude/stat${x=e}/active_task_grap${x=h}.json")).toBe("block");
    // The whole guarded path smuggled AS the default word:
    expect(guardDecision("rm ${x:-.claude/state/active_task_graph.json}")).toBe("block");
    // Redirect-target and ledger-forge variants:
    expect(guardDecision("echo FORGED > .claude/stat${x:-e}/active_task_graph.json")).toBe("block");
    expect(guardDecision("echo x > /tmp/claude-subagent${x:-s}/sess.evidence.jsonl")).toBe("block");
    expect(guardDecision("printf '{}' > /tmp/claude-subagent${x:=s}/sess.evidence.jsonl")).toBe("block");
    // Precision: default words that never complete a guarded literal stay
    // allowed, and a READ through a default-word-fragmented path is in scope
    // but read-only → allow.
    expect(guardDecision("rm ${x:-/tmp/scratch}/foo.txt")).toBe("allow");
    expect(guardDecision("ls src/file${ext:-.ts}")).toBe("allow");
    expect(guardDecision("cat .claude/stat${x:-e}/active_task_graph.json")).toBe("allow");
  });

  it("a substitution that outputs EMPTY rejoins a fragmented guarded literal — `$(:)`/backtick/`<(:)` (round-20 bypass)", () => {
    // The front gate's collapsed view keeps `$(…)`/backticks LITERAL, so
    // `.claude/stat$(:)e` matched no guarded pattern and decide() short-
    // circuited to ALLOW before flattening ever ran — while bash expanded
    // `$(:)` (no-op builtin → empty output) and deleted the real state file.
    // referencesPattern now ALSO tests a blank-substitutions view.
    expect(guardDecision("rm .claude/stat$(:)e/active_task_grap$(:)h.json")).toBe("block");
    expect(guardDecision("rm .claude/stat`:`e/active_task_grap`:`h.json")).toBe("block");
    expect(guardDecision("rm .claude/stat<(:)e/active_task_graph.json")).toBe("block");
    expect(guardDecision("echo FORGED > .claude/stat$(:)e/active_task_graph.json")).toBe("block");
    // Ledger forge via a substitution-fragmented protected dir:
    expect(guardDecision("printf '{}' > /tmp/claude-subagent$(:)s/sess.evidence.jsonl")).toBe("block");
    expect(guardDecision("printf '{}' > /tmp/claude-subagent`:`s/sess.evidence.jsonl")).toBe("block");
    // Control: the substitutions-LITERAL view still surfaces a guarded token
    // sitting INSIDE a body, so flattening + recursive judging engages for a
    // write hidden in a substitution (invisible to the blanked view alone).
    expect(
      guardDecision("echo $(sed -i s/trusted-fail/trusted-pass/ .claude/state/active_task_graph.json)"),
    ).toBe("block");
    // Precision: a READ through a substitution-fragmented path is in scope but
    // read-only → allow; single quotes SUPPRESS substitution, so a quoted
    // `$(:)` string argument never reassembles the literal.
    expect(guardDecision("cat .claude/stat$(:)e/active_task_graph.json")).toBe("allow");
    expect(guardDecision("echo '.claude/stat$(:)e' > /tmp/notes.txt")).toBe("allow");
  });

  it("colonless default `${x-w}`/`${x=w}` ALSO expands to EMPTY on set-but-empty — a decoy word conceals a guarded literal (round-21 bypass)", () => {
    // Round-20 revealed the default WORD, but `${x-w}`/`${x=w}` (no colon) have a
    // SECOND bash output the colon forms lack: when x is SET-BUT-EMPTY they expand
    // to EMPTY, so `.claude/stat${x-X}e` — whose word-reveal view is the harmless
    // `.claude/statXe` — reassembles to `.claude/state`. The word-reveal base
    // conceals it; referencesPattern now ALSO tests a colonless-empty base. Decoy
    // word (`X`) so ONLY the empty view completes the guarded literal.
    expect(guardDecision("rm .claude/stat${x-X}e/active_task_grap${x-X}h.json")).toBe("block");
    expect(guardDecision("rm .claude/stat${x=X}e/active_task_grap${x=X}h.json")).toBe("block");
    // Redirect-target and ledger-forge variants through the empty view:
    expect(guardDecision("echo FORGED > .claude/stat${x-X}e/active_task_graph.json")).toBe("block");
    expect(guardDecision("printf '{}' > /tmp/claude-subagent${x-X}s/sess.evidence.jsonl")).toBe("block");
    // Precision: the COLON forms `${x:-w}`/`${x:=w}` substitute on unset AND null,
    // so `w` is their ONLY output — a decoy word can never expand to empty and the
    // guarded literal never reassembles. Stays allowed.
    expect(guardDecision("rm .claude/stat${x:-X}e/active_task_grap${x:-X}h.json")).toBe("allow");
    expect(guardDecision("rm .claude/stat${x:=X}e/active_task_grap${x:=X}h.json")).toBe("allow");
  });

  it("a `'` inside `\"…\"` is a literal apostrophe — it must NOT disable the substitution defense that follows (round-20 regression, round-21 fix)", () => {
    // The unified scanner tracked quote state as `'\"' | \"'\" | null`. A `'` inside
    // double quotes (`\"it's\"`) is a literal apostrophe; flipping into single-quote
    // mode on it made every later `$(…)`/backtick look single-quoted (suppressed),
    // so the blanked view stopped reassembling and a fragmented guarded write after
    // any double-quoted apostrophe waved through. Both substitution kinds:
    expect(guardDecision(`echo "it's fine" && rm .claude/stat$(:)e/active_task_graph.json`)).toBe("block");
    expect(guardDecision(`echo "don't" && rm .claude/stat\`:\`e/active_task_grap\`:\`h.json`)).toBe("block");
    // Body-hidden write after a double-quoted apostrophe still engages flattening:
    expect(
      guardDecision(`echo "y'all" && echo $(sed -i s/a/b/ .claude/state/active_task_graph.json)`),
    ).toBe("block");
    // Precision: a genuine apostrophe with no forged write stays allowed, and a
    // REAL single-quoted region still suppresses substitution (bash semantics).
    expect(guardDecision(`echo "it's a lovely day"`)).toBe("allow");
    expect(guardDecision(`echo '.claude/stat$(:)e/active_task_graph.json'`)).toBe("allow");
  });

  it("quote-collapse applies inside substitution bodies AND protected-dir redirects (round-17 pins)", () => {
    // A2: a substitution body carrying a quote-split guarded token must still
    // classify the enclosing segment as touching state.
    expect(guardDecision("rm $(echo .cl'aude'/state/active_'task_graph'.json)")).toBe("block");
    // A3: a whitelisted helper cannot forge the evidence ledger via a
    // quote-split protected-dir redirect target.
    expect(
      guardDecision(`bun cli.ts helper set-phase execute > /tmp/cl'aude-subagents'/s.evidence.jsonl`),
    ).toBe("block");
  });

  it("`>&<digit><path>` is a FILE redirect, not an fd dup — whole-word classification (round-16 bypass)", () => {
    // Bash treats `>&word` as fd duplication only when the ENTIRE word is
    // digits (or exactly `-`); a word starting with a digit that continues
    // into a path is a filename redirect. The round-15 single-char check
    // waved these forgeries through (live-verified).
    expect(
      guardDecision("mkdir 2 && echo FORGED >&2/../.claude/state/active_task_graph.json"),
    ).toBe("block");
    expect(guardDecision("echo active_task_graph.json >&2foo")).toBe("block");
    // Precision: whole-word dups and the fd close form stay allowed.
    expect(guardDecision("cat active_task_graph.json >&2")).toBe("allow");
    expect(guardDecision("cat active_task_graph.json 2>&1")).toBe("allow");
    expect(guardDecision("cat active_task_graph.json >&-")).toBe("allow");
  });

  it("`|&` is ONE pipe op — the chain stays one trust unit (round-15 bypass)", () => {
    // Parsing `|&` as `|` + background `&` emitted a spurious empty segment
    // and started a NEW chain, so the downstream executor escaped the
    // chain-scope check. `|&` ≡ `2>&1 |` — same trust unit as a plain pipe.
    expect(guardDecision("cat active_task_graph.json |& xargs rm")).toBe("block");
    expect(guardDecision("echo 'rm active_task_graph.json' |& sh")).toBe("block");
    expect(
      guardDecision(
        "echo .claude/state/active_task_graph.json |& xargs sed -i s/trusted-fail/trusted-pass/",
      ),
    ).toBe("block");
    // Precision: read-only |& chains allow, exactly like their plain-pipe twins.
    expect(guardDecision("cat active_task_graph.json |& jq .tasks")).toBe("allow");
    expect(guardDecision("cat active_task_graph.json |& grep T1")).toBe("allow");
  });

  it("rg is not allowlisted — `--pre <cmd>` executes an arbitrary program per input file (round-15)", () => {
    // `rg --pre /tmp/w.sh . <state>` invokes `/tmp/w.sh <state>` — a
    // pre-staged script receives the guarded path and can rewrite it. The
    // allowlist's membership criterion (no write capability under ANY flag
    // combination) therefore excludes rg entirely; deny-by-default.
    expect(guardDecision("rg --pre /tmp/w.sh . active_task_graph.json")).toBe("block");
    expect(guardDecision("rg pattern active_task_graph.json")).toBe("block");
    // `more` owns an interactive shell escape (`!cmd`) — same class, same fate.
    expect(guardDecision("more active_task_graph.json")).toBe("block");
    // Precision: grep remains the allowlisted read for the same job.
    expect(guardDecision("grep pattern active_task_graph.json")).toBe("allow");
  });

  it("the helper vouch never covers a protected-dir redirect (round-15 mutation pin)", () => {
    // Deleting the protected-dir + redirect branch inside the helper allow
    // (guard-state-file decide) previously failed no test — these pin it.
    expect(
      guardDecision(`bun cli.ts helper set-phase execute > ${SUBAGENT_DIR}/s.evidence.jsonl`),
    ).toBe("block");
    expect(
      guardDecision(
        `bun cli.ts helper store-test-evidence >> ${MACHINES_DIR}/code-implementer-agent.machine.json`,
      ),
    ).toBe("block");
    // Precision: the helper may redirect into its OWN (non-protected-dir)
    // state file — the vouch covers the helper's segment.
    expect(guardDecision("bun cli.ts helper set-phase execute > active_task_graph.json")).toBe(
      "allow",
    );
  });

  it("substitution bodies are judged recursively; placeholders preserve the guarded token", () => {
    // Token constructed INSIDE a substitution: the outer sed never names the
    // file, the placeholder carries the token status out of the body.
    expect(
      guardDecision("sed -i s/x/y/ /repo/$(printf '.claude/state/active_task_graph.json')"),
    ).toBe("block");
    expect(
      guardDecision("sed -i s/x/y/ `printf active_task_graph.json`"),
    ).toBe("block");
    // Benign nested reads flatten cleanly: every body and the outer chain
    // are read-only.
    expect(guardDecision("cat $(echo active_task_graph.json)")).toBe("allow");
    expect(guardDecision("cat $(cat $(echo active_task_graph.json))")).toBe("allow");
    // Unbalanced substitution syntax on a guarded line is unparseable → block.
    expect(guardDecision('echo "active_task_graph $(oops"')).toBe("block");
    expect(guardDecision("cat `active_task_graph.json")).toBe("block");
  });

  it("binding a guarded path to a variable blocks — the indirection seed", () => {
    // A pure assignment has no read-only head; allowing it would hand the
    // path to ANY later segment (the round-13 bypass shape). Reads never
    // need the binding — inline the path instead.
    expect(guardDecision("F=active_task_graph.json && cat $F")).toBe("block");
    expect(guardDecision("F=.claude/state/active_task_graph.json; sed -i s/x/y/ $F")).toBe("block");
    expect(guardDecision("export G=review-invocations.json; sponge $G < /tmp/forged.json")).toBe("block");
  });

  it("forged appends to the evidence ledger are blocked regardless of helper-shaped noise", () => {
    expect(
      guardDecision(
        `true "; bun cli.ts helper cleanup-state"; echo '{"epoch":"a:b"}' >> ${SUBAGENT_DIR}/s.evidence.jsonl`,
      ),
    ).toBe("block");
  });

  it("helper-invocation matching requires the documented bun/cli.ts/helper head shape", () => {
    // Right helper name, wrong invocation shape → no bypass.
    expect(guardDecision("cleanup-state > active_task_graph.json")).toBe("block");
    expect(guardDecision("bun other.ts helper cleanup-state > active_task_graph.json")).toBe("block");
    expect(guardDecision("bun cli.ts run cleanup-state > active_task_graph.json")).toBe("block");
    expect(guardDecision("bun cli.ts helper not-whitelisted > active_task_graph.json")).toBe("block");
  });

  it("review-invocations file also guarded", () => {
    expect(guardDecision("> review-invocations.json")).toBe("block");
    expect(guardDecision("cat review-invocations.json")).toBe("allow");
  });

  it("echo append to state file → block", () => {
    expect(guardDecision('echo "hi" >> active_task_graph.json')).toBe("block");
  });

  it("node fs operations on state file → block", () => {
    expect(guardDecision('node -e "require(\'fs\').writeFileSync(\'active_task_graph.json\')"')).toBe("block");
  });

  it("python open(write) on state file → block", () => {
    expect(guardDecision("python3 -c \"open('active_task_graph.json','w').write('{}')\"")).toBe("block");
  });

  it("jq read operations → allow", () => {
    expect(guardDecision("jq '.tasks[] | select(.wave == 1)' active_task_graph.json")).toBe("allow");
    expect(guardDecision("jq -r '.current_phase' active_task_graph.json")).toBe("allow");
  });

  it("cp with state file in source position → block (still matches cp pattern)", () => {
    expect(guardDecision("cp active_task_graph.json /tmp/backup.json")).toBe("block");
  });

  it("subagent ledger/binding/active files AND the directory itself are guarded (derived from SUBAGENT_DIR)", () => {
    expect(guardDecision(`echo forged >> ${SUBAGENT_DIR}/s.evidence.jsonl`)).toBe("block");
    expect(guardDecision(`echo a-1 >> ${SUBAGENT_DIR}/s.active`)).toBe("block");
    expect(guardDecision(`echo bind > ${SUBAGENT_DIR}/s.machine`)).toBe("block");
    expect(guardDecision(`rm -rf ${SUBAGENT_DIR}`)).toBe("block");
    expect(guardDecision(`rm ${SUBAGENT_DIR}/s.machine`)).toBe("block");
    // reads stay allowed
    expect(guardDecision(`cat ${SUBAGENT_DIR}/s.evidence.jsonl`)).toBe("allow");
    expect(guardDecision(`ls ${SUBAGENT_DIR}`)).toBe("allow");
  });

  it("machine definition files are guarded (derived from MACHINES_DIR) — rm cannot silently disarm the gate", () => {
    expect(guardDecision(`rm ${MACHINES_DIR}/code-implementer-agent.machine.json`)).toBe("block");
    expect(guardDecision(`rm -rf ${MACHINES_DIR}`)).toBe("block");
    expect(guardDecision(`echo '{}' > ${MACHINES_DIR}/code-implementer-agent.machine.json`)).toBe("block");
    expect(guardDecision(`mv ${MACHINES_DIR}/code-implementer-agent.machine.json /tmp/`)).toBe("block");
    // reads stay allowed
    expect(guardDecision(`cat ${MACHINES_DIR}/code-implementer-agent.machine.json`)).toBe("allow");
    expect(guardDecision(`ls ${MACHINES_DIR}`)).toBe("allow");
  });
});

describe("guard-state-file — guarded-path patterns resolve machinesDir() at decision time (round-15)", () => {
  afterEach(() => {
    delete process.env.LOOM_MACHINES_DIR;
  });

  it("a write into a re-pointed LOOM_MACHINES_DIR blocks without a module reload", () => {
    // The old patterns froze MACHINES_DIR at import; bind/gate/resolver all
    // resolve machinesDir() at call time, so a re-pointed dir was gated but
    // its definitions were NOT write-guarded.
    process.env.LOOM_MACHINES_DIR = "/tmp/loom-repointed-machines";
    expect(
      guardDecision("echo '{}' > /tmp/loom-repointed-machines/code-implementer-agent.machine.json"),
    ).toBe("block");
    expect(guardDecision("rm -rf /tmp/loom-repointed-machines")).toBe("block");
    // Reads through the re-pointed dir stay allowed.
    expect(
      guardDecision("cat /tmp/loom-repointed-machines/code-implementer-agent.machine.json"),
    ).toBe("allow");
  });
});

describe("guard-state-file handler — malformed stdin fails CLOSED (round-11)", () => {
  it("non-JSON stdin → block, never a rethrow or a silent allow", async () => {
    // A parse crash exits 1 which is NON-blocking for PreToolUse — it would
    // wave the Bash call past the guard. The handler must fail CLOSED instead.
    const result = await runGuardStateFile("{not json", inMemorySessionRegistry());
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("malformed hook input");
    }
  });
});

describe("guard-state-file handler — call-start stamping never changes the guard outcome", () => {
  const stdin = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "stamp-session",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_use_id: "toolu_stamp_01",
      ...extra,
    });

  /** A registry whose stamp op always throws — the failure mode the
   *  fail-open contract is about. */
  const throwingRegistry = (): SessionRegistry => ({
    ...inMemorySessionRegistry(),
    recordCallStart: async () => {
      throw new Error("disk full");
    },
  });

  it("stamps the call start for the session (readable by callStartFor)", async () => {
    const reg = inMemorySessionRegistry();
    const result = await runGuardStateFile(stdin(), reg);
    expect(result.kind).toBe("allow");
    const sessionId = parseSessionId("stamp-session")!;
    const stamp = reg.callStartFor(sessionId, "toolu_stamp_01");
    expect(stamp).not.toBeNull();
    expect(Math.abs(Date.now() - stamp!)).toBeLessThan(60_000);
  });

  it("an ALLOW stays an allow when the stamp write throws (loud stderr, no exception)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await runGuardStateFile(stdin(), throwingRegistry());
      expect(result.kind).toBe("allow");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("call-start stamp failed");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a BLOCK stays a block when the stamp write throws — stamping runs AFTER the decision", async () => {
    const blockingGuard = (): HookResult => ({ kind: "block", message: "state file write" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await runGuardStateFile(stdin(), throwingRegistry(), blockingGuard);
      expect(result.kind).toBe("block");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("call-start stamp failed");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("a BLOCK also stays a block when stamping SUCCEEDS (stamp is side-band bookkeeping)", async () => {
    const blockingGuard = (): HookResult => ({ kind: "block", message: "state file write" });
    const reg = inMemorySessionRegistry();
    const result = await runGuardStateFile(stdin(), reg, blockingGuard);
    expect(result.kind).toBe("block");
    // The stamp still landed — a blocked call's PostToolUse never fires, but
    // the stamp is bounded and harmless.
    expect(reg.callStartFor(parseSessionId("stamp-session")!, "toolu_stamp_01")).not.toBeNull();
  });

  it("no tool_use_id / unparseable session id → no stamp, guard outcome unchanged", async () => {
    const reg = inMemorySessionRegistry();
    expect((await runGuardStateFile(stdin({ tool_use_id: undefined }), reg)).kind).toBe("allow");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const evil = await runGuardStateFile(stdin({ session_id: "../../escape" }), reg);
      expect(evil.kind).toBe("allow");
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("invalid session id");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("stampCallStart itself never throws (fail-open with stderr)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        stampCallStart(
          { session_id: "s-1", tool_name: "Bash", tool_input: {}, tool_use_id: "toolu_x" },
          throwingRegistry(),
        ),
      ).resolves.toBeUndefined();
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("call-start stamp failed");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
