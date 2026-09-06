import { writeFileSync } from "node:fs";

const marker = process.argv[2];
const mode = process.argv[3] ?? "timeout";
if (!marker || !["timeout", "overflow"].includes(mode)) throw new Error("usage: claude-cert-process-tree.ts <marker> <timeout|overflow>");
const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
  stdin: "ignore", stdout: "inherit", stderr: "inherit",
});
writeFileSync(marker, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
if (mode === "overflow") process.stdout.write("x".repeat(300 * 1024));
await new Promise<never>(() => {});
