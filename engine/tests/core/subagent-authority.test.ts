/**
 * core/subagent-authority (ADR-0067 D6) — the pure decision both harness
 * adapters apply to a SUBAGENT's Bash command. Table-driven: helper operations
 * (derived from the operation tables' traits), every recognised invocation
 * form, authority-path writes vs the hunter's scratch/artifacts space,
 * registered vs unregistered directories, cwd-relative paths, the unreadable
 * registry, and the documented bypass classes pinned as known gaps.
 */
import { describe, expect, it } from "vitest";
import {
  LEXICAL_FILESYSTEM,
  decideSubagentAuthority,
  securityAuditVerifyInvocations,
  renderSubagentAuthorityRefusal,
  type SubagentAuthorityContext,
  type SubagentFilesystemView,
  type SubagentAuthorityRefusal,
} from "../../src/core/subagent-authority";
import { SECURITY_AUDIT_AUTHORITY_ENTRIES, SECURITY_AUDIT_RUN_FILES } from "../../src/core/audit-run-authority";
import { AUTHORITY_HELPER_OPERATIONS, HARNESS_HOOK_ROUTES } from "../../src/handlers/pre-tool-use/subagent-authority-operations";
import { SECURITY_AUDIT_OPERATIONS } from "../../src/handlers/helpers/security-audit-operations";
import { ORCHESTRATION_OPERATIONS } from "../../src/handlers/helpers/orchestration-operations";

const R = "/audits/run-1";

/** The scripts the fake filesystem holds, by absolute path. */
const SCRIPTS: Readonly<Record<string, string>> = {
  "/repo/forge.sh": "loom helper security-audit submit --out /x <<'EOF'\n{}\nEOF\n",
  "/tmp/forge.sh": `echo forged > ${R}/verdicts.json\n`,
  "/repo/forged-hook.sh": "#!/usr/bin/env bash\nbun /opt/loom/engine/src/cli.ts subagent-stop dispatch < /tmp/payload.json\n",
  "/repo/build.sh": "#!/bin/bash\nset -euo pipefail\nnpm run build\necho done > dist/stamp\n",
  "/repo/tool.py": "#!/usr/bin/env python3\nimport subprocess\nsubprocess.run(['loom','helper','security-audit','publish','--out','/x'])\n",
  "/repo/README.md": "Run `loom helper security-audit status` to see the run.\n",
  "/repo/bin/native": "\u007fELF\u0002\u0001\u0001 binary helper orchestration submit",
};
/** Symlinks the fake filesystem resolves: a planted alias of the run directory. */
const LINKS: Readonly<Record<string, string>> = { "/mnt/alias-of-run-1": R, "/private/audits": "/audits" };

const FAKE_FILESYSTEM: SubagentFilesystemView = {
  canonicalize: (path) => {
    for (const [link, target] of Object.entries(LINKS)) {
      if (path === link || path.startsWith(`${link}/`)) return `${target}${path.slice(link.length)}`;
    }
    return path;
  },
  readScript: (path) => SCRIPTS[path] === undefined
    ? { kind: "unreadable", reason: "ENOENT" }
    : { kind: "text", text: SCRIPTS[path]! },
};

const context = (overrides: Partial<SubagentAuthorityContext> = {}): SubagentAuthorityContext => ({
  cwd: "/repo",
  home: "/home/u",
  runs: { kind: "known", directories: [R] },
  protectedDirectories: ["/tmp/claude-subagents", "/opt/loom/machines"],
  helperOperations: AUTHORITY_HELPER_OPERATIONS,
  hookRoutes: HARNESS_HOOK_ROUTES,
  filesystem: FAKE_FILESYSTEM,
  ...overrides,
});

const decide = (command: string, ctx: SubagentAuthorityContext = context()) => decideSubagentAuthority(command, ctx);

const refusalOf = (command: string, ctx?: SubagentAuthorityContext): SubagentAuthorityRefusal => {
  const decision = decide(command, ctx);
  if (decision.kind !== "refuse") throw new Error(`expected a refusal for ${JSON.stringify(command)}`);
  return decision.refusal;
};

const verdict = (command: string, ctx?: SubagentAuthorityContext): string => {
  const decision = decide(command, ctx);
  return decision.kind === "allow" ? "allow" : decision.refusal.rule;
};

describe("helper operations — the split is derived from each table's runtimeSkew trait", () => {
  it.each(Object.entries(SECURITY_AUDIT_OPERATIONS))("security-audit %s", (operation, traits) => {
    expect(verdict(`loom helper security-audit ${operation} --out ${R}`))
      .toBe(traits.runtimeSkew === "available" ? "allow" : "authority-helper-operation");
  });

  it.each(Object.entries(ORCHESTRATION_OPERATIONS))("orchestration %s", (operation, traits) => {
    expect(verdict(`loom helper orchestration ${operation} --run run.x`))
      .toBe(traits.runtimeSkew === "available" ? "allow" : "authority-helper-operation");
  });

  it("refuses exactly the ADR-0067 D6 lists (and allows its read-only list)", () => {
    for (const operation of ["start", "assign", "submit", "defer", "merge-critic", "verify", "publish", "disposition"]) {
      expect(verdict(`loom helper security-audit ${operation} --out ${R}`), operation).toBe("authority-helper-operation");
    }
    for (const operation of ["start", "resume", "submit", "correlate", "decide", "abandon"]) {
      expect(verdict(`loom helper orchestration ${operation}`), operation).toBe("authority-helper-operation");
    }
    for (const operation of ["nonce", "status", "findings"]) {
      expect(verdict(`loom helper security-audit ${operation} --out ${R}`), operation).toBe("allow");
    }
  });

  it("the split mirrors the tables exactly: every known operation is known, read-only is the skew-available set", () => {
    for (const [helper, table] of [["security-audit", SECURITY_AUDIT_OPERATIONS], ["orchestration", ORCHESTRATION_OPERATIONS]] as const) {
      const split = AUTHORITY_HELPER_OPERATIONS[helper];
      expect([...split.known].sort()).toEqual(Object.keys(table).sort());
      expect([...split.readOnly].sort()).toEqual(
        Object.entries(table).filter(([, t]) => t.runtimeSkew === "available").map(([name]) => name).sort());
    }
  });

  it("classifies a NEW operation by the trait it declares, not by a copied list", () => {
    const operations = {
      ...AUTHORITY_HELPER_OPERATIONS,
      "security-audit": {
        known: new Set([...AUTHORITY_HELPER_OPERATIONS["security-audit"].known, "inspect-ballots", "rebind"]),
        readOnly: new Set([...AUTHORITY_HELPER_OPERATIONS["security-audit"].readOnly, "inspect-ballots"]),
      },
    };
    expect(verdict(`loom helper security-audit inspect-ballots --out ${R}`, context({ helperOperations: operations }))).toBe("allow");
    expect(verdict(`loom helper security-audit rebind --out ${R}`, context({ helperOperations: operations }))).toBe("authority-helper-operation");
  });

  it.each([
    ["missing operation", "loom helper security-audit"],
    ["runtime-built operation", `loom helper security-audit $OP --out ${R}`],
    ["substituted operation", `loom helper security-audit $(echo submit) --out ${R}`],
    ["unknown operation", `loom helper security-audit frobnicate --out ${R}`],
    ["prototype key", "loom helper orchestration toString"],
  ])("refuses an operation that is not statically one read-only name: %s", (_name, command) => {
    expect(verdict(command)).toBe("authority-helper-operation");
  });

  it("names the helper and operation in the refusal", () => {
    expect(refusalOf(`loom helper security-audit verify --out ${R}`)).toEqual({
      rule: "authority-helper-operation",
      segment: `loom helper security-audit verify --out ${R}`,
      helper: "security-audit",
      operation: "verify",
    });
  });
});

describe("helper invocation forms", () => {
  const forms: readonly (readonly [string, (rest: string) => string])[] = [
    ["loom on PATH", (rest) => `loom helper ${rest}`],
    ["absolute loom", (rest) => `/usr/local/bin/loom helper ${rest}`],
    ["bun + absolute cli.ts", (rest) => `bun /plugins/loom/engine/src/cli.ts helper ${rest}`],
    ["bun + relative cli.ts", (rest) => `bun engine/src/cli.ts helper ${rest}`],
    ["bun run", (rest) => `bun run /plugins/loom/engine/src/cli.ts helper ${rest}`],
    ["bun with plugin root var", (rest) => `bun "\${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" helper ${rest}`],
    ["node + cli.js", (rest) => `node /plugins/loom/dist/cli.js helper ${rest}`],
    ["npx tsx", (rest) => `npx tsx engine/src/cli.ts helper ${rest}`],
    ["direct cli.ts", (rest) => `/plugins/loom/engine/src/cli.ts helper ${rest}`],
    ["./cli.ts", (rest) => `./engine/src/cli.ts helper ${rest}`],
    ["env prefix", (rest) => `LOOM_X=1 loom helper ${rest}`],
    ["several env prefixes", (rest) => `FOO=bar BAZ="a b" LOOM_HOME=/opt/loom loom helper ${rest}`],
    ["env prefix before bun cli.ts", (rest) => `NODE_ENV=production bun /plugins/loom/engine/src/cli.ts helper ${rest}`],
    ["env prefix inside bash -c", (rest) => `bash -c 'FOO=bar loom helper ${rest}'`],
    ["env wrapper", (rest) => `env -u FOO loom helper ${rest}`],
    ["timeout wrapper", (rest) => `timeout 30 loom helper ${rest}`],
    ["nohup wrapper", (rest) => `nohup loom helper ${rest}`],
    ["constructed head", (rest) => `$(which loom) helper ${rest}`],
    ["variable head", (rest) => `"$LOOM" helper ${rest}`],
    ["bash -c", (rest) => `bash -c 'loom helper ${rest}'`],
    ["sh -c double quotes", (rest) => `sh -c "bun /p/engine/src/cli.ts helper ${rest}"`],
    ["eval", (rest) => `eval 'loom helper ${rest}'`],
    ["xargs", (rest) => `echo x | xargs -n 1 loom helper ${rest}`],
    ["after &&", (rest) => `cd /repo && loom helper ${rest}`],
    ["in a pipe", (rest) => `cat r.json | loom helper ${rest}`],
    ["in a substitution", (rest) => `echo "$(loom helper ${rest})"`],
    ["in backticks", (rest) => `echo \`loom helper ${rest}\``],
    ["executed heredoc", (rest) => `bash <<'EOF'\nloom helper ${rest}\nEOF`],
    ["subshell", (rest) => `( loom helper ${rest} )`],
    ["quoted helper and operation", () => `loom 'helper' "security-audit" 'submit' --out ${R}`],
    ["split quoting", () => `loom helper secu"rity-audit" sub'mit' --out ${R}`],
  ];

  it.each(forms)("%s: a write operation is refused", (_name, form) => {
    expect(verdict(form(`security-audit submit --out ${R}`))).toBe("authority-helper-operation");
  });

  it.each(forms.filter(([name]) => !name.includes("quot")))("%s: a read-only operation is allowed", (_name, form) => {
    expect(verdict(form(`security-audit status --out ${R}`))).toBe("allow");
  });

  it.each([
    ["grep for the text", "grep -rn 'helper security-audit submit' docs/"],
    ["echo the text", "echo loom helper security-audit submit"],
    ["a heredoc that only holds the text", "cat > /tmp/notes.md <<'EOF'\nloom helper security-audit submit\nEOF"],
    ["another helper", "loom helper standalone-review status"],
    ["a different program's helper word", "make helper security-audit"],
    ["the sandbox script", `scripts/security-sandbox.sh --target /repo --scratch ${R}/agents/h/scratch --nonce n -- npm test > ${R}/agents/h/artifacts/out.txt`],
  ])("does not mistake text for an invocation: %s", (_name, command) => {
    expect(verdict(command)).toBe("allow");
  });
});

describe("authority paths of a registered run", () => {
  it.each<readonly [string, string]>([
    ...Object.values(SECURITY_AUDIT_RUN_FILES).map((file) => [`redirect onto ${file}`, `echo x > ${R}/${file}`] as const),
    ["append redirect", `echo x >> ${R}/run.json`],
    ["clobber redirect", `printf x >| ${R}/findings.json`],
    ["stdout+stderr redirect", `cat a &> ${R}/verdicts.json`],
    ["fd redirect", `cmd 2> ${R}/ledger.json`],
    ["fused redirect", `echo x >${R}/ledger.json`],
    ["read-write redirect", `cat <> ${R}/ledger.json`],
    ["redirect from a read-only head", `jq . new.json > ${R}/ledger.json`],
    ["tee", `cat x | tee ${R}/security-findings.json`],
    ["tee -a", `echo x | tee -a ${R}/disposition.json`],
    ["cp onto", `cp x ${R}/standalone-disposition.json`],
    ["cp into the run dir", `cp ledger.json ${R}/`],
    ["cp -r over the run dir", `cp -r fake/. ${R}`],
    ["mv onto", `mv x ${R}/lenses.json`],
    ["rm", `rm ${R}/REPORT.md`],
    ["sed -i", `sed -i s/a/b/ ${R}/ledger.json`],
    ["dd of=", `dd if=x of=${R}/ledger.json`],
    ["touch", `touch ${R}/findings.json`],
    ["chmod", `chmod 666 ${R}/ledger.json`],
    ["ln -s over", `ln -sf /tmp/x ${R}/ledger.json`],
    ["verification run file", `touch ${R}/verification-runs/run.verify-w1/result.json`],
    ["verification runs tree", `rm -rf ${R}/verification-runs`],
    ["the run directory", `rm -rf ${R}`],
    ["the run directory, trailing slash", `rm -rf ${R}/`],
    ["an ancestor of the run", "rm -rf /audits"],
    ["tar into an ancestor", "tar -xf fake.tar -C /audits"],
    ["git -C the run", `git -C ${R} checkout -- ledger.json`],
    ["glob over the run", `rm -rf ${R}/*`],
    ["glob json", `rm ${R}/*.json`],
    ["glob char", `rm ${R}/l?dger.json`],
    ["glob class", `rm ${R}/[l]edger.json`],
    ["glob on the run name", "rm -rf /audits/run-*"],
    ["brace expansion", `rm ${R}/{ledger,notes}.json`],
    ["quoted directory", `rm "${R}"/ledger.json`],
    ["quoted fragment", `rm ${R}/'ledger'.json`],
    ["dot segment", `rm ${R}/./ledger.json`],
    ["dot-dot segment", `rm ${R}/agents/../ledger.json`],
    ["doubled slash", `rm ${R}//ledger.json`],
    ["fused short option", `sort -o${R}/ledger.json x`],
    ["long option value", `foo --output=${R}/findings.json`],
    ["bare assignment", `F=${R}/ledger.json`],
    ["export", `export F=${R}/ledger.json`],
    ["read then pipe to a writer", `echo ${R}/ledger.json | xargs rm`],
    ["substitution body", `echo "$(rm ${R}/ledger.json)"`],
    ["process substitution body", `diff a <(cat x > ${R}/ledger.json)`],
    ["output process substitution", `cat x > >(tee ${R}/ledger.json)`],
    ["executed heredoc", `bash <<'EOF'\nrm ${R}/ledger.json\nEOF`],
    ["heredoc written onto authority", `cat > ${R}/ledger.json <<'EOF'\n{}\nEOF`],
    ["bash -c", `bash -c 'echo x > ${R}/ledger.json'`],
    ["python naming the path", `python3 -c "open('${R}/ledger.json','w').write('x')"`],
    ["runtime-completed directory", `rm "$RUN/ledger.json"`],
    ["runtime-completed directory, braces", "rm ${RUN}/verification-runs/x"],
    ["substitution-completed directory", "rm $(dirname x)/findings.json"],
  ])("refuses: %s", (_name, command) => {
    expect(verdict(command)).toBe("authority-path-write");
  });

  it.each([
    ["cat", `cat ${R}/ledger.json`],
    ["jq", `jq '.units | length' ${R}/ledger.json`],
    ["ls", `ls -la ${R}`],
    ["grep", `grep -c fingerprint ${R}/verdicts.json`],
    ["diff", `diff ${R}/findings.json other.json`],
    ["copy out to scratch", `cat ${R}/ledger.json > ${R}/agents/h/scratch/ledger-copy.json`],
    ["copy out to /tmp through a pipe", `cat ${R}/ledger.json | jq . > /tmp/ledger.json`],
    ["stderr discard", `cat ${R}/run.json 2>/dev/null`],
    ["write scratch", `echo x > ${R}/agents/security-hunter-agent-1/scratch/notes.md`],
    ["write artifacts", `npm test > ${R}/agents/h/artifacts/test-output.txt 2>&1`],
    ["tee artifacts", `npm test | tee ${R}/agents/h/artifacts/out.txt`],
    ["mkdir scratch", `mkdir -p ${R}/agents/h/scratch/work`],
    ["clean scratch", `rm -rf ${R}/agents/h/scratch/*`],
    ["cp into scratch", `cp src/a.ts ${R}/agents/h/scratch/`],
    ["cd into the run and read", `cd ${R} && ls && cat ledger.json`],
    ["cd into scratch and write", `cd ${R}/agents/h/scratch && echo x > notes.md`],
    ["nonce with --out", `loom helper security-audit nonce --out ${R} --artifact agents/h/artifacts/out.txt`],
    ["status saved to scratch", `loom helper security-audit status --out ${R} --json > ${R}/agents/h/scratch/status.json`],
  ])("allows: %s", (_name, command) => {
    expect(verdict(command)).toBe("allow");
  });

  it("refuses a read-only helper that redirects onto authority", () => {
    expect(verdict(`loom helper security-audit findings --out ${R} > ${R}/REPORT.md`)).toBe("authority-path-write");
  });

  it("names the authority path and the writing segment", () => {
    expect(refusalOf(`cat ${R}/ledger.json && cp x ${R}/ledger.json`)).toEqual({
      rule: "authority-path-write",
      segment: `cp x ${R}/ledger.json`,
      path: `${R}/ledger.json`,
    });
  });
});

describe("registered vs unregistered directories", () => {
  it.each([
    ["an unregistered run", "echo x > /audits/run-2/ledger.json"],
    ["a sibling sharing a prefix", "echo x > /audits/run-10/ledger.json"],
    ["a sibling sharing a prefix, rm -rf", "rm -rf /audits/run-1x"],
    ["an authority-named file in the repo", "echo '{}' > findings.json"],
    ["an authority-named file elsewhere", "cp x /tmp/run.json"],
  ])("allows writes outside every registered run: %s", (_name, command) => {
    expect(verdict(command)).toBe("allow");
  });

  it("protects every registered run", () => {
    const ctx = context({ runs: { kind: "known", directories: [R, "/audits/run-2"] } });
    expect(verdict("echo x > /audits/run-2/ledger.json", ctx)).toBe("authority-path-write");
    expect(verdict(`echo x > ${R}/ledger.json`, ctx)).toBe("authority-path-write");
  });

  it("protects nothing run-specific when no run is registered", () => {
    expect(verdict(`echo x > ${R}/ledger.json`, context({ runs: { kind: "known", directories: [] } }))).toBe("allow");
  });
});

describe("cwd-relative paths", () => {
  it.each([
    ["relative from a sibling dir", "/repo", "rm ../audits/run-1/ledger.json"],
    ["relative from the parent", "/audits", "echo x > run-1/findings.json"],
    ["inside the run", R, "echo x > ledger.json"],
    ["inside the run: rm -rf .", R, "rm -rf ."],
    ["inside the run: glob", R, "rm *"],
    ["inside the run: verification-runs", R, "mkdir verification-runs/x"],
    ["inside scratch, climbing out", `${R}/agents/h/scratch`, "echo x > ../../../ledger.json"],
    ["after cd", "/repo", `cd ${R} && echo x > ledger.json`],
    ["after two relative cds", "/repo", "cd /audits; cd run-1; rm verdicts.json"],
    ["after pushd", "/repo", `pushd ${R} >/dev/null; rm verdicts.json`],
    ["after cd into scratch then climbing", "/repo", `cd ${R}/agents/h/scratch && rm ../../../run.json`],
    ["subshell cd (over-approximated)", "/repo", `(cd ${R}); rm ledger.json`],
    ["home", "/repo", "rm ~/audits/run-1/ledger.json"],
  ])("refuses: %s", (_name, cwd, command) => {
    const ctx = context({ cwd, runs: { kind: "known", directories: [R, "/home/u/audits/run-1"] } });
    expect(verdict(command, ctx)).toBe("authority-path-write");
  });

  it.each([
    ["inside the run: scratch", R, "echo x > agents/h/scratch/notes.md"],
    ["unrelated relative name", "/repo", "echo x > ledger.json"],
    ["cd elsewhere", "/repo", "cd /tmp && echo x > ledger.json"],
  ])("allows: %s", (_name, cwd, command) => {
    expect(verdict(command, context({ cwd }))).toBe("allow");
  });

  it("an unresolvable cd makes relative authority names count", () => {
    expect(verdict('cd "$(cat dir)" && echo x > ledger.json')).toBe("authority-path-write");
    expect(verdict('cd "$(cat dir)" && echo x > notes.md')).toBe("allow");
  });

  it("an unknown cwd judges relative paths by the authority names they carry", () => {
    const ctx = context({ cwd: null });
    expect(verdict("echo x > ledger.json", ctx)).toBe("authority-path-write");
    expect(verdict("echo x > notes.md", ctx)).toBe("allow");
    expect(verdict(`echo x > ${R}/ledger.json`, ctx)).toBe("authority-path-write");
  });
});

describe("protected Loom directories", () => {
  it.each([
    ["remove the run registry", "rm -rf /tmp/claude-subagents/security-audit-runs"],
    ["forge a registry entry", "echo '{}' > /tmp/claude-subagents/security-audit-runs/a.json"],
    ["remove the subagent dir", "rm -rf /tmp/claude-subagents"],
    ["glob the subagent dir", "rm -rf /tmp/claude-sub*"],
    ["glob its parent", "rm -rf /tmp/*"],
    ["rewrite a machine definition", "cp x /opt/loom/machines/code-implementer-agent.json"],
  ])("refuses: %s", (_name, command) => {
    expect(verdict(command)).toBe("authority-path-write");
  });

  it.each([
    ["read the registry", "ls /tmp/claude-subagents/security-audit-runs"],
    ["write a temp file", "echo x > /tmp/out.txt"],
    ["environment assignment naming /tmp", "TMPDIR=/tmp npm test"],
    ["cd /tmp", "cd /tmp && ls"],
  ])("allows: %s", (_name, command) => {
    expect(verdict(command)).toBe("allow");
  });
});

describe("ordinary subagent work passes through", () => {
  it.each([
    "git status",
    "git diff HEAD~1 -- src/",
    "npm test",
    "bun test > /tmp/out.txt 2>&1",
    "rg -n 'createHash' engine/src",
    "find . -name '*.ts' | head",
    "VERSION=$(git rev-parse HEAD)",
    "npm test -- $(cat files.txt)",
    "echo $(date) > out.txt",
    "cat > notes.md <<'EOF'\nthe ledger lives at /audits/run-1/ledger.json\nEOF",
    "",
  ])("%j", (command) => {
    expect(verdict(command)).toBe("allow");
  });
});

describe("unreadable registry — fail closed on every authority-shaped path", () => {
  const unreadable = context({ runs: { kind: "unreadable", reason: "registry entry x.json is not JSON" } });

  it.each([
    ["absolute authority file", "echo x > /anywhere/ledger.json"],
    ["relative authority file", "echo x > findings.json"],
    ["verification runs", "rm -rf /x/verification-runs"],
    ["glob with a literal part", "rm /x/*.json"],
  ])("refuses: %s", (_name, command) => {
    expect(verdict(command, unreadable)).toBe("authority-path-write");
  });

  it.each([
    ["read an authority file", "cat /x/ledger.json"],
    ["write an unrelated file", "echo x > /repo/notes.json"],
    ["a substitution argument", "npm test -- $(cat files)"],
  ])("allows: %s", (_name, command) => {
    expect(verdict(command, unreadable)).toBe("allow");
  });

  it("still classifies helper operations", () => {
    expect(verdict("loom helper security-audit submit --out /x", unreadable)).toBe("authority-helper-operation");
    expect(verdict("loom helper security-audit status --out /x", unreadable)).toBe("allow");
  });

  it("says why in the refusal", () => {
    const decision = decide("echo x > /anywhere/ledger.json", unreadable);
    if (decision.kind !== "refuse") throw new Error("expected a refusal");
    expect(renderSubagentAuthorityRefusal(decision.refusal, unreadable)).toContain("registry is unreadable");
  });
});

describe("unparseable commands that name authority", () => {
  it("refuses an unclosed substitution naming a run path", () => {
    expect(verdict(`echo $(cat ${R}/ledger.json`)).toBe("unparseable-authority-command");
  });

  it("refuses substitution nesting past the depth bound", () => {
    const nested = "$(".repeat(8) + "true" + ")".repeat(8);
    expect(verdict(`echo ${nested}`)).toBe("unparseable-authority-command");
  });

  it("allows an unclosed substitution that names nothing governed", () => {
    expect(verdict("echo $(date")).toBe("allow");
  });
});

describe("refusal text", () => {
  const ctx = context();
  const render = (command: string): string => renderSubagentAuthorityRefusal(refusalOf(command, ctx), ctx);

  it("names the rule, the segment, and tells the agent to return to the parent", () => {
    const text = render(`loom helper security-audit verify --out ${R}`);
    expect(text).toContain("guard-subagent-authority (ADR-0067 D6)");
    expect(text).toContain("`helper security-audit verify` is not a read-only operation");
    expect(text).toContain(`Offending segment: "loom helper security-audit verify --out ${R}"`);
    expect(text).toContain("Return your result to the parent session");
  });

  it("lists the read-only operations from the tables", () => {
    expect(render(`echo x > ${R}/ledger.json`)).toContain("security-audit findings|nonce|status; orchestration brief|inspect|status");
  });

  it("names the path for an authority write", () => {
    expect(render(`echo x > ${R}/ledger.json`)).toContain(`may write ${R}/ledger.json`);
  });
});

describe("every authority entry is protected", () => {
  it.each(SECURITY_AUDIT_AUTHORITY_ENTRIES)("%s", (entry) => {
    expect(verdict(`rm -rf ${R}/${entry}`)).toBe("authority-path-write");
    expect(verdict(`cat ${R}/${entry}`)).toBe("allow");
  });
});

/**
 * KNOWN GAPS — allowed, and pinned as allowed so a change in coverage is a
 * visible decision. ADR-0067 Option B: shell-string matching is a fence, not a
 * proof; the capture binding (D1–D4) is what makes a ballot authoritative.
 * These mirror guard-state-file's documented residuals (constructed command
 * names, variable indirection).
 */
describe("known gaps (documented bypass classes, allowed by design)", () => {
  it.each([
    ["eval of runtime-built words", 'a="loom helper security-audit"; b=submit; eval "$a $b"'],
    ["a command held whole in a variable", 'c="loom helper security-audit submit"; $c --out "$OUT"'],
    ["a variable holding a whole authority path", 'P=$(cat /tmp/p); rm "$P"'],
    ["an interpreter building the code at runtime", "python3 -c \"exec(__import__('base64').b64decode('cHJpbnQoMSk='))\""],
    ["a command name spelled in printf escapes, piped to a shell", "printf '\\x6c\\x6f\\x6f\\x6d helper security-audit submit' | bash"],
    ["a script whose text is runtime-built, then run", 'printf "%s" "$PAYLOAD" > s.sh; bash s.sh'],
    ["a symlink whose target the shell builds, created on the same line", 'T=/aud; ln -s "${T}its/run-1" /tmp/l; echo x > /tmp/l/ledger.json'],
    ["an executed interpreter script file", "/repo/tool.py"],
    ["an interpreter's own script FILE (only literal code is scanned)", "python3 tool.py"],
  ])("%s", (_name, command) => {
    expect(verdict(command)).toBe("allow");
  });
});

/** ADR-0067 (amended), F: the normalisations the fence applies. Every form
 *  is refused; each benign look-alike is allowed. */
describe("fence normalisations (F)", () => {
  it.each([
    ["a backslash-escaped command word", "\\loom helper security-audit submit --out /x"],
    ["an escape inside the command word", "l\\oom helper security-audit verify --out /x"],
    ["an escaped wrapper", "\\command loom helper orchestration submit --run r"],
    ["time", "time loom helper security-audit publish --out /x"],
    ["time -p", "time -p loom helper security-audit publish --out /x"],
    ["coproc", "coproc loom helper security-audit publish --out /x"],
    ["named coproc", "coproc FORGE { loom helper security-audit publish --out /x; }"],
    ["negation", "! loom helper security-audit publish --out /x"],
    ["command / builtin", "command loom helper security-audit publish --out /x"],
    ["nice / nohup / timeout / stdbuf / setsid", "nice -n 5 nohup timeout 5 stdbuf -o0 setsid loom helper security-audit publish --out /x"],
  ])("%s is still the helper invocation", (_name, command) => {
    expect(verdict(command)).toBe("authority-helper-operation");
  });

  it.each([
    ["a here-string to bash", "bash <<< 'loom helper security-audit submit --out /x'"],
    ["a fused here-string", "sh <<<'loom helper orchestration submit --run r'"],
    ["a pipe from echo", "echo 'loom helper security-audit verify --out /x' | bash"],
    ["a pipe from printf", "printf 'loom helper security-audit verify --out /x\\n' | sh -s"],
    ["a pipe from a script file", "cat forge.sh | bash"],
    ["an input redirect", "bash < forge.sh"],
    ["a script file argument", "bash forge.sh"],
    ["a script file behind flags", "bash -e -o pipefail ./forge.sh"],
    ["source", "source forge.sh"],
    ["dot", ". /repo/forge.sh"],
  ])("%s: the fed script is judged", (_name, command) => {
    expect(verdict(command)).toBe("authority-helper-operation");
  });

  it("judges a fed script's authority path writes too", () => {
    expect(verdict("source /tmp/forge.sh")).toBe("authority-path-write");
    expect(verdict("bash /tmp/forge.sh")).toBe("authority-path-write");
    expect(verdict("zsh < /tmp/forge.sh")).toBe("authority-path-write");
  });

  it("judges an executed script by its shebang", () => {
    expect(verdict("./forged-hook.sh")).toBe("harness-hook-entrypoint");
    expect(verdict("./build.sh")).toBe("allow");
    expect(verdict("bin/native --help")).toBe("allow");
  });

  it("refuses an unreadable script only when the line concerns authority", () => {
    expect(verdict("bash ./missing.sh")).toBe("allow");
    expect(verdict("printf 'loom helper security-audit publish' > s.sh; bash s.sh")).toBe("unreadable-script");
    expect(verdict(`bash ./missing.sh ${R}`)).toBe("unreadable-script");
    expect(refusalOf("cd \"$D\" && bash x.sh helper")).toMatchObject({ rule: "unreadable-script" });
  });

  it.each([
    ["python -c", "python3 -c \"import subprocess; subprocess.run(['loom', 'helper', 'security-audit', 'submit'])\""],
    ["node -e", "node -e \"require('child_process').execSync('loom helper orchestration submit --run r')\""],
    ["node -p", "node -p \"require('child_process').execSync('loom helper orchestration correlate')\""],
    ["bun -e importing an engine handler", "bun -e \"import('/opt/loom/engine/src/handlers/helpers/security-audit.ts')\""],
    ["perl -e", "perl -e 'system(\"loom helper security-audit verify --out /x\")'"],
    ["ruby -e", "ruby -e 'system(%q(loom helper security-audit publish --out /x))'"],
    ["awk", "awk 'BEGIN { system(\"loom helper security-audit submit --out /x\") }'"],
    ["a python here-string", "python3 <<< 'import os; os.system(\"loom helper security-audit verify\")'"],
    ["a node pipe", "echo \"require('/l/engine/src/orchestration/capture-attestation-store.ts')\" | node"],
    ["an import of the run registry", "bun -e \"await import('../engine/src/orchestration/security-audit-run-registry.ts')\""],
    ["a CLI hook entry in code", "python3 -c \"import os; os.system('bun /l/engine/src/cli.ts subagent-stop dispatch')\""],
  ])("%s: interpreter code naming authority is refused", (_name, command) => {
    expect(verdict(command)).toBe("interpreter-authority-code");
  });

  it.each([
    ["find -exec", "find . -name x -exec loom helper security-audit submit --out /x \;"],
    ["find -execdir +", "find . -execdir loom helper orchestration submit --run r +"],
    ["xargs", "echo /x | xargs loom helper security-audit publish --out"],
  ])("%s runs its command", (_name, command) => {
    expect(verdict(command)).toBe("authority-helper-operation");
  });

  it.each([
    ["claude", "claude -p 'do the audit'"],
    ["pi", "pi --mode json -p --no-session 'x'"],
    ["npx claude-code", "npx @anthropic-ai/claude-code -p hi"],
    ["bunx claude", "bunx claude -p hi"],
    ["pnpm dlx pi", "pnpm dlx @earendil-works/pi-coding-agent -p hi"],
    ["an escaped claude behind env", "env FOO=1 \\claude -p hi"],
  ])("%s: a nested harness is refused", (_name, command) => {
    expect(verdict(command)).toBe("nested-harness");
  });

  it.each([
    ["subagent-stop", "bun /opt/loom/engine/src/cli.ts subagent-stop capture-orchestration-result < p.json"],
    ["post-tool-use", "loom post-tool-use record-orchestration-spawn"],
    ["pre-tool-use", "node ./engine/src/cli.ts pre-tool-use guard-subagent-authority"],
  ])("%s: a hook entrypoint is refused", (_name, command) => {
    expect(verdict(command)).toBe("harness-hook-entrypoint");
  });

  it.each([
    ["an escaped read-only command", "\\cat /etc/hosts"],
    ["time of a test run", "time bun test"],
    ["a benign here-string", "bash <<< 'echo hello'"],
    ["a benign pipe to a shell", "echo 'ls -la' | bash"],
    ["a benign build script", "bash build.sh"],
    ["a python one-liner", "python3 -c 'print(1 + 1)'"],
    ["node printing", "node -e \"console.log('helper text')\""],
    ["awk over a file", "awk '{ print $1 }' data.txt"],
    ["find -exec grep", "find . -name '*.ts' -exec grep -l helper {} \;"],
    ["a word that mentions claude", "echo claude is a model"],
    ["grep for pi", "grep -rn 'pi' src"],
    ["a read-only helper in code", "python3 -c \"import os; os.system('loom helper security-audit status --out /x')\""],
    ["the docs mention the helper", "cat README.md"],
    ["a CLI helper call", "bun /opt/loom/engine/src/cli.ts helper security-audit status --out /x"],
  ])("%s: allowed", (_name, command) => {
    expect(verdict(command)).toBe("allow");
  });
});

describe("symlinked spellings of a run (C)", () => {
  it("judges a path through a symlinked ancestor as the run it reaches", () => {
    expect(verdict("echo x > /mnt/alias-of-run-1/ledger.json")).toBe("authority-path-write");
    expect(verdict("echo x > /private/audits/run-1/verdicts.json")).toBe("authority-path-write");
    expect(verdict("rm -rf /mnt/alias-of-run-1")).toBe("authority-path-write");
    // The alias's scratch space stays writable, like the run's own.
    expect(verdict("echo x > /mnt/alias-of-run-1/agents/h/scratch/n.txt")).toBe("allow");
  });

  it("judges a path lexically when no filesystem view is given", () => {
    expect(verdict("echo x > /mnt/alias-of-run-1/ledger.json", context({ filesystem: LEXICAL_FILESYSTEM }))).toBe("allow");
  });
});

describe("securityAuditVerifyInvocations — the verify imports a line may make (Pi parent witness check)", () => {
  const invocations = (command: string) => securityAuditVerifyInvocations(command, context());

  it.each([
    ["plain", `loom helper security-audit verify --out ${R} --from run.verify-w1-a`],
    ["env prefix", `FOO=bar loom helper security-audit verify --out ${R} --from run.verify-w1-a`],
    ["bun cli.ts", `bun /p/engine/src/cli.ts helper security-audit verify --out ${R} --from run.verify-w1-a`],
    ["after &&", `cd /x && loom helper security-audit verify --out ${R} --from run.verify-w1-a`],
    ["bash -c", `bash -c 'loom helper security-audit verify --out ${R} --from run.verify-w1-a'`],
    ["substitution", `echo "$(loom helper security-audit verify --out ${R} --from run.verify-w1-a)"`],
    ["quoted words", `loom helper 'security-audit' "verify" --out "${R}" --from 'run.verify-w1-a'`],
  ])("%s: one static invocation with its exact words", (_name, command) => {
    expect(invocations(command)).toEqual([
      expect.objectContaining({ kind: "static", args: ["--out", R, "--from", "run.verify-w1-a"] }),
    ]);
  });

  it.each([
    ["a runtime --out", `loom helper security-audit verify --out "$OUT" --from run.verify-w1-a`],
    ["a substituted --from", `loom helper security-audit verify --out ${R} --from "$(cat f)"`],
    ["a brace set", `loom helper security-audit verify --out ${R} --from run.verify-w1-{a,b}`],
    ["a glob", `loom helper security-audit verify --out ${R} --from run.verify-w1-*`],
    ["a runtime operation", `loom helper security-audit $OP --out ${R} --from run.verify-w1-a`],
    ["a runtime helper", `loom helper "$H" verify --out ${R} --from run.verify-w1-a`],
  ])("%s: unresolved", (_name, command) => {
    expect(invocations(command).map((invocation) => invocation.kind)).toEqual(["unresolved"]);
  });

  it.each([
    ["another operation", `loom helper security-audit status --out ${R}`],
    ["orchestration", "loom helper orchestration verify --run x"],
    ["text, not an invocation", `echo loom helper security-audit verify --out ${R} --from run.verify-w1-a`],
    ["a grep", "grep -rn 'helper security-audit verify' docs/"],
  ])("%s: none", (_name, command) => {
    expect(invocations(command)).toEqual([]);
  });

  it("finds every invocation on one line", () => {
    expect(invocations(`loom helper security-audit verify --out ${R} --from a; loom helper security-audit verify --out ${R} --from b`)
      .map((invocation) => invocation.kind === "static" ? invocation.args[3] : null)).toEqual(["a", "b"]);
  });
});

describe("securityAuditVerifyInvocations — fed forms are never static (F)", () => {
  const invocations = (command: string) => securityAuditVerifyInvocations(command, context());
  it.each([
    ["a here-string", `bash <<< 'loom helper security-audit verify --out ${R} --from run.verify-w1-g1-a'`],
    ["a pipe", `echo 'loom helper security-audit verify --out ${R} --from run.verify-w1-g1-a' | bash`],
    ["interpreter code", `python3 -c "import os; os.system('loom helper security-audit verify --out ${R}')"`],
  ])("%s: every invocation found is unresolved", (_name, command) => {
    const found = invocations(command);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((invocation) => invocation.kind === "unresolved")).toBe(true);
  });

  it.each([
    // Not fed: the shell reads these words itself — an escaped head resolves
    // to `loom`, and `find -exec` runs its command words verbatim.
    ["an escaped head", `\\loom helper security-audit verify --out ${R} --from run.verify-w1-g1-a`],
    ["find -exec", `find . -maxdepth 0 -exec loom helper security-audit verify --out ${R} --from run.verify-w1-g1-a \;`],
  ])("%s: one static invocation", (_name, command) => {
    expect(invocations(command).map((invocation) => invocation.kind)).toEqual(["static"]);
  });

  it("reads a script that would import, as unresolved", () => {
    const withScript: SubagentAuthorityContext = context({ filesystem: { ...FAKE_FILESYSTEM,
      readScript: () => ({ kind: "text", text: `loom helper security-audit verify --out ${R} --from run.verify-w1-g1-a` }) } });
    expect(securityAuditVerifyInvocations("bash import.sh", withScript).map((invocation) => invocation.kind)).toEqual(["unresolved"]);
  });
});

/**
 * A fed script is read where the line's `cd` leads, by BOTH judgments: the
 * collector tracks the line's directories exactly as `judgeLine` does (one
 * shared rule), so `cd /b && bash run.sh` reads `/b/run.sh`, never only the
 * starting cwd's `run.sh` — a verify import hidden there is found.
 */
describe("fed scripts are read in the directories a `cd` on the line leads to", () => {
  const IMPORT = `loom helper security-audit verify --out ${R} --from run.verify-w1-g1-a\n`;
  const SUBMIT = `loom helper security-audit submit --out ${R}\n`;
  /** Scripts only in directories other than the starting cwd `/repo`. */
  const scripts = (text: string): SubagentAuthorityContext => context({ filesystem: { ...FAKE_FILESYSTEM,
    readScript: (path) => ["/b/run.sh", "/repo/sub/run.sh"].includes(path)
      ? { kind: "text", text }
      : { kind: "unreadable", reason: "ENOENT" } } });
  const kinds = (command: string): readonly string[] =>
    securityAuditVerifyInvocations(command, scripts(IMPORT)).map((invocation) => invocation.kind);

  it.each([
    ["an absolute cd", "cd /b && bash run.sh"],
    ["an absolute cd, ; separated", "cd /b; bash ./run.sh"],
    ["a relative cd", "cd sub && bash run.sh"],
    ["pushd", "pushd /b >/dev/null && source run.sh"],
    ["an input redirect after cd", "cd /b && bash < run.sh"],
  ])("the collector finds the import in the cd'd script: %s", (_name, command) => {
    expect(kinds(command)).toEqual(["unresolved"]);
  });

  it("finds nothing when no directory the line may be in holds the script", () => {
    expect(kinds("cd /elsewhere && bash run.sh")).toEqual([]);
    expect(kinds("bash run.sh")).toEqual([]);
  });

  it.each([
    ["an absolute cd", "cd /b && bash run.sh"],
    ["a relative cd", "cd sub && bash run.sh"],
    ["pushd", "pushd /b >/dev/null && source run.sh"],
  ])("judgeLine reads the same script, unchanged: %s", (_name, command) => {
    expect(verdict(command, scripts(SUBMIT))).toBe("authority-helper-operation");
    expect(verdict(command, scripts("npm test\n"))).toBe("allow");
  });
});
