import { readdirSync, unlinkSync, writeFileSync } from "node:fs";

if (process.getuid?.() === 0) throw new Error("container test must run as an unprivileged user");
try { writeFileSync("/app/.ocx-write-test", "must fail"); unlinkSync("/app/.ocx-write-test"); throw new Error("/app must be unwritable"); }
catch (error) { if (error instanceof Error && error.message === "/app must be unwritable") throw error; }
for (const path of ["/tmp", "/home/ocx"]) {
  const probe = `${path}/.ocx-write-test`;
  writeFileSync(probe, "ok");
  if (await Bun.file(probe).text() !== "ok") throw new Error(`${path} write probe failed`);
  unlinkSync(probe);
}
if (readdirSync("/sys/class/net").sort().join("\n") !== "lo") throw new Error("container networking must expose only lo");
const run = async (cwd: string, args: string[]) => {
  const result = await Bun.spawn(["bun", ...args], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  if (result !== 0) process.exit(result);
};
await run("/app", ["run", "test"]);
await run("/app/integrations/replit-gateway", ["run", "test"]);
