import type { CommandRunner, SyncEvent } from "./types";

export const ALLOWED_VENDOR_REFS = ["vendor/main", "vendor/dev"] as const;
export type AllowedVendorRef = (typeof ALLOWED_VENDOR_REFS)[number];

export function isAllowedVendorRef(ref: string): ref is AllowedVendorRef {
  return (ALLOWED_VENDOR_REFS as readonly string[]).includes(ref);
}

async function run(
  runner: CommandRunner,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runner(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git command failed with exit code ${result.exitCode}`);
  }
  return result;
}

export async function pinVendorRef(
  ref: string,
  target: string,
  runner: CommandRunner,
): Promise<void> {
  if (!isAllowedVendorRef(ref)) {
    throw new Error(`ref ${ref} is not allowlisted`);
  }
  await run(runner, ["fetch", ".", `${target}:refs/heads/${ref}`]);
}

export interface PinOptions {
  runner: CommandRunner;
  upstreamDevRef?: string;
}

function pinError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/\S+/gi, "[remote]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export async function pinVendorRefs(
  event: SyncEvent,
  options: PinOptions,
): Promise<SyncEvent> {
  if (event.kind !== "pin-updated") return event;
  try {
    const upstreamDevRef = options.upstreamDevRef ?? "refs/remotes/upstream/dev";
    if (event.vendorDevSha) {
      const devCanFastForward = await options.runner([
        "merge-base",
        "--is-ancestor",
        event.vendorDevSha,
        upstreamDevRef,
      ]);
      if (devCanFastForward.exitCode === 1) {
        throw new Error("vendor/dev cannot be fast-forwarded to upstream/dev");
      }
      if (devCanFastForward.exitCode !== 0) {
        throw new Error(
          devCanFastForward.stderr.trim()
          || `git merge-base --is-ancestor failed with exit code ${devCanFastForward.exitCode}`,
        );
      }
    }

    let vendorMainSha = event.vendorMainSha;
    if (vendorMainSha && !event.vendorDevSha) {
      const keepMain = await options.runner([
        "merge-base",
        "--is-ancestor",
        event.latestTagSha,
        vendorMainSha,
      ]);
      if (keepMain.exitCode === 1) vendorMainSha = "";
      else if (keepMain.exitCode !== 0) {
        throw new Error(
          keepMain.stderr.trim()
          || `git merge-base --is-ancestor failed with exit code ${keepMain.exitCode}`,
        );
      }
    } else {
      vendorMainSha = "";
    }
    if (!vendorMainSha) {
      await pinVendorRef("vendor/main", event.latestTagSha, options.runner);
      vendorMainSha = (await run(
        options.runner,
        ["rev-parse", "refs/heads/vendor/main"],
      )).stdout.trim();
    }
    await pinVendorRef(
      "vendor/dev",
      upstreamDevRef,
      options.runner,
    );
    const dev = await run(options.runner, ["rev-parse", "refs/heads/vendor/dev"]);
    return {
      ...event,
      kind: "pin-updated",
      vendorMainSha,
      vendorDevSha: dev.stdout.trim(),
    };
  } catch (error) {
    return {
      ...event,
      kind: "pin-diverged",
      error: pinError(error),
    };
  }
}
