import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { HookHandler } from "../../types";
import {
  parseCalibrationCorpus,
  parseCalibrationPredictions,
  scoreCalibration,
  serializeCalibrationScore,
} from "../../core/model-calibration";

const OPERATIONS = ["validate", "prompt", "score"] as const;
const USAGE = `Usage: helper model-calibration <${OPERATIONS.join("|")}> --corpus <file> [--case <id>]`;

function arg(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1]! : null;
}

function loadCorpus(path: string) {
  try { return parseCalibrationCorpus(readFileSync(path, "utf-8")); }
  catch (error) { return { ok: false as const, errors: [`cannot read corpus ${path}: ${error}`] }; }
}

export type CalibrationRevisionProbe =
  | Readonly<{ kind: "present" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "error"; message: string }>;

export function classifyCalibrationRevisionProbeError(
  error: unknown,
  revision: string,
): CalibrationRevisionProbe {
  const detail = error && typeof error === "object"
    ? error as { status?: unknown; stderr?: unknown; code?: unknown; message?: unknown }
    : {};
  const status = typeof detail.status === "number" ? detail.status : null;
  const stderr = detail.stderr === undefined ? "" : String(detail.stderr).trim();
  if (status === 128 && /(?:not a valid object name|bad object|unknown revision|invalid object name)/i.test(stderr)) {
    return { kind: "missing" };
  }
  const code = typeof detail.code === "string" ? `${detail.code}: ` : "";
  const reason = stderr || (typeof detail.message === "string" ? detail.message : String(error));
  return { kind: "error", message: `cannot verify calibration revision ${revision}: ${code}${reason}` };
}

function probeCalibrationRevision(revision: string): CalibrationRevisionProbe {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { kind: "present" };
  } catch (error) {
    return classifyCalibrationRevisionProbeError(error, revision);
  }
}

const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];
  const corpusPath = arg(args, "--corpus") ?? "calibration/corpus.json";
  if (!operation || !(OPERATIONS as readonly string[]).includes(operation)) {
    return { kind: "error", message: USAGE };
  }
  const corpus = loadCorpus(corpusPath);
  if (!corpus.ok) return { kind: "error", message: `Invalid calibration corpus:\n${corpus.errors.map((e) => `  - ${e}`).join("\n")}` };

  if (operation === "validate") {
    const missing: Array<(typeof corpus.value.cases)[number]> = [];
    for (const entry of corpus.value.cases) {
      const probe = probeCalibrationRevision(entry.revision);
      if (probe.kind === "error") return { kind: "error", message: probe.message };
      if (probe.kind === "missing") missing.push(entry);
    }
    if (missing.length > 0) {
      return { kind: "error", message: `Calibration revisions are missing: ${missing.map((entry) => `${entry.id}:${entry.revision}`).join(", ")}` };
    }
    process.stdout.write(`Validated ${corpus.value.cases.length} calibration cases.\n`);
    return { kind: "passthrough" };
  }

  if (operation === "prompt") {
    const caseId = arg(args, "--case");
    const selected = corpus.value.cases.find((entry) => entry.id === caseId);
    if (!selected) return { kind: "error", message: `Unknown calibration case ${JSON.stringify(caseId)}` };
    const paths = [...new Set(selected.expectedCriticals.flatMap((finding) => finding.file ? [finding.file] : []))];
    process.stdout.write([
      `Review historical revision ${selected.revision} (${selected.state}) for critical correctness defects.`,
      `Inspect only these seeded paths first: ${paths.join(", ") || "the changed implementation"}.`,
      `Use git show ${selected.revision}:<path> to read that snapshot; do not judge the current worktree.`,
      "Return ONLY JSON: an array of {severity:'critical', file:string|null, line:number|null, claim:string}.",
      "Report real criticals even when they are not among the seeded expectations; novel findings are retained as unscored.",
    ].join("\n") + "\n");
    return { kind: "passthrough" };
  }

  const predictions = parseCalibrationPredictions(stdin);
  if (!predictions.ok) return { kind: "error", message: `Invalid calibration predictions:\n${predictions.errors.map((e) => `  - ${e}`).join("\n")}` };
  const score = scoreCalibration(corpus.value, predictions.value);
  if (!score.ok) return { kind: "error", message: `Calibration scoring failed:\n${score.errors.map((e) => `  - ${e}`).join("\n")}` };
  process.stdout.write(serializeCalibrationScore(score.value));
  return { kind: "passthrough" };
};

export default handler;
