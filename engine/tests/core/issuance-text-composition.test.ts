/**
 * One writer for the two facts that make a re-spawned reviewer capturable: the
 * instruction and the Task/Wave binding line.
 *
 * The fugue-dags wave-gate failure was not one bad string: two code paths
 * composed the same request's text (publication appended the binding, the
 * collection re-emission did not), so a re-emitted reviewer named no Task and
 * its capture could never be attributed. This suite holds the consolidation
 * that removed the second composer:
 *
 *  - no handler spells a binding line (a hand-appended suffix is the regression);
 *  - no source spells an instruction sentence outside the core composer, so a
 *    code path cannot author what its child is told to do;
 *  - the attempt-1 emission sites and the Pi re-render both render through the
 *    one function, so a re-emission cannot differ from the first emission;
 *  - exactly one function in the tree appends a binding.
 *
 * A source scan, not a runtime assertion: the defect is text composed in the
 * wrong place, and only the source says where text is composed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const engineRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = join(engineRoot, "src");

function walk(relativeDirectory: string): string[] {
  const out: string[] = [];
  const step = (relative: string): void => {
    for (const entry of readdirSync(join(sourceRoot, relative), { withFileTypes: true })) {
      const child = posix.join(relative, entry.name);
      if (entry.isDirectory()) step(child);
      else out.push(child);
    }
  };
  step(relativeDirectory);
  return out;
}

const read = (relative: string): string => readFileSync(join(sourceRoot, relative), "utf8");
const sources = walk(".");

/** The binding line templates the child's echo is matched against: the subject
 *  and its closing period, with nothing after them. Their only home is
 *  `core/issued-request-task.ts`; anywhere else is a second composer. (A packet
 *  `outputContract` that merely starts "Review Task T1" and continues with
 *  prose is a different text and is not matched.) */
const BINDING_TEMPLATES = [
  /Review Task \$\{[^}`]+\}\./,
  /Spec-check Wave \$\{[^}`]+\}\./,
  /"\\nReview Task /,
  /"\\nSpec-check Wave /,
];

const spellsBinding = (text: string): boolean => BINDING_TEMPLATES.some((pattern) => pattern.test(text));

describe("the Task/Wave binding has one writer", () => {
  it("is written only by the issued-request-task module", () => {
    const writers = sources.filter((relative) => spellsBinding(read(relative)));
    expect(writers).toEqual(["core/issued-request-task.ts"]);
  });

  it("is never appended by a handler", () => {
    const offenders = sources.filter((relative) => relative.startsWith("handlers/") &&
      (read(relative).includes("Review Task ") || read(relative).includes("Spec-check Wave ")));
    expect(offenders).toEqual([]);
  });

  it("is applied by exactly one function", () => {
    const callers = sources.filter((relative) => read(relative).includes("withTaskBinding("));
    expect(callers).toEqual(["core/issued-request-task.ts", "handlers/helpers/programs/spawn-task.ts"]);
  });
});

/** The instruction the child reads: the composer, plus the one shared constant
 *  it reads. A handler spelling one of these sentences is a second composer,
 *  which is how the emission paths came to tell the same request two different
 *  things. */
const INSTRUCTION_FINGERPRINTS = [
  "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.",
  "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave Review Packet slot.",
  "Read the immutable context packet at LOOM_CONTEXT_PATH, then retry the exact current Wave spec-check slot.",
  "Read the immutable context packet at LOOM_CONTEXT_PATH, then complete the exact pending Refutation Panel request.",
  "Read your brief with LOOM_CONTEXT_SECTION_COMMAND",
];

/** The only files allowed to spell an instruction: the composer, and the core
 *  module that owns the reviewer-result constant it reads. */
const INSTRUCTION_HOMES = ["core/issued-request-task.ts", "core/spawn-task-text.ts"];

const spellsInstruction = (text: string): boolean =>
  INSTRUCTION_FINGERPRINTS.some((fingerprint) => text.includes(fingerprint));

describe("the instruction has one composer", () => {
  it("is never spelled outside the core composer", () => {
    const offenders = sources.filter((relative) => spellsInstruction(read(relative)) &&
      !INSTRUCTION_HOMES.includes(relative));
    expect(offenders).toEqual([]);
  });

  it("is not spelled by the Pi adapter either", () => {
    const piRoot = join(engineRoot, "..", "pi");
    const offenders = readdirSync(piRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .filter((entry) => spellsInstruction(readFileSync(join(piRoot, entry.name), "utf8")))
      .map((entry) => entry.name);
    expect(offenders).toEqual([]);
  });
});

describe("both attempt-1 emission sites render through the one function", () => {
  const sites = [
    "handlers/helpers/programs/request-publication.ts",
    "handlers/helpers/programs/wave-review-collection.ts",
  ] as const;

  it.each(sites)("%s renders the issued task rather than composing one", (site) => {
    const text = read(site);
    expect(text).toContain("renderIssuedRequestTask(");
    expect(text).not.toContain("Review Task ");
    expect(text).not.toContain("Spec-check Wave ");
  });

  it("gives the re-emission the same instruction the publication used", () => {
    // Neither site names an instruction: the request authority selects it, so
    // the two paths cannot disagree about what the child is told to do.
    for (const site of sites) {
      expect(read(site), site).not.toContain("complete the exact Wave review request");
    }
  });
});
