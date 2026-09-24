/**
 * Focused regression pins for the raced spawn-failed arm of the completion
 * check runner (code-reviewer-1 / pr-test-analyzer-2, round-4).
 *
 * When the spawned process fails asynchronously AFTER its pid was assigned
 * (the child emits `error` instead of ever closing), the timeout and
 * cancellation triggers still run process-group containment — but the group
 * dissolves because nothing ever ran, and the leader never reaps. Reporting
 * that race as an unexplained "parent close observation is unavailable" would
 * hide the errno cause; the runner must surface the raced spawn-failed
 * observation instead: "<trigger> process group is gone but the spawned
 * process had failed to start: <cause>".
 *
 * `spawn` is scripted to return a fake child whose pid is outside every
 * platform's pid space, so the process-group probes resolve ESRCH (the group
 * is provably gone) without any real process; `spawnSync` stays real for
 * fixture setup. The fake child emits `error` once, asynchronously, after the
 * trigger window opens.
 */

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  readonly pid = 999_999_999;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const fake = vi.hoisted(() => ({ children: [] as FakeChild[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (): FakeChild => {
      const child = new FakeChild();
      fake.children.push(child);
      setTimeout(() => child.emit("error", new Error("spawn fixture-child ENOENT")), 120);
      return child;
    },
  };
});

import {
  parseAuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionCheck,
} from "../../src/core/completion-suite";
import {
  runCompletionCheck,
  type CompletionCheckRunnerResult,
} from "../../src/orchestration/completion-check-runner";
import {
  parseCanonicalRepositoryRoot,
  type CanonicalRepositoryRoot,
} from "../../src/utils/workspace-digest";

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

const roots: string[] = [];

function fixtureRoot(): CanonicalRepositoryRoot {
  const root = canonicalTempDir("loom-raced-spawn-");
  roots.push(root);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root });
  if (initialized.status !== 0) throw new Error("raced-spawn fixture Git init failed");
  const parsed = parseCanonicalRepositoryRoot(root);
  if (!parsed.ok) throw new Error("message" in parsed.error ? parsed.error.message : "root observation drifted");
  return parsed.value;
}

function check(name: string, overrides: Partial<{ timeoutMs: number }> = {}): ProjectCommandCheck {
  const parsed = parseAuthorizedWaveCompletionCheck({
    kind: "project-command",
    checkId: `project:${name}`,
    scope: "wave",
    executable: "node",
    args: ["fixture-child.mjs"],
    cwd: ".",
    timeoutMs: overrides.timeoutMs ?? 2_000,
    reportPolicy: { kind: "not-required" },
  });
  if (!parsed.ok || parsed.value.kind !== "project-command") throw new Error("invalid raced-spawn test check");
  return parsed.value;
}

function refusalOf(result: CompletionCheckRunnerResult): { readonly kind: string; readonly message: string } {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("raced arm expected a refusal");
  return { kind: result.error.kind, message: result.error.message };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

beforeEach(() => {
  fake.children.length = 0;
});

describe("raced spawn failure surfaces the errno cause instead of an unavailable close", () => {
  it("reports the raced spawn-failed cause on a timeout trigger", async () => {
    const result = refusalOf(await runCompletionCheck(check("raced-timeout", { timeoutMs: 30 }), fixtureRoot()));
    expect(result.kind).toBe("termination-unconfirmed");
    expect(result.message).toContain(
      "timeout process group is gone but the spawned process had failed to start: spawn fixture-child ENOENT",
    );
    expect(fake.children).toHaveLength(1);
    expect(fake.children[0]!.killed).toBe(false);
  });

  it("reports the raced spawn-failed cause on a cancellation trigger", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = refusalOf(await runCompletionCheck(
      check("raced-cancel", { timeoutMs: 60_000 }),
      fixtureRoot(),
      { signal: controller.signal },
    ));
    expect(result.kind).toBe("termination-unconfirmed");
    expect(result.message).toContain(
      "cancelled process group is gone but the spawned process had failed to start: spawn fixture-child ENOENT",
    );
    expect(fake.children).toHaveLength(1);
    expect(fake.children[0]!.killed).toBe(false);
  });
});
