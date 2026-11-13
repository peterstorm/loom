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

/** The wire shape each stack signal takes: a list of names, or a flag. */
export type StackSignalShape<Value> = Value extends boolean ? "boolean" : "string-list";

/**
 * The one table of stack signals: every field of `StackSignals` and its wire
 * shape, in declaration order. Keyed by the type, so a signal added to
 * `StackSignals` is a compile error here until its shape is declared — and the
 * `start` parser, the exclusion reasons and the tests all read THIS table, so
 * none of them can silently omit the new signal.
 */
export const STACK_SIGNAL_SHAPES: Readonly<{ [K in keyof StackSignals]: StackSignalShape<StackSignals[K]> }> = Object.freeze({
  languages: "string-list",
  manifests: "string-list",
  servesHttp: "boolean",
  rendersClientSide: "boolean",
  drivesModelsOrTools: "boolean",
  usesQueuesOrRpc: "boolean",
  isolatesTenants: "boolean",
  deploysInfrastructure: "boolean",
  hasNativeMemory: "boolean",
  hasAppOrLocalIpc: "boolean",
  hasReleasePipelines: "boolean",
  hasSharedResourcePressure: "boolean",
});

/** The own keys of a record keyed by `K`, typed as `K`: the guard re-checks
 *  ownership, so the narrowing is earned rather than asserted. */
const keysOf = <K extends string>(record: Readonly<Record<K, unknown>>): readonly K[] =>
  Object.keys(record).filter((key): key is K => Object.hasOwn(record, key));

/** Every stack signal name, in declaration order — derived from the table. */
export const STACK_SIGNAL_NAMES: readonly (keyof StackSignals)[] = Object.freeze(keysOf(STACK_SIGNAL_SHAPES));

/** No signal at all: what an absent `signals` object means. */
export const NO_STACK_SIGNALS: StackSignals = Object.freeze({
  languages: [],
  manifests: [],
  servesHttp: false,
  rendersClientSide: false,
  drivesModelsOrTools: false,
  usesQueuesOrRpc: false,
  isolatesTenants: false,
  deploysInfrastructure: false,
  hasNativeMemory: false,
  hasAppOrLocalIpc: false,
  hasReleasePipelines: false,
  hasSharedResourcePressure: false,
});

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

/** One ranking rule: when `fires` holds, the lens gains `weight` and records
 *  `reason`. The reason states exactly what the predicate tests — a critic
 *  challenges the decision from these strings, so a reason the evidence does
 *  not establish is a wrong record, not a loose one. */
type LensRule = Readonly<{ weight: number; reason: string; fires: (signals: StackSignals) => boolean }>;

/** Languages that raise a lens on presence alone (a cheap, coarse signal). */
const CLIENT_LANGUAGES = new Set(["tsx", "jsx", "vue", "svelte", "html", "css"]);
const SYSTEMS_LANGUAGES = new Set(["c", "cc", "cpp", "h", "hpp", "rs", "zig", "asm"]);
/** Dependency-manifest basenames: files whose whole job is to declare what the
 *  build pulls in, which is the supply chain's entry point. A config file that
 *  merely sits in a repo (`Chart.yaml`, `tsconfig.json`) is not one. */
const DEPENDENCY_MANIFESTS = new Set([
  "package.json", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "requirements.txt",
  "pyproject.toml", "Pipfile", "Gemfile", "composer.json", "mix.exs", "pubspec.yaml", "Package.swift",
]);

const languageIn = (pool: ReadonlySet<string>) => (signals: StackSignals): boolean =>
  signals.languages.some((language) => pool.has(language.toLowerCase()));

const manifestIn = (pool: ReadonlySet<string>) => (signals: StackSignals): boolean =>
  signals.manifests.some((manifest) => pool.has(manifest.slice(manifest.lastIndexOf("/") + 1)));

const flag = (signal: { [K in keyof StackSignals]: StackSignals[K] extends boolean ? K : never }[keyof StackSignals]) =>
  (signals: StackSignals): boolean => signals[signal];

/** Lens ranking rules. A lens with score 0 is excluded with the reason "no
 *  matching signal". A manifest list alone raises neither the web nor the
 *  data-isolation lens: a `package.json` establishes neither an HTTP surface
 *  nor a persistence dependency, and crediting them would print reasons the
 *  evidence did not support; only a DEPENDENCY manifest raises the
 *  supply-chain lens, which is what that file does establish. */
const LENS_RULES: Readonly<Record<Exclude<SecurityLens, "ATTACK-CLASSES.md">, readonly LensRule[]>> = {
  "WEB-PROTOCOL-AND-AUTH.md": [
    { weight: 4, reason: "source serves HTTP and routes untrusted input", fires: flag("servesHttp") },
    { weight: 1, reason: "request identity reaches tenant-scoped state", fires: flag("isolatesTenants") },
  ],
  "CLIENT-SIDE.md": [
    { weight: 3, reason: "source renders untrusted data in a browser context", fires: flag("rendersClientSide") },
    { weight: 1, reason: "client-side languages are present", fires: languageIn(CLIENT_LANGUAGES) },
  ],
  "AI-AND-LLM.md": [
    { weight: 4, reason: "source assembles prompts, tool schemas, or an agent loop", fires: flag("drivesModelsOrTools") },
  ],
  "MEMORY-SAFETY-AND-BINARY.md": [
    { weight: 4, reason: "source has native or unsafe memory handling", fires: flag("hasNativeMemory") },
    { weight: 1, reason: "a systems language is present", fires: languageIn(SYSTEMS_LANGUAGES) },
  ],
  "SUPPLY-CHAIN-AND-RELEASE.md": [
    { weight: 3, reason: "dependency pinning, CI, or release tooling is in the repo", fires: flag("hasReleasePipelines") },
    { weight: 1, reason: "a dependency manifest is present", fires: manifestIn(DEPENDENCY_MANIFESTS) },
  ],
  "CLOUD-AND-DEPLOYMENT.md": [
    { weight: 3, reason: "the repo declares containers, IaC, or cloud resources", fires: flag("deploysInfrastructure") },
  ],
  "PROTOCOLS-RPC-AND-MESSAGING.md": [
    { weight: 3, reason: "source defines RPC, broker, or streaming surfaces", fires: flag("usesQueuesOrRpc") },
  ],
  "RESOURCE-EXHAUSTION-AND-AVAILABILITY.md": [
    { weight: 3, reason: "untrusted work reaches shared bounded resources", fires: flag("hasSharedResourcePressure") },
    { weight: 1, reason: "request handling shares pool resources", fires: flag("servesHttp") },
  ],
  "DATA-ISOLATION-AND-LIFECYCLE.md": [
    { weight: 4, reason: "stored state is partitioned by tenant or owner", fires: flag("isolatesTenants") },
  ],
  "DESKTOP-MOBILE-AND-LOCAL-IPC.md": [
    { weight: 4, reason: "the repo ships a desktop/mobile app or local IPC surface", fires: flag("hasAppOrLocalIpc") },
  ],
};

const hasSignal = (signals: StackSignals, signal: keyof StackSignals): boolean => {
  const value = signals[signal];
  if (Array.isArray(value)) return value.length > 0;
  return value === true;
};

/**
 * Rank the lenses a target earns. Deterministic for equal signals: score
 * descending, then DECLARATION order (`SECURITY_LENSES`), never filename order —
 * the two disagree, and the docstring a critic reads names declaration order.
 *
 * `maxLenses` is the PROFILE's total document budget, base lens included, so the
 * specialised list is capped at `maxLenses - 1`.
 */
export function selectSecurityLenses(
  signals: StackSignals,
  options: Readonly<{ maxLenses: number }>,
): LensSelection {
  const maxLenses = Math.max(1, Math.min(options.maxLenses, SECURITY_AUDIT_LIMITS.companionBlocks));
  const specialisedCap = maxLenses - 1;
  const scored: LensSelectionEntry[] = [];

  for (const lens of SECURITY_LENSES) {
    if (lens === "ATTACK-CLASSES.md") continue;
    const fired = LENS_RULES[lens].filter((rule) => rule.fires(signals));
    const score = fired.reduce((total, rule) => total + rule.weight, 0);
    if (score > 0) scored.push({ lens, score, reasons: [...new Set(fired.map((rule) => rule.reason))], base: false });
  }

  const ranked = [...scored].sort((left, right) =>
    right.score - left.score || SECURITY_LENSES.indexOf(left.lens) - SECURITY_LENSES.indexOf(right.lens),
  );
  const included = ranked.slice(0, specialisedCap);
  const includedLenses = new Set(included.map((entry) => entry.lens));

  return {
    included: [
      { lens: "ATTACK-CLASSES.md", score: 0, reasons: ["core class list; always included"], base: true },
      ...included,
    ],
    excluded: SECURITY_LENSES.filter((lens) => lens !== "ATTACK-CLASSES.md" && !includedLenses.has(lens)).map((lens) => {
      const rank = ranked.findIndex((entry) => entry.lens === lens);
      return {
        lens,
        reason: rank >= 0
          ? `ranked ${rank + 1} of ${ranked.length}; beyond the ${maxLenses}-lens cap`
          : `no matching signal (${STACK_SIGNAL_NAMES.filter((name) => hasSignal(signals, name)).join(", ") || "none detected"})`,
      };
    }),
  };
}

/** The selection as the prompt fragment a hunter receives. Each included lens
 *  is named by the absolute path `lensPath` gives it — the running package's
 *  `LoomCommands.securityLens` (taken as a function, because `loom-cli-command`
 *  imports this module's lens type): a hunter works in the audited
 *  repository, where a package-relative path names nothing. */
export function renderLensSelection(lensPath: (lens: SecurityLens) => string, selection: LensSelection): string {
  const included = selection.included
    .map((entry) => `- ${lensPath(entry.lens)} (${entry.base ? "base" : `score ${entry.score}`}): ${entry.reasons.join("; ")}`)
    .join("\n");
  const excluded = selection.excluded
    .map((entry) => `- ${entry.lens}: ${entry.reason}`)
    .join("\n");
  return `Included lenses:\n${included}\n\nExcluded lenses:\n${excluded}`;
}
