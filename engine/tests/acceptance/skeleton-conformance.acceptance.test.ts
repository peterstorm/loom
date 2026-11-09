/**
 * CT-2 acceptance: the completion conformance judge (AD-11), through its pure
 * entry point `judgeConformance` and its diagnostic
 * `renderConformanceViolations`.
 *
 * One world: a frozen TypeScript contract (CT-1) and a frozen Java contract
 * (CT-2), read from source text through the real surface readers; bindings
 * built as data with identifiers minted by `parseIdentifier`; and five
 * in-scope production files, each parsed to its target by
 * `skeletonLanguageOf`. Every judgment sees the whole world, with every file
 * conforming except the seeded defects a testcase names, so the expected
 * violations are exactly the seeded ones (SC-006).
 *
 * Every input is built lazily inside a testcase: the file loads even while
 * the readers, the language predicate and the judge are stubs.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { judgeConformance, renderConformanceViolations } from "../../src/core/skeleton/conformance";
import { readJavaTypesSurface } from "../../src/core/skeleton/java-surface";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";
import { readTsTypesSurface } from "../../src/core/skeleton/ts-surface";
import type {
  ConformanceFile,
  ConformanceViolation,
  ContractConformance,
  ContractSurface,
  ExportBinding,
  SkeletonTarget,
  ViolationReason,
} from "../../src/core/skeleton/types";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import {
  SOURCES_JAVA_CONTRACT_ID,
  JAVA_GEOMETRY,
  JAVA_GEOMETRY_PATH,
  JAVA_PRICING,
  JAVA_PRICING_PATH,
  SOURCES_JAVA_TYPES_PATH,
  SOURCES_JAVA_TYPES_TEXT,
  SOURCES_TS_CONTRACT_ID,
  TS_LEDGER,
  TS_LEDGER_PATH,
  TS_PRICING,
  TS_PRICING_PATH,
  TS_REPLAY,
  TS_REPLAY_PATH,
  SOURCES_TS_TYPES_PATH,
  SOURCES_TS_TYPES_TEXT,
} from "../fixtures/skeleton-sources";
import { binding, unwrap } from "../fixtures/skeleton-builders";

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const surfaces = (): readonly ContractSurface[] => [
  { contract: SOURCES_TS_CONTRACT_ID, surface: unwrap(readTsTypesSurface(SOURCES_TS_TYPES_PATH, SOURCES_TS_TYPES_TEXT), "readTsTypesSurface") },
  { contract: SOURCES_JAVA_CONTRACT_ID, surface: unwrap(readJavaTypesSurface(SOURCES_JAVA_TYPES_PATH, SOURCES_JAVA_TYPES_TEXT), "readJavaTypesSurface") },
];

const bindings = (): readonly ExportBinding[] => [
  binding(TS_PRICING_PATH, SOURCES_TS_CONTRACT_ID, ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]),
  binding(TS_REPLAY_PATH, SOURCES_TS_CONTRACT_ID, ["replayEvents", "ReplayEventsFn"]),
  binding(JAVA_PRICING_PATH, SOURCES_JAVA_CONTRACT_ID, ["priceOrder", "PriceOrderFn"], ["parseOrder", "ParseOrderFn"]),
];

const target = (path: string): SkeletonTarget => {
  const parsed = skeletonLanguageOf(path);
  if (parsed.kind !== "supported") throw new Error(`${path} is no skeleton target: ${parsed.reason}`);
  return parsed;
};

/** Path → text, or null for a file that no longer exists. */
type World = Readonly<Record<string, string | null>>;

const CONFORMING_WORLD: World = {
  [TS_PRICING_PATH]: TS_PRICING.conforming,
  [TS_REPLAY_PATH]: TS_REPLAY.conforming,
  [TS_LEDGER_PATH]: TS_LEDGER.conforming,
  [JAVA_PRICING_PATH]: JAVA_PRICING.conforming,
  [JAVA_GEOMETRY_PATH]: JAVA_GEOMETRY.conforming,
};

/** Append declarations to a Java class body, before its closing brace. */
const withinJavaClass = (text: string, members: string): string => {
  const close = text.lastIndexOf("}");
  return `${text.slice(0, close)}${members}${text.slice(close)}`;
};

/** Judge the whole world, every file conforming except `seeded`. */
const judge = (seeded: World = {}): ContractConformance => {
  const files: readonly ConformanceFile[] = Object.entries({ ...CONFORMING_WORLD, ...seeded }).map(([path, text]) => ({
    target: target(path),
    text,
  }));
  return judgeConformance({ surfaces: surfaces(), bindings: bindings(), files });
};

// ---------------------------------------------------------------------------
// Reading a judgment
// ---------------------------------------------------------------------------

/** One violation of one file. Whether it carries a remedy is part of its
 *  shape; the remedy's wording is asserted where it matters. */
type Listed = Readonly<{ file: string; subject: string; reason: ViolationReason; hasRemedy: boolean }>;

const order = (left: Listed, right: Listed): number =>
  `${left.file}\u0000${left.subject}\u0000${left.reason}`.localeCompare(`${right.file}\u0000${right.subject}\u0000${right.reason}`);

/** Every violation of a judgment, one row per (file, violation), in a stable order. */
const listed = (conformance: ContractConformance): readonly Listed[] => {
  if (conformance.kind !== "judged") throw new Error(`the judge always judges; got ${conformance.kind}`);
  return [...conformance.violations]
    .flatMap(([file, violations]) => violations.map(({ subject, reason, remedy }) => ({ file, subject, reason, hasRemedy: remedy !== null })))
    .sort(order);
};

const violationsOf = (conformance: ContractConformance, file: string): NonEmpty<ConformanceViolation> => {
  if (conformance.kind !== "judged") throw new Error(`the judge always judges; got ${conformance.kind}`);
  const violations = conformance.violations.get(file);
  if (violations === undefined) throw new Error(`no violation reported for ${file}`);
  return violations;
};

const remedyOf = (conformance: ContractConformance, file: string, subject: string): string => {
  const relisting = violationsOf(conformance, file).find(
    (violation) => violation.subject === subject && violation.reason === "re-lists-frozen-variants",
  );
  if (relisting?.remedy == null) throw new Error(`no re-listing remedy for ${subject} in ${file}`);
  return relisting.remedy;
};

/** A signature or same-name violation: no fixed remedy. */
const plain = (file: string, subject: string, reason: Exclude<ViolationReason, "re-lists-frozen-variants">): Listed => ({
  file,
  subject,
  reason,
  hasRemedy: false,
});

/** A re-listing violation: always carries a remedy. */
const relisted = (file: string, subject: string): Listed => ({
  file,
  subject,
  reason: "re-lists-frozen-variants",
  hasRemedy: true,
});

const expectViolations = (conformance: ContractConformance, ...expected: readonly Listed[]): void => {
  expect(listed(conformance)).toEqual([...expected].sort(order));
};

const NO_VIOLATION: ContractConformance = { kind: "judged", violations: new Map() };

/** The diagnostic's wording of each reason (FR-021). */
const REASON_WORDS: Readonly<Record<ViolationReason, string>> = {
  deleted: "deleted",
  renamed: "renamed",
  retyped: "retyped",
  "still-unimplemented": "still unimplemented",
  "shadows-frozen-adt": "shadows frozen ADT",
  "re-lists-frozen-variants": "re-lists frozen variants",
};

/** The same violations with the file stripped: what parity compares. */
const shapeOf = (conformance: ContractConformance): readonly Omit<Listed, "file">[] =>
  listed(conformance).map(({ subject, reason, hasRemedy }) => ({ subject, reason, hasRemedy }));

// ---------------------------------------------------------------------------
// The seeded signature matrix (SC-006), one row per defect in both languages
// ---------------------------------------------------------------------------

type SignatureDefect = Readonly<{
  defect: string;
  ts: string;
  java: string;
  subject: string;
  reason: Exclude<ViolationReason, "shadows-frozen-adt" | "re-lists-frozen-variants">;
}>;

const SIGNATURE_MATRIX: readonly SignatureDefect[] = [
  { defect: "export deleted", ts: TS_PRICING.deleted, java: JAVA_PRICING.deleted, subject: "parseOrder", reason: "deleted" },
  { defect: "export renamed", ts: TS_PRICING.renamed, java: JAVA_PRICING.renamed, subject: "priceOrder", reason: "renamed" },
  {
    defect: "alias replaced by a type that still compiles",
    ts: TS_PRICING.retypedInlineType,
    java: JAVA_PRICING.retypedOtherType,
    subject: "priceOrder",
    reason: "retyped",
  },
  {
    defect: "alias replaced by a local alias of the same name",
    ts: TS_PRICING.retypedLocalAlias,
    java: JAVA_PRICING.retypedLocalAlias,
    subject: "priceOrder",
    reason: "retyped",
  },
  {
    defect: "marker still present",
    ts: TS_PRICING.stillUnimplemented,
    java: JAVA_PRICING.stillUnimplemented,
    subject: "priceOrder",
    reason: "still-unimplemented",
  },
];

const LANGUAGES = [
  { language: "TypeScript", path: TS_PRICING_PATH, pick: (row: SignatureDefect): string => row.ts },
  { language: "Java", path: JAVA_PRICING_PATH, pick: (row: SignatureDefect): string => row.java },
] as const;

const SIGNATURE_CASES = LANGUAGES.flatMap(({ language, path, pick }) =>
  SIGNATURE_MATRIX.map((row) => ({ name: `${language}: ${row.defect}`, path, text: pick(row), row })),
);

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

describe("CT-2 signature conformance", () => {
  it("AS-020: every bound export keeps its name and frozen-alias annotation and no marker — no violation in either language", () => {
    expect(judge()).toEqual(NO_VIOLATION);
  });

  it("AS-020: a Java bound member typed through the imported holder (`OrderContract.PriceOrderFn`) conforms", () => {
    expect(judge({ [JAVA_PRICING_PATH]: JAVA_PRICING.conformingQualified })).toEqual(NO_VIOLATION);
  });

  it.each(SIGNATURE_CASES)("FR-013: $name is refused with its reason", ({ path, text, row }) => {
    expectViolations(judge({ [path]: text }), plain(path, row.subject, row.reason));
  });

  it("AS-021: a deleted bound export is refused as `deleted`, and the diagnostic names the file, the export and the reason", () => {
    const conformance = judge({ [TS_PRICING_PATH]: TS_PRICING.deleted });

    expectViolations(conformance, plain(TS_PRICING_PATH, "parseOrder", "deleted"));
    const diagnostic = renderConformanceViolations(TS_PRICING_PATH, violationsOf(conformance, TS_PRICING_PATH));
    expect(diagnostic).toContain(TS_PRICING_PATH);
    expect(diagnostic).toContain("parseOrder");
    expect(diagnostic).toContain("deleted");
  });

  it("AS-022: a bound export whose frozen-alias annotation now sits on another name is refused as `renamed`", () => {
    expectViolations(judge({ [TS_PRICING_PATH]: TS_PRICING.renamed }), plain(TS_PRICING_PATH, "priceOrder", "renamed"));
  });

  it.each([
    { how: "annotation removed", text: TS_PRICING.retypedUnannotated },
    { how: "annotation replaced by an equivalent inline function type that compiles", text: TS_PRICING.retypedInlineType },
    { how: "annotation replaced by a local alias of the frozen alias's name", text: TS_PRICING.retypedLocalAlias },
    { how: "exported as a function declaration instead of an annotated const", text: TS_PRICING.retypedFunctionDeclaration },
  ])("AS-023: a bound export with its $how is refused as `retyped`", ({ text }) => {
    expectViolations(judge({ [TS_PRICING_PATH]: text }), plain(TS_PRICING_PATH, "priceOrder", "retyped"));
  });

  it("AS-024: a bound export whose body still holds its exact `unimplemented: <name>` marker is refused as `still unimplemented`", () => {
    expectViolations(
      judge({ [TS_PRICING_PATH]: TS_PRICING.stillUnimplemented }),
      plain(TS_PRICING_PATH, "priceOrder", "still-unimplemented"),
    );
  });

  it("AS-024: the untouched engine skeleton is refused as `still unimplemented`", () => {
    expectViolations(
      judge({ [TS_REPLAY_PATH]: TS_REPLAY.skeleton }),
      plain(TS_REPLAY_PATH, "replayEvents", "still-unimplemented"),
    );
  });

  it("AS-025: other throws on legitimate paths, including a message that only resembles the marker, never trip the unimplemented check", () => {
    expect(judge({ [TS_PRICING_PATH]: TS_PRICING.otherThrows, [JAVA_PRICING_PATH]: JAVA_PRICING.otherThrows })).toEqual(
      NO_VIOLATION,
    );
  });

  it("AS-026: internal helpers and extra exports beside the bound ones pass in both languages", () => {
    expect(judge({ [TS_PRICING_PATH]: TS_PRICING.withExtras, [JAVA_PRICING_PATH]: JAVA_PRICING.withExtras })).toEqual(
      NO_VIOLATION,
    );
  });

  it("AS-027: a deleted skeleton file reports every bound export of that file as `deleted`", () => {
    expectViolations(
      judge({ [TS_PRICING_PATH]: null }),
      plain(TS_PRICING_PATH, "priceOrder", "deleted"),
      plain(TS_PRICING_PATH, "parseOrder", "deleted"),
    );
  });

  it("FR-014: deleting a bound file counts as deleting every bound export of it, in both languages", () => {
    expectViolations(
      judge({ [TS_REPLAY_PATH]: null, [JAVA_PRICING_PATH]: null }),
      plain(TS_REPLAY_PATH, "replayEvents", "deleted"),
      plain(JAVA_PRICING_PATH, "priceOrder", "deleted"),
      plain(JAVA_PRICING_PATH, "parseOrder", "deleted"),
    );
  });

  it.each(SIGNATURE_MATRIX)(
    "AS-029: Java — $defect — is refused with the same reason and violation shape as TypeScript",
    ({ ts, java, subject, reason }) => {
      const typescript = shapeOf(judge({ [TS_PRICING_PATH]: ts }));
      const javaShape = shapeOf(judge({ [JAVA_PRICING_PATH]: java }));

      expect(typescript).toEqual([{ subject, reason, hasRemedy: false }]);
      expect(javaShape).toEqual(typescript);
    },
  );

  it("AS-029: a deleted Java bound file is refused like a deleted TypeScript one", () => {
    expect(shapeOf(judge({ [JAVA_PRICING_PATH]: null }))).toEqual(shapeOf(judge({ [TS_PRICING_PATH]: null })));
  });
});

// ---------------------------------------------------------------------------
// Frozen ADTs
// ---------------------------------------------------------------------------

describe("CT-2 frozen ADT conformance", () => {
  it.each([
    { declaration: "type alias", text: TS_LEDGER.shadowsUnionAsType },
    { declaration: "interface", text: TS_LEDGER.shadowsUnionAsInterface },
    { declaration: "class", text: TS_LEDGER.shadowsUnionAsClass },
  ])(
    "AS-030: a local $declaration named as the frozen union `OrderEvent` is refused as `shadows frozen ADT`, naming the file and the declaration",
    ({ text }) => {
      const conformance = judge({ [TS_LEDGER_PATH]: text });

      expectViolations(conformance, plain(TS_LEDGER_PATH, "OrderEvent", "shadows-frozen-adt"));
      const diagnostic = renderConformanceViolations(TS_LEDGER_PATH, violationsOf(conformance, TS_LEDGER_PATH));
      expect(diagnostic).toContain(TS_LEDGER_PATH);
      expect(diagnostic).toContain("OrderEvent");
      expect(diagnostic).toContain("shadows frozen ADT");
    },
  );

  it("AS-031: a differently named local union listing the frozen tags `placed | paid | shipped` is refused as `re-lists frozen variants`", () => {
    expectViolations(judge({ [TS_LEDGER_PATH]: TS_LEDGER.relistsAllTags }), relisted(TS_LEDGER_PATH, "OrderEvent"));
  });

  it("AS-032: a local type named as the frozen brand `OrderId` is refused as `shadows frozen ADT`", () => {
    expectViolations(judge({ [TS_LEDGER_PATH]: TS_LEDGER.shadowsBrand }), plain(TS_LEDGER_PATH, "OrderId", "shadows-frozen-adt"));
  });

  it("AS-033: a local sealed interface permitting the frozen variants `Circle, Square` is refused as `re-lists frozen variants`", () => {
    expectViolations(
      judge({ [JAVA_GEOMETRY_PATH]: JAVA_GEOMETRY.relistsExplicitPermits }),
      relisted(JAVA_GEOMETRY_PATH, "Shape"),
      plain(JAVA_GEOMETRY_PATH, "Circle", "shadows-frozen-adt"),
      plain(JAVA_GEOMETRY_PATH, "Square", "shadows-frozen-adt"),
    );
  });

  it.each([
    { declaration: "an interface named as the frozen sealed interface", text: JAVA_GEOMETRY.shadowsSealedInterface, subject: "Shape" },
    { declaration: "a record named as a frozen record", text: JAVA_GEOMETRY.shadowsRecord, subject: "Order" },
    { declaration: "a class named as a frozen record", text: JAVA_GEOMETRY.shadowsRecordAsClass, subject: "Price" },
  ])("AS-034: $declaration is refused as `shadows frozen ADT`", ({ text, subject }) => {
    expectViolations(judge({ [JAVA_GEOMETRY_PATH]: text }), plain(JAVA_GEOMETRY_PATH, subject, "shadows-frozen-adt"));
  });

  it("AS-035: files that import the frozen ADTs, pattern-match on them and construct their variants pass in both languages", () => {
    const conformance = judge({ [TS_REPLAY_PATH]: TS_REPLAY.conforming, [JAVA_GEOMETRY_PATH]: JAVA_GEOMETRY.conforming });

    expect(conformance).toEqual(NO_VIOLATION);
  });

  it("AS-036: a local TypeScript union re-listing a strict subset of the frozen tags is refused, and the remedy derives it with `Extract<OrderEvent, …>`", () => {
    const conformance = judge({ [TS_LEDGER_PATH]: TS_LEDGER.relistsTagSubset });

    expectViolations(conformance, relisted(TS_LEDGER_PATH, "OrderEvent"));
    const remedy = remedyOf(conformance, TS_LEDGER_PATH, "OrderEvent");
    expect(remedy).toContain("Extract<OrderEvent");
    expect(remedy).toContain("SettledEntry");
    expect(renderConformanceViolations(TS_LEDGER_PATH, violationsOf(conformance, TS_LEDGER_PATH))).toContain(remedy);
  });

  it("AS-036: a local union re-listing the inline variants of a frozen union is refused as `re-lists frozen variants`", () => {
    const conformance = judge({ [TS_LEDGER_PATH]: TS_LEDGER.relistsInlineVariants });

    expectViolations(conformance, relisted(TS_LEDGER_PATH, "PaymentState"));
    expect(remedyOf(conformance, TS_LEDGER_PATH, "PaymentState")).toContain("Extract<PaymentState");
  });

  it("AS-036: a local Java sealed hierarchy re-listing the full set of frozen variants is refused, and the remedy names the frozen and the local hierarchy", () => {
    const conformance = judge({ [JAVA_GEOMETRY_PATH]: JAVA_GEOMETRY.relistsImplicitPermits });

    expectViolations(
      conformance,
      relisted(JAVA_GEOMETRY_PATH, "Shape"),
      plain(JAVA_GEOMETRY_PATH, "Circle", "shadows-frozen-adt"),
      plain(JAVA_GEOMETRY_PATH, "Square", "shadows-frozen-adt"),
      plain(JAVA_GEOMETRY_PATH, "Triangle", "shadows-frozen-adt"),
    );
    const remedy = remedyOf(conformance, JAVA_GEOMETRY_PATH, "Shape");
    expect(remedy).toContain("Shape");
    expect(remedy).toContain("Figure");
  });

  it("AS-036: a local declaration sharing a single frozen variant name trips only the same-name rule, never the re-listing rule", () => {
    expectViolations(
      judge({ [TS_LEDGER_PATH]: TS_LEDGER.shadowsVariant, [JAVA_GEOMETRY_PATH]: JAVA_GEOMETRY.singleSharedVariant }),
      plain(TS_LEDGER_PATH, "OrderPaid", "shadows-frozen-adt"),
      plain(JAVA_GEOMETRY_PATH, "Circle", "shadows-frozen-adt"),
    );
  });

  it.each([
    { language: "TypeScript", path: TS_LEDGER_PATH, text: TS_LEDGER.shadowsUnionAsType, subject: "OrderEvent" },
    { language: "TypeScript", path: TS_LEDGER_PATH, text: TS_LEDGER.shadowsBrand, subject: "OrderId" },
    { language: "TypeScript", path: TS_LEDGER_PATH, text: TS_LEDGER.shadowsVariant, subject: "OrderPaid" },
    { language: "Java", path: JAVA_GEOMETRY_PATH, text: JAVA_GEOMETRY.shadowsSealedInterface, subject: "Shape" },
    { language: "Java", path: JAVA_GEOMETRY_PATH, text: JAVA_GEOMETRY.shadowsRecord, subject: "Order" },
    { language: "Java", path: JAVA_GEOMETRY_PATH, text: JAVA_GEOMETRY.shadowsVariant, subject: "Circle" },
  ])("FR-015: $language — a local declaration named `$subject` shadows a frozen ADT", ({ path, text, subject }) => {
    expectViolations(judge({ [path]: text }), plain(path, subject, "shadows-frozen-adt"));
  });

  it.each([
    { what: "TypeScript, every frozen tag", path: TS_LEDGER_PATH, text: TS_LEDGER.relistsAllTags, subject: "OrderEvent", shadowed: [] },
    { what: "TypeScript, two frozen tags", path: TS_LEDGER_PATH, text: TS_LEDGER.relistsTagSubset, subject: "OrderEvent", shadowed: [] },
    {
      what: "Java, two permitted frozen variants",
      path: JAVA_GEOMETRY_PATH,
      text: JAVA_GEOMETRY.relistsExplicitPermits,
      subject: "Shape",
      shadowed: ["Circle", "Square"],
    },
    {
      what: "Java, every permitted frozen variant",
      path: JAVA_GEOMETRY_PATH,
      text: JAVA_GEOMETRY.relistsImplicitPermits,
      subject: "Shape",
      shadowed: ["Circle", "Square", "Triangle"],
    },
  ])("FR-016: $what — a local union or sealed hierarchy re-lists frozen variants", ({ path, text, subject, shadowed }) => {
    expectViolations(
      judge({ [path]: text }),
      relisted(path, subject),
      ...shadowed.map((name) => plain(path, name, "shadows-frozen-adt")),
    );
  });

  it("FR-016: near-miss view-models — string-literal unions, other discriminant keys, unfrozen tags, one shared tag, single shapes — never re-list", () => {
    expect(judge({ [TS_LEDGER_PATH]: TS_LEDGER.conforming })).toEqual(NO_VIOLATION);
  });

  it.each([
    { kind: "discriminated union", path: TS_LEDGER_PATH, text: TS_LEDGER.shadowsUnionAsType, subject: "OrderEvent" },
    { kind: "branded type", path: TS_LEDGER_PATH, text: TS_LEDGER.shadowsBrand, subject: "OrderId" },
    { kind: "sealed interface", path: JAVA_GEOMETRY_PATH, text: JAVA_GEOMETRY.shadowsSealedInterface, subject: "Shape" },
    { kind: "record", path: JAVA_GEOMETRY_PATH, text: JAVA_GEOMETRY.shadowsRecordAsClass, subject: "Price" },
    { kind: "permitted variant", path: JAVA_GEOMETRY_PATH, text: JAVA_GEOMETRY.shadowsVariant, subject: "Circle" },
  ])("FR-017: a frozen $kind is a frozen ADT", ({ path, text, subject }) => {
    expectViolations(judge({ [path]: text }), plain(path, subject, "shadows-frozen-adt"));
  });

  /** A TypeScript file declaring every frozen Java ADT name (`Order`, `Price`,
   *  `Shape` and its variants), each of which would shadow in a Java file. */
  const TS_DECLARING_JAVA_ADTS = `export type Order = Readonly<{ id: string }>;
export interface Price {
  readonly cents: number;
}
export class Shape {
  constructor(readonly sides: number) {}
}
export type Circle = Readonly<{ radius: number }>;
export type Square = Readonly<{ side: number }>;
export type Triangle = Readonly<{ base: number; height: number }>;
`;

  /** A Java file declaring every frozen TypeScript ADT name (`OrderId`, and
   *  `OrderEvent` sealed over its named variants), each of which would shadow
   *  in a TypeScript file. */
  const JAVA_DECLARING_TS_ADTS = `package com.acme.order.pricing;

public final class Geometry {
    private Geometry() {}

    record OrderId(String value) {}

    sealed interface OrderEvent permits OrderPlaced, OrderPaid, OrderShipped {}

    record OrderPlaced(String id) implements OrderEvent {}

    record OrderPaid(String id, long cents) implements OrderEvent {}

    record OrderShipped(String id, String carrier) implements OrderEvent {}

    record PaymentState(String status) {}
}
`;

  it("FR-017: a frozen ADT binds only files of its types file's language — every Java ADT name in TypeScript and every TypeScript ADT name in Java pass", () => {
    expect(judge({ [TS_LEDGER_PATH]: TS_DECLARING_JAVA_ADTS, [JAVA_GEOMETRY_PATH]: JAVA_DECLARING_TS_ADTS })).toEqual(NO_VIOLATION);
  });

  it("FR-017: beside the other language's ADT names, only the file's own language's frozen ADTs are refused", () => {
    const conformance = judge({
      [TS_LEDGER_PATH]: `${TS_DECLARING_JAVA_ADTS}export type OrderPaid = Readonly<{ kind: "paid"; cents: number }>;\n`,
      [JAVA_GEOMETRY_PATH]: withinJavaClass(JAVA_DECLARING_TS_ADTS, "\n    record Circle(double radius) {}\n"),
    });

    expectViolations(
      conformance,
      plain(TS_LEDGER_PATH, "OrderPaid", "shadows-frozen-adt"),
      plain(JAVA_GEOMETRY_PATH, "Circle", "shadows-frozen-adt"),
    );
  });
});

// ---------------------------------------------------------------------------
// Every violation, every file, one judgment
// ---------------------------------------------------------------------------

describe("CT-2 listing every violation", () => {
  const SEEDED: World = {
    [TS_PRICING_PATH]: TS_PRICING.severalViolations,
    [TS_REPLAY_PATH]: null,
    [TS_LEDGER_PATH]: TS_LEDGER.severalViolations,
    [JAVA_PRICING_PATH]: JAVA_PRICING.severalViolations,
    [JAVA_GEOMETRY_PATH]: JAVA_GEOMETRY.severalViolations,
  };

  const EXPECTED: readonly Listed[] = [
    plain(TS_PRICING_PATH, "priceOrder", "still-unimplemented"),
    plain(TS_PRICING_PATH, "parseOrder", "deleted"),
    plain(TS_REPLAY_PATH, "replayEvents", "deleted"),
    plain(TS_LEDGER_PATH, "OrderId", "shadows-frozen-adt"),
    relisted(TS_LEDGER_PATH, "OrderEvent"),
    plain(JAVA_PRICING_PATH, "priceOrder", "still-unimplemented"),
    plain(JAVA_PRICING_PATH, "parseOrder", "retyped"),
    plain(JAVA_GEOMETRY_PATH, "Order", "shadows-frozen-adt"),
  ];

  it("AS-028: several violations across files and languages are all listed, not only the first", () => {
    expectViolations(judge(SEEDED), ...EXPECTED);
  });

  it("AS-028: each file's diagnostic names every one of its violations with its reason", () => {
    const conformance = judge(SEEDED);

    for (const file of new Set(EXPECTED.map(({ file }) => file))) {
      const diagnostic = renderConformanceViolations(file, violationsOf(conformance, file));
      expect(diagnostic).toContain(file);
      for (const { subject, reason } of EXPECTED.filter((row) => row.file === file)) {
        expect(diagnostic).toContain(subject);
        expect(diagnostic).toContain(REASON_WORDS[reason]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Additions never add a violation (FR-022)
// ---------------------------------------------------------------------------

describe("CT-2 additions", () => {
  /** Fresh names that can collide with no bound export, frozen ADT or reserved word. */
  const freshNames = fc
    .uniqueArray(fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,8}$/), { minLength: 1, maxLength: 4 })
    .map((stems) => stems.map((stem) => `extra${stem.charAt(0).toUpperCase()}${stem.slice(1)}`));

  const withTsAdditions = (text: string, names: readonly string[]): string =>
    names.reduce(
      (source, name) =>
        `${source}
const ${name}Helper = (value: number): number => value + 1;
export const ${name} = (value: number): number => ${name}Helper(value);
export type ${name.charAt(0).toUpperCase()}${name.slice(1)}View = Readonly<{ value: number }>;
`,
      text,
    );

  const withJavaAdditions = (text: string, names: readonly string[]): string =>
    withinJavaClass(
      text,
      names
        .map(
          (name) => `
    public static final int ${name} = 0;

    private static int ${name}Helper(int value) {
        return value + 1;
    }

    record ${name.charAt(0).toUpperCase()}${name.slice(1)}Row(int value) {}
`,
        )
        .join(""),
    );

  it("FR-022: extra exports and internal helpers added to conforming files never add a violation, in either language", () => {
    fc.assert(
      fc.property(freshNames, (names) => {
        const conformance = judge({
          [TS_PRICING_PATH]: withTsAdditions(TS_PRICING.conforming, names),
          [TS_LEDGER_PATH]: withTsAdditions(TS_LEDGER.conforming, names),
          [JAVA_PRICING_PATH]: withJavaAdditions(JAVA_PRICING.conforming, names),
          [JAVA_GEOMETRY_PATH]: withJavaAdditions(JAVA_GEOMETRY.conforming, names),
        });
        expect(conformance).toEqual(NO_VIOLATION);
      }),
      { numRuns: 25 },
    );
  });

  it("FR-022: additions to a violating file add no violation beyond the seeded one", () => {
    fc.assert(
      fc.property(freshNames, (names) => {
        expectViolations(
          judge({
            [TS_PRICING_PATH]: withTsAdditions(TS_PRICING.deleted, names),
            [JAVA_PRICING_PATH]: withJavaAdditions(JAVA_PRICING.deleted, names),
          }),
          plain(TS_PRICING_PATH, "parseOrder", "deleted"),
          plain(JAVA_PRICING_PATH, "parseOrder", "deleted"),
        );
      }),
      { numRuns: 25 },
    );
  });
});
