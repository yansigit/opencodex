import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { testProviderFetch } from "../../src/lib/test-provider-fetch";

test("provider-object fetch fixtures are inert outside the repository test preload", () => {
  const fixture = async () => new Response("fixture");
  expect(testProviderFetch({ fetch: fixture })).toBe(fixture);
  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `import { testProviderFetch } from ${JSON.stringify(fileURLToPath(new URL("../../src/lib/test-provider-fetch.ts", import.meta.url)))}; console.log(testProviderFetch({ fetch: () => null }) === undefined);`,
  ], {
    env: { ...process.env, OCX_TEST_HOME_GUARD: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.success).toBe(true);
  expect(new TextDecoder().decode(child.stdout).trim()).toBe("true");
});
