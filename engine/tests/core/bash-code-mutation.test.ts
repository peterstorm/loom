import { describe, expect, it } from "vitest";
import { firstBashCodeMutationTarget } from "../../src/core/bash-code-mutation";

describe("firstBashCodeMutationTarget", () => {
  it("does not combine an artifact copy with a later read-only TypeScript CLI invocation", () => {
    const command = [
      "cd /worktree",
      "cp .claude/specs/ui-relay/plan-alignment.md /tmp/plan-alignment-gap-report.md",
      "bun /plugins/loom/engine/src/cli.ts helper set-phase --phase architecture",
      "rm -f .claude/specs/ui-relay/plan-alignment.md",
    ].join(" && ");
    expect(firstBashCodeMutationTarget(command)).toBeNull();
  });

  it("ignores read-only execution of a TypeScript CLI", () => {
    expect(firstBashCodeMutationTarget("bun /plugins/loom/engine/src/cli.ts helper set-phase --phase decompose")).toBeNull();
  });

  it("identifies code redirection targets", () => {
    expect(firstBashCodeMutationTarget("printf '%s' source > src/generated.ts")).toBe("src/generated.ts");
    expect(firstBashCodeMutationTarget("echo x >> src/log.ts")).toBe("src/log.ts");
  });

  it("identifies the destination of code copy and move commands", () => {
    expect(firstBashCodeMutationTarget("cp templates/input.ts src/output.ts")).toBe("src/output.ts");
    expect(firstBashCodeMutationTarget("mv src/old.ts src/new.ts")).toBe("src/new.ts");
  });

  it("identifies in-place sed targets", () => {
    expect(firstBashCodeMutationTarget("sed -i 's/old/new/' src/module.ts")).toBe("src/module.ts");
  });

  it("keeps a piped patch mutation gated", () => {
    expect(firstBashCodeMutationTarget("cat fix.patch | patch src/module.ts")).toBe("src/module.ts");
  });

  it("does not treat copying documentation beside a code command as a code mutation", () => {
    expect(firstBashCodeMutationTarget("cp report.md /tmp/report.md; bun scripts/check.ts --dry-run")).toBeNull();
  });

  it("ignores non-code redirection targets", () => {
    expect(firstBashCodeMutationTarget("echo hi > notes.md")).toBeNull();
  });
});
