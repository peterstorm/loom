/**
 * Lens selection: which vendored security lenses a target earns, and why.
 *
 * Upstream ships eleven taxonomy documents and tells the orchestrator to "select
 * attack classes relevant to the application type" — a judgement call with no
 * deterministic answer, made by the same model that is about to hunt. That is
 * exactly the shape of decision Loom keeps in code: the selection is derived
 * from repository facts (languages, manifests, source signatures), ranked, and
 * printed with a reason per lens, so a run's prompt can be reproduced and a
 * critic can challenge the *decision* rather than guess at it.
 *
 * Two rules the selection keeps:
 * - `ATTACK-CLASSES.md` is always included: it is the core class list every
 *   other lens extends, so a target with no specialised lens is still covered.
 *   It counts against the run's cap like any other document — the cap is a
 *   context budget, and the base lens occupies context too.
 * - How many lenses a hunter holds is the run's PROFILE (`quick` two,
 *   `standard` four, `deep` eight, base lens included). Upstream's fleet keeps
 *   children under a quarter of the context window; eleven lenses × a verbatim
 *   `architecture.md` does not fit in that budget.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import { SECURITY_AUDIT_LIMITS } from "./security-audit-contract";

/** Lens documents, in their upstream filenames (see ATTRIBUTION.md). */
export const SECURITY_LENSES = [
  "ATTACK-CLASSES.md",
  "WEB-PROTOCOL-AND-AUTH.md",
  "CLIENT-SIDE.md",
  "AI-AND-LLM.md",
  "MEMORY-SAFETY-AND-BINARY.md",
  "SUPPLY-CHAIN-AND-RELEASE.md",
  "CLOUD-AND-DEPLOYMENT.md",
  "PROTOCOLS-RPC-AND-MESSAGING.md",
  "RESOURCE-EXHAUSTION-AND-AVAILABILITY.md",
  "DATA-ISOLATION-AND-LIFECYCLE.md",
  "DESKTOP-MOBILE-AND-LOCAL-IPC.md",
] as const;
export type SecurityLens = (typeof SECURITY_LENSES)[number];

/** Repository facts the selector reads. Every field is optional: a selector
 *  that demands facts a cheap scan cannot produce is a selector that guesses. */
export type StackSignals = Readonly<{
  /** Lowercase language ids or extensions: "ts", "java", "rs", "c", "go". */
  languages: readonly string[];
  /** Manifest or config basenames: "package.json", "Cargo.toml", "Chart.yaml". */
  manifests: readonly string[];
  /** A server, router, or handler exists in source. */
  servesHttp: boolean;
  /** The code both handles and re-emits untrusted input as HTML/DOM. */
  rendersClientSide: boolean;
  /** Model prompts, tool schemas, or an agent loop exist in source. */
  drivesModelsOrTools: boolean;
  /** Queues, brokers, RPC stubs, or event streams exist in source. */
  usesQueuesOrRpc: boolean;
  /** Multi-tenant, per-owner, or per-account stored state exists in source. */
  isolatesTenants: boolean;
  /** Containers, IaC, or cloud provider declarations exist in the repository. */
  deploysInfrastructure: boolean;
  /** Native or unsafe memory code exists in source. */
  hasNativeMemory: boolean;
  /** Deep links, app bundles, exported components, or local IPC exist. */
  hasAppOrLocalIpc: boolean;
  /** Dependency pinning, CI, signing, or release tooling exists in the repo. */
  hasReleasePipelines: boolean;
  /** Untrusted work can consume shared CPU/memory/connections/quota. */
  hasSharedResourcePressure: boolean;
}>;

export type LensSelectionEntry = Readonly<{
  lens: SecurityLens;
  /** Deterministic rank within this selection; ties break by lens order. */
  score: number;
  reasons: readonly string[];
  /** The always-included core list. A boolean rather than `score: Infinity`:
   *  an infinite score does not survive JSON (`JSON.stringify(Infinity)` is
   *  `null`), and `lenses.json` records this entry. */
  base: boolean;
}>;

export type LensSelection = Readonly<{
  included: readonly LensSelectionEntry[];
  excluded: readonly Readonly<{ lens: SecurityLens; reason: string }>[];
}>;

/** Lens ranking rules. Each entry names the signals that raise it and how much;
 *  a lens with score 0 is excluded with the reason "no matching signal". */
const LENS_RULES: Readonly<Record<Exclude<SecurityLens, "ATTACK-CLASSES.md">, readonly (readonly [keyof StackSignals, number, string])[]>> = {
  "WEB-PROTOCOL-AND-AUTH.md": [
    ["servesHttp", 4, "source serves HTTP and routes untrusted input"],
    ["isolatesTenants", 1, "request identity reaches tenant-scoped state"],
    ["manifests", 1, "an application manifest is present"],
  ],
  "CLIENT-SIDE.md": [
    ["rendersClientSide", 3, "source renders untrusted data in a browser context"],
    ["languages", 1, "client-side languages are present"],
  ],
  "AI-AND-LLM.md": [
    ["drivesModelsOrTools", 4, "source assembles prompts, tool schemas, or an agent loop"],
  ],
  "MEMORY-SAFETY-AND-BINARY.md": [
    ["hasNativeMemory", 4, "source has native or unsafe memory handling"],
    ["languages", 1, "a systems language is present"],
  ],
  "SUPPLY-CHAIN-AND-RELEASE.md": [
    ["hasReleasePipelines", 3, "dependency pinning, CI, or release tooling is in the repo"],
    ["manifests", 1, "a package manifest is present"],
  ],
  "CLOUD-AND-DEPLOYMENT.md": [
    ["deploysInfrastructure", 3, "the repo declares containers, IaC, or cloud resources"],
  ],
  "PROTOCOLS-RPC-AND-MESSAGING.md": [
    ["usesQueuesOrRpc", 3, "source defines RPC, broker, or streaming surfaces"],
  ],
  "RESOURCE-EXHAUSTION-AND-AVAILABILITY.md": [
    ["hasSharedResourcePressure", 3, "untrusted work reaches shared bounded resources"],
    ["servesHttp", 1, "request handling shares pool resources"],
  ],
  "DATA-ISOLATION-AND-LIFECYCLE.md": [
    ["isolatesTenants", 4, "stored state is partitioned by tenant or owner"],
    ["manifests", 1, "a persistence or search dependency is declared"],
  ],
  "DESKTOP-MOBILE-AND-LOCAL-IPC.md": [
    ["hasAppOrLocalIpc", 4, "the repo ships a desktop/mobile app or local IPC surface"],
  ],
};

/** Languages that raise a lens on presence alone (a cheap, coarse signal). */
const CLIENT_LANGUAGES = new Set(["tsx", "jsx", "vue", "svelte", "html", "css"]);
const SYSTEMS_LANGUAGES = new Set(["c", "cc", "cpp", "h", "hpp", "rs", "zig", "asm"]);

const signalNames: Readonly<Record<keyof StackSignals, string>> = {
  languages: "languages",
  manifests: "manifests",
  servesHttp: "an HTTP surface",
  rendersClientSide: "client-side rendering",
  drivesModelsOrTools: "model or tool driving",
  usesQueuesOrRpc: "RPC or messaging",
  isolatesTenants: "tenant-scoped state",
  deploysInfrastructure: "deployment declarations",
  hasNativeMemory: "native memory handling",
  hasAppOrLocalIpc: "app or local IPC",
  hasReleasePipelines: "release pipelines",
  hasSharedResourcePressure: "shared resource pressure",
};

const hasSignal = (signals: StackSignals, signal: keyof StackSignals): boolean => {
  const value = signals[signal];
  if (Array.isArray(value)) return value.length > 0;
  return value === true;
};

const languageSignal = (signals: StackSignals, pool: ReadonlySet<string>): boolean =>
  signals.languages.some((language) => pool.has(language.toLowerCase()));

/**
 * Rank the lenses a target earns. Deterministic for equal signals: score
 * descending, then DECLARATION order (`SECURITY_LENSES`), never filename order —
 * the two disagree, and the docstring a critic reads names declaration order.
 *
 * `maxLenses` is the PROFILE's total document budget, base lens included, so the
 * specialised list is capped at `maxLenses - 1`.
 */
/** Which language family a lens is about. Most lenses match on any language
 *  signal; two are specific, so a TypeScript-only repository does not select the
 *  memory-safety lens merely by declaring languages. */
const languageMatches = (lens: SecurityLens, signals: StackSignals): boolean =>
  match(lens)
    .with("CLIENT-SIDE.md", () => languageSignal(signals, CLIENT_LANGUAGES))
    .with("MEMORY-SAFETY-AND-BINARY.md", () => languageSignal(signals, SYSTEMS_LANGUAGES))
    .otherwise(() => hasSignal(signals, "languages"));

export function selectSecurityLenses(
  signals: StackSignals,
  options: Readonly<{ maxLenses: number }>,
): LensSelection {
  const maxLenses = Math.max(1, Math.min(options.maxLenses, SECURITY_AUDIT_LIMITS.companionBlocks));
  const specialisedCap = maxLenses - 1;
  const scored: LensSelectionEntry[] = [];

  for (const lens of SECURITY_LENSES) {
    if (lens === "ATTACK-CLASSES.md") continue;
    const rules = LENS_RULES[lens];
    let score = 0;
    const reasons: string[] = [];
    for (const [signal, weight, reason] of rules) {
      if (signal === "languages") {
        if (languageMatches(lens, signals)) {
          score += weight;
          reasons.push(reason);
        }
        continue;
      }
      if (hasSignal(signals, signal)) {
        score += weight;
        reasons.push(reason);
      }
    }
    if (score > 0) scored.push({ lens, score, reasons: [...new Set(reasons)], base: false });
  }

  const ranked = scored.sort((left, right) =>
    right.score - left.score || SECURITY_LENSES.indexOf(left.lens) - SECURITY_LENSES.indexOf(right.lens),
  );
  const included = ranked.slice(0, specialisedCap);
  const includedLenses = new Set(included.map((entry) => entry.lens));

  return {
    included: [
      { lens: "ATTACK-CLASSES.md", score: 0, reasons: ["core class list; always included"], base: true },
      ...included,
    ],
    excluded: SECURITY_LENSES.filter((lens) => lens !== "ATTACK-CLASSES.md" && !includedLenses.has(lens)).map((lens) => ({
      lens,
      reason:
        scored.some((entry) => entry.lens === lens)
          ? `ranked ${scored.findIndex((entry) => entry.lens === lens) + 1} of ${scored.length}; beyond the ${maxLenses}-lens cap`
          : `no matching signal (${Object.keys(signalNames).filter((name) => hasSignal(signals, name as keyof StackSignals)).join(", ") || "none detected"})`,
    })),
  };
}

/** The selection as the prompt fragment a hunter receives. */
export function renderLensSelection(selection: LensSelection): string {
  const included = selection.included
    .map((entry) => `- references/security-lenses/${entry.lens} (${entry.base ? "base" : `score ${entry.score}`}): ${entry.reasons.join("; ")}`)
    .join("\n");
  const excluded = selection.excluded
    .map((entry) => `- ${entry.lens}: ${entry.reason}`)
    .join("\n");
  return `Included lenses:\n${included}\n\nExcluded lenses:\n${excluded}`;
}
