import { join } from "node:path";
import {
  runTestLaneForTests,
  terminateSpawnedTestProcessForTests,
} from "../../scripts/test";

const mode = process.argv[2];
const markerPath = process.argv[3];
if (!mode || !markerPath) throw new Error("usage: test-runner-tree-controller.ts <mode> <marker>");

const treePath = join(import.meta.dir, "test-runner-tree.ts");
if (mode === "already-dead") {
  const child = Bun.spawn([process.execPath, treePath, markerPath, "exit"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  await child.exited;
  await terminateSpawnedTestProcessForTests(child, "SIGTERM", { graceMs: 25, killGraceMs: 100 });
  process.exitCode = 0;
} else {
  process.exitCode = await runTestLaneForTests(
    { label: mode, args: [], timeoutMs: mode === "timeout" ? 500 : 10_000 },
    "tree-fixture",
    {
      command: [process.execPath, treePath, markerPath, mode === "SIGINT" ? "normal" : "stubborn"],
      graceMs: 25,
      killGraceMs: 100,
    },
  );
}
