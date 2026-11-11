/**
 * One child process run to its end: `stdin` written whole, stdout and stderr
 * collected as text. A spawn failure rejects; a non-zero exit resolves, so the
 * caller decides what a failure means.
 */
import { spawn } from "node:child_process";

export type CollectedChild = Readonly<{ status: number | null; stdout: string; stderr: string }>;

export function collectedChild(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>,
  stdin = "",
): Promise<CollectedChild> {
  return new Promise<CollectedChild>((resolve, reject) => {
    const child = spawn(command, [...args], options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
