const MINIMUM_CONTAINER_VERSION = [1, 3, 0];
const image = "opencodex-test";

function output(result: ReturnType<typeof Bun.spawnSync>): string {
  return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
}

function command(args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["container", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
}

function versionAtLeast(version: string): boolean {
  const found = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!found) return false;
  for (const [index, part] of found.slice(1).map(Number).entries()) {
    if (part !== MINIMUM_CONTAINER_VERSION[index]) return part > MINIMUM_CONTAINER_VERSION[index];
  }
  return true;
}

function requireSuccess(args: string[], message: string): void {
  if (!command(args).success) throw new Error(message);
}

if (process.argv.length !== 2) throw new Error("test:container does not accept arguments; use OCX_CONTAINER_CPUS and OCX_CONTAINER_MEMORY");

const version = Bun.spawnSync(["container", "--version"], { stdout: "pipe", stderr: "pipe" });
if (!version.success || !versionAtLeast(output(version))) throw new Error("Apple Container CLI 1.3.0 or newer is required");
if (!command(["system", "status"]).success) throw new Error("Apple Container is stopped; run `container system start` and retry");

const cpus = process.env.OCX_CONTAINER_CPUS ?? "8";
const memory = process.env.OCX_CONTAINER_MEMORY ?? "8G";
const memoryValue = memory.match(/^(\d+(?:\.\d+)?)(?:[KMGT](?:i?B)?)?$/i);
if (!/^\d+(?:\.\d+)?$/.test(cpus) || Number(cpus) <= 0 || !memoryValue || Number(memoryValue[1]) <= 0) {
  throw new Error("OCX_CONTAINER_CPUS must be positive and OCX_CONTAINER_MEMORY must be a positive Container memory value");
}

requireSuccess(["build", "--tag", image, "--file", "Containerfile.test", "."], "Container image build failed");
requireSuccess([
  "run", "--rm", "--init", "--read-only", "--cap-drop", "ALL", "--network", "none", "--no-dns",
  "--cpus", cpus, "--memory", memory, "--tmpfs", "/tmp", "--tmpfs", "/home/ocx", "--user", "ocx",
  "--env", "HOME=/home/ocx", "--env", "TMPDIR=/tmp", "--env", "XDG_CACHE_HOME=/home/ocx/.cache",
  image, "bun", "scripts/test-container-entrypoint.ts",
], "Container test run failed");
