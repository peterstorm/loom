import { spawn } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, reportPath] = process.argv.slice(2);
const fixturePath = fileURLToPath(import.meta.url);

function spawnSentinelDescendant(path, parentAction) {
  if (path === undefined) throw new Error(`${mode} requires a sentinel path`);
  const descendant = spawn(process.execPath, [fixturePath, "delayed-sentinel", path], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  descendant.once("message", () => {
    descendant.disconnect();
    descendant.unref();
    parentAction();
  });
}

switch (mode) {
  case "timeout-exit-zero":
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => undefined, 1_000);
    break;
  case "ignore-sigterm":
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1_000);
    break;
  case "self-sigterm":
    process.kill(process.pid, "SIGTERM");
    break;
  case "fresh-report":
    if (reportPath === undefined) throw new Error("fresh-report requires a path");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, Buffer.from([0, 1, 2, 255]));
    break;
  case "missing-report":
    break;
  case "symlink-report-parent":
    if (reportPath === undefined) throw new Error("symlink-report-parent requires a path");
    mkdirSync("report-storage", { recursive: true });
    writeFileSync(`report-storage/${reportPath.split("/").at(-1)}`, "untrusted");
    symlinkSync("report-storage", dirname(reportPath));
    break;
  case "parent-exits-with-descendant":
    spawnSentinelDescendant(reportPath, () => process.exit(0));
    break;
  case "timeout-with-descendant":
    spawnSentinelDescendant(reportPath, () => setInterval(() => undefined, 1_000));
    break;
  case "exit-before-close": {
    // argv: [fixture, mode, sentinelPath, holdMs]. Spawns a grandchild that
    // INHERITS this process's stdout/stderr (holding the runner's pipe
    // write-ends), signals readiness, then exits: Node's 'exit' fires (the
    // leader is reaped) while 'close' stays withheld until the holder
    // releases the inherited pipes.
    const holdMs = Number(process.argv[4]);
    if (!Number.isFinite(holdMs)) throw new Error(`${mode} requires a hold duration`);
    const holder = spawn(process.execPath, [fixturePath, "pipe-holder", reportPath, String(holdMs)], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    holder.once("message", () => {
      holder.disconnect();
      holder.unref();
      process.exit(0);
    });
    break;
  }
  case "pipe-holder": {
    const holdMs = Number(process.argv[4]);
    if (!Number.isFinite(holdMs)) throw new Error("pipe-holder requires a hold duration");
    process.send?.("ready");
    setTimeout(() => {
      if (reportPath !== undefined) writeFileSync(reportPath, "holder survived\n");
      process.exit(0);
    }, holdMs);
    break;
  }
  case "delayed-sentinel":
    process.send?.("ready");
    process.once("disconnect", () => {
      setTimeout(() => writeFileSync(reportPath, "descendant survived\n"), 250);
    });
    break;
  case "diagnostic-tail":
    process.stdout.write("x".repeat(4_096) + "STDOUT-END");
    process.stderr.write("y".repeat(4_096) + "STDERR-END");
    break;
  default:
    process.stderr.write(`unknown completion fixture mode: ${String(mode)}\n`);
    process.exitCode = 2;
}
