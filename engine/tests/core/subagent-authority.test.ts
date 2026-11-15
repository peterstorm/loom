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
  parseInheritedEnvironment,
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
const LINKS: Readonly<Record<string, string>> = { "/mnt/alias-of-run-1": R, "/private/audits": "/audits", "/mnt/loom-link": "/opt/loom" };

/** The Loom package the fixture runs in: its machine definitions are protected. */
const LOOM = "/opt/loom";
/** The one read-only Loom script the fixture lists, as the shell observes it. */
const READER = `${LOOM}/scripts/read-context-packet.ts`;

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
  protectedDirectories: ["/tmp/claude-subagents", `${LOOM}/machines`],
  helperOperations: AUTHORITY_HELPER_OPERATIONS,
  hookRoutes: HARNESS_HOOK_ROUTES,
  readOnlyScripts: [READER],
  cdSearchPath: [],
  environment: parseInheritedEnvironment({}),
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

describe("helper operations — the split is derived from each table's subagent trait", () => {
  it.each(Object.entries(SECURITY_AUDIT_OPERATIONS))("security-audit %s", (operation, traits) => {
    expect(verdict(`loom helper security-audit ${operation} --out ${R}`))
      .toBe(traits.subagent === "read-only" ? "allow" : "authority-helper-operation");
  });

  it.each(Object.entries(ORCHESTRATION_OPERATIONS))("orchestration %s", (operation, traits) => {
    expect(verdict(`loom helper orchestration ${operation} --run run.x`))
      .toBe(traits.subagent === "read-only" ? "allow" : "authority-helper-operation");
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

  it("the split mirrors the tables exactly: every known operation is known, read-only is the subagent read-only set", () => {
    for (const [helper, table] of [["security-audit", SECURITY_AUDIT_OPERATIONS], ["orchestration", ORCHESTRATION_OPERATIONS]] as const) {
      const split = AUTHORITY_HELPER_OPERATIONS[helper];
      expect([...split.known].sort()).toEqual(Object.keys(table).sort());
      expect([...split.readOnly].sort()).toEqual(
        Object.entries(table).filter(([, t]) => t.subagent === "read-only").map(([name]) => name).sort());
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

  it("lists Loom's read-only scripts among what a subagent may run", () => {
    expect(render(`echo x > ${R}/ledger.json`))
      .toContain("Loom's read-only scripts (read-context-packet.ts, read-context-section.ts, ledger-epoch.ts)");
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
    ["a symlink whose target the shell builds at runtime, created on the same line", 'T=$(cat /tmp/p); ln -s "${T}its/run-1" /tmp/l; echo x > /tmp/l/ledger.json'],
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

/**
 * Issue #177 — routine work a subagent runs from a checkout that HOLDS a
 * protected directory (Loom's own, whose `machines/` is protected). The
 * checkout is an ancestor of a protected root, so any writer naming `.` or a
 * file under `machines/` there reaches it; these commands write neither.
 */
describe("routine work in a checkout that holds a protected directory (#177)", () => {
  const inLoom = context({ cwd: LOOM });
  const verdictInLoom = (command: string): string => verdict(command, inLoom);

  describe("Loom's own read-only scripts read", () => {
    it.each([
      ["the packet reader diffing a protected file", `bun ${READER} --diff machines/README.md /x/packet.json`],
      ["the reader exactly as Loom prints it, every word quoted",
        `'bun' '${READER}' '--packet' '/tmp/claude-subagents/runs/r/contexts/d.json' '--section' 'diff'`],
      ["bun run", `bun run ${READER} --file machines/a.json`],
      ["a relative script path", "bun scripts/read-context-packet.ts --file machines/a.json"],
      ["the script executed by its path", `${READER} --file machines/a.json`],
      ["a symlinked spelling of the package", "bun /mnt/loom-link/scripts/read-context-packet.ts --file machines/a.json"],
      ["piped into a read-only command", `bun ${READER} --file machines/a.json | jq .`],
      ["its output saved to scratch", `bun ${READER} --file machines/a.json > /tmp/out.json`],
    ])("allows: %s", (_name, command) => {
      expect(verdictInLoom(command)).toBe("allow");
    });

    it.each([
      ["its output redirected into a protected directory", `bun ${READER} --file x > machines/a.json`],
      ["another script beside it", `bun ${LOOM}/scripts/sync-machines.ts machines/a.json`],
      ["a script word the shell completes at runtime", 'bun "$S" --file machines/a.json'],
      ["a script word that is a glob", `bun ${LOOM}/scripts/read-*.ts machines/a.json`],
      ["behind an environment prefix", `NODE_OPTIONS=--require=/x/p.js bun ${READER} --file machines/a.json`],
      ["behind a wrapper", `env bun ${READER} --file machines/a.json`],
      ["piped into a writer", `bun ${READER} --file machines/a.json | tee machines/b.json`],
      ["inline code naming the script", `bun -e 'require("${READER}")' machines/a.json`],
    ])("refuses: %s", (_name, command) => {
      expect(verdictInLoom(command)).toBe("authority-path-write");
    });

    it("lists nothing read-only unless the shell says so", () => {
      expect(verdict(`bun ${READER} --file machines/a.json`, context({ cwd: LOOM, readOnlyScripts: [] }))).toBe("authority-path-write");
    });
  });

  describe("a segment after `cd X &&` runs in X only", () => {
    it.each([
      ["a type check in another checkout", "cd /work/clone && npx tsc --noEmit -p ."],
      ["a chain of commands there", "cd /work/clone && rm -rf dist && npx tsc -p ."],
      ["a relative cd", "cd engine && npx tsc --noEmit -p ."],
      ["two cds", "cd /work && cd ./clone && rm -rf ."],
      ["after an earlier ;", "echo start; cd /work/clone && rm -rf ."],
      ["after an earlier ||", "true || cd /work/x; cd /work/clone && rm -rf ."],
      ["pushd", "pushd /work/clone >/dev/null && rm -rf ."],
      ["a cd behind builtin", "builtin cd /work/clone && rm -rf ."],
      ["home", "cd ~/clone && rm -rf ."],
    ])("allows: %s", (_name, command) => {
      expect(verdictInLoom(command)).toBe("allow");
    });

    it.each([
      ["; runs even when the cd fails", "cd /work/clone; rm -rf ."],
      ["|| runs only when the cd fails", "cd /work/clone || rm -rf ."],
      ["&& after an || that may have skipped the cd", "true || cd /work/clone && rm -rf ."],
      ["|| after a cd chain, which also runs when the cd failed", "cd /work/clone && false || rm -rf ."],
      ["a later ;", "cd /work/clone && true; rm -rf ."],
      ["a subshell cd", "(cd /work/clone) && rm -rf ."],
      ["a grouped cd", "{ cd /work/clone; } && rm -rf ."],
      ["a cd inside a loop", "for d in a; do cd /work/clone; done && rm -rf ."],
      ["a negated cd", "! cd /work/clone && rm -rf ."],
      ["a cd in a pipeline", "cd /work/clone | cat && rm -rf ."],
      ["a backgrounded cd", "cd /work/clone & rm -rf ."],
      ["cd -", "cd /work/clone && cd - && rm -rf ."],
      ["popd", "pushd /work/clone && popd && rm -rf ."],
      ["a cd the shell completes at runtime", 'cd "$D" && rm -rf .'],
      ["a cd into the protected directory", "cd machines && rm -rf ."],
      ["a relative cd naming the protected directory's parent", "cd ../loom && rm -rf machines"],
      ["CDPATH set on the line", "CDPATH=/tmp cd claude-subagents && rm -rf ."],
    ])("refuses: %s", (_name, command) => {
      expect(verdictInLoom(command)).toBe("authority-path-write");
    });

    it("a bare relative cd also searches the CDPATH the shell observed", () => {
      const withCdPath = context({ cwd: "/home/u", cdSearchPath: ["/tmp"] });
      expect(verdict("cd claude-subagents && rm -rf .", withCdPath)).toBe("authority-path-write");
      expect(verdict("cd ./claude-subagents && rm -rf .", withCdPath)).toBe("allow");
      expect(verdict("cd claude-subagents && rm -rf .", context({ cwd: "/home/u" }))).toBe("allow");
    });

    it("an unparseable line is judged in every directory the line may reach", () => {
      expect(verdictInLoom("cd /work/clone && rm -rf . $(echo")).toBe("unparseable-authority-command");
    });
  });

  describe("a bare assignment of an inert name binds a path; it writes nothing above it", () => {
    it.each([
      ["a bare assignment under /tmp", "T=$CLAUDE_JOB_DIR/tmp"],
      ["a bare assignment of /tmp", "T=/tmp"],
      ["several assignments", "A=/tmp B=/opt/loom"],
      ["a quoted value", 'T="$CLAUDE_JOB_DIR/tmp"'],
      ["the checkout itself, read plainly", `ROOT=${LOOM}; echo "$ROOT"`],
      ["a writer under a bound variable, outside every protected directory", "T=/tmp; rm -rf $T/build"],
      ["a value the shell completes at runtime, then written under", "T=$CLAUDE_JOB_DIR/tmp; mkdir -p $T/guard && cat x > $T/guard/probe.ts"],
      ["an environment prefix binds nothing for later segments", "T=/tmp true; rm -rf $T/claude-subagents"],
    ])("allows: %s", (_name, command) => {
      expect(verdictInLoom(command)).toBe("allow");
    });

    it.each([
      ["a bare assignment of a protected directory", "T=/tmp/claude-subagents"],
      ["a bare assignment inside one", "T=/tmp/claude-subagents/x && rm -rf $T"],
      ["export inside one", `export M=${LOOM}/machines`],
      ["an assignment beside a writer", "T=/tmp rm -rf /tmp/claude-subagents"],
      ["a writer reaching the ancestor an assignment names", "T=/tmp; rm -rf /tmp"],
      ["a writer extending a variable bound to an ancestor", "T=/tmp; rm -rf $T/claude-subagents"],
      ["the same, through a runtime-completed value", "T=$CLAUDE_JOB_DIR/tmp; rm -rf $T/claude-subagents"],
      ["the same, braced and quoted", "T=/tmp && rm -rf \"${T}/claude-subagents\""],
      ["the same, exported", "export T=/tmp; rm -rf $T/claude-subagents"],
      ["the same, inside a substitution", "T=/tmp; echo $(rm -rf $T/claude-subagents)"],
      ["the same, inside bash -c", `T=/tmp; bash -c "rm -rf $T/claude-subagents"`],
      ["a redirect through a bound variable", `ROOT=${LOOM}; echo x > $ROOT/machines/a.json`],
      ["a variable bound later on the line (a loop may run it first)", "rm -rf $T/claude-subagents; T=/tmp"],
      ["a symlink onto a run, its target spelled through a bound variable", 'T=/aud; ln -s "${T}its/run-1" /tmp/l; echo x > /tmp/l/ledger.json'],
      // A declaration may export the value to a program the guard cannot read: it reaches, as on main.
      ["export of an ancestor", "export T=/tmp"],
      ["declare -x of an ancestor", "declare -x T=/tmp"],
      ["local of an ancestor", "local T=/opt"],
    ])("refuses: %s", (_name, command) => {
      expect(verdictInLoom(command)).toBe("authority-path-write");
    });

    /** PR #180 review: each read the guard does not splice must leave the assignment reaching. */
    it.each([
      ["a parameter operation", "T=/tmp; rm -rf ${T%x}"],
      ["a default expansion", "T=/tmp; rm -rf ${T:-}"],
      ["an array element", "T=/tmp; rm -rf ${T[0]}"],
      ["an array", "a=(/tmp); rm -rf ${a[0]}"],
      ["an indirection", "T=/tmp; U=T; rm -rf ${!U}"],
      ["a nameref", "declare -n U=T; T=/tmp; rm -rf $U"],
      ["a copy into another variable", "T=/tmp; U=$T; rm -rf $U/claude-subagents"],
      ["a value word splitting changes", 'T="/tmp "; rm -rf $T'],
      ["a glob value", "T=/tm[p]; rm -rf $T"],
      ["an ANSI-C value", "T=$'/tmp'; rm -rf $T"],
      ["an exported value read by interpreter code", `T=/tmp; export T; python3 -c 'import os,shutil; shutil.rmtree(os.environ["T"])'`],
      ["allexport", "set -a; T=/tmp; python3 -c 'x'"],
      ["a sourced script", "T=/tmp; source ./x.sh"],
      ["a cd through it", "T=/tmp; cd $T && rm -rf claude-subagents"],
      ["a cd through it, then find -delete", "T=/tmp; cd $T && find . -delete"],
      ["HOME bound to an ancestor", "HOME=/tmp; rm -rf ~/claude-subagents"],
      ["HOME, then a bare cd", "HOME=/tmp; cd && rm -rf claude-subagents"],
      ["HOME exported, then cd ~", "export HOME=/tmp; cd ~ && rm -rf claude-subagents"],
      ["HOME at the checkout", `HOME=${LOOM}; rm -rf ~/machines`],
      // HOME read from input: `~` is unknown, so its authority entry names count.
      ["HOME read, then ~", "read HOME < /tmp/h; rm ~/ledger.json"],
      ["HOME read, then a bare cd", "read HOME < /tmp/h; cd && rm ledger.json"],
      ["a name also declared, then bound bare", "export T=/var; T=/tmp; node x.js"],
      ["IFS splits a bound value where the guard does not", "IFS=:; T=x:/tmp/claude-subagents:y; rm -rf $T"],
      ["IFS read from input", "read IFS < /tmp/i; T=x:/tmp/claude-subagents:y; rm -rf $T"],
    ])("refuses: %s", (_name, command) => {
      expect(verdict(command, context({ cwd: "/repo" }))).toBe("authority-path-write");
    });

    it.each([
      ["an IFS prefix splits only its command's input", 'IFS=, read -r a b <<< "$x"'],
      ["an IFS prefix does not split the words of its own command", "T=/tmp/x; IFS=: rm -rf $T"],
    ])("allows: %s", (_name, command) => {
      expect(verdict(command, context({ cwd: "/repo" }))).toBe("allow");
    });

    it("more spellings than the guard builds fail closed", () => {
      const bindings = (count: number): string => Array.from({ length: count }, (_, index) => `T=/v${index}`).join("; ");
      expect(verdictInLoom(`${bindings(17)}; rm -rf $T`)).toBe("authority-path-write");
      expect(verdictInLoom(`${bindings(15)}; rm -rf $T`)).toBe("allow");
    });

    it("a script FILE past the cap, or setting IFS, is judged on its words as written", () => {
      const bindings = Array.from({ length: 17 }, (_, index) => `T=/v${index}`).join("\n");
      const running = (text: string): SubagentAuthorityContext => context({ cwd: LOOM, filesystem: { ...FAKE_FILESYSTEM,
        readScript: (path) => (path === "/repo/many.sh" ? { kind: "text", text } : { kind: "unreadable", reason: "ENOENT" }) } });
      expect(verdict("bash /repo/many.sh", running(`${bindings}\nrm -rf $T`))).toBe("allow");
      expect(verdict("bash /repo/many.sh", running("IFS=:\nT=/v\nrm -rf $T"))).toBe("allow");
      expect(verdict("bash /repo/many.sh", running(`${bindings}\nrm -rf $T /tmp/claude-subagents`))).toBe("authority-path-write");
    });
  });
});

/** PR #180 review: the moves and rebindings the separator walk must not trust. */
describe("moves the guard cannot follow fall back to every directory (#177 review)", () => {
  it.each([
    ["pushd -n only edits the stack", "/tmp", "pushd -n /repo && rm -rf claude-subagents"],
    ["pushd -n from the checkout", LOOM, "pushd -n /repo && rm -rf machines"],
    ["a popd lands on the directory pushd -n stacked", "/repo", "pushd -n /opt/loom && popd >/dev/null && rm -rf machines"],
    ["lastpipe runs a pipeline's last cd in this shell", "/tmp", "shopt -s lastpipe; true | cd /repo; rm -rf claude-subagents"],
    ["CDPATH set by printf -v", LOOM, "printf -v CDPATH /opt; cd loom && rm -rf machines"],
    ["CDPATH set by read", LOOM, "read CDPATH <<< /opt; cd loom && rm -rf machines"],
    // The search path is unknown, but bash still tries the target under the current directory.
    ["CDPATH set by read, from the protected directory's grandparent", "/opt", "read CDPATH < /tmp/c; cd loom && rm -rf machines"],
    ["cd -P resolves .. physically", LOOM, "cd -P /repo/l/.. && rm -rf machines"],
    ["set -P makes every cd physical", LOOM, "set -P; cd /repo/l/.. && rm -rf machines"],
  ])("refuses: %s", (_name, cwd, command) => {
    expect(verdict(command, context({ cwd }))).toBe("authority-path-write");
  });

  it("pushd -n alone leaves the segment where it was", () => {
    expect(verdict("pushd -n /opt/loom && rm -rf machines", context({ cwd: "/repo" }))).toBe("allow");
  });

  it.each([
    ["a script by bare name is looked up on PATH", `${LOOM}/scripts`, "read-context-packet.ts --file /opt/loom/machines"],
    ["hash rebinds bun", LOOM, `hash -p /bin/rm bun; bun ${READER} -r /opt/loom/machines`],
    ["an alias rebinds bun", LOOM, `alias bun='rm -rf'\nbun ${READER} /opt/loom/machines`],
    ["a function rebinds bun", LOOM, `bun() { rm -rf "$@"; }; bun ${READER} /opt/loom/machines`],
  ])("a read-only script is not trusted: %s", (_name, cwd, command) => {
    expect(verdict(command, context({ cwd, readOnlyScripts: [READER] }))).not.toBe("allow");
  });

  it.each([
    ["hash rebinds cat", "hash -p /bin/rm cat; cat -r /opt/loom/machines"],
    ["an alias rebinds ls", "alias ls='rm -rf'\nls /tmp/claude-subagents"],
    ["a function rebinds cd", 'cd() { rm -rf "$@"; }; cd /opt/loom/machines'],
    ["a function rebinds loom", `loom() { rm -rf "$@"; }; loom helper security-audit status --out ${R}`],
  ])("a read-only head is not trusted on a line that rebinds a command: %s", (_name, command) => {
    expect(verdict(command)).toBe("authority-path-write");
  });

  it("a read-only head stays trusted on a line that rebinds nothing", () => {
    expect(verdict("cat -r /opt/loom/machines")).toBe("allow");
  });
});

/** A git invocation that writes nothing outside the repository's `.git` reads (`core/read-only-git.ts`). */
describe("git in a checkout that holds a protected directory (#177 follow-up)", () => {
  it.each([
    ["fetch by -C", "/repo", `git -C ${LOOM} fetch`],
    ["status by -C", "/repo", `git -C ${LOOM} status --short`],
    ["log by -C, then a cd elsewhere", "/repo", `git -C ${LOOM} log --oneline -5 && cd /tmp`],
    ["a diff of a protected file", LOOM, "git diff HEAD~1 -- machines/a.json"],
    ["show of a protected file", LOOM, "git --no-pager show HEAD:machines/a.json"],
    ["-C . from the checkout", LOOM, "git -C . rev-parse HEAD"],
    ["piped into a reader", "/repo", `git -C ${LOOM} log --oneline | head -3`],
    ["a quoted git head", "/repo", `'git' -C "${LOOM}" fetch`],
    ["fetch -u, which moves only a ref", "/repo", `git -C ${LOOM} fetch -u origin main`],
  ])("allows: %s", (_name, cwd, command) => {
    expect(verdict(command, context({ cwd }))).toBe("allow");
  });

  it.each([
    ["checkout over a protected directory", "/repo", `git -C ${LOOM} checkout -- machines`],
    ["clean in the checkout", "/repo", `git -C ${LOOM} clean -fdx`],
    ["log writing a protected file", "/repo", `git -C ${LOOM} log --output=${LOOM}/machines/a.json`],
    ["an abbreviated --output", LOOM, "git diff --outp=machines/a.json"],
    ["a config value that runs a command", "/repo", `git -C ${LOOM} -c core.fsmonitor=x status`],
    ["fetch --upload-pack", "/repo", `git -C ${LOOM} fetch --upload-pack=x origin`],
    ["grep -O", LOOM, "git grep -O rm machines"],
    ["an environment prefix", "/repo", `GIT_DIR=/x git -C ${LOOM} status`],
    ["a wrapper", "/repo", `env git -C ${LOOM} status`],
    ["a runtime option word", "/repo", `git -C ${LOOM} log $OPT`],
    ["a redirect into a protected directory", "/repo", `git -C ${LOOM} log > ${LOOM}/machines/a.json`],
    ["piped into a writer", "/repo", `git -C ${LOOM} show HEAD:x | tee ${LOOM}/machines/a.json`],
    ["a line that rebinds git", "/repo", `git() { rm -rf "$@"; }; git -C ${LOOM} fetch`],
    ["ls-remote --exec, the hidden synonym of --upload-pack", "/repo", `git -C ${LOOM} ls-remote --exec='cp /tmp/x machines/a.json;' .`],
    ["ls-remote --exec from the checkout", LOOM, "git ls-remote --exec=/bin/sh machines"],
    ["a -C directory the shell completes at runtime", "/repo", `git -C "$D" fetch ${LOOM}/machines`],
    ["a read followed by a writer", "/repo", `git -C ${LOOM} fetch && rm -r ${LOOM}/machines`],
  ])("refuses: %s", (_name, cwd, command) => {
    expect(verdict(command, context({ cwd }))).toBe("authority-path-write");
  });
});

describe("parseInheritedEnvironment — the inherited variables the guard can splice", () => {
  it("keeps each identifier whose value is literal path text, an empty one included", () => {
    const parsed = parseInheritedEnvironment({ LOOM_ROOT: LOOM, EMPTY: "", PATH: "/a:/b", TMPDIR: "/tmp", A_1: "x=y,z@1+%" });
    expect([...parsed]).toEqual([["LOOM_ROOT", LOOM], ["EMPTY", ""], ["PATH", "/a:/b"], ["TMPDIR", "/tmp"], ["A_1", "x=y,z@1+%"]]);
  });

  it.each([
    ["the working directory bash keeps itself", "PWD"],
    ["its predecessor", "OLDPWD"],
    ["the nesting level", "SHLVL"],
    ["the last argument", "_"],
    ["word splitting", "IFS"],
    ["a BASH name", "BASH_ENV"],
    ["bash's options", "BASHOPTS"],
    ["a dynamic variable", "RANDOM"],
    ["a name that is no identifier", "A-B"],
    ["a name starting with a digit", "1X"],
  ])("drops %s", (_label, name) => {
    expect(parseInheritedEnvironment({ [name]: "/tmp" }).has(name)).toBe(false);
  });

  it.each([
    ["whitespace, which splits", "/tmp/claude-subagents x"],
    ["a newline", "/tmp\n/x"],
    ["a glob", "/tmp/*"],
    ["a quote", "'/tmp'"],
    ["an expansion, which the shell does not expand again", "$HOME/x"],
    ["a tilde, which an expansion does not resolve", "~/x"],
    ["a brace", "/tmp/{a,b}"],
  ])("drops a value holding %s", (_label, value) => {
    expect(parseInheritedEnvironment({ X: value }).has("X")).toBe(false);
  });

  it("drops an unset variable", () => {
    expect(parseInheritedEnvironment({ X: undefined }).size).toBe(0);
  });
});

/**
 * A variable the shell inherits is judged with the value the shell observed in
 * place as well as as written; `$PWD` with every directory the segment may run
 * in. A variable no line on the way rebinds holds exactly that value, so a `cd`
 * through it is placed and a git or read-only script word reading it is static.
 */
describe("the environment the shell inherits, and $PWD", () => {
  const withEnvironment = (environment: Readonly<Record<string, string>>, cwd: string = "/repo"): SubagentAuthorityContext =>
    context({ cwd, environment: parseInheritedEnvironment(environment) });
  const ROOTED = { LOOM_ROOT: LOOM, TMPDIR: "/tmp", RUN: R, CLONE: "/work/clone", A: "/opt" };
  const judged = (command: string, cwd?: string): string => verdict(command, withEnvironment(ROOTED, cwd));

  it.each([
    ["a write under an inherited checkout", "rm -rf $LOOM_ROOT/machines"],
    ["braced and quoted", 'rm -rf "${LOOM_ROOT}"/machines/a.json'],
    ["an inherited ancestor of the subagent directory", "rm -rf $TMPDIR/claude-subagents"],
    ["a writer naming the ancestor itself", "cp x $TMPDIR"],
    ["a redirect through an inherited run directory", "echo x > $RUN/ledger.json"],
    ["a line binding built from an inherited value", "D=$A/loom; rm -rf $D/machines"],
    ["a cd through an inherited checkout", "cd $LOOM_ROOT && rm -rf machines"],
    ["a git option held in an inherited variable", 'git -C /opt/loom log $OPT'],
  ])("refuses: %s", (_label, command) => {
    const environment = { ...ROOTED, OPT: `--output=${LOOM}/machines/a.json` };
    expect(verdict(command, withEnvironment(environment))).toBe("authority-path-write");
  });

  it.each([
    ["a write beside the subagent directory", "cp x $TMPDIR/out.txt"],
    ["a git -C through an inherited checkout", 'git -C "$LOOM_ROOT" fetch'],
    ["a cd through an inherited clone, then a writer there", 'cd "$CLONE" && rm -rf .'],
    ["a quoted read on a line that sets IFS is never split", 'IFS=:; cp a "$TMPDIR/out"'],
  ])("allows: %s", (_label, command) => {
    expect(judged(command, LOOM)).toBe("allow");
  });

  it("reads Loom's read-only script through an inherited package root", () => {
    expect(judged("bun $LOOM_ROOT/scripts/read-context-packet.ts --file machines/a.json", LOOM)).toBe("allow");
  });

  it("drops a variable's pin on a line that may bind a name it does not spell", () => {
    const optionInherited = withEnvironment({ V: "--oneline" });
    // The name is built at runtime and the value read from a file: only the pin rule sees it.
    expect(verdict(`N=$(printf '\\x56'); read -r "$N" < /tmp/v; git -C ${LOOM} log $V`, optionInherited)).toBe("authority-path-write");
    // A line that rebinds the name by its own spelling drops its pin too.
    expect(verdict(`V+=x; git -C ${LOOM} log $V`, optionInherited)).toBe("authority-path-write");
    expect(verdict(`V=--output=/x/y; git -C ${LOOM} log $V`, optionInherited)).toBe("authority-path-write");
    expect(verdict(`git -C ${LOOM} log $V`, optionInherited)).toBe("allow");
    expect(verdict(`read -r V < /tmp/v; git -C ${LOOM} log $V`, optionInherited)).toBe("authority-path-write");
  });

  it("a cd through an inherited variable the line also rebinds may land on the observed value", () => {
    const inherited = withEnvironment({ E: LOOM });
    expect(verdict("cd \"$E\" && rm -rf machines; E=/elsewhere", inherited)).toBe("authority-path-write");
    expect(verdict("E=/elsewhere", inherited)).toBe("allow");
  });

  it("a cd the guard cannot place still lands where its bound spellings lead, searched and home-resolved", () => {
    // CDPATH=/opt: `cd loom` lands in /opt/loom.
    expect(verdict("D=loom; cd $D && rm -rf machines", context({ cwd: "/repo", cdSearchPath: ["/opt"] }))).toBe("authority-path-write");
    // The assignment expands ~; the cd lands in /home/u/x, beside the protected directory.
    const nearHome = context({ protectedDirectories: ["/home/u/.claude/shell-snapshots"] });
    expect(verdict("D=~/x; cd $D && rm -rf ../.claude/shell-snapshots", nearHome)).toBe("authority-path-write");
    expect(verdict("D=~/x; cd $D && rm -rf ../.claude/other", nearHome)).toBe("allow");
  });

  it("an absolute landing is a directory the line reaches even when the starting directory is unknown, like a placed cd", () => {
    // `read` unpins E, so the cd is unknown; its one spelling is still a place it may land.
    const unknownStart = context({ cwd: null, environment: parseInheritedEnvironment({ E: LOOM }) });
    expect(verdict("read Z < /tmp/z; cd $E && rm -rf machines", unknownStart)).toBe("authority-path-write");
    expect(verdict(`cd ${LOOM} && rm -rf machines`, unknownStart)).toBe("authority-path-write");
    expect(verdict("read Z < /tmp/z; cd $E && rm -rf dist", unknownStart)).toBe("allow");
  });

  it("an unquoted inherited read on a line that sets IFS may split anywhere: it fails closed", () => {
    expect(verdict("IFS=:; rm -rf $P", withEnvironment({ P: "x:/tmp/claude-subagents:y" }))).toBe("authority-path-write");
  });

  it.each([
    ["a write under $PWD", "rm -rf $PWD/machines"],
    ["$PWD itself", 'rm -rf "$PWD"'],
    ["a cd under $PWD", "cd $PWD/machines && rm -rf ."],
  ])("$PWD is where the segment runs — refuses: %s", (_label, command) => {
    expect(verdict(command, context({ cwd: LOOM }))).toBe("authority-path-write");
  });

  it("$PWD is the segment's own directory, never the PWD the hook process inherited", () => {
    expect(verdict("rm -rf $PWD/machines", withEnvironment({ PWD: LOOM }, "/repo"))).toBe("allow");
    expect(verdict(`git -C "$PWD" status`, context({ cwd: LOOM }))).toBe("allow");
    expect(verdict("cd /work/clone && rm -rf $PWD/machines", context({ cwd: LOOM }))).toBe("allow");
    // A line that may set PWD leaves it no single value: the script it names is unknown.
    expect(verdict("read PWD < /tmp/p; bun $PWD/scripts/read-context-packet.ts --file machines/a.json", context({ cwd: LOOM }))).toBe("authority-path-write");
    expect(verdict("bun $PWD/scripts/read-context-packet.ts --file machines/a.json", context({ cwd: LOOM }))).toBe("allow");
    // A cd that starts at $PWD is relative to where the shell is: placed, not unknown.
    expect(verdict("cd $PWD/engine && rm -rf .", context({ cwd: LOOM }))).toBe("allow");
  });
});

/** Claude Code carries a session's shell state between Bash calls in its config directory: the shell protects it. */
describe("the shell state Claude Code carries between Bash calls", () => {
  const SNAPSHOTS = "/home/u/.claude/shell-snapshots";
  const SESSION_ENV = "/home/u/.claude/session-env";
  const guarded = context({ protectedDirectories: ["/tmp/claude-subagents", `${LOOM}/machines`, SNAPSHOTS, SESSION_ENV] });

  it.each([
    ["an alias appended to the snapshot", `echo "alias ls='rm -rf'" >> ${SNAPSHOTS}/snapshot-bash-1.sh`],
    ["the snapshot rewritten through ~", "cp evil.sh ~/.claude/shell-snapshots/snapshot-bash-1.sh"],
    ["a session environment file", `echo 'export HOME=/tmp' > ${SESSION_ENV}/s-1/hook-0.sh`],
    ["the whole config directory", "rm -rf ~/.claude"],
  ])("refuses: %s", (_label, command) => {
    expect(verdict(command, guarded)).toBe("authority-path-write");
  });

  it("refuses a write through the inherited CLAUDE_ENV_FILE", () => {
    const withEnvFile = { ...guarded, environment: parseInheritedEnvironment({ CLAUDE_ENV_FILE: `${SESSION_ENV}/s-1/hook-0.sh` }) };
    expect(verdict('echo "alias git=rm" >> "$CLAUDE_ENV_FILE"', withEnvFile)).toBe("authority-path-write");
  });

  it("allows reading it and writing beside it", () => {
    expect(verdict(`cat ${SNAPSHOTS}/snapshot-bash-1.sh`, guarded)).toBe("allow");
    expect(verdict("echo x > ~/.claude/notes.md", guarded)).toBe("allow");
  });
});
