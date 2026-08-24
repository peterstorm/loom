import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [mode, reportPath] = process.argv.slice(2);

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
  case "diagnostic-tail":
    process.stdout.write("x".repeat(4_096) + "STDOUT-END");
    process.stderr.write("y".repeat(4_096) + "STDERR-END");
    break;
  default:
    process.stderr.write(`unknown completion fixture mode: ${String(mode)}\n`);
    process.exitCode = 2;
}
