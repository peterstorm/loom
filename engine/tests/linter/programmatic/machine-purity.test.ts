/** Executable FC/IS closure for the Guarded Skill Machine and Defect-Family Accounting. */
import { afterEach, describe, it, expect } from "vitest";
import fc from "fast-check";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve, posix } from "node:path";
import {
  handler as noIoHandler,
  isPureModule,
  DEFAULT_PURE_MODULES,
} from "../../../src/linter/programmatic/no-io-in-pure-modules";

// Closure scans are deliberately synchronous. Yield between cases so the
// unchanged root runner can acknowledge task updates under parallel CPU load.
afterEach(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });

const REPO_ROOT = resolve(__dirname, "../../../..");
const requireFromEngine = createRequire(resolve(REPO_ROOT, "engine/package.json"));
const ACCOUNTING = "engine/src/core/defect-family-accounting.ts";
const MACHINE_ROOT = "engine/src/machine/advance.ts";
const PARSER = "engine/src/core/structured-test-report.ts";
const SOURCE_AUTHORITY = "engine/src/core/standalone-review-machine.ts";

// Exact runtime entry points, NOT package-prefix allowances. Updates require re-audit.
const SAX_ENTRY = requireFromEngine.resolve("saxes");
const requireFromSaxes = createRequire(SAX_ENTRY);
const XML_CHAR_MODULES = [
  ["xmlchars/xml/1.0/ed5", "ea350479ab6f6553c0c3395c30ec440fb39821f6902081939831ddf1b5e8fd0f"],
  ["xmlchars/xml/1.1/ed2", "461d5c71cc6076dc16aebbfd2d3c506481df5a74f43631d82372a6ffdc239d69"],
  ["xmlchars/xmlns/1.0/ed3", "ff14ffa3a2cdfdd1b6077c4a8443dc949f53d5bb56de5ed89d4dbc5d9fdf08f7"],
] as const;
type AuditedRuntime = Readonly<{ path: string; dependencies: readonly string[]; digest: string }>;
const SAX_RUNTIME: ReadonlyMap<string, AuditedRuntime> = new Map([
  ["saxes", {
    path: SAX_ENTRY,
    dependencies: XML_CHAR_MODULES.map(([specifier]) => specifier),
    digest: "d00e2ba27ed7d6ac961d03ff14d6b8c0eb5bf063ed2c996c22c6df06ac121423",
  }],
  ...XML_CHAR_MODULES.map(([specifier, digest]): readonly [string, AuditedRuntime] => [
    specifier, { path: requireFromSaxes.resolve(specifier), dependencies: [], digest },
  ]),
]);

// P4 audit: actual jsonc-parser UMD and Zod ESM entrypoint closures, not all package files.
// Tuple fields: exact installed relative path, SHA-256, ordered literal dependencies.
const REVIEWER_RUNTIME_BYTES: readonly (readonly [string, string, readonly string[]])[] = [
  ["jsonc-parser/lib/umd/impl/edit.js","9ecd115039cf7a478f223e4a9649170c7f5e8fd8016df1b267723b57553f9483",["./format","./parser"]],
  ["jsonc-parser/lib/umd/impl/format.js","f9e468e436bf1014a4395b1ac70374edb918739ba90b19e6e6a22ca0214564a9",["./scanner","./string-intern"]],
  ["jsonc-parser/lib/umd/impl/parser.js","a35db1bfb9631dcba643fa42972e9ebe2a318b4de3cac239d29081577a43d688",["./scanner"]],
  ["jsonc-parser/lib/umd/impl/scanner.js","581d82c4f1aa84b0605369c01f414fb0164ee462e03daa298cb960076a2a9e82",[]],
  ["jsonc-parser/lib/umd/impl/string-intern.js","e590d27909a7c132382fbf9b8c4668054ab425734c1e0789753063356826c30f",[]],
  ["jsonc-parser/lib/umd/main.js","6dc132e2e792a9616688ff93d10dd671c1fbcfa3301d76bff3e81193d049337d",["./impl/format","./impl/edit","./impl/scanner","./impl/parser"]],
  ["zod/v4/classic/checks.js","78a162d29e06001b4d919e1ed08f6e7d0d665bba0ef983201373745410d7b354",["../core/index.js"]],
  ["zod/v4/classic/coerce.js","fb2efe3b6eacc475c77cbb571b5fb8650d92a10f316dc869e49b722973d83c3c",["../core/index.js","./schemas.js"]],
  ["zod/v4/classic/compat.js","0e948b101771cc0e7b753e54b3f5b486929d3db9bd4c09d98fe4ce86271bcf7b",["../core/index.js","../core/index.js"]],
  ["zod/v4/classic/errors.js","fd807f79ded4f88928ab8205de1922901a4d3a8c9b93d072e1ab8c0a44a95df5",["../core/index.js","../core/index.js","../core/util.js"]],
  ["zod/v4/classic/external.js","179a03ace3d1d77895cc5b3c54a3fcbf2b7f8bad44d6f030092491c10e5d9097",["../core/index.js","./schemas.js","./checks.js","./errors.js","./parse.js","./compat.js","../core/index.js","../locales/en.js","../core/index.js","../core/json-schema-processors.js","./from-json-schema.js","../locales/index.js","./iso.js","./iso.js","./coerce.js"]],
  ["zod/v4/classic/from-json-schema.js","826d3386506f0e92b77c9917c04c67b8349c67815e002ac1f712b0e68d7538a7",["../core/registries.js","./checks.js","./iso.js","./schemas.js"]],
  ["zod/v4/classic/index.js","d49030b9a324bab9bcf9f663a70298391b0f5a25328409174d86617512bf3037",["./external.js","./external.js"]],
  ["zod/v4/classic/iso.js","3cc5e6b4da086b8ffc7ee3188c69e4d3c945b368092e78d2299b5321182752c5",["../core/index.js","./schemas.js"]],
  ["zod/v4/classic/parse.js","14cbcc416ab9169abc2cde97af77da54ca769684eac1e03a3753c16ea4a7cd95",["../core/index.js","./errors.js"]],
  ["zod/v4/classic/schemas.js","74f7043b7de6f35661a86c378e7b0f9198b6170336dfb85b30e6c8d1a43f8ef7",["../core/index.js","../core/index.js","../core/json-schema-processors.js","../core/to-json-schema.js","./checks.js","./iso.js","./parse.js"]],
  ["zod/v4/core/api.js","b0249f67024345bab7b455b0363eccf40dd58c326f492d0321bf825888a71c9a",["./checks.js","./registries.js","./schemas.js","./util.js"]],
  ["zod/v4/core/checks.js","5a33a20dcad372b4d18ead8d1e58b1950454f136a2216e62f247e0e5601ac838",["./core.js","./regexes.js","./util.js"]],
  ["zod/v4/core/core.js","3a988a40d75ea5729a6ffcb2c94619e244ba0341ff1ed981d5a1725229952442",[]],
  ["zod/v4/core/doc.js","e084bbcc536746a8942fd33b08afe4db345554b3a0383114f1dca95261c958d9",[]],
  ["zod/v4/core/errors.js","c920e5549c1abcb8fc95824678beabb43023407d6a92020a3ac4a223af0a7a4b",["./core.js","./util.js"]],
  ["zod/v4/core/index.js","f9698820ee8371215e8d015cfa060230c62e65428397dce83f78e6538976301c",["./core.js","./parse.js","./errors.js","./schemas.js","./checks.js","./versions.js","./util.js","./regexes.js","../locales/index.js","./registries.js","./doc.js","./api.js","./to-json-schema.js","./json-schema-processors.js","./json-schema-generator.js","./json-schema.js"]],
  ["zod/v4/core/json-schema-generator.js","9cc884cdb535a9c87b85b66e61a593ff6b686222f038834f81c5e92552cd6e23",["./json-schema-processors.js","./to-json-schema.js"]],
  ["zod/v4/core/json-schema-processors.js","1872537015ed25ea43461fa109491c70ddccf43dc4995329354fb80a8971d22e",["./to-json-schema.js","./util.js"]],
  ["zod/v4/core/json-schema.js","8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881",[]],
  ["zod/v4/core/parse.js","a58b9c7be78e29d71f969f01807fe5f9be1f68d222a0f60c25e32e24f3b6639c",["./core.js","./errors.js","./util.js"]],
  ["zod/v4/core/regexes.js","a89562e9bea575edbbf5da84b7762fed64e20c4ff6c105dca318dfc60915706a",["./util.js"]],
  ["zod/v4/core/registries.js","620ea1a715ccc4e6e605a271343bf47942dccae90885dc71f137b1f08a972e50",[]],
  ["zod/v4/core/schemas.js","8f25b8fe962d889812763c51e1a10b439996ef59c65b3ee7c46df911f82c4b59",["./checks.js","./core.js","./doc.js","./parse.js","./regexes.js","./util.js","./versions.js","./util.js"]],
  ["zod/v4/core/to-json-schema.js","7224e53b6d3110925b67d7abd1b61389e5a359f6cca6a982e27c8271b27ea19e",["./registries.js"]],
  ["zod/v4/core/util.js","e41f9e774b96a9fe2b04c08f5aad32e6db2f6aa090671d2a375e7062b4f178aa",[]],
  ["zod/v4/core/versions.js","070e8cb9b31440b1bf0ae0de74a5fd7e8d410217a08df8a927c3d620477cc01e",[]],
  ["zod/v4/index.js","a4b634bb8c97cc700dbf165f3bb0095ec669042da72eaf28a7c5e2ddd98169ce",["./classic/index.js","./classic/index.js"]],
  ["zod/v4/locales/ar.js","220ca3ca8cf67e4ccc05d789eeed2692d970269fe0cd82f05db8fd899b661b9e",["../core/util.js"]],
  ["zod/v4/locales/az.js","4725ffef0b2f2df947194f9698c792b69f52a8c3a5a1e1bdfabbf62259a1dd46",["../core/util.js"]],
  ["zod/v4/locales/be.js","da4bda7fbc940dd9f50efdd914caa9397243be779a505b82bd4be5395d3b795e",["../core/util.js"]],
  ["zod/v4/locales/bg.js","48511ad2f86043f0eea6e7673d5e2b848a3295a26c9c4650e96b3884d640196d",["../core/util.js"]],
  ["zod/v4/locales/ca.js","796f9ba7dcd53648171aa0132c50271ef358936765cec0a44a642c41d05b3e8c",["../core/util.js"]],
  ["zod/v4/locales/cs.js","670a75fe1db1104db090c95aabb01e4eb6decd451fe77fd830c2e4dafc79b49a",["../core/util.js"]],
  ["zod/v4/locales/da.js","cdaad7a1fa370abda1943fe9c2caba961e7896b9808d51275daf33f964af49cc",["../core/util.js"]],
  ["zod/v4/locales/de.js","521a4ed29fcaf3f781163875dc282cfb5262047773aa2b70a852996b1d8a51b9",["../core/util.js"]],
  ["zod/v4/locales/en.js","3e2c03ebed517345ad73a247a8134577e5986622c22e7b6c760b8b9af5827442",["../core/util.js"]],
  ["zod/v4/locales/eo.js","ebe08048aa3ee9871ce9fe1271e254cb672b1968ec40ac253066d08d176e8a65",["../core/util.js"]],
  ["zod/v4/locales/es.js","4edd9302e9724c408b024220e99092fbd2f90100ac3c6407a94543b79843610c",["../core/util.js"]],
  ["zod/v4/locales/fa.js","2dc1bee1e984e8a15191fb3c69aaecaa26c922e12a0d4486ac005a0372b78565",["../core/util.js"]],
  ["zod/v4/locales/fi.js","3911184979f01d2ae580ce611710ee40597eff97a410d0fa823ab6ea27cee88c",["../core/util.js"]],
  ["zod/v4/locales/fr-CA.js","f8716c2baaccdfd1d958743bbc5250c9bdef5152d0801470e9b9a380d618f4ab",["../core/util.js"]],
  ["zod/v4/locales/fr.js","af85482fed4a3e4c97565ef849b4a14193b979b88b385844633d6af9b2e5ae30",["../core/util.js"]],
  ["zod/v4/locales/he.js","290512e43d2907700211da09dc3959fd98d120bfb89f8836e6e3f83a472e26fe",["../core/util.js"]],
  ["zod/v4/locales/hu.js","913ee94a253db79b31463ae23a337060b6fe28be73dfc7657d8a83a4942bd8a8",["../core/util.js"]],
  ["zod/v4/locales/hy.js","0d3bbb96c0f8bc74468a2dfc7d066e838bb56fab64fd5ec03ce9c4d89eccbe99",["../core/util.js"]],
  ["zod/v4/locales/id.js","cd2c19b5c30dade3ed91ffcff3deb0b068713be24f02248e7e46b87b2b9553ee",["../core/util.js"]],
  ["zod/v4/locales/index.js","8b23cfb530a5af9375303c0ffbec9ee260fff97ac59a1f780171f288b6e2f2da",["./ar.js","./az.js","./be.js","./bg.js","./ca.js","./cs.js","./da.js","./de.js","./en.js","./eo.js","./es.js","./fa.js","./fi.js","./fr.js","./fr-CA.js","./he.js","./hu.js","./hy.js","./id.js","./is.js","./it.js","./ja.js","./ka.js","./kh.js","./km.js","./ko.js","./lt.js","./mk.js","./ms.js","./nl.js","./no.js","./ota.js","./ps.js","./pl.js","./pt.js","./ru.js","./sl.js","./sv.js","./ta.js","./th.js","./tr.js","./ua.js","./uk.js","./ur.js","./uz.js","./vi.js","./zh-CN.js","./zh-TW.js","./yo.js"]],
  ["zod/v4/locales/is.js","ead5b14eac892229f915fe38ec94ab3b1e676f8aa2df2a8450848ba9ca9a1612",["../core/util.js"]],
  ["zod/v4/locales/it.js","1409d5c02a8d5922f21577f1d0f892aa141f56f3a3b49a13fe4802395ddaa0ac",["../core/util.js"]],
  ["zod/v4/locales/ja.js","43ee10378cac22b0b8aee912a66c3f36a834d5b4c76e9748f88a784044f248fd",["../core/util.js"]],
  ["zod/v4/locales/ka.js","b25387ebafa764efb3b1142eda956a24ed3bba8ea523d97a8ace4dc2973f0e38",["../core/util.js"]],
  ["zod/v4/locales/kh.js","78c3d1991041bb8c8fc0f7c5d745aae422d4c2e4e8f30bae44f3fef4765900a8",["./km.js"]],
  ["zod/v4/locales/km.js","dbdabda94dd93d4a1827e6c809505c79fa6aa7abefec91dc50fa0871382c99cc",["../core/util.js"]],
  ["zod/v4/locales/ko.js","d2efe22ac069d9b32b0109fa07713ac0695ac1c1357afc4e4277056466f2e196",["../core/util.js"]],
  ["zod/v4/locales/lt.js","dad886e52c56a1329d22e072f8b08dc8730f69c3dc5e5acf8267cac18df1ab28",["../core/util.js"]],
  ["zod/v4/locales/mk.js","9eb4af0392fc5b9c438cdc6ceea446acc541b59e221dba918f7b80800d9da3d1",["../core/util.js"]],
  ["zod/v4/locales/ms.js","c550a9185d997e8fcd17311951aa1e29793a50b8e825e18310efd5a46c641795",["../core/util.js"]],
  ["zod/v4/locales/nl.js","acba414579c5bbd7f83dc6661fa1a12d65f1822f9b0f5035549ac60f46d93763",["../core/util.js"]],
  ["zod/v4/locales/no.js","1854483c7cf158b8f97f0faf6fd799eb1f762009018b5fde893ca33f2fb0b313",["../core/util.js"]],
  ["zod/v4/locales/ota.js","34ae496104bc17fea7d30c3d45c94cfe3d1d569b5d39a6ca51de6c177690c556",["../core/util.js"]],
  ["zod/v4/locales/pl.js","18eab58f395e30b906e8e3fddc5f212eb19f2c4362410889a5c5e0141ebe2144",["../core/util.js"]],
  ["zod/v4/locales/ps.js","f977b5141fa8fb6a8459372e0b2895d74b381c9f2ff4899141f7ee3e639a4513",["../core/util.js"]],
  ["zod/v4/locales/pt.js","df172afc585544dee7c063c484f5a07b5ed103e2c1072a782c763ad8ceb08e17",["../core/util.js"]],
  ["zod/v4/locales/ru.js","c397a473e94d7d189a9c09c7890fe379c4f6f46d9556d52a040a90ffa56f7b93",["../core/util.js"]],
  ["zod/v4/locales/sl.js","ee2ff3a19b62cd2f89b54b165088773b937de15df7253df220bef07d9adf2d80",["../core/util.js"]],
  ["zod/v4/locales/sv.js","97d6718fb643e05d6fe30fa4f9f09b8d9a3eda4a3a350b57dfb2944943d19502",["../core/util.js"]],
  ["zod/v4/locales/ta.js","04bbde9766251f9047e786fdd77632f2ecd53aec2eb060eb2fc85bf576ad729d",["../core/util.js"]],
  ["zod/v4/locales/th.js","aea70c9ac2b399fe4749e19ba3aa99c3efb4dfb50eadfb62b0b2a6e005748f3d",["../core/util.js"]],
  ["zod/v4/locales/tr.js","4449f41d22c6f15ede5066f79d840a52ec45a6b694c859e16f9121062b6fad2f",["../core/util.js"]],
  ["zod/v4/locales/ua.js","9391169ffbc72f777a83230b6ffcc3f4cf46ab5945ec540de9ef4609dca1f4cc",["./uk.js"]],
  ["zod/v4/locales/uk.js","77136a2a60eef62f7cc803a0f9971aebbc641403af77c1b41fd5ce59abfa5de3",["../core/util.js"]],
  ["zod/v4/locales/ur.js","858f4f38d651073e7a3fbec7ed356692578b3ad1fae1b453cb3d85312a4f39d2",["../core/util.js"]],
  ["zod/v4/locales/uz.js","287481257de95c9d99b91e070773ade607fb5c68cf5fb74df311376950d507b6",["../core/util.js"]],
  ["zod/v4/locales/vi.js","2c61bd3f4a733f3cbb1ad85e75a053cb15a8ebeb83ab56dc21f2948b1138e12f",["../core/util.js"]],
  ["zod/v4/locales/yo.js","98b9cbf31bf00c8b2c00de62725a9dd7cb718ac72d6e8fd4e0a1a7c49723e0f4",["../core/util.js"]],
  ["zod/v4/locales/zh-CN.js","99a4b16af598834a0b11607fcdebd1c6de026386ff1d6a5a306b364c154c5899",["../core/util.js"]],
  ["zod/v4/locales/zh-TW.js","37dcae620e1553e9174a4b9434bbcc4e465150a627e80c9c17fd01de8baaf59a",["../core/util.js"]],
];
const REVIEWER_RUNTIME: ReadonlyMap<string, AuditedRuntime> = new Map(REVIEWER_RUNTIME_BYTES.map(([mod, digest, dependencies]) => [mod, {
  path: resolve(REPO_ROOT, "engine/node_modules", mod), digest, dependencies,
}]));
const AUDITED_RUNTIME = new Map([...SAX_RUNTIME, ...REVIEWER_RUNTIME]);
const CONTRACT = "engine/src/core/reviewer-contract.ts";
const LINEAGE_CONTRACT = "engine/src/core/standalone-lineage-contract.ts";
const CODEC = "engine/src/core/reviewer-protocol.ts";
const PANEL_CONTRACT = "engine/src/core/panel-contract.ts";
const PANEL_TALLY = "engine/src/core/review-panel.ts";
const REVIEWER_ENTRIES = new Map([
  ["zod/v4", "zod/v4/index.js"], ["jsonc-parser", "jsonc-parser/lib/umd/main.js"],
]);

/** Include type edges, re-exports, side effects, CJS and dynamic imports. No regex over prose. */
function dependencies(content: string): readonly Readonly<{ specifier: string | null; text: string }>[] {
  const source = ts.createSourceFile("module.ts", content, ts.ScriptTarget.Latest, true);
  const found: { specifier: string | null; text: string }[] = [];
  const add = (node: ts.Node, argument: ts.Node | undefined): void => {
    found.push({
      specifier: argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null,
      text: node.getText(source),
    });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const readSource = (mod: string): string => readFileSync(resolve(REPO_ROOT, mod), "utf-8");

/** The optional overlays mutate bytes in memory, never live authority or source files. */
function auditClosure(roots: readonly string[], overlays: ReadonlyMap<string, string> = new Map()): Readonly<{
  visited: ReadonlySet<string>;
  errors: readonly string[];
}> {
  const visited = new Set<string>();
  const errors: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const mod = queue.pop();
    if (mod === undefined || visited.has(mod)) continue;
    visited.add(mod);
    const runtime = AUDITED_RUNTIME.get(mod);
    if (runtime === undefined && !DEFAULT_PURE_MODULES.includes(mod)) {
      errors.push(`${mod}: dependency leaves the declared pure closure`);
      continue;
    }
    const content = overlays.get(mod) ?? (runtime === undefined
      ? readSource(mod)
      : readFileSync(runtime.path, "utf-8"));
    const digest = createHash("sha256").update(content).digest("hex");
    if (runtime !== undefined && digest !== runtime.digest) errors.push(`${mod}: runtime bytes differ from the audit`);
    // Zod exposes an UNUSED randomString function. No initializer or consumer calls it.
    // This exact source line is not a grant: changed bytes lose the allowance, calls
    // are independently excluded below, and import + actual codec execution run with sentinels.
    const dormantExport = mod === "zod/v4/core/util.js" && digest === runtime?.digest;
    errors.push(...noIoHandler(content, mod, [mod]).filter((v) => !(dormantExport && v.line === 131 &&
      v.text === "str += chars[Math.floor(Math.random() * chars.length)];"))
      .map((v) => `${mod}:${v.line}: ${v.fixHint}`));
    const imports = dependencies(content);
    if (runtime !== undefined) {
      const actual = imports.map(({ specifier }) => specifier).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...runtime.dependencies].sort())) {
        errors.push(`${mod}: runtime dependencies differ from the audited closure`);
      }
    }
    for (const { specifier, text } of imports) {
      if (specifier === null) {
        errors.push(`${mod}: non-literal dependency cannot prove purity: ${text}`);
      } else if (specifier.startsWith(".")) {
        const base = posix.normalize(posix.join(posix.dirname(mod), specifier));
        const candidates = runtime === undefined ? [base, `${base}.ts`, `${base}/index.ts`] : [base, `${base}.js`];
        const target = candidates.find((candidate) => runtime === undefined
          ? DEFAULT_PURE_MODULES.includes(candidate) : runtime.dependencies.includes(specifier) && AUDITED_RUNTIME.has(candidate));
        if (target === undefined) errors.push(`${mod}: ${specifier} leaves the declared pure closure`);
        else queue.push(target);
      } else if (([CONTRACT, LINEAGE_CONTRACT, PANEL_CONTRACT, PANEL_TALLY].includes(mod) && specifier === "zod/v4") || (mod === CODEC && specifier === "jsonc-parser")) {
        const entry = REVIEWER_ENTRIES.get(specifier);
        if (entry !== undefined) queue.push(entry);
      } else if ((mod === PARSER && specifier === "saxes") || runtime?.dependencies.includes(specifier)) {
        queue.push(specifier);
      } else if (runtime !== undefined) {
        errors.push(`${mod}: unaudited runtime package ${specifier}`);
      } else if (["node:crypto", "crypto", "node:util", "util"].includes(specifier)) {
        // The same shipped rule must prove the narrow named capability, not a module waiver.
        errors.push(...noIoHandler(text, mod, [mod]).map((v) => `${mod}: ${v.fixHint}`));
      } else if (!["ts-pattern", "node:path", "path", "node:url", "url"].includes(specifier)) {
        errors.push(`${mod}: unaudited package ${specifier}`);
      }
    }
  }
  return { visited, errors };
}

const IMPURE_PROBES = [
  'import { randomUUID } from "node:crypto";',
  'import { randomUUID } from\n "node:crypto";',
  'import { createHash } from "node:crypto"; import { randomUUID } from "node:crypto";',
  'import { createHash } from "node:crypto"; const entropy = require("crypto");',
  'import { randomBytes } from "crypto";',
  'import { createHash, randomUUID } from "node:crypto";',
  'import {\n createHash,\n randomBytes as entropy,\n} from "node:crypto";',
  'import crypto from "node:crypto";',
  'import * as crypto from "crypto";',
  'export { randomBytes } from "node:crypto";',
  'const { randomUUID } = require("node:crypto");',
  'const entropy = await import("crypto");',
  'import { readFileSync } from "node:fs";',
  'const fs = require("fs/promises");',
  'import { env } from "node:process";',
  'import { cwd } from "process";',
  'const environment = process.env.HOME;',
  'const cwd = process.cwd();',
  'const clock = process.hrtime.bigint();',
  'const clock = Date.now();',
  'const clock = new Date();',
  'const clock = performance.now();',
  'const entropy = Math.random();',
  'const entropy = crypto.randomUUID();',
  'const entropy = crypto.getRandomValues(new Uint8Array(1));',
  'import { debuglog } from "node:util";',
  'import { isDeepStrictEqual, debuglog } from "node:util";',
] as const;

const HASH_MODULES = [
  "engine/src/core/review-packet.ts",
  "engine/src/core/standalone-review.ts",
  SOURCE_AUTHORITY,
  "engine/src/core/panel-program.ts",
  "engine/src/core/parse-spec.ts",
  "engine/src/core/orchestration-contract/bytes.ts",
  "engine/src/core/orchestration-contract/publication.ts",
] as const;

describe("functional core — executable purity closure", () => {
  it("ships accounting and every transitive source dependency as declared pure", () => {
    expect(DEFAULT_PURE_MODULES).toContain(ACCOUNTING);
    expect(isPureModule(ACCOUNTING)).toBe(true);
    expect(auditClosure(DEFAULT_PURE_MODULES).errors).toEqual([]);
    const audit = auditClosure([ACCOUNTING]);
    expect(audit.errors).toEqual([]);
    for (const required of [SOURCE_AUTHORITY, PARSER, "engine/src/core/standalone-review.ts",
      "engine/src/core/orchestration-contract/index.ts", "engine/src/core/completion-suite.ts",
      "engine/src/core/verification-manifest.ts", "engine/src/types.ts", ...HASH_MODULES, ...SAX_RUNTIME.keys()]) {
      expect(audit.visited, `walk must reach ${required}`).toContain(required);
    }
  });

  it.each(DEFAULT_PURE_MODULES)("%s passes the shipped default rule", (mod) => {
    expect(noIoHandler(readSource(mod), mod)).toEqual([]);
  });

  it.each([
    "engine/src/machine/ledger.ts", "engine/src/machine/report-discovery.ts",
    "engine/src/machine/session-registry.ts", "engine/src/orchestration/remediation-candidate.ts",
    "engine/src/orchestration/completion-check-runner.ts", "engine/src/orchestration/git-remediation.ts",
    "engine/src/handlers/helpers/programs/remediation.ts",
  ])("%s stays in the imperative shell", (mod) => {
    expect(isPureModule(mod)).toBe(false);
  });

  it.each(IMPURE_PROBES)("rejects direct impurity: %s", (probe) => {
    expect(noIoHandler(probe, ACCOUNTING).length).toBeGreaterThan(0);
  });

  it.each(IMPURE_PROBES)("rejects source-authority transitive impurity: %s", (probe) => {
    const audit = auditClosure([ACCOUNTING], new Map([[SOURCE_AUTHORITY, `${readSource(SOURCE_AUTHORITY)}\n${probe}`]]));
    expect(audit.errors.some((error) => error.startsWith(`${SOURCE_AUTHORITY}:`))).toBe(true);
  });

  it.each([ACCOUNTING, ...HASH_MODULES])("%s allows only named deterministic hashing", (mod) => {
    expect(isPureModule(mod)).toBe(true);
    for (const specifier of ["node:crypto", "crypto"]) {
      expect(noIoHandler(`import { createHash } from "${specifier}";\nconst digest = createHash("sha256").update("bytes").digest("hex");`, mod)).toEqual([]);
      expect(noIoHandler(`import {\n createHash as hash,\n} from "${specifier}";`, mod)).toEqual([]);
      expect(noIoHandler(`import { createHash, randomBytes } from "${specifier}";`, mod).length).toBeGreaterThan(0);
    }
  });

  it("allows dates computed from supplied data without granting ambient clock access", () => {
    expect(noIoHandler('const canonical = new Date(epoch).toISOString();', ACCOUNTING)).toEqual([]);
    expect(noIoHandler('const canonical = new Date(\n epoch\n).toISOString();', ACCOUNTING)).toEqual([]);
    expect(noIoHandler('const now = new Date();', ACCOUNTING).length).toBeGreaterThan(0);
  });

  it("never lets a createHash alias hide an entropy import", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,20}$/), (alias) => {
      const source = `import { randomBytes as ${alias} } from "node:crypto";`;
      expect(noIoHandler(source, ACCOUNTING).length).toBeGreaterThan(0);
    }), { numRuns: 100 });
  });

  it.each([
    'import "../orchestration/git-remediation";',
    'export * from "../orchestration/remediation-candidate";',
    'const shell = require("../orchestration/completion-check-runner");',
    'const shell = import("../orchestration/git-remediation");',
    'const shell = import(moduleName);',
    'import { parse } from "some-new-package";',
    'import { parse } from "saxes/other";',
    'import * as chars from "xmlchars";',
  ])("rejects an undeclared dependency edge: %s", (probe) => {
    const audit = auditClosure([ACCOUNTING], new Map([[ACCOUNTING, `${readSource(ACCOUNTING)}\n${probe}`]]));
    expect(audit.errors.some((error) => error.startsWith(`${ACCOUNTING}:`))).toBe(true);
  });

  it.each([ACCOUNTING, SOURCE_AUTHORITY, PARSER])("%s cannot expand the exact parser-to-SAX grant", (mod) => {
    for (const specifier of ["saxes/other", "saxes/saxes.js", "saxes-extra", "xmlchars", "node:fs"]) {
      const audit = auditClosure([ACCOUNTING], new Map([[mod, `${readSource(mod)}\nimport * as extra from "${specifier}";`]]));
      expect(audit.errors.some(error => error.startsWith(`${mod}:`)), `${mod} -> ${specifier}`).toBe(true);
    }
    if (mod !== PARSER) {
      const audit = auditClosure([ACCOUNTING], new Map([[mod, `${readSource(mod)}\nimport { SaxesParser } from "saxes";`]]));
      expect(audit.errors.some(error => error.startsWith(`${mod}:`))).toBe(true);
    }
  });

  it("the Guarded Skill Machine reducer's source closure still has no Node import", () => {
    const audit = auditClosure([MACHINE_ROOT]);
    expect(audit.errors).toEqual([]);
    for (const mod of audit.visited) {
      if (SAX_RUNTIME.has(mod)) continue;
      expect(dependencies(readSource(mod)).filter(({ specifier }) => specifier?.startsWith("node:")), mod).toEqual([]);
    }
    expect(audit.visited).toContain("engine/src/machine/test-report.ts");
    expect(audit.visited).toContain("engine/src/machine/types.ts");
    expect(audit.visited).toContain("saxes");
  });

  it("parses dependency syntax without treating comments or strings as imports", () => {
    const source = `// import "node:fs";\nconst prose = 'from "node:fs"';\nimport type { T } from "./types";\nexport * from "./barrel";\nimport "./side-effect";\nconst x = require("./cjs");\nconst y = import("./dynamic");\nimport z = require("./equals");\ntype U = import("./type-expression").U;`;
    expect(dependencies(source).map(({ specifier }) => specifier)).toEqual([
      "./types", "./barrel", "./side-effect", "./cjs", "./dynamic", "./equals", "./type-expression",
    ]);
  });
});

describe("audited reviewer runtime closure", () => {
  it("pins installed versions, entrypoints and dependency-free manifests", () => {
    const jsonc = JSON.parse(readFileSync(requireFromEngine.resolve("jsonc-parser/package.json"), "utf-8"));
    const zod = JSON.parse(readFileSync(requireFromEngine.resolve("zod/package.json"), "utf-8"));
    expect(jsonc.version).toBe("3.3.1");
    expect(jsonc.main).toBe("./lib/umd/main.js");
    expect(jsonc.exports).toBeUndefined();
    expect(jsonc.dependencies).toBeUndefined();
    expect(zod.version).toBe("4.3.6");
    expect(zod.exports["./v4"].import).toBe("./v4/index.js");
    expect(zod.dependencies).toBeUndefined();
    expect(requireFromEngine.resolve("jsonc-parser")).toBe(REVIEWER_RUNTIME.get("jsonc-parser/lib/umd/main.js")?.path);
    const audit = auditClosure([CONTRACT, LINEAGE_CONTRACT, CODEC, "engine/src/core/standalone-successor-reviewer.ts", "engine/src/core/context-packets.ts"]);
    expect(audit.errors).toEqual([]);
    for (const mod of REVIEWER_RUNTIME.keys()) expect(audit.visited).toContain(mod);
  });

  it.each(REVIEWER_RUNTIME_BYTES)("%s retains its exact audited bytes and imports", (mod, digest, expected) => {
    const content = readFileSync(resolve(REPO_ROOT, "engine/node_modules", mod), "utf-8");
    expect(createHash("sha256").update(content).digest("hex")).toBe(digest);
    expect(dependencies(content).map(({ specifier }) => specifier)).toEqual(expected);
  });

  it("Zod's dormant entropy export has no caller in the full local/dependency closure", () => {
    const audit = auditClosure([CODEC]);
    const mentions: string[] = [];
    for (const mod of audit.visited) {
      const runtime = AUDITED_RUNTIME.get(mod);
      const content = runtime === undefined ? readSource(mod) : readFileSync(runtime.path, "utf-8");
      const source = ts.createSourceFile(mod, content, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === "randomString") mentions.push(`${mod}:${node.getText(source)}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(mentions).toEqual(["zod/v4/core/util.js:randomString"]);
    expect(noIoHandler(readFileSync(REVIEWER_RUNTIME.get("zod/v4/core/util.js")!.path, "utf-8"), "zod/v4/core/util.js", ["zod/v4/core/util.js"]))
      .toMatchObject([{ line: 131, text: "str += chars[Math.floor(Math.random() * chars.length)];" }]);
  });

  it.each([CONTRACT, LINEAGE_CONTRACT, CODEC, "engine/src/core/standalone-lineage.ts", "engine/src/core/standalone-successor-reviewer.ts", "engine/src/core/context-packets.ts"].flatMap((mod) =>
    [...IMPURE_PROBES, 'import "zod";', 'import "zod/v4/core";', 'import "zod/v4/other";', 'import "jsonc-parser/lib/umd/main.js";', 'import "jsonc-parser-extra";',
      ...([CONTRACT, LINEAGE_CONTRACT].includes(mod) ? ['import "jsonc-parser";'] : ['import "zod/v4";']),
      ...(mod === CODEC ? [] : ['import "jsonc-parser";'])].map((probe) => [mod, probe] as const),
  ))("%s refuses additional capability: %s", (mod, probe) => {
    const audit = auditClosure([mod], new Map([[mod, `${readSource(mod)}\n${probe}`]]));
    expect(audit.errors.some((error) => error.startsWith(`${mod}:`)), probe).toBe(true);
  });

  it.each(REVIEWER_RUNTIME_BYTES)("%s cannot conceal appended entropy/I/O/time or changed implementation", (mod) => {
    const runtime = REVIEWER_RUNTIME.get(mod)!;
    const content = readFileSync(runtime.path, "utf-8");
    for (const probe of IMPURE_PROBES) {
      const violations = noIoHandler(`${content}\n${probe}`, mod, [mod]);
      expect(violations.some((v) => v.line > content.split("\n").length), probe).toBe(true);
    }
    expect(auditClosure([mod], new Map([[mod, `${content}\nconst changed = 1;`]])).errors).toContain(`${mod}: runtime bytes differ from the audit`);
  });

  it("imports and exercises the actual codec/schema/visitor with throwing ambient sentinels", () => {
    const sources = Object.fromEntries([...auditClosure([CODEC]).visited].map((mod) => {
      const runtime = AUDITED_RUNTIME.get(mod);
      const source = runtime === undefined ? ts.transpileModule(readSource(mod), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText : readFileSync(runtime.path, "utf-8");
      return [mod, source];
    }));
    const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", REVIEWER_SENTINEL_SCRIPT], {
      input: JSON.stringify(sources), encoding: "utf-8", timeout: 20_000, maxBuffer: 2_000_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "3ac3395301c1d38f41cd93accb19b942e832d7ebced990976335208259f40c37",
      rubric: "4f36c09cc1e7c27e2d8ff36c86ad22c7723c1a4715bd9c198bbed40e2c2f3a6b",
      valid: 4, invalid: 5, sentinels: 8,
    });
  });
});

// Sources are read by the test shell first. The VM then grants no filesystem,
// process, timers, network, clock or entropy, including during module initialization.
// Only deterministic createHash, POSIX path math and byte encoders cross into it.
const REVIEWER_SENTINEL_SCRIPT = String.raw`
import vm from "node:vm";
import { createHash } from "node:crypto";
import { posix } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const sources = JSON.parse(input);
const context = vm.createContext({ TextEncoder, TextDecoder, Buffer: Object.freeze({ from: Buffer.from }) });
vm.runInContext([
  'const deny = () => { throw new Error("ambient sentinel"); };',
  'Math.random = deny;',
  'const OriginalDate = Date;',
  'Date = class extends OriginalDate { constructor(...args) { if (!args.length) deny(); super(...args); } static now = deny; };',
  'globalThis.performance = { now: deny };',
  'globalThis.process = new Proxy({}, { get: deny });',
  'globalThis.crypto = new Proxy({}, { get: deny });',
  'globalThis.console = new Proxy({}, { get: deny });',
  'globalThis.fetch = deny; globalThis.setTimeout = deny; globalThis.setInterval = deny;',
].join("\n"), context);
const modules = new Map();
const cjs = new Map();
function target(specifier, parent) {
  if (specifier === "zod/v4") return "zod/v4/index.js";
  if (specifier === "jsonc-parser") return "jsonc-parser/lib/umd/main.js";
  if (!specifier.startsWith(".")) throw Error("ungranted dependency: " + specifier);
  const base = posix.normalize(posix.join(posix.dirname(parent), specifier));
  const found = [base, base + ".ts", base + "/index.ts", base + ".js"].find(x => Object.hasOwn(sources, x));
  if (!found) throw Error("ungranted source: " + base);
  return found;
}
function commonjs(id) {
  if (cjs.has(id)) return cjs.get(id).exports;
  const module = { exports: {} };
  cjs.set(id, module);
  vm.runInContext("(function(require,module,exports){" + sources[id] + "\n})", context)(specifier => commonjs(target(specifier, id)), module, module.exports);
  return module.exports;
}
function load(id) {
  if (modules.has(id)) return modules.get(id);
  let module;
  if (id === "node:crypto") module = new vm.SyntheticModule(["createHash"], function() { this.setExport("createHash", createHash); }, { context, identifier: id });
  else if (id === "node:path") module = new vm.SyntheticModule(["posix"], function() { this.setExport("posix", posix); }, { context, identifier: id });
  else if (id === "jsonc-parser/lib/umd/main.js") {
    const exports = commonjs(id);
    module = new vm.SyntheticModule(["visit"], function() { this.setExport("visit", exports.visit); }, { context, identifier: id });
  } else {
    if (!Object.hasOwn(sources, id)) throw Error("ungranted module: " + id);
    module = new vm.SourceTextModule(sources[id], { context, identifier: id });
  }
  modules.set(id, module);
  return module;
}
const codec = load("engine/src/core/reviewer-protocol.ts");
await codec.link((specifier, parent) => load(["node:crypto", "node:path"].includes(specifier) ? specifier : target(specifier, parent.identifier)));
await codec.evaluate();
const leaf = modules.get("engine/src/core/reviewer-contract.ts").namespace;
const parse = raw => codec.namespace.parseReviewerPayloadV2(new TextEncoder().encode(raw));
const example = leaf.REVIEWER_PAYLOAD_EXAMPLE_V2;
const critical = example.findings[0];
const reproduction = { ...critical, basis: { ...critical.basis, evidence: { kind: "reproduction", execution: "reviewer-reported", setup: "s", input: "i", observed: "o", expected: "e", reference: "r" } } };
const valid = [example, { schemaVersion: 2, kind: "standalone-review", findings: [] }, { ...example, findings: [reproduction] }, { schemaVersion: 2, kind: "wave-review", packetId: "a".repeat(64), generation: 0, prior_findings: [], findings: [] }];
for (const value of valid) if (!parse(JSON.stringify(value)).ok) throw Error("valid parse failed");
const invalid = ['{"x":1,"x":2}', '{"x":1,}', '{}', JSON.stringify({ ...example, findings: [{ ...critical, basis: null }] }), '['.repeat(33)];
for (const raw of invalid) if (parse(raw).ok) throw Error("invalid parse passed");
codec.namespace.renderReviewerWireContract();
const probes = ['Math.random()', 'Date.now()', 'new Date()', 'performance.now()', 'process.env', 'crypto.randomUUID()', 'fetch("x")', 'setTimeout(()=>{},1)'];
for (const probe of probes) {
  let refused = false;
  try { vm.runInContext(probe, context); } catch (error) { refused = error.message === "ambient sentinel"; }
  if (!refused) throw Error("sentinel failed: " + probe);
}
// Prove the dormant Zod export is NOT implicitly granted as a capability.
let dormantRefused = false;
try { modules.get("zod/v4/core/util.js").namespace.randomString(); } catch (error) { dormantRefused = error.message === "ambient sentinel"; }
if (!dormantRefused) throw Error("dormant entropy was granted");
process.stdout.write(JSON.stringify({ schema: leaf.CURRENT_REVIEWER_PROTOCOL.schemaDigest, rubric: leaf.CURRENT_REVIEWER_PROTOCOL.rubricDigest, valid: valid.length, invalid: invalid.length, sentinels: probes.length }));
`;

describe("audited in-process SAX runtime closure", () => {
  it("pins actual runtime versions, entrypoints and dependency manifests", () => {
    const saxes = JSON.parse(readFileSync(requireFromEngine.resolve("saxes/package.json"), "utf-8"));
    const xmlchars = JSON.parse(readFileSync(requireFromSaxes.resolve("xmlchars/package.json"), "utf-8"));
    expect(saxes.version).toBe("6.0.0");
    expect(saxes.main).toBe("saxes.js");
    expect(saxes.exports).toBeUndefined();
    expect(saxes.type).toBeUndefined();
    expect(saxes.dependencies).toEqual({ xmlchars: "^2.2.0" });
    expect(xmlchars.version).toBe("2.2.0");
    expect(xmlchars.exports).toBeUndefined();
    expect(xmlchars.type).toBeUndefined();
    expect(xmlchars.dependencies).toEqual({});
    expect(auditClosure(["saxes"]).errors).toEqual([]);
  });

  it.each([...SAX_RUNTIME])("%s has exactly its audited imports and no ambient I/O", (mod, runtime) => {
    const content = readFileSync(runtime.path, "utf-8");
    expect(dependencies(content).map(({ specifier }) => specifier)).toEqual(runtime.dependencies);
    expect(noIoHandler(content, mod, [mod])).toEqual([]);
    // Changed implementation (not just changed imports) requires a fresh audit.
    expect(createHash("sha256").update(content).digest("hex")).toBe(runtime.digest);
  });

  it.each([...SAX_RUNTIME])("%s cannot conceal transitive entropy, filesystem, process or time", (mod, runtime) => {
    const content = readFileSync(runtime.path, "utf-8");
    for (const probe of IMPURE_PROBES) {
      const audit = auditClosure(["saxes"], new Map([[mod, `${content}\n${probe}`]]));
      expect(audit.errors.some((error) => error.startsWith(`${mod}:`)), `${mod}: ${probe}`).toBe(true);
    }
  });
});
