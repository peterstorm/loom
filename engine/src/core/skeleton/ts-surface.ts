/**
 * The third parse-only TypeScript compiler seam (AD-6, amending ADR-0042):
 * the declaration surfaces of frozen types files and of implementation files,
 * and the specifier style the frozen acceptance tests import a types file
 * with. One of the INV-1 seams allowed to import `typescript`; it parses
 * already-read text through `import-graph.ts`'s `parseModule` (the one
 * path-to-script-kind rule) and walks nodes only: no `ts.sys`, no Program, no
 * type checker. Every reading is syntactic.
 *
 * - `readTsTypesSurface` — every exported type alias and interface, with its
 *   function shape (a type alias whose type is a function type; generic when
 *   the alias or the function type has type parameters). Interfaces, callable
 *   ones included, are never function aliases. Frozen ADTs: an exported union
 *   of two or more object-shaped members sharing a string-literal-typed key
 *   (the discriminant), and an exported brand — a primitive intersected with
 *   an object carrying a computed (unique-symbol) or `…brand…` key.
 * - `readTsImplementationSurface` — every exported name with its declaration
 *   kind, bare-identifier annotation, the import that annotation comes from,
 *   and the string literal values of its initializer or body; every local
 *   type, interface, class and enum; every local named union with the
 *   string-literal properties of its object-shaped members.
 * - `typesImportSpecifier` — the style of the first relative import, in
 *   declaration order, that names the types file (AD-8).
 *
 * "Object-shaped" means a type literal, `Readonly<…>` of one, an intersection
 * with at least one object-shaped part, or a reference to a top-level type
 * alias or interface of the same file that is object-shaped. A reference to
 * an imported type never is: its shape is not in this text.
 */

import ts from "typescript";
import type { DomainResult } from "../orchestration-contract";
import { moduleEdges, parseModule, syntaxErrorsOf } from "../owner-verification/import-graph";
import { directoryOf, within } from "../owner-verification/repo-path";
import type {
  AliasShape,
  DeclaredAlias,
  FrozenAdt,
  LiteralProperties,
  ReadTsImplementationSurfaceFn,
  ReadTsTypesSurfaceFn,
  SpecifierStyle,
  SurfaceProblem,
  TsExportedBinding,
  TsLocalDeclaration,
  TsLocalUnion,
  TypesImportSpecifierFn,
} from "./types";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Parsed = Readonly<{ ok: true; source: ts.SourceFile }> | Readonly<{ ok: false; problem: SurfaceProblem }>;

/** The parsed file, or `unparseable` with every syntax error; fails closed when the parser exposes no diagnostics. */
const parse = (path: string, text: string): Parsed => {
  const source = parseModule(path, text);
  const errors = syntaxErrorsOf(source);
  if (errors === null) {
    return { ok: false, problem: { kind: "unparseable", path, detail: "this TypeScript exposes no parse diagnostics" } };
  }
  return errors.length > 0
    ? { ok: false, problem: { kind: "unparseable", path, detail: errors.join("; ") } }
    : { ok: true, source };
};

const refused = <T>(problem: SurfaceProblem): DomainResult<T, SurfaceProblem> => ({ ok: false, error: problem });

// ---------------------------------------------------------------------------
// Shared syntactic readings
// ---------------------------------------------------------------------------

/** A top-level type declaration a same-file type reference can resolve to. */
type LocalType = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;

/** The top-level type aliases and interfaces by name; the first declaration of a name wins. */
const localTypesOf = (source: ts.SourceFile): ReadonlyMap<string, LocalType> => {
  const types = new Map<string, LocalType>();
  for (const statement of source.statements) {
    if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && !types.has(statement.name.text)) {
      types.set(statement.name.text, statement);
    }
  }
  return types;
};

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);

const withoutParentheses = (node: ts.TypeNode): ts.TypeNode =>
  ts.isParenthesizedTypeNode(node) ? withoutParentheses(node.type) : node;

/** The type with parentheses and `Readonly<…>` wrappers removed. */
const unwrapped = (node: ts.TypeNode): ts.TypeNode => {
  const bare = withoutParentheses(node);
  const isReadonly = ts.isTypeReferenceNode(bare) && ts.isIdentifier(bare.typeName) && bare.typeName.text === "Readonly";
  const [argument, ...extra] = isReadonly ? bare.typeArguments ?? [] : [];
  return argument !== undefined && extra.length === 0 ? unwrapped(argument) : bare;
};

/** The name a same-file reference names: a bare identifier with no type arguments. */
const referencedName = (node: ts.TypeNode): string | null =>
  ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeArguments === undefined ? node.typeName.text : null;

/** A property name's text; null for a computed name. */
const propertyNameText = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name) ? name.text : null;

/** A string literal type's value; null for any other type. */
const stringLiteralOf = (node: ts.TypeNode): string | null => {
  const bare = withoutParentheses(node);
  return ts.isLiteralTypeNode(bare) && (ts.isStringLiteral(bare.literal) || ts.isNoSubstitutionTemplateLiteral(bare.literal))
    ? bare.literal.text
    : null;
};

const literalPropertiesOfMembers = (members: ts.NodeArray<ts.TypeElement>): LiteralProperties =>
  members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || member.type === undefined) return [];
    const key = propertyNameText(member.name);
    const literal = stringLiteralOf(member.type);
    return key === null || literal === null ? [] : [{ key, literal }];
  });

/**
 * The string-literal-valued properties of an object-shaped type, in source
 * order; null when the type is not object-shaped. `seen` breaks reference
 * cycles between same-file declarations.
 */
const literalPropertiesOf = (
  node: ts.TypeNode,
  locals: ReadonlyMap<string, LocalType>,
  seen: ReadonlySet<string> = new Set(),
): LiteralProperties | null => {
  const type = unwrapped(node);
  if (ts.isTypeLiteralNode(type)) return literalPropertiesOfMembers(type.members);
  if (ts.isIntersectionTypeNode(type)) {
    const parts = type.types.map((part) => literalPropertiesOf(part, locals, seen)).filter((part) => part !== null);
    return parts.length === 0 ? null : parts.flat();
  }
  const name = referencedName(type);
  const local = name === null || seen.has(name) ? undefined : locals.get(name);
  if (name === null || local === undefined) return null;
  return ts.isInterfaceDeclaration(local)
    ? literalPropertiesOfMembers(local.members)
    : literalPropertiesOf(local.type, locals, new Set([...seen, name]));
};

/** The members of a union type alias; null when the alias is no union. */
const unionMembersOf = (declaration: ts.TypeAliasDeclaration): readonly ts.TypeNode[] | null => {
  const type = withoutParentheses(declaration.type);
  return ts.isUnionTypeNode(type) ? type.types : null;
};

// ---------------------------------------------------------------------------
// Types surface
// ---------------------------------------------------------------------------

/** Each exported name a local declaration carries: its own (with `export`), and every local export list entry naming it. */
const exportedNamesOf = (source: ts.SourceFile): ReadonlyMap<string, readonly string[]> => {
  const names = new Map<string, readonly string[]>();
  const add = (local: string, exported: string): void => {
    const known = names.get(local) ?? [];
    if (!known.includes(exported)) names.set(local, [...known, exported]);
  };
  for (const statement of source.statements) {
    if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      add(statement.name.text, statement.name.text);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined
      && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) add((element.propertyName ?? element.name).text, element.name.text);
    }
  }
  return names;
};

const aliasShapeOf = (declaration: LocalType): AliasShape => {
  if (ts.isInterfaceDeclaration(declaration)) return { kind: "not-a-function" };
  const type = withoutParentheses(declaration.type);
  if (!ts.isFunctionTypeNode(type)) return { kind: "not-a-function" };
  const generic = (declaration.typeParameters?.length ?? 0) > 0 || (type.typeParameters?.length ?? 0) > 0;
  return { kind: "function", generic, parameterCount: type.parameters.length };
};

/** The discriminant: a key string-literal-typed in every member; among several, the first whose tags are distinct, else the first. */
const discriminantOf = (members: readonly LiteralProperties[]): Readonly<{ key: string; tags: readonly string[] }> | null => {
  const [first, ...rest] = members;
  if (first === undefined) return null;
  const candidates = first.flatMap(({ key }) => {
    const tags = members.map((member) => member.find((property) => property.key === key)?.literal);
    return rest.length > 0 && tags.every((tag) => tag !== undefined) ? [{ key, tags: tags.filter((tag) => tag !== undefined) }] : [];
  });
  return candidates.find(({ tags }) => new Set(tags).size === tags.length) ?? candidates[0] ?? null;
};

const discriminatedUnionOf = (
  name: string,
  declaration: ts.TypeAliasDeclaration,
  locals: ReadonlyMap<string, LocalType>,
): FrozenAdt | null => {
  const members = unionMembersOf(declaration);
  if (members === null) return null;
  const properties = members.map((member) => literalPropertiesOf(member, locals));
  if (!properties.every((member) => member !== null)) return null;
  const discriminant = discriminantOf(properties);
  const [firstTag, ...otherTags] = [...new Set(discriminant?.tags ?? [])];
  if (discriminant === null || firstTag === undefined) return null;
  const variants = [...new Set(members.flatMap((member) => {
    const variant = referencedName(withoutParentheses(member));
    return variant !== null && locals.has(variant) ? [variant] : [];
  }))];
  return { kind: "discriminated-union", name, discriminant: discriminant.key, tags: [firstTag, ...otherTags], variants };
};

const PRIMITIVE_KEYWORDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.SymbolKeyword,
]);

/** Whether an intersection part is an object carrying a brand key: computed (a unique symbol) or named `…brand…`. */
const hasBrandKey = (members: ts.NodeArray<ts.TypeElement>): boolean =>
  members.some((member) => ts.isPropertySignature(member)
    && (ts.isComputedPropertyName(member.name) || /brand/i.test(propertyNameText(member.name) ?? "")));

const isBrandPart = (part: ts.TypeNode, locals: ReadonlyMap<string, LocalType>): boolean => {
  const type = unwrapped(part);
  if (ts.isTypeLiteralNode(type)) return hasBrandKey(type.members);
  const name = referencedName(type);
  const local = name === null ? undefined : locals.get(name);
  // One same-file hop: `type Brand = Readonly<{ [B]: true }>; type Id = string & Brand`.
  if (local === undefined) return false;
  return ts.isInterfaceDeclaration(local) ? hasBrandKey(local.members) : isBrandPart(local.type, new Map());
};

const isBrand = (declaration: ts.TypeAliasDeclaration, locals: ReadonlyMap<string, LocalType>): boolean => {
  const type = withoutParentheses(declaration.type);
  return ts.isIntersectionTypeNode(type)
    && type.types.some((part) => PRIMITIVE_KEYWORDS.has(withoutParentheses(part).kind))
    && type.types.some((part) => isBrandPart(part, locals));
};

export const readTsTypesSurface: ReadTsTypesSurfaceFn = (path, text) => {
  const parsed = parse(path, text);
  if (!parsed.ok) return refused(parsed.problem);
  const locals = localTypesOf(parsed.source);
  const exported = exportedNamesOf(parsed.source);
  const aliases: DeclaredAlias[] = [];
  const adts: FrozenAdt[] = [];
  const seen = new Set<string>();
  for (const statement of parsed.source.statements) {
    if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue;
    for (const name of exported.get(statement.name.text) ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      aliases.push({ name, shape: aliasShapeOf(statement) });
      if (!ts.isTypeAliasDeclaration(statement)) continue;
      const adt = isBrand(statement, locals) ? { kind: "brand" as const, name } : discriminatedUnionOf(name, statement, locals);
      if (adt !== null) adts.push(adt);
    }
  }
  return { ok: true, value: { language: "typescript", path, aliases, adts } };
};

// ---------------------------------------------------------------------------
// Implementation surface
// ---------------------------------------------------------------------------

/** Every string literal value under a node, in source order; type positions and substituted templates are not values. */
const stringLiteralsIn = (node: ts.Node | undefined): readonly string[] => {
  const strings: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isTypeNode(child)) return;
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) strings.push(child.text);
    ts.forEachChild(child, visit);
  };
  if (node !== undefined) visit(node);
  return strings;
};

/** Each imported local name and the module specifier it comes from. */
const importSourcesOf = (source: ts.SourceFile): ReadonlyMap<string, string> => {
  const sources = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name !== undefined) sources.set(clause.name.text, specifier);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) sources.set(bindings.name.text, specifier);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) sources.set(element.name.text, specifier);
      }
    }
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
      && ts.isStringLiteral(statement.moduleReference.expression)) {
      sources.set(statement.name.text, statement.moduleReference.expression.text);
    }
  }
  return sources;
};

/** What an exported name reads as, before it is given its exported name. */
type BindingReading = Omit<TsExportedBinding, "name">;

const variableKindOf = (list: ts.VariableDeclarationList): TsExportedBinding["declaration"] => {
  const scoped = list.flags & ts.NodeFlags.BlockScoped;
  return scoped === ts.NodeFlags.Const ? "const" : scoped === ts.NodeFlags.Let ? "let" : scoped === 0 ? "var" : "other";
};

const boundNamesOf = (name: ts.BindingName): readonly string[] =>
  ts.isIdentifier(name)
    ? [name.text]
    : name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : boundNamesOf(element.name));

const unannotated = (declaration: TsExportedBinding["declaration"], initializerStrings: readonly string[]): BindingReading =>
  ({ declaration, annotation: null, annotationSource: null, initializerStrings });

/** Each name a top-level statement declares as a value or type, with its reading. */
const declaredReadings = (
  statement: ts.Statement,
  imports: ReadonlyMap<string, string>,
): readonly Readonly<{ name: string; reading: BindingReading }>[] => {
  if (ts.isVariableStatement(statement)) {
    const declaration = variableKindOf(statement.declarationList);
    return statement.declarationList.declarations.flatMap((variable) => {
      const annotation = variable.type !== undefined && ts.isTypeReferenceNode(variable.type) ? referencedName(variable.type) : null;
      const reading: BindingReading = {
        declaration,
        annotation,
        annotationSource: annotation === null ? null : imports.get(annotation) ?? null,
        initializerStrings: stringLiteralsIn(variable.initializer),
      };
      return boundNamesOf(variable.name).map((name) => ({ name, reading }));
    });
  }
  const named = (name: ts.Identifier | undefined, reading: BindingReading) => {
    const exportedName = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : name?.text;
    return exportedName === undefined ? [] : [{ name: exportedName, reading }];
  };
  if (ts.isFunctionDeclaration(statement)) return named(statement.name, unannotated("function", stringLiteralsIn(statement)));
  if (ts.isClassDeclaration(statement)) return named(statement.name, unannotated("class", stringLiteralsIn(statement)));
  if (ts.isEnumDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
    return named(statement.name, unannotated("other", stringLiteralsIn(statement)));
  }
  if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
    return named(statement.name, unannotated("other", []));
  }
  return [];
};

const exportedBindingsOf = (source: ts.SourceFile, imports: ReadonlyMap<string, string>): readonly TsExportedBinding[] => {
  const locals = new Map<string, BindingReading>();
  for (const statement of source.statements) {
    for (const { name, reading } of declaredReadings(statement, imports)) if (!locals.has(name)) locals.set(name, reading);
  }
  const reexport = unannotated("re-export", []);
  return source.statements.flatMap((statement): readonly TsExportedBinding[] => {
    if (ts.isExportAssignment(statement)) {
      return statement.isExportEquals === true ? [] : [{ name: "default", ...unannotated("other", stringLiteralsIn(statement.expression)) }];
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) return [];
      if (ts.isNamespaceExport(clause)) return [{ name: clause.name.text, ...reexport }];
      return clause.elements.map((element) => {
        const local = (element.propertyName ?? element.name).text;
        const reading = statement.moduleSpecifier !== undefined || imports.has(local)
          ? reexport
          : locals.get(local) ?? unannotated("other", []);
        return { name: element.name.text, ...reading };
      });
    }
    return hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ? declaredReadings(statement, imports).map(({ name, reading }) => ({ name, ...reading }))
      : [];
  });
};

/** A named local type, interface, class or enum declaration; null for any other node. */
const localDeclarationOf = (node: ts.Node): TsLocalDeclaration | null => {
  if (ts.isTypeAliasDeclaration(node)) return { name: node.name.text, kind: "type" };
  if (ts.isInterfaceDeclaration(node)) return { name: node.name.text, kind: "interface" };
  if (ts.isClassDeclaration(node) && node.name !== undefined) return { name: node.name.text, kind: "class" };
  if (ts.isEnumDeclaration(node)) return { name: node.name.text, kind: "enum" };
  return null;
};

/** Every named local type, interface, class and enum at any depth, in source order. */
const localDeclarationsOf = (source: ts.SourceFile): readonly TsLocalDeclaration[] => {
  const declarations: TsLocalDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    const declaration = localDeclarationOf(node);
    if (declaration !== null) declarations.push(declaration);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declarations;
};

/** Every local named union with at least one object-shaped member, at any depth, in source order. */
const localUnionsOf = (source: ts.SourceFile, locals: ReadonlyMap<string, LocalType>): readonly TsLocalUnion[] => {
  const unions: TsLocalUnion[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) {
      const objectMembers = (unionMembersOf(node) ?? [])
        .map((member) => literalPropertiesOf(member, locals))
        .filter((member) => member !== null);
      if (objectMembers.length > 0) unions.push({ name: node.name.text, objectMembers });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return unions;
};

export const readTsImplementationSurface: ReadTsImplementationSurfaceFn = (path, text) => {
  const parsed = parse(path, text);
  if (!parsed.ok) return refused(parsed.problem);
  const { source } = parsed;
  return {
    ok: true,
    value: {
      language: "typescript",
      path,
      exports: exportedBindingsOf(source, importSourcesOf(source)),
      localDeclarations: localDeclarationsOf(source),
      localUnions: localUnionsOf(source, localTypesOf(source)),
    },
  };
};

// ---------------------------------------------------------------------------
// Specifier style (AD-8)
// ---------------------------------------------------------------------------

/** Each TypeScript module extension and the runtime extension a `.js`-style specifier names it by. */
const RUNTIME_EXTENSIONS: readonly (readonly [string, string])[] = [
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".ts", ".js"],
];

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");

export const typesImportSpecifier: TypesImportSpecifierFn = (acceptancePath, acceptanceText, typesPath) => {
  const extensions = RUNTIME_EXTENSIONS.find(([extension]) => typesPath.endsWith(extension));
  if (extensions === undefined) return null;
  const [extension, runtimeExtension] = extensions;
  const stem = typesPath.slice(0, -extension.length);
  const indexDirectory = stem === "index" || stem.endsWith("/index") ? directoryOf(stem) : null;
  const styleOf = (resolved: string): SpecifierStyle | null =>
    resolved === typesPath ? ".ts"
    : resolved === `${stem}${runtimeExtension}` ? ".js"
    : resolved === stem || resolved === indexDirectory ? "extensionless"
    : null;
  const fromDirectory = directoryOf(acceptancePath);
  for (const { specifier } of moduleEdges(acceptancePath, acceptanceText)) {
    const resolved = isRelativeSpecifier(specifier) ? within(fromDirectory, specifier) : null;
    const style = resolved === null ? null : styleOf(resolved);
    if (style !== null) return style;
  }
  return null;
};
