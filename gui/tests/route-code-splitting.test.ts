import { expect, test } from "bun:test";
import { build, type Rollup } from "vite";

test("Dashboard is eager while every other page and Integration workspace is split", async () => {
  const result = await build({
    root: new URL("..", import.meta.url).pathname,
    logLevel: "silent",
    build: { write: false },
  }) as Rollup.RollupOutput;
  const chunks = result.output.filter(output => output.type === "chunk");
  const facade = (suffix: string) => chunks.find(chunk => chunk.facadeModuleId?.endsWith(suffix));
  const entry = chunks.find(chunk => chunk.isEntry)!;
  const eagerFiles = new Set<string>();
  const visit = (chunk: Rollup.OutputChunk) => {
    if (eagerFiles.has(chunk.fileName)) return;
    eagerFiles.add(chunk.fileName);
    for (const imported of chunk.imports) {
      const dependency = chunks.find(candidate => candidate.fileName === imported);
      if (dependency) visit(dependency);
    }
  };
  visit(entry);
  const eagerModules = chunks
    .filter(chunk => eagerFiles.has(chunk.fileName))
    .flatMap(chunk => Object.keys(chunk.modules));

  expect(facade("/src/pages/Dashboard.tsx")).toBeUndefined();
  expect(eagerModules.some(module => module.endsWith("/src/pages/Dashboard.tsx"))).toBe(true);
  for (const page of [
    "Startup",
    "Providers",
    "Models",
    "Subagents",
    "Logs",
    "Usage",
    "Storage",
    "CodexSet",
    "Integrations",
  ]) {
    expect(facade(`/src/pages/${page}.tsx`)).toBeDefined();
    expect(eagerModules.some(module => module.endsWith(`/src/pages/${page}.tsx`))).toBe(false);
  }
  for (const workspace of [
    "/src/pages/ApiKeys.tsx",
    "/src/pages/Claude.tsx",
    "/src/pages/Grok.tsx",
    "/src/pages/integrations/IntegrationsOverview.tsx",
    "/src/pages/integrations/FileIntegrationPage.tsx",
  ]) {
    expect(facade(workspace)).toBeDefined();
  }
});
