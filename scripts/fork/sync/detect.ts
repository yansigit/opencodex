import type {
  CommandResult,
  CommandRunner,
  SyncEvent,
} from "./types";

export interface DetectOptions {
  upstreamRepo: string;
  runner: CommandRunner;
  now?: () => Date;
}

class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: CommandResult,
  ) {
    super(result.stderr.trim() || `git command failed with exit code ${result.exitCode}`);
  }
}

async function runGit(
  runner: CommandRunner,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await runner(args);
  if (result.exitCode !== 0) throw new GitCommandError(args, result);
  return result;
}

async function optionalLocalRef(
  runner: CommandRunner,
  ref: string,
): Promise<string> {
  const result = await runner(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (result.exitCode === 1) return "";
  if (result.exitCode !== 0) {
    throw new GitCommandError(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], result);
  }
  const sha = result.stdout.trim();
  if (!sha) throw new Error(`${ref} resolved to an empty SHA`);
  return sha;
}

async function stableTagAtCommit(
  runner: CommandRunner,
  commit: string,
): Promise<string> {
  const packageJson = (await runGit(runner, ["show", `${commit}:package.json`])).stdout;
  const version = (JSON.parse(packageJson) as { version?: unknown }).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("vendor/main package version is not a stable release");
  }
  return `v${version}`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, "[remote]")
    .replace(/(?:token|secret|password|authorization|bearer)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function parseTags(output: string): Array<{ tag: string; sha: string }> {
  const tags = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref?.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const tag = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
    if (/^v\d+\.\d+\.\d+$/.test(tag) && (peeled || !tags.has(tag))) tags.set(tag, sha);
  }
  return [...tags].map(([tag, sha]) => ({ tag, sha }));
}

function compareTags(left: string, right: string): number {
  const version = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
  const leftMatch = version.exec(left);
  const rightMatch = version.exec(right);
  if (leftMatch && rightMatch) {
    for (let index = 1; index <= 3; index += 1) {
      const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
      if (difference !== 0) return difference;
    }
    const leftStable = /^v\d+\.\d+\.\d+$/.test(left);
    const rightStable = /^v\d+\.\d+\.\d+$/.test(right);
    if (leftStable !== rightStable) return leftStable ? 1 : -1;
  } else if (leftMatch) {
    return 1;
  } else if (rightMatch) {
    return -1;
  }
  return left.localeCompare(right);
}

function event(
  kind: SyncEvent["kind"],
  options: DetectOptions,
  latestTag = "",
  latestTagSha = "",
  vendorMainSha = "",
  vendorDevSha = "",
  error?: string,
): SyncEvent {
  return {
    kind,
    upstreamRepo: options.upstreamRepo,
    latestTag,
    latestTagSha,
    vendorMainSha,
    vendorDevSha,
    detectedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(error ? { error } : {}),
  };
}

export async function detectLatestVTag(
  options: DetectOptions,
): Promise<SyncEvent> {
  let latestTag = "";
  let latestTagSha = "";
  let vendorMainSha = "";
  let vendorDevSha = "";
  try {
    const tags = parseTags(
      (await runGit(options.runner, [
        "ls-remote",
        "--tags",
        options.upstreamRepo,
        "v*",
      ])).stdout,
    ).sort((left, right) => compareTags(left.tag, right.tag));
    if (tags.length === 0) throw new Error("no v* release tag found");
    vendorMainSha = await optionalLocalRef(options.runner, "refs/heads/vendor/main");
    vendorDevSha = await optionalLocalRef(options.runner, "refs/heads/vendor/dev");

    let latest: { tag: string; sha: string } | undefined;
    for (let index = tags.length - 1; index >= 0; index -= 1) {
      const candidate = tags[index]!;
      latestTag = candidate.tag;
      latestTagSha = candidate.sha;
      const onUpstreamMain = await options.runner([
        "merge-base",
        "--is-ancestor",
        candidate.sha,
        "refs/remotes/upstream/main",
      ]);
      if (onUpstreamMain.exitCode === 0) {
        latest = candidate;
        break;
      }
      if (onUpstreamMain.exitCode !== 1) {
        throw new GitCommandError(
          ["merge-base", "--is-ancestor", candidate.sha, "refs/remotes/upstream/main"],
          onUpstreamMain,
        );
      }
    }
    if (!latest) {
      return event(
        "detect-failed",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
        "no v* tag is an ancestor of upstream/main",
      );
    }
    latestTag = latest.tag;
    latestTagSha = latest.sha;

    if (vendorMainSha && vendorMainSha !== latestTagSha) {
      const pinnedTag = await stableTagAtCommit(options.runner, vendorMainSha);
      if (!tags.some(tag => tag.tag === pinnedTag && tag.sha === vendorMainSha)) {
        return event(
          "pin-diverged",
          options,
          latestTag,
          latestTagSha,
          vendorMainSha,
          vendorDevSha,
          "vendor/main is not pinned to its current stable tag",
        );
      }
    }

    if (!vendorMainSha || !vendorDevSha) {
      return event(
        "pin-updated",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
      );
    }

    if (vendorMainSha === latestTagSha) {
      return event(
        "already-current",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
      );
    }

    const tagContainedInVendor = await options.runner([
      "merge-base",
      "--is-ancestor",
      latestTagSha,
      vendorMainSha,
    ]);
    if (tagContainedInVendor.exitCode === 0) {
      return event(
        "pin-diverged",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
        "vendor/main is ahead of the latest eligible stable tag",
      );
    }
    if (tagContainedInVendor.exitCode !== 1) {
      throw new GitCommandError(
        ["merge-base", "--is-ancestor", latestTagSha, vendorMainSha],
        tagContainedInVendor,
      );
    }

    const vendorCanFastForward = await options.runner([
      "merge-base",
      "--is-ancestor",
      vendorMainSha,
      latestTagSha,
    ]);
    if (vendorCanFastForward.exitCode === 1) {
      return event(
        "pin-diverged",
        options,
        latestTag,
        latestTagSha,
        vendorMainSha,
        vendorDevSha,
        "vendor/main cannot be fast-forwarded to the latest tag",
      );
    }
    if (vendorCanFastForward.exitCode !== 0) {
      throw new GitCommandError(
        ["merge-base", "--is-ancestor", vendorMainSha, latestTagSha],
        vendorCanFastForward,
      );
    }
    return event(
      "pin-updated",
      options,
      latestTag,
      latestTagSha,
      vendorMainSha,
      vendorDevSha,
    );
  } catch (error) {
    return event(
      "detect-failed",
      options,
      latestTag,
      latestTagSha,
      vendorMainSha,
      vendorDevSha,
      safeError(error),
    );
  }
}
