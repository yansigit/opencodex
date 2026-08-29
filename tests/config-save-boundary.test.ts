import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { API } from "typescript/unstable/async";
import {
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamedExports,
  isNamespaceImport,
  isNamespaceExport,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableDeclaration,
  SyntaxKind,
  type Expression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

/**
 * "Every live-config writer goes through the guarded saver" is a claim until something
 * checks it (devlog 260726_claude_auth_auto/040 H1). `saveConfig` serializes the WHOLE
 * config, so ONE bare call on a live config re-clobbers a hand-edited `claudeCode` and
 * silently undoes the guard.
 *
 * Startup migrations are the documented exception: they run before the server serves
 * requests, against a config nobody else holds.
 */

const SRC = join(import.meta.dir, "..", "src");

function configReplacementReferences(source: SourceFile, symbol: string): number[] {
  const namespaces = new Set<string>();
  const hits: number[] = [];
  const isConfigModule = (node: Node): boolean => isStringLiteral(node)
    && resolve(dirname(source.fileName), node.text).replace(/\.ts$/, "") === join(SRC, "config");
  const staticString = (node: Expression): string | undefined => {
    while (isParenthesizedExpression(node)) node = node.expression;
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken) {
      const left = staticString(node.left);
      const right = staticString(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  };
  const unwrap = (node: Expression): Expression => {
    while (isParenthesizedExpression(node) || isAwaitExpression(node)) node = node.expression;
    return node;
  };
  const isConfigNamespace = (node: Expression): boolean => {
    node = unwrap(node);
    return (isIdentifier(node) && namespaces.has(node.text))
      || (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && isConfigModule(node.arguments[0]!));
  };
  const collectNamespaces = (node: Node): void => {
    if (isImportDeclaration(node) && isConfigModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && isNamedImports(bindings) && bindings.elements.some(
        item => (item.propertyName ?? item.name).text === symbol,
      )) hits.push(node.getStart(source));
    }
    if (isExportDeclaration(node) && node.moduleSpecifier && isConfigModule(node.moduleSpecifier)) {
      const bindings = node.exportClause;
      if (!bindings || isNamespaceExport(bindings) || (isNamedExports(bindings) && bindings.elements.some(
        item => (item.propertyName ?? item.name).text === symbol,
      ))) hits.push(node.getStart(source));
    }
    if (isVariableDeclaration(node) && node.initializer && isConfigNamespace(node.initializer)) {
      if (isIdentifier(node.name)) namespaces.add(node.name.text);
      if (isObjectBindingPattern(node.name) && node.name.elements.some(element => {
        const imported = element.propertyName ?? element.name;
        return (isIdentifier(imported) || isStringLiteral(imported))
          && imported.text === symbol;
      })) hits.push(node.getStart(source));
    }
    if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken
      && isIdentifier(node.left) && isConfigNamespace(node.right)) {
      namespaces.add(node.left.text);
    }
    node.forEachChild(collectNamespaces);
  };
  const collectAccesses = (node: Node): void => {
    if (isPropertyAccessExpression(node)
      && node.name.text === symbol
      && isConfigNamespace(node.expression)) hits.push(node.getStart(source));
    if (isElementAccessExpression(node)
      && staticString(node.argumentExpression) === symbol
      && isConfigNamespace(node.expression)) hits.push(node.getStart(source));
    node.forEachChild(collectAccesses);
  };
  collectNamespaces(source);
  collectAccesses(source);
  return hits;
}

/** Modules that hold a LIVE server config and must use the wrapper. */
const GUARDED_FILES = [
  "providers/api-keys.ts",       // request-path + management key pool
  "providers/key-failover.ts",   // 429 rotation, reached mid-turn with no user action
  "codex/routing.ts",            // account auto-switch during a turn
  "codex/auth-api.ts",           // runtime account/quota persistence
  "cli/claude-desktop.ts",       // CLI against a running service
  "server/management-api.ts",
];

function guardedManagementFiles(): string[] {
  const dir = join(SRC, "server", "management");
  return readdirSync(dir)
    .filter(name => name.endsWith(".ts"))
    .map(name => join("server", "management", name));
}

/** Bare `saveConfig(` calls, ignoring the guarded wrapper's own longer name. */
function bareSaveConfigCalls(text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(entry => /(?<![A-Za-z])saveConfig\s*\(/.test(entry.line))
    .map(entry => `${entry.number}: ${entry.line}`);
}

test("no live-config writer calls saveConfig directly", () => {
  const offenders: string[] = [];
  for (const relative of [...GUARDED_FILES, ...guardedManagementFiles()]) {
    const text = readFileSync(join(SRC, relative), "utf8");
    for (const hit of bareSaveConfigCalls(text)) offenders.push(`${relative}:${hit}`);
  }
  expect(offenders).toEqual([]);
});

// The import itself is the drift risk: a later edit reaching for the bare symbol should
// have to add the import back, which review catches.
test("guarded modules do not import the bare saver", () => {
  const offenders: string[] = [];
  for (const relative of [...GUARDED_FILES, ...guardedManagementFiles()]) {
    const text = readFileSync(join(SRC, relative), "utf8");
    if (/(?<![A-Za-z])saveConfig\s*[,}]/.test(text)) offenders.push(relative);
  }
  expect(offenders).toEqual([]);
});

// The exception has to stay narrow and visible, not become a habit.
test("startServer arms the baseline before it can serve a request", () => {
  const text = readFileSync(join(SRC, "server", "index.ts"), "utf8");
  const start = text.indexOf("export function startServer");
  expect(start).toBeGreaterThan(-1);
  const armIndex = text.indexOf("armClaudeCodeBaseline(config)", start);
  expect(armIndex).toBeGreaterThan(-1);
  // Every bare save inside startServer is a startup migration and must precede arming.
  const body = text.slice(start, armIndex);
  const after = text.slice(armIndex, text.indexOf("\n}\n", armIndex));
  expect(bareSaveConfigCalls(body).length).toBeGreaterThan(0);
  expect(bareSaveConfigCalls(after)).toEqual([]);
});

test("full config replacement is limited to explicit import and init", async () => {
  const allowed = new Map([
    ["replacePersistedConfig", new Set(["cli/config-command.ts", "cli/init.ts", "config.ts"])],
    ["initializePersistedConfigIfMissing", new Set(["config.ts", "oauth/index.ts"])],
  ]);
  const fixtureDir = mkdtempSync(join(tmpdir(), "ocx-config-policy-"));
  const fixture = join(fixtureDir, "fixture.ts");
  const configModule = join(SRC, "config");
  writeFileSync(fixture, [
    `import { replacePersistedConfig as replace } from ${JSON.stringify(configModule)}; replace(value);`,
    `import * as config from ${JSON.stringify(configModule)}; config.replacePersistedConfig(value);`,
    `config["replacePersistedConfig"](value);`,
    `config["replace" + "PersistedConfig"](value);`,
    `(await import(${JSON.stringify(configModule)})).replacePersistedConfig(value);`,
    `const loaded = (await import(${JSON.stringify(configModule)})); loaded.replacePersistedConfig(value);`,
    `let assigned; assigned = (await import(${JSON.stringify(configModule)})); assigned.replacePersistedConfig(value);`,
    `const { replacePersistedConfig: destructured } = await import(${JSON.stringify(configModule)}); destructured(value);`,
    "config[`replacePersistedConfig`](value);",
    `config[("replace" + "PersistedConfig")](value);`,
    `(await import(${JSON.stringify(configModule)})).initializePersistedConfigIfMissing(value);`,
    `export { replacePersistedConfig } from ${JSON.stringify(configModule)};`,
    `export { replacePersistedConfig as replaceExport } from ${JSON.stringify(configModule)};`,
    `export { initializePersistedConfigIfMissing } from ${JSON.stringify(configModule)};`,
    `export { initializePersistedConfigIfMissing as initializeExport } from ${JSON.stringify(configModule)};`,
    `export * from ${JSON.stringify(configModule)};`,
    `export * as config from ${JSON.stringify(configModule)};`,
  ].join("\n"));
  const api = new API({ cwd: join(SRC, "..") });
  try {
    const snapshot = await api.updateSnapshot({
      openProjects: [join(SRC, "..", "tsconfig.json")],
      openFiles: [fixture],
    });
    try {
      const fixtureProject = await snapshot.getDefaultProjectForFile(fixture);
      const fixtureSource = await fixtureProject?.program.getSourceFile(fixture);
      expect(fixtureSource && configReplacementReferences(fixtureSource, "replacePersistedConfig")).toHaveLength(14);
      expect(fixtureSource && configReplacementReferences(fixtureSource, "initializePersistedConfigIfMissing")).toHaveLength(5);

      const project = snapshot.getProject(join(SRC, "..", "tsconfig.json"));
      if (!project) throw new Error("TypeScript did not load the repository project");
      const paths: string[] = [];
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (entry.name.endsWith(".ts")) paths.push(path);
        }
      };
      visit(SRC);
      const sources = await Promise.all(paths.map(path => project.program.getSourceFile(path)));
      const offenders = sources.flatMap(source => {
        if (!source) throw new Error("TypeScript omitted a production source file");
        const relative = source.fileName.slice(SRC.length + 1);
        return [...allowed].flatMap(([symbol, files]) =>
          !files.has(relative) && configReplacementReferences(source, symbol).length > 0
            ? [`${relative}: ${symbol}`]
            : []);
      });
      expect(offenders).toEqual([]);
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
