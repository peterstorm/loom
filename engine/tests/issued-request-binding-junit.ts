/**
 * JUnit wrapper for the issued-request binding suite, for critical-repair
 * enrollment: the engine's required-file report needs a fresh parseable JUnit
 * XML at an exact path on every run, produced by an allowlisted executable
 * (bun). Runs the real vitest suite; its exit code and summary decide the
 * testcase status. The report path arrives as argv[2].
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const report = process.argv[2];
if (!report) {
  console.error("usage: issued-request-binding-junit.ts <report-path>");
  process.exit(2);
}

let output = "";
let rc = 0;
try {
  output = execFileSync("npx", ["vitest", "run", "tests/handlers/helpers/programs/issued-request-binding.test.ts",
    "--reporter=default"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (thrown) {
  const error = thrown as { status?: number; stdout?: string; stderr?: string };
  rc = typeof error.status === "number" ? error.status : 1;
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}
const summary = output.trimEnd().split("\n").pop() ?? "suite failed";
const failures = rc === 0 ? 0 : 1;
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const name = "vitest tests/handlers/helpers/programs/issued-request-binding.test.ts";
const testcase = failures === 0
  ? `    <testcase name="${esc(name)}" classname="loom.engine"/>\n`
  : `    <testcase name="${esc(name)}" classname="loom.engine">\n` +
    `      <failure message="${esc(summary)}"><![CDATA[${output}]]></failure>\n` +
    `    </testcase>\n`;
const xml =
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n` +
  `  <testsuite name="issued-request-binding" tests="1" failures="${failures}" errors="0" skipped="0">\n` +
  testcase +
  `  </testsuite>\n</testsuites>\n`;
const absolute = path.isAbsolute(report) ? report : path.resolve(process.cwd(), "..", report);
mkdirSync(path.dirname(absolute), { recursive: true });
const tmp = `${absolute}.tmp-${process.pid}`;
writeFileSync(tmp, xml);
renameSync(tmp, absolute);
process.exit(rc);
