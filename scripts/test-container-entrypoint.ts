import { accessSync, constants } from "node:fs";

if (process.getuid?.() === 0) throw new Error("container test must run as an unprivileged user");
try {
  accessSync("/app", constants.W_OK);
  throw new Error("/app must be unwritable");
} catch (error) {
  if (error instanceof Error && error.message === "/app must be unwritable") throw error;
}
for (const path of ["/tmp", "/home/ocx"]) {
  const probe = `${path}/.ocx-write-test`;
  await Bun.write(probe, "ok");
  await Bun.file(probe).text();
  await Bun.$`rm -f ${probe}`;
}
const response = await fetch("http://127.0.0.1:1").catch(error => error as Error);
if (!(response instanceof Error) || !/refused|failed|connect/i.test(response.message)) {
  throw new Error("container networking must be limited to loopback");
}
const run = async (cwd: string, args: string[]) => {
  const result = await Bun.spawn(["bun", ...args], { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  if (result !== 0) process.exit(result);
};
await run("/app", ["run", "test"]);
await run("/app/integrations/replit-gateway", ["run", "test"]);
