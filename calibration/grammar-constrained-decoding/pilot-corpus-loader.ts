/**
 * The filesystem adapter of `WindowWorkload.loadCorpusCases` (SHELL): reads
 * the corpus the workload fixtures name and parses it with the corpus core.
 * `recordWindow` invokes the port only for a window that dispatches, so an
 * unreadable corpus never costs a non-dispatching window its record; an
 * unreadable or invalid corpus is a refusal, never a throw.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseCalibrationCorpus } from "../../engine/src/core/model-calibration";
import { err, errorMessage, ok } from "../kernel";
import type { WindowWorkload } from "./pilot-retention";
import type { WorkloadFixtures } from "./pilot-workload";

/** The corpus loader of one checkout: the fixtures' corpus path resolves
 *  against `repoRoot`, and every diagnostic names it relative to the checkout,
 *  never by machine path. */
export const workloadCorpusLoader = (repoRoot: string, fixtures: WorkloadFixtures): WindowWorkload["loadCorpusCases"] => () => {
  const path = resolve(repoRoot, fixtures.reviewer.corpus);
  const label = relative(repoRoot, path);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return err(`cannot read ${label}: ${errorMessage(error)}`);
  }
  const corpus = parseCalibrationCorpus(text);
  return corpus.ok ? ok(corpus.value.cases) : err(`invalid corpus ${label}:\n  - ${corpus.errors.join("\n  - ")}`);
};
