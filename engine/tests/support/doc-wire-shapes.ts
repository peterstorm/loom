/**
 * The registry of documented wire shapes: for every shape id a doc marker may
 * name, the PRODUCTION parser that decides it and the values that stand in for
 * the doc's placeholders.
 *
 * `WireShapeId` (`doc-wire-shape-ids.ts`) is a closed union and `WIRE_SHAPES`
 * is a record over it, so an id without a parser does not compile. No entry
 * re-implements a rule: each one calls the function the engine itself calls on
 * that input, with whatever surrounding authority that function needs built
 * from the suite's fixtures. The entry's `parse` body is the one statement of
 * which production function decides the shape; no label restates it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDefectFamilyAccounting } from "../../src/core/defect-family-accounting";
import { parseImplementationBriefRequest } from "../../src/core/implementation-brief";
import { translateLegacyPanelJournal } from "../../src/core/legacy-archive";
import { CODEBASE_FIT_CRITERION, PANEL_LENSES, PRIMARY_AXES, candidateFilename, parseJudgeVerdict } from "../../src/core/panel-contract";
import { reduceArchitectureProgram, startArchitectureDispatchProgram } from "../../src/core/panel-program";
import { REVIEW_LENSES, parseRefutationVerdict, parseWaveFindingId } from "../../src/core/review-panel";
import { parseSecurityAuditStart } from "../../src/core/security-audit-start";
import { canonicalCoverageId, isWireRecord } from "../../src/core/security-audit-contract";
import { parseCoverageSeeds, parseCriticResult, parseHunterResult } from "../../src/core/security-coverage";
import { parseVerificationResultWire } from "../../src/core/security-verification";
import { parseOwnershipInput } from "../../src/core/spec-trace";
import { parseStandaloneDispositionStartBytes } from "../../src/core/standalone-disposition-machine";
import { parseUserDecision } from "../../src/core/user-decision";
import { parseVerificationManifest } from "../../src/core/verification-manifest";
import { parseReopenRequest } from "../../src/core/wave-reopening-request";
import {
  parseRemediationStartInput,
  parseStandaloneStartInput,
  parseWaveGateStartInput,
} from "../../src/handlers/helpers/programs/registration";
import { validateFull } from "../../src/handlers/helpers/validate-task-graph";
import { loadRules } from "../../src/linter/loader";
import { parseProjectConfig } from "../../src/linter/programmatic/config";
import { mintedCriterion } from "../fixtures/architecture-criterion";
import { isJsonArray } from "../fixtures/json-wire";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import { REFUTATION_PROFILE, aRefs } from "../security/fixtures";
import type { WireShapeId } from "./doc-wire-shape-ids";
import {
  REPO_ROOT,
  parseDocJson,
  resolvePlaceholders,
  sequence,
  type DocExample,
  type PlaceholderTable,
} from "./doc-wire-examples";

/** Whether the production parser admitted a documented example, and what it said if not. */
export type WireParse =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

/**
 * One documented shape.
 * - `format`: a `json` example is read as JSON and its placeholders resolved
 *   before `parse` sees it; a `text` example reaches `parse` as its own string.
 * - `parse` calls the production function(s) that decide the shape.
 */
export type WireShape = Readonly<{
  format: "json" | "text";
  placeholders: PlaceholderTable;
  parse: (raw: unknown) => WireParse;
}>;

// --- Result adapters ---

const ADMITTED: WireParse = { ok: true };
const refused = (...errors: readonly string[]): WireParse => ({ ok: false, errors });

/** The engine's result unions differ in how they carry a refusal (`errors`,
 *  `error`, `message`); a refusal is reported whole, in the parser's own words. */
const settle = (result: Readonly<{ ok: boolean }>): WireParse =>
  result.ok
    ? ADMITTED
    : refused(JSON.stringify(result, (_key, value: unknown) => (value instanceof Error ? value.message : value)));

const requireRecord = (raw: unknown, parse: (record: Readonly<Record<string, unknown>>) => WireParse): WireParse =>
  isWireRecord(raw) ? parse(raw) : refused("the example is not a JSON object");

const entriesOf = (raw: unknown): readonly Readonly<Record<string, unknown>>[] =>
  isJsonArray(raw) ? raw.filter(isWireRecord) : [];

// --- Surrounding authority, from the suite's fixtures ---

const SHA256 = "0123456789abcdef".repeat(4);
const REVIEW_LENS = REVIEW_LENSES[0];
const JUDGE_CRITERION = mintedCriterion(CODEBASE_FIT_CRITERION);
const CANDIDATE = candidateFilename(PANEL_LENSES[0]);

/** A published review result with one surviving critical, or with none: the
 *  source a remediation's Defect-Family Accounting is joined to. */
const reviewSource = (withCritical: boolean) =>
  standaloneFixture(withCritical ? ["src/main.ts", "src/family.ts"] : ["src/clean.ts"], withCritical).input.standaloneResult;

/**
 * Accounting is parsed against its source's exact surviving criticals. The docs
 * name a stand-in Finding (`code-reviewer-1`) and say so; the stand-in is bound
 * to the fixture source's real id, everywhere it appears, before the parse.
 */
function parseAccounting(raw: unknown): WireParse {
  const notRequired = isWireRecord(raw) && raw.kind === "not-required";
  const source = reviewSource(!notRequired);
  const realId = source.survivingCriticals[0]?.id;
  const documentedId = isWireRecord(raw) ? entriesOf(raw.dispositions)[0]?.findingId : undefined;
  const bound: unknown = typeof documentedId === "string" && realId !== undefined
    ? JSON.parse(JSON.stringify(raw).split(JSON.stringify(documentedId)).join(JSON.stringify(realId)))
    : raw;
  return settle(prepareDefectFamilyAccounting(source, bound));
}

/** A declarative rule is parsed by the loader as it reads a rules directory, so
 *  the example is installed as the one rule of a scratch project directory. */
function parseRegexRule(raw: unknown): WireParse {
  const projectRules = mkdtempSync(join(tmpdir(), "doc-wire-rule-"));
  try {
    writeFileSync(join(projectRules, "documented-rule.json"), JSON.stringify(raw));
    const name = isWireRecord(raw) ? raw.name : undefined;
    const loaded = loadRules(join(REPO_ROOT, "lint-rules"), projectRules, "full", { includeProgrammatic: false });
    // A rule with `"enabled": false` is admitted and then dropped: that is the documented way to disable one.
    const present = loaded.some((rule) => rule.name === name) || (isWireRecord(raw) && raw.enabled === false);
    return present ? ADMITTED : refused(`the loader admitted the directory without the documented rule ${JSON.stringify(name)}`);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(projectRules, { recursive: true, force: true });
  }
}

/** The one placeholder table the three security shapes (hunter, critic,
 *  verifier) share; `security-agent-docs.test.ts` resolves their blocks by it. */
export const SECURITY_PLACEHOLDERS: PlaceholderTable = {
  coverageId: canonicalCoverageId(aRefs()),
  reviewedPaths: "src/api/login.ts",
  reviewed_paths: "src/api/login.ts",
  startingPaths: "src/api/login.ts",
  invariant: "Every request field reaches the query as a bound parameter.",
  result: "The field is interpolated into the query string.",
  fingerprints: "api/login:sqli-email",
  fingerprint: "api/login:sqli-email",
  unresolved: "No database container to reproduce the payload.",
  reason: "The sandbox payload returned the admin row.",
  agent: "security-verifier-agent",
  profile: REFUTATION_PROFILE,
  surface: "http-ingress",
  boundary: "api-edge",
  subsystem: "auth",
  attack_class: "injection",
  ordinaryAttackClassBlock: "Injection: untrusted input reaching an interpreter.",
  selectedCompanionBlocks: "WEB-PROTOCOL-AND-AUTH.md#browser-session-attack-classes",
  block: "CLIENT-SIDE.md#dom",
  reassignIds: canonicalCoverageId(aRefs()),
  resolvedPriorLeads: "api/login:sqli-email: the unit's paths do not reach the sink.",
};

const NO_PLACEHOLDERS: PlaceholderTable = {};

export const WIRE_SHAPES: Readonly<Record<WireShapeId, WireShape>> = {
  "architecture-panel-journal": {
    format: "json",
    placeholders: {
      candidateLenses: sequence(...PANEL_LENSES),
      judgeCriteria: sequence(...PRIMARY_AXES),
    },
    parse: (raw) => {
      const journal = translateLegacyPanelJournal("architecture", raw);
      if (!journal.ok) return settle(journal);
      if (journal.value.panel !== "architecture") return refused("the journal did not translate as an architecture panel");
      const started = startArchitectureDispatchProgram(journal.value.input);
      if (!started.ok) return settle(started);
      // The helper replays the journal's events over the started program; so does this.
      let state = started.value.state;
      for (const event of journal.value.events) {
        const reduced = reduceArchitectureProgram(state, event);
        if (!reduced.ok) return settle(reduced);
        state = reduced.value.state;
      }
      return ADMITTED;
    },
  },
  "completed-wave-reopening": {
    format: "json",
    placeholders: { runId: "run.completed-wave-3", authorityDigest: SHA256 },
    parse: (raw) => settle(parseReopenRequest(JSON.stringify(raw))),
  },
  "decompose-task-graph": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: (raw) => requireRecord(raw, (graph) => settle(validateFull({ ...graph }, "decompose-payload"))),
  },
  "defect-family-accounting": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: parseAccounting,
  },
  "implementation-brief-request": {
    format: "text",
    placeholders: NO_PLACEHOLDERS,
    parse: (raw) => {
      if (typeof raw !== "string") return refused("the example is not text");
      const parsed = parseImplementationBriefRequest(raw);
      return parsed.kind === "request" ? ADMITTED : refused(JSON.stringify(parsed));
    },
  },
  "judge-verdict": {
    format: "json",
    placeholders: { criterion: JUDGE_CRITERION, candidate: CANDIDATE, strongest_idea: "Keep the parser at the boundary." },
    parse: (raw) => settle(parseJudgeVerdict(JSON.stringify(raw), JUDGE_CRITERION, [CANDIDATE])),
  },
  "linter-project-config": {
    format: "json",
    placeholders: {
      path: "third_party/",
      reason: "vendored upstream code, pinned by its manifest",
      requireGovernance: "src/",
      module: "src/domain/",
      description: "The functional core: imports itself only.",
      allow: "src/domain/",
      deny: "src/infra/",
      pureModules: "src/domain/",
    },
    parse: (raw) => settle(parseProjectConfig(raw, ".claude/linter/rules/config.json")),
  },
  "linter-regex-rule": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: parseRegexRule,
  },
  "refutation-verdict": {
    format: "json",
    placeholders: { criterion: REVIEW_LENS, finding_id: "T1:code-reviewer-1" },
    parse: (raw) => {
      const documented = isWireRecord(raw) ? entriesOf(raw.verdicts).map((entry) => entry.finding_id) : [];
      const ids = documented.flatMap((id) => parseWaveFindingId(id) ?? []);
      return ids.length === documented.length
        ? settle(parseRefutationVerdict(JSON.stringify(raw), REVIEW_LENS, ids))
        : refused(`a documented finding_id is not a wave-scoped Finding id: ${JSON.stringify(documented)}`);
    },
  },
  "remediation-start": {
    format: "json",
    placeholders: { sourceRun: "run.source-review", supportPaths: "docs/remediation-plan.md" },
    parse: (raw) => {
      const input = parseRemediationStartInput(raw);
      return input.ok ? parseAccounting(input.value.defectFamily) : settle(input);
    },
  },
  "security-audit-start": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: (raw) => {
      const start = parseSecurityAuditStart(raw);
      return start.ok ? settle(parseCoverageSeeds(start.value.units)) : settle(start);
    },
  },
  "security-critic-result": {
    format: "json",
    placeholders: SECURITY_PLACEHOLDERS,
    parse: (raw) => settle(parseCriticResult(raw)),
  },
  "security-hunter-result": {
    format: "json",
    placeholders: SECURITY_PLACEHOLDERS,
    parse: (raw) => settle(parseHunterResult(raw)),
  },
  "security-verification-result": {
    format: "json",
    placeholders: SECURITY_PLACEHOLDERS,
    parse: (raw) => settle(parseVerificationResultWire(raw)),
  },
  "spec-trace-ownership": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: (raw) => settle(parseOwnershipInput(raw, "documented example")),
  },
  "standalone-disposition-start": {
    format: "json",
    placeholders: { resultDigest: SHA256, origin: SHA256 },
    parse: (raw) => settle(parseStandaloneDispositionStartBytes(new TextEncoder().encode(JSON.stringify(raw)))),
  },
  "standalone-review-start": {
    format: "json",
    placeholders: { resultDigest: SHA256, dispositionDigest: SHA256 },
    parse: (raw) => settle(parseStandaloneStartInput(raw)),
  },
  "verification-manifest": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: (raw) => settle(parseVerificationManifest(raw)),
  },
  "wave-gate-decision": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: (raw) => settle(parseUserDecision(JSON.stringify(raw), "wave-gate")),
  },
  "wave-gate-start": {
    format: "json",
    placeholders: NO_PLACEHOLDERS,
    parse: (raw) => settle(parseWaveGateStartInput(raw)),
  },
};

/** A documented example as the value its parser receives: the text itself for a
 *  `text` shape, the placeholder-resolved JSON for a `json` shape. */
export function documentedValue(shapeId: WireShapeId, text: string): unknown {
  const shape = WIRE_SHAPES[shapeId];
  return shape.format === "text" ? text : resolvePlaceholders(parseDocJson(text), shape.placeholders);
}

/** Put one documented example through its shape's production parser. An example
 *  that cannot be read at all (broken JSON, an unresolved placeholder) is a
 *  refusal like any other, so the suite reports it beside its file and line.
 *  Its shape id was parsed at the scan, so it always names a registered shape. */
export function parseDocumentedExample(example: DocExample): WireParse {
  let value: unknown;
  try {
    value = documentedValue(example.shapeId, example.text);
  } catch (error) {
    return refused(`the example cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return WIRE_SHAPES[example.shapeId].parse(value);
}
