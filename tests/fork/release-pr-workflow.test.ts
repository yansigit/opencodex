import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(new URL("../../.github/workflows/release-pr.yml", import.meta.url), "utf8");
const workflow = Bun.YAML.parse(workflowText) as {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, {
    if?: string;
    permissions?: Record<string, string>;
    steps?: Array<Record<string, unknown>>;
  }>;
};

describe("release PR workflow contract", () => {
  test("runs only for a main-branch manual dispatch", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs?.["release-pr"]?.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflowText).not.toContain("dev-version-bump");
    expect(workflowText).not.toContain("npm publish");
    expect(workflowText).not.toContain("refs/heads/dev");
    expect(workflowText).not.toContain("refs/heads/preview");
  });

  test("uses least-privilege write scopes and the repository App-token pattern", () => {
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs?.["release-pr"]?.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(workflowText).toContain("actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0");
    expect(workflowText).toContain("vars.PR_AUTOMATION_APP_ID");
    expect(workflowText).toContain("secrets.PR_AUTOMATION_PRIVATE_KEY");
    expect(workflowText).toContain("steps.release-please-app-token.outputs.token");
  });

  test("pins release tooling and delegates release creation to the existing publisher", () => {
    expect(workflowText).toContain("googleapis/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071 # v4.4.1");
    expect(workflowText).toContain("config-file: release-please-config.json");
    expect(workflowText).toContain("manifest-file: .release-please-manifest.json");
    const config = JSON.parse(readFileSync(new URL("../../release-please-config.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(config["skip-github-release"]).toBe(true);
    const manifest = JSON.parse(readFileSync(new URL("../../.release-please-manifest.json", import.meta.url), "utf8")) as Record<string, string>;
    expect(manifest["."]).toBe("2.41.1");
  });
});
