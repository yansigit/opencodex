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

test("Linux shards isolate the storage API runtime family into its own gated job", async () => {
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

  const storageJob = workflow.jobs?.["storage-policy"];
  expect(storageJob?.["runs-on"]).toBe("ubuntu-latest");
  expect(storageJob?.["timeout-minutes"]).toBe(5);

  const storageRun = storageJob?.steps?.find(
    step => step.name === "Test storage policy API",
  )?.run ?? "";
  expect(storageRun).toContain("scripts/ci/test-lanes.ts --lane dedicated-storage");
  expect(storageRun).toContain('"${dedicated_files[@]}"');
  expect(storageRun).not.toContain("--timings");

  expect(storageRun).not.toContain("--shard");

  expect(workflow.jobs?.ci?.needs).toContain("storage-policy");
});
