import { expect, test } from "bun:test";

type Step = {
  name?: string;
  run?: string;
};

type Job = {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  needs?: string[];
  steps?: Step[];
};

test("Linux shards isolate api-usage into its own gated job", async () => {
  const text = await Bun.file(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  ).text();
  const workflow = Bun.YAML.parse(text) as {
    jobs?: Record<string, Job>;
  };

  const shardRun = workflow.jobs?.test?.steps?.find(
    step => step.name === "Test in fresh-process timing-aware batches",
  )?.run ?? "";
  expect(shardRun).toContain("scripts/ci/run-bun-test-batches.sh");

  const batchHelper = await Bun.file(
    new URL("../scripts/ci/run-bun-test-batches.sh", import.meta.url),
  ).text();
  expect(batchHelper).toContain("scripts/ci/test-lanes.ts --lane general");
  expect(batchHelper).not.toContain("is_general_test_file");

  const apiUsageJob = workflow.jobs?.["api-usage"];
  expect(apiUsageJob?.["runs-on"]).toBe("ubuntu-latest");
  expect(apiUsageJob?.["timeout-minutes"]).toBe(5);

  const apiUsageRun = apiUsageJob?.steps?.find(
    step => step.name === "Test api usage API",
  )?.run ?? "";
  expect(apiUsageRun).toContain("scripts/ci/test-lanes.ts --lane dedicated-api");
  expect(apiUsageRun).toContain("bun test --isolate");
  expect(apiUsageRun).not.toContain("--timings");
  expect(apiUsageRun).not.toContain("--shard");

  expect(workflow.jobs?.ci?.needs).toContain("api-usage");
});
