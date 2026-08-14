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

  it("stepped brace sequences match bash expansion (`{a..y..4}` → …state — round-29 fail-open)", () => {
    // sequenceOptions originally covered only unstepped `{x..y}`; bash also
    // expands stepped ranges, and the step can land on the guarded literal:
    // `{a..y..4}` → a e i m q u y, so `.claude/stat{a..y..4}` → `.claude/state`.
    // Pinned against real bash (differential sweep in the review remediation):
    expect(guardDecision("rm -rf .claude/stat{a..y..4}")).toBe("block");
    // Descending endpoints with a positive step land on the same member:
    expect(guardDecision("rm -rf .claude/stat{y..a..4}")).toBe("block");
    // The step's SIGN is ignored (endpoints set direction; `{1..5..-1}` ascends
    // in bash) and a zero step means a full step-1 enumeration:
    expect(guardDecision("rm -rf .claude/stat{a..y..-4}")).toBe("block");
    expect(guardDecision("rm -rf .claude/stat{a..y..0}")).toBe("block");
    // `+`-signed steps and endpoints parse (bash expands both forms):
    expect(guardDecision("rm -rf .claude/stat{a..z..+2}")).toBe("block");
    // Mixed-type bodies stay literal in bash — no expansion to guard:
    expect(guardDecision("rm -rf .claude/stat{a..10..2}")).toBe("allow");
    expect(guardDecision("rm -rf .claude/stat{1..z..2}")).toBe("allow");
    // Numeric stepped sequences never reach an alpha guarded literal:
    expect(guardDecision("ls src/file{1..10..3}.ts")).toBe("allow");
    // Zero-padded numeric stepped forms still expand to digits only:
    expect(guardDecision("ls src/file{01..100..3}.ts")).toBe("allow");
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

  it("a colonless default NESTED inside a colon-form word still reaches its set-empty output (round-22 nested bypass)", () => {
    // Round-21 emptied a TOP-LEVEL colonless default, but the reveal of a colon
    // form's word (`${x:-w}`) dropped the colonless-empty flag, so a colonless
    // default buried inside that word never produced its set-empty output. With x
    // unset the outer word `${y-X}` is revealed; y set-but-empty → EMPTY, so bash
    // yields `.claude/stat` + `` + `e` = `.claude/state` — verified against real
    // bash: `unset x; y=; printf %s ".claude/stat${x:-${y-X}}e"` → `.claude/state`.
    expect(guardDecision("rm .claude/stat${x:-${y-X}}e/active_task_grap${x:-${y-X}}h.json")).toBe("block");
    expect(guardDecision("rm .claude/stat${x:=${y=X}}e/active_task_graph.json")).toBe("block");
    // Arbitrary nesting depth — colonless two colon-reveals deep.
    expect(guardDecision("echo FORGED > .claude/stat${x:-${y:-${z-X}}}e/active_task_graph.json")).toBe("block");
    // Precision: a nested COLON form is only-output — decoy word never empties, so
    // `.claude/statXe` never reassembles the guarded literal. Stays allowed.
    expect(guardDecision("rm .claude/stat${x:-${y:-X}}e/active_task_grap${x:-${y:-X}}h.json")).toBe("allow");
  });

  it("alternate expansion `${x:+w}`/`${x+w}` substitutes its WORD on SET — an always-set var carries a guarded literal past the front gate (round-24 fail-open)", () => {
    // The MIRROR of the round-20/21 default-word bug. `${x:+w}` yields EMPTY on
    // unset (the only view the guard modeled) but the WORD `w` when x is SET —
    // and PWD/HOME/USER/$$ are ALWAYS set, so `${PWD:+.claude/state/…}` reassembles
    // the guarded literal and bash runs the delete/write while the guard, deleting
    // the whole span, saw `rm -rf ` and ALLOWed. referencesPattern now ALSO tests
    // an alternate-reveal base. Verified against real bash:
    // `printf %s "${PWD:+.claude/state/active_task_graph.json}"` → the guarded path.
    expect(guardDecision("rm -rf ${PWD:+.claude/state/active_task_graph.json}")).toBe("block");
    expect(guardDecision("rm -rf ${HOME+.claude/state}")).toBe("block");
    expect(guardDecision("echo FORGED > ${PWD:+.claude/state/active_task_graph.json}")).toBe("block");
    expect(guardDecision("printf '{}' > ${USER:+/tmp/claude-subagents/sess.evidence.jsonl}")).toBe("block");
    // Word carrying only a FRAGMENT — reassembles with surrounding literals only in
    // the alternate-reveal view (the primary view deletes it → `.claude/state`... so
    // use a decoy that makes ONLY the reveal view complete the literal).
    expect(guardDecision("rm .claude/sta${x:+te/active_task_graph.json}")).toBe("block");
    // Colonless `+` (set, even if null) reveals its word too.
    expect(guardDecision("rm .claude/sta${x+te}/active_task_graph.json")).toBe("block");
    // Precision: the ERROR form `${x:?w}` never substitutes `w` into the value
    // (it is a stderr message), so a guarded literal parked there never runs.
    expect(guardDecision("rm ${x:?.claude/state/active_task_graph.json}")).toBe("allow");
  });

  it("indirect expansion with a word operator `${!x:-w}`/`${!x:+w}`/`${!x-w}` substitutes its WORD — the `!`-prefix short-circuit concealed a guarded literal (round-25 fail-open)", () => {
    // The remaining sibling of the round-20/21/22/24 word-operator bugs. `${!x}`
    // is pure indirection (no word), but `${!x:-w}`/`${!x:+w}`/`${!x-w}` indirect
    // THEN apply the operator, substituting `w` exactly like the non-indirect
    // twin. classifyBraceBody blanket-returned `empty` for every `!`-prefix body,
    // deleting the span and concealing a guarded literal parked in `w`, so the
    // guard saw `rm ` and ALLOWed while bash ran the delete. Verified against real
    // bash: `x=NOPEVAR; printf %s "${!x:-.claude/state/active_task_graph.json}"`.
    expect(guardDecision("rm ${!x:-.claude/state/active_task_graph.json}")).toBe("block");
    expect(guardDecision("rm ${!x-.claude/state/active_task_graph.json}")).toBe("block"); // colonless
    expect(guardDecision("rm ${!x:+.claude/state/active_task_graph.json}")).toBe("block"); // alternate (set var)
    expect(guardDecision("echo FORGED > ${!x:-.claude/state/active_task_graph.json}")).toBe("block");
    expect(guardDecision("printf '{}' > ${!x:+/tmp/claude-subagents/sess.evidence.jsonl}")).toBe("block");
    // Fragment carried in the word, reassembled with surrounding literals.
    expect(guardDecision("rm .claude/sta${!x:-te/active_task_graph.json}")).toBe("block");
    // Precision: the ERROR form UNDER indirection (`${!x:?w}`) never substitutes
    // `w` into the value (stderr message), so a guarded literal parked there never
    // runs — the `!` strip must not turn `:?` into a revealing operator.
    expect(guardDecision("rm ${!x:?.claude/state/active_task_graph.json}")).toBe("allow");
  });

  it("a substitution whose NONEMPTY output COMPLETES a guarded literal — `.claude/stat$(printf e)` → `.claude/state` (round-26 fail-open)", () => {
    // The mirror of round-20's empty-output fragmentation. Round-20 modeled a
    // substitution producing EMPTY (drop it, rejoin fragments); the literal view
    // keeps `$(…)` verbatim. Neither modeled the THIRD channel: output that ADDS
    // a completing character. bash resolves `.claude/stat$(printf e)` → the
    // guarded `.claude/state` dir (verified: `ls -d .claude/stat$(printf e)`), but
    // the empty view drops the `e` (`.claude/stat`) and the literal view keeps
    // `$(printf e)` inline — so decide() short-circuited to ALLOW and bash ran the
    // delete. referencesPattern now ALSO tests a WILDCARD-substitutions base
    // (`.claude/stat*`), whose glob reaches the guarded dir.
    expect(guardDecision("rm -rf .claude/stat$(printf e)")).toBe("block");
    expect(guardDecision("rm -rf .claude/stat`printf e`")).toBe("block"); // backtick
    expect(guardDecision("echo FORGED > .claude/stat$(printf e)/active_task_graph.json")).toBe("block");
    // Ledger forge via a completing substitution into the protected subagent dir:
    expect(guardDecision("printf '{}' > /tmp/claude-subagent$(printf s)/sess.evidence.jsonl")).toBe("block");
    // Nested inside a default word and an alternate word — the wildcard is left in
    // the word for collapseVariants to reveal (`${x:-*}` → `*`, `${PWD:+*}` → `*`).
    expect(guardDecision("rm -rf .claude/stat${x:-$(printf e)}")).toBe("block");
    expect(guardDecision("rm -rf .claude/stat${PWD:+$(printf e)}")).toBe("block");
    // Precision: a READ through a completing substitution is in scope but
    // read-only → allow; single quotes SUPPRESS substitution so a quoted string
    // never reassembles the literal; and a wildcard whose surrounding literal
    // shares no guarded prefix (`jq . $(cat foo)` → `jq . *`) never hits.
    expect(guardDecision("cat .claude/stat$(printf e)/active_task_graph.json")).toBe("allow");
    expect(guardDecision("echo '.claude/stat$(printf e)' > /tmp/notes.txt")).toBe("allow");
    expect(guardDecision("jq . $(cat /tmp/list.txt)")).toBe("allow");
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

describe("guard-state-file — heredoc bodies are data, not command text (issue-20)", () => {
  it("quoted-delimiter heredoc bodies are opaque: inert prose never blocks (issue-20 repro)", () => {
    // The exact issue-20 minimal repro: double-quoted backtick pair inside a
    // quoted heredoc body; both writes target /tmp only.
    expect(guardDecision(
      "cat > /tmp/x.ts << 'EOF'\nconst lines = [\n  \"echo no `bullmq`/`ioredis` here\",\n];\nEOF",
    )).toBe("allow");
    // Guarded-path substrings in body prose are data, not references.
    expect(guardDecision(
      "cat > /tmp/x.py << 'PYEOF'\nmsg = 'path: .pi/state/active_task_graph.json'\nprint(msg)\nPYEOF",
    )).toBe("allow");
    expect(guardDecision(
      "cat > /tmp/spec.md << 'MDEOF'\nThe state lives in .claude/state/active_task_graph.json.\nMDEOF",
    )).toBe("allow");
    expect(guardDecision(
      "cat > /tmp/spec.md << 'MDEOF'\nInstall `bullmq`/`ioredis`.\nMDEOF",
    )).toBe("allow");
    expect(guardDecision(
      "cat <<- 'TEOF'\n\tprose mentioning .claude/state/active_task_graph.json\n\tTEOF",
    )).toBe("allow");
    // The very same text OUTSIDE a heredoc is a live command substitution and
    // stays fail-closed.
    expect(guardDecision("echo \"check `active_task_graph.json` path\"")).toBe("block");
  });

  it("an unquoted delimiter makes body substitutions LIVE commands (fail-closed)", () => {
    expect(guardDecision(
      "cat > /tmp/x << EOF\n$(rm .claude/state/active_task_graph.json)\nEOF",
    )).toBe("block");
    expect(guardDecision(
      "cat > /tmp/x << EOF\n`rm .claude/state/active_task_graph.json`\nEOF",
    )).toBe("block");
    expect(guardDecision(
      "cat > /tmp/x << EOF\necho \"$(mv .claude/state/active_task_graph.json /tmp/)\"\nEOF",
    )).toBe("block");
    // Quote characters are literal data in an unquoted body: they do not
    // suppress the substitution (verified against bash).
    expect(guardDecision(
      "cat > /tmp/x << EOF\n'$(rm .claude/state/active_task_graph.json)'\nEOF",
    )).toBe("block");
    // Escaped dollar is literal and harmless.
    expect(guardDecision(
      "cat > /tmp/x << EOF\n\\$(echo .claude/state prose)\nEOF",
    )).toBe("allow");
    // The same destructive text in a QUOTED body is data and must allow.
    expect(guardDecision(
      "cat > /tmp/x << 'EOF'\n$(rm .claude/state/active_task_graph.json)\nEOF",
    )).toBe("allow");
  });

  it("redirect targets on the opener line stay guarded", () => {
    expect(guardDecision(
      "cat > .claude/state/active_task_graph.json << 'EOF'\nprose\nEOF",
    )).toBe("block");
    expect(guardDecision(
      "cat > .claude/state/active_task_graph.json << EOF\n$(echo hi)\nEOF",
    )).toBe("block");
    // Unterminated heredoc with a live substitution still blocks.
    expect(guardDecision(
      "cat > /tmp/x << EOF\n$(rm .claude/state/active_task_graph.json)\n",
    )).toBe("block");
  });

  it("compound commands with heredocs keep chain scoping", () => {
    expect(guardDecision(
      "cat << 'A' && echo hi\nbody\nA",
    )).toBe("allow");
    expect(guardDecision(
      "cat << 'A' && rm .claude/state/active_task_graph.json\nbody\nA",
    )).toBe("block");
    // Two heredocs on one opener line.
    expect(guardDecision(
      "cat << A << B\nx `a`/`b`\nA\ny\nB",
    )).toBe("allow");
  });

  it("script heredocs (interpreter stdin) stay fully judged even when quoted", () => {
    // A QUOTED delimiter does not make the body inert when it feeds a code
    // interpreter: the inner interpreter still executes it as a script.
    expect(guardDecision(
      "bash << 'EOF'\nrm .claude/state/active_task_graph.json\nEOF",
    )).toBe("block");
    expect(guardDecision(
      "sh << 'EOF'\ncat > .claude/state/active_task_graph.json << X\nY\nX\nEOF",
    )).toBe("block");
    expect(guardDecision(
      "cat << 'EOF' | bash\nrm .claude/state/active_task_graph.json\nEOF",
    )).toBe("block");
    expect(guardDecision(
      "python3 - << 'PY'\nprint('.claude/state prose')\nPY",
    )).toBe("block");
    expect(guardDecision(
      "env X=y bash << 'EOF'\nrm .claude/state/active_task_graph.json\nEOF",
    )).toBe("block");
    // Two heredocs on one line split by `&&`: only the interpreter-fed one
    // is a script.
    expect(guardDecision(
      "cat << A && bash << B\nrm .claude/state/active_task_graph.json\nA\nrm .claude/state/active_task_graph.json\nB",
    )).toBe("block");
    // awk/sed read stdin as DATA — not script context.
    expect(guardDecision(
      "awk << 'EOF'\nrm .claude/state/active_task_graph.json\nEOF",
    )).toBe("allow");
    // An interpreter on the OTHER side of `&&` (no pipe) does not make this
    // heredoc a script.
    expect(guardDecision(
      "bash -c 'true' && cat << 'EOF'\nrm .claude/state/active_task_graph.json\nEOF",
    )).toBe("allow");
    // The same inert text in a DATA heredoc must allow.
    expect(guardDecision(
      "cat > /tmp/x << 'EOF'\nrm .claude/state/active_task_graph.json\nEOF",
    )).toBe("allow");
  });

  it("block messages name the offending segment and its pipe-chain (issue-20 addendum)", () => {
    const result = guardStateFileDecision("npm install && rm .claude/state/active_task_graph.json");
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.message).toContain("Offending segment: \"rm .claude/state/active_task_graph.json\"");
    }
    const piped = guardStateFileDecision("echo x | rm .claude/state/active_task_graph.json");
    expect(piped.kind).toBe("block");
    if (piped.kind === "block") {
      expect(piped.message).toContain("In chain:");
    }
  });

  it("property: random quoted-heredoc body prose never blocks", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 120 }), (prose) => {
        const cmd = `cat > /tmp/out << 'EOF'\n${prose.replace(/\n/g, " ")}\nEOF`;
        expect(guardDecision(cmd)).toBe("allow");
      }),
      { numRuns: 100 },
    );
  });
});

describe("guard-state-file — heredoc script-body detection stays fail-closed (C1/C2/C3, wrappers)", () => {
  const G = ".claude/state/active_task_graph.json";
  const guardedWrite = `rm ${G}`;
  const prose = `this prose mentions ${G} but is data`;

  it("brace-grouped pipelines execute the body: { cat << 'EOF'; } | bash blocks", () => {
    expect(guardDecision(`{ cat << 'EOF' ; } | bash\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`{ tee x << 'EOF' ; } | bash\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`{ cat << 'EOF' && cat ; } | bash\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("paren-grouped, if/then/fi, and case pipelines keep the script head in the group", () => {
    expect(guardDecision(`(cat << 'EOF'; cat) | bash\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`if true; then cat << 'EOF'; fi | bash\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`case x in a) cat << 'EOF';; esac | bash\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("reader+executor compounds (while read … eval) execute the body and block", () => {
    expect(guardDecision(`while read -r l; do eval "$l"; done << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`while read l; do sh -c "$l"; done << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`while read l; do . "$l"; done << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`cat << 'EOF' | while read l; do eval "$l"; done\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`eval "$(cat)" << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`sh -c "$(sed -n 1p)" << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("reader-only and executor-only compounds stay data", () => {
    expect(guardDecision(`while read l; do echo "$l"; done << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`while read l; do sh -c 'echo hi'; done << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`read x; eval "$x" << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`echo "$(cat)" << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`eval "$(printf 'x')" << 'EOF'\n${prose}\nEOF`)).toBe("allow");
  });

  it("a `<<` inside ${…} word text is not a heredoc opener (concealment fails closed)", () => {
    expect(guardDecision(`echo ${'${x:-<<\'EOF\'}'}; rm ${G}\n`)).toBe("block");
    expect(guardDecision(`echo "${'${x:-<<EOF}'}"; rm ${G}\n`)).toBe("block");
  });

  it("wrapped interpreters are unwrapped: sudo/command/timeout/env … << blocks", () => {
    expect(guardDecision(`sudo bash << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`command bash << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`timeout 5 bash << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`env -u FOO bash << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`sudo -u root -- bash << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`nice -n 5 bash << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("xargs turns body lines into command arguments: the body is judged", () => {
    expect(guardDecision(`cat << 'EOF' | xargs rm\n${G}\nEOF`)).toBe("block");
    expect(guardDecision(`cat << 'EOF' | xargs -I{} sh -c '{}'\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("interpreter stdin DATA stays data: file/inline/module program sources", () => {
    expect(guardDecision(`bash script.sh << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`bash -c 'echo hi' << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`python3 -c 'print(1)' << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`python3 -m json.tool << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`python3 script.py << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`cat << 'EOF' | grep -c bash\n${prose}\nEOF`)).toBe("allow");
  });

  it("inline programs that read the body as THEIR program are scripts (bash -c 'sh' class)", () => {
    // The inline program inherits the command's stdin and reads it as its
    // own program source — the heredoc body is EXECUTED (verified against
    // real bash), so it must be judged as a script even with a quoted
    // delimiter. HEAD regressed these to allow; the recursion restores block.
    expect(guardDecision(`bash -c 'sh' << 'BODY'\n${guardedWrite}\nBODY`)).toBe("block");
    expect(guardDecision(`bash -c 'python3' << 'PY'\n${guardedWrite}\nPY`)).toBe("block");
    expect(guardDecision(`sh -c 'sh' << 'BODY'\n${guardedWrite}\nBODY`)).toBe("block");
    expect(guardDecision(`python3 -c 'bash' << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    // A wrapper around the outer interpreter changes nothing: the inner
    // program still inherits stdin (env -S re-splits the command line).
    expect(guardDecision(`env -S 'bash -c "sh"' << 'BODY'\n${guardedWrite}\nBODY`)).toBe("block");
    // Nested inline programs: `bash -c 'bash -c sh'` — the innermost sh
    // reads the body.
    expect(guardDecision(`bash -c 'bash -c sh' << 'BODY'\n${guardedWrite}\nBODY`)).toBe("block");
    // A WRAPPER front must not hide the interpreter the stdin reaches:
    // the inline-program checks bind to the RESOLVED interpreter, so a
    // variable-fed program under sudo still joins the reader+executor pair.
    expect(guardDecision(`while read l; do sudo sh -c "$l"; done << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`while read l; do sudo sh -c 'echo hi'; done << 'EOF'\n${prose}\nEOF`)).toBe("allow");
  });

  it("inline reader+executor pairs execute the body: bash -c 'eval \"$(cat)\"' blocks", () => {
    expect(guardDecision(`bash -c 'eval "$(cat)"' << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`sh -c 'eval "$(cat)"' << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`bash -c 'eval "$(sed -n 1p)"' << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    // A reader WITHOUT an executor inside the program stays data.
    expect(guardDecision(`bash -c 'echo "$(cat)"' << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    // An inline program that merely reads its own stdin as DATA stays data.
    expect(guardDecision(`bash -c 'cat' << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`bash -c 'sh file.sh' << 'BODY'\n${prose}\nBODY`)).toBe("allow");
    expect(guardDecision(`bash -c 'python3 script.py' << 'PY'\n${prose}\nPY`)).toBe("allow");
    // A script body is LIVE command text: inert prose that mentions a
    // guarded path in it still blocks, exactly like any other script feed.
    expect(guardDecision(`bash -c 'sh' << 'BODY'\n${prose}\nBODY`)).toBe("block");
  });

  it("redirect constructs never read as interpreter or file arguments", () => {
    expect(guardDecision(`sudo bash > /tmp/log << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`bash 2>&1 << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("F1: fused heredoc spelling — redirect fused into/before the head — stays a script", () => {
    expect(guardDecision(`bash<<'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`sh<<EOF\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`python3<<'PY'\n${guardedWrite}\nPY`)).toBe("block");
    expect(guardDecision(`sudo bash<<'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`env X=y bash<<'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`timeout 5 bash<<'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`2>/dev/null bash<<'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`>log sh<<'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    // A fused DATA heredoc stays data: the body is opaque, not a script.
    expect(guardDecision(`cat<<'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`cat<<'EOF'|grep -c bash\n${prose}\nEOF`)).toBe("allow");
  });

  it("F2: subshell-wrapped interpreter heredocs with the close on the opener line stay scripts", () => {
    expect(guardDecision(`( bash << 'EOF' )\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`( bash -x << 'EOF' )\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`( bash<<'EOF' )\n${guardedWrite}\nEOF`)).toBe("block");
    // The heredoc redirect attaches to the subshell's stdin: still a script.
    expect(guardDecision(`( bash ) << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    // A DATA heredoc inside a subshell stays data.
    expect(guardDecision(`( cat << 'EOF' )\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`( cat ) << 'EOF'\n${prose}\nEOF`)).toBe("allow");
  });

  it("F3: case-clause interpreter heredocs stay scripts (patterns are not heads)", () => {
    expect(guardDecision(`case x in x) bash << 'EOF'\n${guardedWrite}\nEOF\n;; esac`)).toBe("block");
    expect(guardDecision(`case x in *|y) bash << 'EOF'\n${guardedWrite}\nEOF\n;; esac`)).toBe("block");
    expect(guardDecision(`case x in (x) bash << 'EOF'\n${guardedWrite}\nEOF\n;; esac`)).toBe("block");
    expect(guardDecision(`case $x in $y) bash << 'EOF'\n${guardedWrite}\nEOF\n;; esac`)).toBe("block");
    // A case-clause DATA heredoc stays data.
    expect(guardDecision(`case x in x) cat << 'EOF'\n${prose}\nEOF\n;; esac`)).toBe("allow");
  });

  it("data/script group split is preserved: cat << 'A' && bash << 'B'", () => {
    expect(guardDecision(`cat << 'A' && bash << 'B'\n${prose}\nA\nrm ${G}\nB\n`)).toBe("block");
    // The data body A stays data even though the sibling group B is a script.
    expect(guardDecision(`cat << 'A' && bash << 'B'\n${prose}\nA\necho hi\nB\n`)).toBe("allow");
  });

  // A `source`/`.` reading commands from a bound descriptor, or an interpreter
  // reading its PROGRAM from one, executes the heredoc body even though the
  // argument looks like a named file — the descriptor IS the heredoc. This
  // whole class read `allow` before the fd-device-path fix (the executor
  // read+executed in one command, so the reader/executor handshake never
  // tripped; the interpreter treated the path as a plain script file).
  it("source/. reading a bound descriptor executes the body and blocks", () => {
    for (const fd of ["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]) {
      expect(guardDecision(`source ${fd} << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
      expect(guardDecision(`. ${fd} << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    }
    // Numbered-fd spelling resolves the same way (`source` is a builtin, so
    // it is never wrapped by sudo/env — no wrapper spelling exists for it).
    expect(guardDecision(`source /dev/fd/3 3<< 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("interpreter reading its program from a bound descriptor blocks", () => {
    for (const head of ["bash", "sh", "python3"]) {
      for (const fd of ["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]) {
        expect(guardDecision(`${head} ${fd} << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
      }
    }
    expect(guardDecision(`sudo bash /dev/stdin << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
    expect(guardDecision(`bash -- /dev/stdin << 'EOF'\n${guardedWrite}\nEOF`)).toBe("block");
  });

  it("a NAMED file argument that merely resembles a descriptor path stays data", () => {
    // Not fd 0/N device paths: a real file whose name contains "stdin" or "fd".
    expect(guardDecision(`bash /home/me/dev/stdin.sh << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`source ./config/fd0 << 'EOF'\n${prose}\nEOF`)).toBe("allow");
    expect(guardDecision(`bash script.sh << 'EOF'\n${prose}\nEOF`)).toBe("allow");
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

  it("a present-but-non-string `command` fails CLOSED — never a silent allow (round-25 fail-open)", async () => {
    // The normalizers iterate `text.length`; for a non-string that is `undefined`,
    // so every loop no-ops and every match view comes back empty →
    // referencesGuardedState=false → ALLOW. A crafted or malformed harness payload
    // that delivers `command` as an object/number/boolean would wave straight past
    // the guard. The handler must reject the malformed field type, failing closed.
    for (const command of [{ foo: "rm .claude/state/active_task_graph.json" }, 42, true, ["rm", "x"]]) {
      const stdin = JSON.stringify({
        session_id: "s-nonstr",
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: "toolu_nonstr",
      });
      const result = await runGuardStateFile(stdin, inMemorySessionRegistry());
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("non-string Bash command");
      }
    }
  });

  it("an absent `command` (no Bash payload) still allows — only PRESENT non-strings fail closed", async () => {
    // `tool_input: {}` (or a non-Bash tool) has no command to guard; `undefined`
    // must stay the empty-command allow, not trip the non-string block.
    const stdin = JSON.stringify({
      session_id: "s-nocmd",
      tool_name: "Read",
      tool_input: {},
      tool_use_id: "toolu_nocmd",
    });
    const result = await runGuardStateFile(stdin, inMemorySessionRegistry());
    expect(result.kind).toBe("allow");
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
