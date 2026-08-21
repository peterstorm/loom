#!/usr/bin/env bun
/** Opt-in live Pi calibration. Never runs in CI without an explicit opt-in. */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCalibrationCorpus } from "../engine/src/core/model-calibration";
import { lowerModelProfile, resolveModelProfile, type LlmProfileId } from "../engine/src/core/model-profiles";

if (process.env.LOOM_RUN_MODEL_CALIBRATION !== "1") {
  process.stderr.write("Calibration NOT executed. Set LOOM_RUN_MODEL_CALIBRATION=1 explicitly.\n");
  process.exit(2);
}

const args = process.argv.slice(2);
const value = (flag: string, fallback: string): string => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const profileId = value("--profile", "focused-review") as LlmProfileId;
const corpusPath = resolve(value("--corpus", "calibration/corpus.json"));
const outputPath = resolve(value("--output", `calibration/results/${profileId}.json`));
const profile = resolveModelProfile(profileId);
if (!profile.ok) throw new Error(profile.error.message);
const target = lowerModelProfile(profile.value, "pi");
const corpus = parseCalibrationCorpus(readFileSync(corpusPath, "utf-8"));
if (!corpus.ok) throw new Error(corpus.errors.join("\n"));

function prompt(caseId: string): string {
  const result = spawnSync("bun", [
    "engine/src/cli.ts", "helper", "model-calibration", "prompt",
    "--corpus", corpusPath, "--case", caseId,
  ], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `could not build prompt for ${caseId}`);
  return result.stdout;
}

function finalText(stdout: string): string | null {
  let answer: string | null = null;
  const malformed: string[] = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") ?? "";
        if (text.trim()) answer = text;
      }
    } catch (error) {
      malformed.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (malformed.length > 0) {
    throw new Error(`Pi JSON stream contained ${malformed.length} malformed line(s): ${malformed.join("; ")}`);
  }
  return answer;
}

function findings(text: string): unknown[] {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(unfenced);
  if (!Array.isArray(parsed)) throw new Error("model output was not a JSON array");
  return parsed;
}

const cases = corpus.value.cases.map((entry) => {
  // `prompt()` throws when the helper cannot build this case's prompt. Built
  // INSIDE the try that isolates one case: evaluated as a `spawnSync` argument
  // it sat outside, so a single unbuildable case aborted the whole run before
  // any result was written.
  try {
    const run = spawnSync("pi", [
      "--mode", "json", "-p", "--no-session",
      "--provider", target.provider,
      "--model", target.model,
      "--thinking", target.thinking,
      "--tools", "read,grep,find,ls,bash",
      prompt(entry.id),
    ], { encoding: "utf-8", cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) {
      return { case_id: entry.id, status: "not-executed", reason: run.stderr.trim() || `pi exited ${run.status}` };
    }
    const text = finalText(run.stdout);
    if (!text) throw new Error("Pi produced no final assistant text");
    return { case_id: entry.id, status: "executed", findings: findings(text) };
  } catch (error) {
    return { case_id: entry.id, status: "not-executed", reason: error instanceof Error ? error.message : String(error) };
  }
});

const output = { schema_version: 1, profile_id: profileId, cases };
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
const notExecuted = cases.filter((entry) => entry.status === "not-executed");
process.stdout.write(`${outputPath}\n`);
process.stderr.write(
  `Calibration execution: ${cases.length - notExecuted.length}/${cases.length} executed, ` +
  `${notExecuted.length} not executed.\n`,
);
if (notExecuted.length > 0) process.exitCode = 1;
