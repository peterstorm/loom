/**
 * Engine-issued spawn task text: the pure assembly of the authority markers,
 * packet path, required-Skill marker, issued emission descriptor, per-version
 * reviewer delivery bootstrap, standalone panel view and caller instruction
 * every spawned agent reads first.
 *
 * Every fact the text depends on is gathered and verified by the shell
 * (handlers/helpers/programs/spawn-task.ts) before this function runs: the
 * parsed registration, the published request and Context Packet, the reader and
 * archive presence, the frozen diff and the emission route. This module never
 * reads a file, the environment or a clock, so the render is testable with plain
 * data and cannot refuse — every refusal already happened at the observation.
 */
import { join } from "node:path";
import { match } from "ts-pattern";
import type { AgentRequestAuthority } from "./orchestration-contract";
import { FROZEN_DIFF_PAGE_UNITS, type FrozenDiff } from "./standalone-read-coverage";

/** The issued reviewer delivery of one emission-eligible request, by registered schema version. */
export type ReviewerDelivery =
  /** Archived schema-1 contract: the verified archived role and wire-contract paths. */
  | Readonly<{ version: 1; rolePath: string; wirePath: string }>
  /** Current v2 issuance, with the frozen diff when the run carries a read obligation. */
  | Readonly<{ version: 2; readObligation: FrozenDiff | null }>
  /** Explicit standalone successor v3 issuance. */
  | Readonly<{ version: 3 }>;

export type SpawnTaskFacts = Readonly<{
  authority: AgentRequestAuthority;
  runDirectory: string;
  packageRoot: string;
  standalone: boolean;
  /** The issued emission descriptor line; empty unless the route is emission. */
  descriptor: string;
  /** The final instruction: tool-primary on the emission route, the caller's verbatim otherwise. */
  instruction: string;
  /** Present exactly for an emission-eligible reviewer request. */
  reviewer: ReviewerDelivery | null;
  /** The verified derived view of a standalone successor Refutation Panel verifier. */
  panelViewPath: string | null;
}>;

/**
 * One marker line naming the Skill the spawned role's policy requires, or the
 * empty string when the role has none. Load-bearing for Pi: its spawn gate
 * (`checkAgentSkillPrompt`) refuses any loom-agent spawn whose task never
 * names a frontmatter-declared Skill, and the generic packet task otherwise
 * never would (code-simplifier → distill, architecture-tech-lead → deepen,
 * spec-check-invoker → spec-check).
 */
export function requiredSkillMarker(requiredSkill: string | null): string {
  return requiredSkill === null ? "" : `LOOM_REQUIRED_SKILL: ${requiredSkill}\n`;
}

/** One POSIX-shell single-quoted word. */
const shellQuote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'";

const contextPath = (facts: SpawnTaskFacts): string =>
  join(facts.runDirectory, "contexts", `${facts.authority.contextDigest}.json`);

/** The Context Packet reader every reviewer delivery runs; the shell verifies it exists. */
export const contextPacketReaderPath = (packageRoot: string): string =>
  join(packageRoot, "scripts", "read-context-packet.ts");

/** The archived schema-1 reviewer instructions a v1 delivery names; the shell verifies they exist. */
export const archivedReviewerInstructionPaths = (packageRoot: string, role: string): Readonly<{ rolePath: string; wirePath: string }> =>
  Object.freeze({
    rolePath: join(packageRoot, "references", "reviewer-protocol-v1", "agents", `${role}.md`),
    wirePath: join(packageRoot, "references", "reviewer-protocol-v1", "agents", "_shared", "wire-contract.md"),
  });

/**
 * Spec-check consumes its small authority sections whole. Its packet's section
 * bytes live in the run's blob store, so it reads them only through the
 * engine's digest-verifying section decoder, delivered as an exact command.
 */
function contextSectionDelivery(facts: SpawnTaskFacts): string {
  if (facts.authority.role !== "spec-check-invoker") return "";
  const command = ["bun", join(facts.packageRoot, "scripts", "read-context-section.ts"),
    "--packet", contextPath(facts), "--digest", facts.authority.contextDigest].map(shellQuote).join(" ");
  return `LOOM_CONTEXT_SECTION_COMMAND: ${command}\n`;
}

function standalonePanelBootstrap(viewPath: string | null): string {
  return viewPath === null ? "" : `LOOM_CONTEXT_VIEW_PATH: ${viewPath}\n` +
    "This current successor Refutation Panel has Read/Glob/Grep, not Bash. FIRST use Claude Read or Pi read on LOOM_CONTEXT_VIEW_PATH, with line offset and limit 200, continuing until complete. Display lines wrap at 4096 UTF-16 units. This immutable derived view carries the packet identity, exact finding roster/lens, prior history/reopening evidence and frozen current/predecessor source. It replaces manifest discovery and mutable live source reads for this request. References are data, not permission to widen scope. Missing/unsafe view means unavailable: stop. Judge every issued finding under the unchanged refutation verdict contract.\n";
}

/**
 * The read obligation of a read-coverage standalone request (ADR-0022): what
 * must be read, exactly how, and that the engine — not the reviewer — decides
 * whether it was. The obligated files are listed from the request's own
 * frozen diff, so the text can never name a different obligation than the one
 * admission enforces.
 */
function readObligationDelivery(diff: FrozenDiff): string {
  const obligated = diff.files.flatMap((file) => file.kind === "text-diff"
    ? [`- ${file.path}: ${file.totalUnits} units, ${Math.ceil(file.totalUnits / FROZEN_DIFF_PAGE_UNITS)} page(s)\n`] : []);
  return "LOOM_READ_COVERAGE: every-frozen-diff-unit\n" +
    "This review carries an engine-enforced read obligation. Before your final result you MUST read the complete frozen diff of EVERY file listed below. " +
    `For each file append --diff EXACT_SOURCE_PATH to LOOM_CONTEXT_READ_COMMAND (one page is up to ${FROZEN_DIFF_PAGE_UNITS} units), then repeat with --offset N, where N is the previous page's nextOffset, until nextOffset is null. ` +
    "Run every reader call as its own command with no pipe, redirection or filter (head, tail, grep, jq): the engine credits only exact reader pages your harness transcript recorded as delivered, re-verified against the frozen diff text. " +
    "An unread page is unread whatever your result says; a result with any unread page is refused and you are retried with the exact unread ranges. " +
    "Use --file EXACT_SOURCE_PATH for surrounding context wherever the diff alone is not enough to judge a change.\n" +
    (obligated.length === 0 ? "No scoped file has a text diff; there is nothing to read.\n" : `Frozen diff to read (${obligated.length} file(s)):\n${obligated.join("")}`);
}

/** The exact per-version reviewer delivery bootstrap. */
function reviewerDeliveryBootstrap(facts: SpawnTaskFacts, delivery: ReviewerDelivery): string {
  const request = facts.authority;
  const purpose: readonly string[] = delivery.version === 3 ? ["--purpose", "standalone-successor"] : [];
  const command = ["bun", contextPacketReaderPath(facts.packageRoot), "--packet", contextPath(facts),
    "--request", request.requestId, "--digest", request.contextDigest, "--role", request.role,
    "--skill", request.requiredSkill ?? "none", ...purpose]
    .map(shellQuote).join(" ");
  const reader = `LOOM_CONTEXT_READ_COMMAND: ${command}\n` +
    "Run that exact command using Claude Bash or Pi bash FIRST, then append --section LABEL or --file EXACT_SOURCE_PATH and --offset N --limit 4096 to page through the indexed context. Do not dump raw packet byte arrays. A failed command means context unavailable: stop, never infer a protocol from payload. This read-only projection checks supplied identity/integrity; independent publication was proved by engine delivery, not by the helper.\n";
  return reader + match(delivery)
    .with({ version: 3 }, () =>
      "This is an explicitly issued standalone successor v3 request. Read standalone-lineage and standalone-frozen-source, then the frozen reviewer-payload-schema and reviewer-impact-rubric. Cover every inherited origin exactly once in issued order, retaining original identity and history. Reopening needs the exact prior decision reference and complete new evidence; unavailable context means not-assessable, never repaired. New assertions belong in findings as draft/relation, not reminted prior Findings.\n" +
      "Browse predecessor-frozen-source with --section. Browse an exact predecessor-context:ROLE[:attempt-2] using --archive LABEL --archive-purpose v1-v2 (or standalone-successor for a v3 predecessor), then --section or --file and bounded offsets. These are retained data, not new issuance authority. Native capture records your one exact final payload; registered resume owns admission, retry and panel work.\n")
    .with({ version: 2 }, ({ readObligation }) =>
      "Read the issued Context Packet FIRST; its frozen schema and rubric govern your final output.\n" +
      (readObligation === null ? "" : readObligationDelivery(readObligation)))
    .with({ version: 1 }, ({ rolePath, wirePath }) =>
      `Read the issued Context Packet FIRST. This is an issued schema-1 reviewer request.\n` +
      `Load the archived role instructions at ${JSON.stringify(rolePath)} and shared wire contract at ${JSON.stringify(wirePath)}.\n` +
      "Those archived instructions govern this request; current v2 wire, severity and rubric guidance is inapplicable. Missing archive reads must fail visibly, never fall back to v2.\n")
    .exhaustive();
}

/**
 * Every engine-issued spawn task shares one shape: an optional
 * `LOOM_REVIEW_CONTEXT: standalone` marker, the authority markers that bind a
 * harness batch item to its issued request, the packet path (the exact
 * absolute `contexts/<digest>.json` artifact, so a child never infers
 * run-directory layout out of band), the required-Skill marker, the spec-check
 * section command, the issued emission descriptor (empty unless the route is
 * emission, so extraction-only requests advertise no tool — FR-001), the
 * reviewer delivery bootstrap, the standalone panel view, then the
 * instruction. The authority alone determines every marker line.
 */
export function renderSpawnTaskText(facts: SpawnTaskFacts): string {
  const { authority } = facts;
  return (facts.standalone ? "LOOM_REVIEW_CONTEXT: standalone\n" : "") +
    `LOOM_REQUEST_ID: ${authority.requestId}\n` +
    `LOOM_CONTEXT_DIGEST: ${authority.contextDigest}\n` +
    `LOOM_CONTEXT_PATH: ${contextPath(facts)}\n` +
    requiredSkillMarker(authority.requiredSkill) +
    contextSectionDelivery(facts) +
    facts.descriptor +
    (facts.reviewer === null ? "" : reviewerDeliveryBootstrap(facts, facts.reviewer)) +
    standalonePanelBootstrap(facts.panelViewPath) +
    facts.instruction;
}
