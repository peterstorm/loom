import { execFileSync } from "node:child_process";
import { argumentValue } from "./cli-args";
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

/** Label-blind review scope derived only from the historical revision itself. */
export function calibrationRevisionPaths(revision: string): readonly string[] {
  const output = execFileSync(
    "git",
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", revision],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return [...new Set(output.split("\n").map((path) => path.trim()).filter(Boolean))].sort();
}

const handler: HookHandler = async (stdin, args) => {
  const operation = args[0];
  const corpusPath = argumentValue(args, "--corpus") ?? "calibration/corpus.json";
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
    const caseId = argumentValue(args, "--case");
    const selected = corpus.value.cases.find((entry) => entry.id === caseId);
    if (!selected) return { kind: "error", message: `Unknown calibration case ${JSON.stringify(caseId)}` };
    let paths: readonly string[];
    try {
      paths = calibrationRevisionPaths(selected.revision);
    } catch (error) {
      return {
        kind: "error",
        message: `Cannot derive changed-path scope for calibration revision ${selected.revision}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    process.stdout.write([
      `Review historical revision ${selected.revision} for critical correctness defects.`,
      `Inspect the complete revision-derived changed-path scope: ${paths.join(", ") || "no changed paths reported"}.`,
      `Use git show ${selected.revision}:<path> to read that snapshot; do not judge the current worktree.`,
      "Return ONLY JSON: an array of {severity:'critical', file:string|null, line:number|null, claim:string}.",
      "Report every real critical in scope; novel findings are retained as unscored.",
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
