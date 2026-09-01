import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEDICATED_TEST_FILES,
  SERIAL_TEST_FILES,
  discoverTestFiles,
  laneFiles,
  allocateFilesByTiming,
  validateLaneManifest,
} from "../scripts/ci/test-lanes";
import { validateTimingData } from "../scripts/ci/validate-timings";
import { mergeTimingData } from "../scripts/ci/merge-timings";
import { selectTimingData } from "../scripts/ci/select-timings";

describe("CI lane manifest", () => {
  test("is exhaustive and disjoint over the repository test inventory", () => {
    const inventory = discoverTestFiles(process.cwd());
    const lanes = validateLaneManifest(inventory);
    expect(lanes.general.length + lanes.serial.length + lanes.dedicated.length)
      .toBe(inventory.length);
    expect(new Set(lanes.general).size).toBe(lanes.general.length);
    expect(new Set(lanes.serial).size).toBe(lanes.serial.length);
    expect(new Set(lanes.dedicated).size).toBe(lanes.dedicated.length);
    expect(new Set(lanes.general).intersection(new Set(lanes.serial)).size).toBe(0);
    expect(new Set(lanes.general).intersection(new Set(lanes.dedicated)).size).toBe(0);
    expect(new Set(lanes.serial).intersection(new Set(lanes.dedicated)).size).toBe(0);
    expect(lanes.serial).toEqual(SERIAL_TEST_FILES);
    expect(lanes.serial).toContain("tests/server-auth.test.ts");
    expect(lanes.serial).toContain("tests/shutdown-launcher.test.ts");
    expect(lanes.dedicated).toEqual(DEDICATED_TEST_FILES);
    expect(laneFiles("general", process.cwd())).toEqual(lanes.general);
  });

  test("never accepts a lane path outside tests", () => {
    expect(() => validateLaneManifest(["tests/good.test.ts", "src/not-a-test.ts"]))
      .toThrow(/outside tests/);
  });

  test("ignores a scratch directory that vanishes during inventory", () => {
    const root = join(tmpdir(), `opencodex-ci-lanes-${process.pid}-${Date.now()}`);
    const testsRoot = join(root, "tests");
    const vanishing = join(testsRoot, ".tmp-vanishing");
    mkdirSync(vanishing, { recursive: true });
    writeFileSync(join(testsRoot, "stable.test.ts"), "");

    try {
      expect(discoverTestFiles(root, directory => {
        if (directory === vanishing) {
          const error = new Error(`directory disappeared: ${directory}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return readdirSync(directory, { withFileTypes: true });
      })).toEqual(["tests/stable.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still fails when the required tests root is missing", () => {
    const root = join(tmpdir(), `opencodex-ci-lanes-missing-${process.pid}-${Date.now()}`);
    expect(() => discoverTestFiles(root)).toThrow(/ENOENT/);
  });

  test("timing data changes allocation only, never lane membership", () => {
    const files = ["tests/slow.test.ts", "tests/fast.test.ts"];
    const shards = allocateFilesByTiming(files, 2, new Map([
      [files[0], 100],
      [files[1], 1],
    ]));
    expect(new Set(shards.flat())).toEqual(new Set(files));
    expect(shards[0]?.[0]).toBe(files[0]);
  });

  test("longest processing time allocation balances bins without dropping files", () => {
    const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
    const shards = allocateFilesByTiming(files, 2, new Map([
      [files[0], 10], [files[1], 9], [files[2], 1],
    ]));
    expect(shards).toEqual([[files[0]], [files[1], files[2]]]);
  });

  test("cold timing caches still distribute files across shards", () => {
    const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"];
    expect(allocateFilesByTiming(files, 2)).toEqual([
      [files[0], files[2]],
      [files[1], files[3]],
    ]);
  });
});

describe("timing data validation", () => {
  test("accepts bounded repository-relative timing entries", () => {
    expect(validateTimingData({
      version: 1,
      files: { "tests/good.test.ts": 12.5 },
    }, new Set(["tests/good.test.ts"]))).toEqual({
      version: 1,
      files: { "tests/good.test.ts": 12.5 },
    });
  });

  test("rejects malformed timing metadata and unknown paths", () => {
    const files = new Set(["tests/good.test.ts"]);
    for (const value of [
      { version: 2, files: {} },
      { version: 1, files: { "../secret": 1 } },
      { version: 1, files: { "tests/missing.test.ts": 1 } },
      { version: 1, files: { "tests/good.test.ts": -1 } },
      { version: 1, files: { "tests/good.test.ts": Infinity } },
    ]) expect(() => validateTimingData(value, files)).toThrow();
    expect(validateTimingData({ version: 1, files: { "tests/good.test.ts": 0 } }, files)
      .files["tests/good.test.ts"]).toBe(0);
  });

  test("merges only validated repository timing maps", () => {
    const files = new Set(["tests/a.test.ts", "tests/b.test.ts"]);
    expect(mergeTimingData([
      { version: 1, files: { "tests/a.test.ts": 10 } },
      { version: 1, files: { "tests/b.test.ts": 2 } },
    ], files)).toEqual({
      version: 1,
      files: { "tests/a.test.ts": 10, "tests/b.test.ts": 2 },
    });
  });

  test("selects one shard report from the restored timing map", () => {
    const files = new Set(["tests/a.test.ts", "tests/b.test.ts"]);
    expect(selectTimingData({ version: 1, files: {
      "tests/a.test.ts": 10,
      "tests/b.test.ts": 2,
    } }, ["tests/b.test.ts"], files)).toEqual({
      version: 1,
      files: { "tests/b.test.ts": 2 },
    });
  });
});

test("the timing validator is runnable without a test-selection input", async () => {
  const script = join(process.cwd(), "scripts/ci/validate-timings.ts");
  expect(await Bun.file(script).exists()).toBe(true);
});

test("only trusted dev shards publish the canonical timing cache", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  const ci = Bun.YAML.parse(workflow) as { jobs: Record<string, {
    if?: string;
    needs?: string[];
    steps?: Array<{ uses?: string; if?: string; with?: Record<string, string>; run?: string }>;
  }> };
  const general = ci.jobs.test;
  const generalSteps = general.steps ?? [];
  const restore = general.steps?.find(step => step.uses?.startsWith("actions/cache/restore@"));
  expect(restore?.with?.key).toContain("ocx-test-timings-dev-");
  expect(restore?.with?.["restore-keys"]?.trim()).toBe("ocx-test-timings-dev-");
  const validateIndex = generalSteps.findIndex(step => step.run?.includes("validate-timings.ts"));
  const testIndex = generalSteps.findIndex(step => step.run?.includes("run-bun-test-batches.sh"));
  expect(validateIndex).toBeGreaterThan(generalSteps.indexOf(restore!));
  expect(validateIndex).toBeLessThan(testIndex);
  expect(generalSteps[validateIndex]?.run).toContain("--discard-invalid");
  const upload = general.steps?.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  expect(upload?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  expect(upload?.if).toContain("github.ref == 'refs/heads/dev'");
  expect(upload?.with?.path).toBe(".bun-timings.json");
  expect(upload?.with?.["include-hidden-files"]).toBe(true);
  expect(ci.jobs["publish-test-timings"].if).toContain("github.ref == 'refs/heads/dev'");
  expect(ci.jobs["publish-test-timings"].needs).toBe("test");
  expect(ci.jobs["publish-test-timings"].steps?.some(step =>
    step.uses === "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  )).toBe(true);
  expect(ci.jobs["publish-test-timings"].steps?.some(step =>
    step.run?.includes("scripts/ci/merge-timings.ts"),
  )).toBe(true);
  expect(ci.jobs["publish-test-timings"].steps?.some(step =>
    step.uses === "actions/cache/save@caa296126883cff596d87d8935842f9db880ef25",
  )).toBe(true);
  expect(ci.jobs["platform-macos"].steps?.some(step => step.uses?.startsWith("actions/cache/save@"))).toBe(false);
  const swift = ci.jobs["platform-macos"].steps?.find(step =>
    step.run?.includes("tests/aistudio-native-webkit.test.ts"),
  );
  expect(swift?.if).toContain("needs.changes.outputs.swift == 'true'");
  expect(swift?.if).toContain("refs/heads/dev");
  const focused = ci.jobs["platform-macos"].steps?.find(step =>
    step.name === "Focused Darwin/process lifecycle tests",
  );
  expect(focused?.run).not.toContain("tests/aistudio-native-webkit.test.ts");
  expect(focused?.run).toContain("tests/test-runner.test.ts");
  expect(focused?.run).toContain("tests/cursor-native-exec-shell.test.ts");
  const full = ci.jobs["platform-macos"].steps?.find(step => step.name === "Full macOS suite");
  expect(full?.run).toContain("bun scripts/test.ts --timeout 60000");
  expect(full?.run).not.toContain("--update-timings");
});

test("nightly macOS is timed at 08:17 UTC and names its timing file", async () => {
  const text = await Bun.file(new URL("../.github/workflows/nightly-macos.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(text) as {
    on?: { schedule?: Array<{ cron?: string }> };
    jobs?: Record<string, { steps?: Array<{ name?: string; run?: string; with?: Record<string, string> }> }>;
  };
  expect(workflow.on?.schedule).toEqual([{ cron: "17 8 * * *" }]);
  const steps = workflow.jobs?.["full-macos"]?.steps ?? [];
  expect(steps.find(step => step.name === "Checkout")?.with?.ref).toBe("dev");
  expect(steps.findIndex(step => step.run?.includes("validate-timings.ts")))
    .toBeLessThan(steps.findIndex(step => step.name === "Full macOS suite"));
  expect(steps.find(step => step.run?.includes("validate-timings.ts"))?.run)
    .toContain("--discard-invalid");
  expect(text).toContain("--timings .bun-timings.json --update-timings");
  expect(text).toContain("ocx-test-timings-dev-");
});
