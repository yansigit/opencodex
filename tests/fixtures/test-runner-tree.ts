import { writeFileSync } from "node:fs";

const markerPath = process.argv[2];
const mode = process.argv[3];

if (!markerPath || !mode) throw new Error("usage: test-runner-tree.ts <marker> <mode>");

if (mode === "grandchild-exit") process.exit(0);
if (mode === "grandchild-stubborn") process.on("SIGTERM", () => {});
if (mode.startsWith("grandchild-")) await new Promise(() => {});

const behavior = mode === "exit" ? "exit" : mode === "stubborn" ? "stubborn" : "normal";
if (behavior === "stubborn") process.on("SIGTERM", () => {});
const grandchild = Bun.spawn([
  process.execPath,
  import.meta.path,
  markerPath,
  `grandchild-${behavior === "exit" ? "exit" : behavior === "stubborn" ? "stubborn" : "normal"}`,
], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
writeFileSync(markerPath, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
if (behavior === "exit") await grandchild.exited;
else await new Promise(() => {});
