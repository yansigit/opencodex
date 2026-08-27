import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("live inference workflow", () => {
  test("is restricted to trusted pushes and manual dispatch", async () => {
    const workflow = await readFile(new URL("../.github/workflows/live-inference.yml", import.meta.url), "utf8");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [dev]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).toContain("github.ref == 'refs/heads/dev'");
    expect(workflow).toContain("if: github.event_name == 'push'");
  });

  test("uses ephemeral homes and provider-specific environment secrets", async () => {
    const workflow = await readFile(new URL("../.github/workflows/live-inference.yml", import.meta.url), "utf8");
    expect(workflow).toContain("secrets[matrix.secret_name]");
    expect(workflow).toContain("mktemp -d");
    expect(workflow).toContain("OCX_LIVE_SMOKE_BUNDLE_B64");
    expect(workflow).toContain("rm -rf --");
  });
});
