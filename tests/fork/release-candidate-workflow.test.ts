import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(import.meta.dir, "../../.github/workflows/release-candidate.yml");
const workflowText = readFileSync(workflowPath, "utf8");
const workflow = Bun.YAML.parse(workflowText) as {
  on?: {
    workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] };
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean; type?: string }>;
    };
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, {
    permissions?: Record<string, string>;
    "timeout-minutes"?: number;
    steps?: Array<{
      name?: string;
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
    }>;
  }>;
};

describe("release candidate workflow contract", () => {
  test("requires an explicit immutable candidate SHA", () => {
    expect(workflow.on?.workflow_dispatch?.inputs?.["expected-sha"]).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflowText).toContain('^[0-9a-f]{40}$');
    expect(workflowText).toContain("ref: ${{ inputs.expected-sha || github.event.workflow_run.head_sha }}");
    expect(workflowText).toContain('actual_sha="$(git rev-parse HEAD)"');
  });

  test("is read-only and contains no publication credential surface", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs?.build?.permissions).toBeUndefined();
    expect(workflowText).not.toMatch(/npm publish|NPM_TOKEN|NODE_AUTH_TOKEN|packages:\s*write|contents:\s*write|id-token:\s*write/);
    expect(workflow.jobs?.build?.["timeout-minutes"]).toBeGreaterThan(0);
  });

  test("installs once, runs only candidate contracts, then builds and packages once", () => {
    expect(workflowText.match(/bun install --frozen-lockfile/g)?.length).toBe(2);
    const focused = workflowText.indexOf("bun test tests/release-candidate.test.ts");
    const gui = workflowText.indexOf("bun run build:gui");
    const pack = workflowText.indexOf("bun scripts/build-release-candidate.ts");
    const verify = workflowText.indexOf("bun scripts/release-candidate.ts verify");
    expect(focused).toBeGreaterThan(0);
    expect(workflowText).not.toContain("bun run audit:high");
    expect(workflowText).not.toContain("bun run typecheck");
    expect(workflowText).not.toMatch(/bun run test(?:\s|$)/m);
    expect(gui).toBeGreaterThan(focused);
    expect(pack).toBeGreaterThan(gui);
    expect(verify).toBeGreaterThan(pack);
    expect(workflowText).toContain("release-candidate/release-candidate.json");
    expect(workflowText).toContain("--repository \"$GITHUB_REPOSITORY\"");
    expect(workflowText).toContain("--sha \"$EXPECTED_SHA\"");
    expect(workflowText).toContain("--tree \"$tree_sha\"");
    expect(workflowText).toContain("--input-root \"$GITHUB_WORKSPACE\"");
  });

  test("packs once and uploads only the immutable candidate directory", () => {
    const builderText = readFileSync(resolve(import.meta.dir, "../../scripts/build-release-candidate.ts"), "utf8");
    expect(builderText.match(/\["npm", "pack",/g)?.length).toBe(1);
    expect(workflowText).not.toMatch(/^\s*npm pack\b/m);

    const upload = workflow.jobs?.build?.steps?.find(step => step.name === "Upload immutable candidate");
    expect(upload).toMatchObject({
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "release-candidate-${{ inputs.expected-sha || github.event.workflow_run.head_sha }}",
        path: "release-candidate/",
        "if-no-files-found": "error",
        overwrite: false,
      },
    });
  });

  test("pins every action and deliberately defers attestation", () => {
    const actions = [...workflowText.matchAll(/uses:\s+([^\s#]+)/g)].map(match => match[1]);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/@[0-9a-f]{40}$/);
    expect(workflowText).not.toContain("actions/attest-");
    expect(workflowText).toContain("No attestation action is used until its version is reviewed and pinned");
  });
});
